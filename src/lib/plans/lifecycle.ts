/**
 * Vencimento de plano — a varredura da SPEC 062 §8 (F9).
 *
 * Server-only, `service_role` (como `sweep.ts` da SPEC 060, que esta
 * varredura acompanha na mesma rota de cron). Por conta com
 * `current_period_end` não nulo:
 *
 *   1. **Vencendo** (7 e 1 dia) → aviso, sem mudar nada.
 *   2. **Vencido** → se `cancel_at_period_end`, desce para o plano
 *      padrão; senão marca `past_due` e abre carência.
 *   3. **Carência encerrada** → aviso. NUNCA bloqueia (D-7) — quem
 *      bloqueia é o proprietário, pelo console.
 *
 * Nunca lança — chamada de dentro de `after()`, onde uma exceção não
 * tem quem a leia (mesmo contrato de `runMessageRetention`).
 *
 * Idempotência de cada ramo, e por quê ela não precisa da outbox da
 * SPEC 063 (que não existe ainda — SPEC irmã, fora de escopo):
 *
 *   - Os ramos que MUDAM `status`/`plan_id` (2) são idempotentes **por
 *     construção**: só disparam quando o status ainda é
 *     `active`/`trialing`, e depois de disparar uma vez o status já
 *     não bate mais nessa condição na próxima corrida. O downgrade por
 *     cancelamento agendado tem uma segunda garantia: o plano padrão
 *     tem `current_period_end` NULL, e a consulta desta função só olha
 *     linhas com `current_period_end IS NOT NULL` — a conta sai do
 *     escopo da varredura sozinha.
 *   - Os ramos que só AVISAM sem mudar nada (1 e 3) não têm essa
 *     garantia estrutural, então usam `platform_audit_log` como
 *     registro de "já avisei" — a MESMA tabela que o console já usa
 *     para auditoria, consultada por `payload->>dedupeKey` antes de
 *     escrever. Não é a outbox com `dedupe_key` dedicado que a SPEC 063
 *     desenha; é o que dá para construir hoje sem inventar uma tabela
 *     nova fora do escopo desta fase.
 *
 * "Emite o evento" (§6.1, §8) tem DOIS destinatários, e cada linha de
 * `processOne` dispara os dois: `dispatchWebhookEvent` (o webhook de
 * saída POR CONTA, `src/lib/webhooks/` — a conta só ouve quando registra
 * um endpoint assinando o evento) e, desde a SPEC 063, `emitSystemEvent`
 * (a outbox do PROPRIETÁRIO da plataforma — e-mail/webhook do
 * mantenedor, independente de qualquer configuração da conta). São
 * públicos diferentes; nenhum substitui o outro.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { writePlatformAudit } from '@/lib/platform/audit';
import { emitSystemEvent } from '@/lib/notifications/emit';
import { computePeriodEnd, daysUntil, graceEnd, isExpired } from './billing';
import type { AccountPlanStatus, BillingPeriod } from './types';

const LIFECYCLE_ACTOR = 'cron:lifecycle';
const EXPIRING_NOTICE_DAYS = [7, 1] as const;

export interface PlanLifecycleResult {
  accountsScanned: number;
  expiringNotices: number;
  expired: number;
  canceledApplied: number;
  graceEnded: number;
  errors: number;
}

function emptyResult(): PlanLifecycleResult {
  return {
    accountsScanned: 0,
    expiringNotices: 0,
    expired: 0,
    canceledApplied: 0,
    graceEnded: 0,
    errors: 0,
  };
}

interface AccountPlanLifecycleRow {
  account_id: string;
  plan_id: string;
  status: AccountPlanStatus;
  billing_cycle: 'monthly' | 'yearly';
  current_period_end: string;
  cancel_at_period_end: boolean;
  grace_until: string | null;
  limit_overrides: Record<string, unknown> | null;
  plans: { code: string } | null;
  accounts: { name: string } | null;
}

interface DefaultPlanRow {
  id: string;
  code: string;
  billing_period: BillingPeriod;
  price_cents: number;
}

const SCAN_PAGE_SIZE = 500;

const ACCOUNT_PLANS_SELECT =
  'account_id, plan_id, status, billing_cycle, current_period_end, cancel_at_period_end, grace_until, limit_overrides, plans:plan_id (code), accounts:account_id (name)';

/**
 * Todas as linhas com `current_period_end` preenchido, paginado
 * (achado de code review: a consulta original não tinha `.range()`
 * nem `.order()` — acima do teto de linhas do PostgREST o resto do
 * catálogo era truncado em silêncio, e QUAL subconjunto sobrevivia era
 * indefinido sem `.order()`). `ascending: true` por vencimento não é
 * só determinismo: se o processo for morto no meio (o teto de
 * `maxDuration` da rota de cron), as contas que vencem PRIMEIRO já
 * foram processadas — o pior caso possível vira "algumas contas
 * esperam mais um ciclo", nunca "as mais urgentes ficam de fora".
 */
async function fetchDueAccountPlans(
  db: SupabaseClient
): Promise<AccountPlanLifecycleRow[]> {
  const rows: AccountPlanLifecycleRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('account_plans')
      .select(ACCOUNT_PLANS_SELECT)
      .not('current_period_end', 'is', null)
      .order('current_period_end', { ascending: true })
      .range(from, from + SCAN_PAGE_SIZE - 1);
    if (error) throw error;

    const page = (data ?? []) as unknown as AccountPlanLifecycleRow[];
    rows.push(...page);
    if (page.length < SCAN_PAGE_SIZE) break;
    from += SCAN_PAGE_SIZE;
  }
  return rows;
}

/**
 * `platform_audit_log` como backend de dedupe (ver docstring do
 * arquivo) — UMA consulta em bloco para TODAS as contas da corrida,
 * não uma por conta dentro do laço (achado de code review: o mesmo
 * padrão de "uma consulta por BLOCO" que `sweep.ts`'s
 * `fetchPoliciesByPair` e `platform/accounts.ts` já seguem). `dedupeKey`
 * já inclui o `account_id`, então uma chave só precisa ser única
 * globalmente — o `Set` não precisa ser particionado por conta.
 *
 * Falha aberta: erro na consulta devolve um `Set` vazio (nenhum aviso
 * registrado) em vez de abortar a varredura — melhor um aviso
 * duplicado (o pior caso aqui é um e-mail/webhook repetido) do que
 * travar o ciclo por causa de uma leitura de auditoria.
 */
/**
 * Achado de code review: sem filtro de data nem `.limit()`, esta
 * consulta cresce para sempre — `plan.lifecycle_notice` nunca é
 * apagada (é auditoria). Acima do teto de linhas do PostgREST, o `Set`
 * volta incompleto e `notify()` reenvia avisos já mandados, na cara do
 * cliente, a cada corrida.
 *
 * O corte por data é seguro porque toda `dedupeKey` desta função
 * embute o `periodEnd`/`graceUntil` ATUAL da conta
 * (`plan.expiring:<id>:<periodEnd>:<dias>`,
 * `plan.grace_ended:<id>:<graceUntil>`) — e o aviso só é gravado 1–7
 * dias antes daquele instante (`EXPIRING_NOTICE_DAYS`/`graceDays`),
 * nunca antes. Uma linha mais velha que a janela nunca poderia colidir
 * com a chave que este ciclo está prestes a checar, plano mensal ou
 * anual — a distância entre "escrito" e "relevante" é sempre pequena,
 * não o tamanho do ciclo de cobrança.
 */
const NOTICE_LOOKBACK_DAYS = 45;
const NOTICE_SCAN_LIMIT = 5000;

async function loadExistingNotices(
  db: SupabaseClient,
  accountIds: string[],
  now: Date
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();

  const cutoff = new Date(
    now.getTime() - NOTICE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );
  const { data, error } = await db
    .from('platform_audit_log')
    .select('payload')
    .eq('action', 'plan.lifecycle_notice')
    .in('account_id', accountIds)
    .gte('created_at', cutoff.toISOString())
    .order('created_at', { ascending: false })
    .limit(NOTICE_SCAN_LIMIT);

  if (error) {
    console.error('[plans/lifecycle] dedupe batch read failed:', error.message);
    return new Set();
  }

  const keys = new Set<string>();
  for (const row of (data ?? []) as { payload: Record<string, unknown> }[]) {
    const dedupeKey = row.payload?.dedupeKey;
    if (typeof dedupeKey === 'string') keys.add(dedupeKey);
  }
  return keys;
}

/** `false` = já tinha avisado (dedupe) — o chamador não conta isso como um evento novo. */
async function notify(
  db: SupabaseClient,
  accountId: string,
  accountName: string,
  event: 'plan.expiring' | 'plan.grace_ended',
  dedupeKey: string,
  payload: Record<string, unknown>,
  existingNotices: Set<string>,
  now: Date
): Promise<boolean> {
  if (existingNotices.has(dedupeKey)) return false;
  await writePlatformAudit(db, {
    actor: LIFECYCLE_ACTOR,
    action: 'plan.lifecycle_notice',
    accountId,
    payload: { event, dedupeKey, ...payload },
  });
  await dispatchWebhookEvent(db, accountId, event, payload);
  // SPEC 063 §3.1 — a outbox do proprietário tem sua PRÓPRIA
  // idempotência (`dedupe_key` único no banco), independente do
  // `existingNotices` acima (que dedupa só o webhook por conta e o
  // registro em `platform_audit_log`). Chamar sempre que este ponto é
  // alcançado é seguro: a chave `plan.expiring:<acc>:<periodEnd>:<dias>`
  // / `plan.grace_ended:<acc>:<periodEnd>` é a MESMA em toda corrida do
  // mesmo período, então o `INSERT` só entrega na primeira vez.
  await emitSystemEvent(
    {
      type: event,
      accountId,
      account: { id: accountId, name: accountName, ownerEmail: null },
      actor: LIFECYCLE_ACTOR,
      data: { plan: payload },
    },
    db,
    now
  );
  // Registrado localmente para o RESTO desta mesma corrida — sem isto,
  // duas contas cujo dedupeKey colidisse (não deveria, já que a chave
  // inclui account_id, mas é defesa em profundidade barata) poderiam
  // avisar duas vezes na mesma varredura.
  existingNotices.add(dedupeKey);
  return true;
}

export async function runPlanLifecycle(
  now: Date = new Date(),
  db: SupabaseClient = supabaseAdmin()
): Promise<PlanLifecycleResult> {
  const result = emptyResult();

  try {
    const { data: settings, error: settingsErr } = await db
      .from('platform_settings')
      .select('default_plan_code, grace_days')
      .maybeSingle();
    if (settingsErr || !settings) {
      console.error(
        '[plans/lifecycle] platform_settings read failed:',
        settingsErr?.message
      );
      result.errors++;
      return result;
    }

    const { data: defaultPlan, error: defaultPlanErr } = await db
      .from('plans')
      .select('id, code, billing_period, price_cents')
      .eq('code', settings.default_plan_code)
      .maybeSingle();
    if (defaultPlanErr || !defaultPlan) {
      console.error(
        '[plans/lifecycle] default plan lookup failed:',
        defaultPlanErr?.message ??
          `code ${settings.default_plan_code} not found`
      );
      result.errors++;
      return result;
    }

    let typedRows: AccountPlanLifecycleRow[];
    try {
      typedRows = await fetchDueAccountPlans(db);
    } catch (err) {
      console.error(
        '[plans/lifecycle] account_plans read failed:',
        err instanceof Error ? err.message : err
      );
      result.errors++;
      return result;
    }
    result.accountsScanned = typedRows.length;

    const existingNotices = await loadExistingNotices(
      db,
      typedRows.map((r) => r.account_id),
      now
    );

    for (const row of typedRows) {
      try {
        await processOne(
          db,
          row,
          defaultPlan as DefaultPlanRow,
          settings.grace_days as number,
          now,
          result,
          existingNotices
        );
      } catch (err) {
        console.error('[plans/lifecycle] account failed:', row.account_id, err);
        result.errors++;
      }
    }
  } catch (err) {
    console.error('[plans/lifecycle] sweep failed:', err);
    result.errors++;
  }

  return result;
}

async function processOne(
  db: SupabaseClient,
  row: AccountPlanLifecycleRow,
  defaultPlan: DefaultPlanRow,
  graceDays: number,
  now: Date,
  result: PlanLifecycleResult,
  existingNotices: Set<string>
): Promise<void> {
  const periodEnd = row.current_period_end;
  const accountName = row.accounts?.name ?? 'Conta';
  const isActiveLikeStatus =
    row.status === 'active' || row.status === 'trialing';

  // ── Vencido ──────────────────────────────────────────────────────
  if (isExpired(periodEnd, now) && isActiveLikeStatus) {
    if (row.cancel_at_period_end) {
      const newPeriodEnd = computePeriodEnd(now, row.billing_cycle, {
        billingPeriod: defaultPlan.billing_period,
        priceCents: defaultPlan.price_cents,
      });
      const { data: downgraded, error: updateErr } = await db
        .from('account_plans')
        .update({
          plan_id: defaultPlan.id,
          started_at: now.toISOString(),
          current_period_end: newPeriodEnd ? newPeriodEnd.toISOString() : null,
          status: 'active',
          cancel_at_period_end: false,
          canceled_at: null,
          grace_until: null,
          updated_by: LIFECYCLE_ACTOR,
          updated_at: now.toISOString(),
        })
        .eq('account_id', row.account_id)
        .eq('current_period_end', periodEnd)
        .eq('status', row.status)
        .select('account_id');
      if (updateErr) {
        console.error(
          '[plans/lifecycle] downgrade update failed:',
          updateErr.message
        );
        result.errors++;
        return;
      }
      // SPEC 078 §3.3 — zero linhas: o vencimento OU o status mudou
      // depois da leitura do lote (o operador empurrou a data, suspendeu
      // a conta, ou uma renovação chegou). Sem evento, sem contagem; a próxima corrida reavalia.
      if (!downgraded || downgraded.length === 0) return;

      await db.from('account_plan_events').insert({
        account_id: row.account_id,
        from_plan_code: row.plans?.code ?? null,
        to_plan_code: defaultPlan.code,
        from_status: row.status,
        to_status: 'active',
        overrides_after: row.limit_overrides ?? {},
        actor: LIFECYCLE_ACTOR,
        reason: 'cancel_at_period_end reached',
      });
      await dispatchWebhookEvent(db, row.account_id, 'plan.canceled_applied', {
        fromPlanCode: row.plans?.code ?? null,
        toPlanCode: defaultPlan.code,
      });
      // SPEC 063 §3.1 — `dedupe_key` inclui o `periodEnd` VENCIDO (o
      // gatilho desta transição), não o novo: é o que impede a mesma
      // efetivação de gerar dois avisos se a varredura rodar de novo
      // antes do próximo período (a garantia estrutural da §8 já cobre
      // isso via `status`, mas a chave de dedupe é defesa em
      // profundidade barata).
      await emitSystemEvent(
        {
          type: 'plan.canceled_applied',
          accountId: row.account_id,
          account: { id: row.account_id, name: accountName, ownerEmail: null },
          actor: LIFECYCLE_ACTOR,
          data: {
            plan: {
              fromPlanCode: row.plans?.code ?? null,
              toPlanCode: defaultPlan.code,
              periodEnd,
            },
          },
        },
        db,
        now
      );
      result.canceledApplied++;
      return;
    }

    const graceUntil = graceEnd(periodEnd, graceDays);
    // Concorrência otimista (SPEC 078 §3.3): só marca `past_due` se o
    // vencimento E o status ainda são os que o lote leu. Sem isto, a
    // conta cairia em atraso com vencimento futuro quando o operador (ou
    // uma renovação) empurra a data entre a leitura e esta escrita — ou
    // desfaria uma suspensão/cancelamento manual feito nesse intervalo.
    const { data: markedPastDue, error: updateErr } = await db
      .from('account_plans')
      .update({
        status: 'past_due',
        grace_until: graceUntil.toISOString(),
        updated_by: LIFECYCLE_ACTOR,
        updated_at: now.toISOString(),
      })
      .eq('account_id', row.account_id)
      .eq('current_period_end', periodEnd)
      .eq('status', row.status)
      .select('account_id');
    if (updateErr) {
      console.error(
        '[plans/lifecycle] past_due update failed:',
        updateErr.message
      );
      result.errors++;
      return;
    }
    if (!markedPastDue || markedPastDue.length === 0) return;

    // Achado de code review: `to_plan_code` é `NOT NULL` no schema
    // (067) — o plano não muda nesta transição (só o status), mas a
    // linha ainda precisa de um valor. Usar o próprio código atual dos
    // dois lados é o que descreve corretamente "nada mudou de plano
    // aqui" sem violar a constraint (um `null` cru fazia este INSERT
    // falhar toda vez que uma conta vencia sem cancelamento agendado —
    // silenciosamente, porque o erro do INSERT nunca era lido).
    const currentPlanCode = row.plans?.code ?? 'unknown';
    await db.from('account_plan_events').insert({
      account_id: row.account_id,
      from_plan_code: currentPlanCode,
      to_plan_code: currentPlanCode,
      from_status: row.status,
      to_status: 'past_due',
      overrides_after: row.limit_overrides ?? {},
      actor: LIFECYCLE_ACTOR,
      reason: 'current_period_end reached',
    });
    await dispatchWebhookEvent(db, row.account_id, 'plan.expired', {
      periodEnd,
      graceUntil: graceUntil.toISOString(),
    });
    await emitSystemEvent(
      {
        type: 'plan.expired',
        accountId: row.account_id,
        account: { id: row.account_id, name: accountName, ownerEmail: null },
        actor: LIFECYCLE_ACTOR,
        data: { plan: { periodEnd, graceUntil: graceUntil.toISOString() } },
      },
      db,
      now
    );
    result.expired++;
    return;
  }

  // ── Carência encerrada (D-7: não bloqueia) ──────────────────────
  if (
    row.status === 'past_due' &&
    row.grace_until !== null &&
    isExpired(row.grace_until, now)
  ) {
    const emitted = await notify(
      db,
      row.account_id,
      accountName,
      'plan.grace_ended',
      `plan.grace_ended:${row.account_id}:${row.grace_until}`,
      { graceUntil: row.grace_until },
      existingNotices,
      now
    );
    if (emitted) result.graceEnded++;
    return;
  }

  // ── Vencendo (7 e 1 dia) ─────────────────────────────────────────
  if (isActiveLikeStatus) {
    const remaining = daysUntil(periodEnd, now);
    if (
      remaining !== null &&
      (EXPIRING_NOTICE_DAYS as readonly number[]).includes(remaining)
    ) {
      const emitted = await notify(
        db,
        row.account_id,
        accountName,
        'plan.expiring',
        `plan.expiring:${row.account_id}:${periodEnd}:${remaining}`,
        { periodEnd, daysUntil: remaining },
        existingNotices,
        now
      );
      if (emitted) result.expiringNotices++;
    }
  }
}
