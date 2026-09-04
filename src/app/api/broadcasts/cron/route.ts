/**
 * GET /api/broadcasts/cron — dispara as campanhas agendadas que venceram
 * (SPEC 044 §6.3).
 *
 * O que ela resolve
 *
 *   `broadcasts.scheduled_at` existe desde a migração 001 e nunca foi
 *   lido por ninguém: agendar era impossível. Com o envio já no servidor
 *   (§6.1), o que faltava era alguém acordando de tempo em tempo para
 *   perguntar "venceu algo?". É esta rota.
 *
 * Três decisões que valem ser lidas antes de mexer
 *
 *   1. **A audiência é resolvida AGORA, não no agendamento.** O que ficou
 *      gravado é o FILTRO. Quem entrou na etiqueta depois de ontem
 *      recebe; quem pediu opt-out na madrugada não recebe (§6.8); a cota
 *      conferida é a da janela de 24 h que vale neste instante. Congelar
 *      a lista no agendamento produziria um disparo tecnicamente correto
 *      e factualmente velho.
 *   2. **Fora da janela, ADIA — não dispara nem falha.** Um agendamento
 *      que vence às 23h (porque o cron ficou fora do ar, ou porque o
 *      usuário marcou assim e depois tirou o override) é empurrado para a
 *      próxima abertura da janela. Disparar queimaria reputação; marcar
 *      como falho destruiria a intenção do usuário. Adiar preserva as
 *      duas coisas, e o motivo fica na trilha (§6.8).
 *   3. **O claim é o lock.** `UPDATE … WHERE status = 'scheduled'` só
 *      casa uma vez; duas invocações sobrepostas do cron não disparam a
 *      mesma campanha duas vezes. Mesmo padrão de
 *      `/api/automations/cron`, sem `SELECT … FOR UPDATE`.
 *   4. **A varredura ignora variantes B** (§6.6). Um teste A/B agendado
 *      são duas linhas `scheduled`, e só a variante A é campanha por si
 *      só: a B existe para receber metade da audiência que a A vai
 *      sortear. Varrê-la também faria o cron disparar a audiência
 *      INTEIRA duas vezes, uma por template.
 *
 * Auth: reusa `AUTOMATION_CRON_SECRET` para o operador ter um segredo só
 * — igual a `/api/flows/cron`.
 *
 * Hospedagem: um ping a cada 5 min é suficiente (a granularidade do
 * agendamento na UI é de minuto, e um atraso de poucos minutos num
 * disparo em massa não muda nada). Ver docs/automations-and-cron.md.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse, after } from 'next/server';

import { canEditSettings, type AccountRole } from '@/lib/auth/roles';
import { logBroadcastAudit } from '@/lib/broadcasts/audit';
import {
  parseAudienceConfig,
  parseVariableMap,
} from '@/lib/broadcasts/parse-input';
import {
  DEFAULT_TIME_ZONE,
  describeSendWindow,
  isWithinSendWindow,
  nextWindowOpening,
  resolveTimeZone,
} from '@/lib/broadcasts/send-window';
import {
  decidePartialSend,
  type PartialSendState,
} from '@/lib/broadcasts/partial-send';
import { loadBlockedAccountIds } from '@/lib/platform/blocked';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  BroadcastError,
  deliverBroadcast,
} from '@/lib/whatsapp/broadcast-core';
import {
  SEND_BATCH_DELAY_MS,
  SEND_BATCH_SIZE,
  planAbTestBroadcast,
  planDashboardBroadcast,
} from '@/lib/whatsapp/broadcast-dispatch';
import { loadAccountQuota } from '@/lib/whatsapp/messaging-limit-server';

/** Mesmo teto da rota de envio: o fan-out roda em `after()`. */
export const maxDuration = 300;

/**
 * Quantas campanhas uma invocação assume.
 *
 * Baixo de propósito: cada uma pode ter milhares de destinatários e o
 * fan-out roda em `after()`, dentro do `maxDuration` desta requisição.
 * Um ping a cada 5 min drena 5 campanhas por ciclo, e o excedente espera
 * o próximo — que é melhor do que assumir 50 e ser cortado no meio da
 * décima.
 */
const MAX_PER_RUN = 5;

/**
 * Quanto tempo esperar antes de tentar de novo quando a cota da janela de
 * 24 h não cabe. A janela é DESLIZANTE: em uma hora ela já liberou parte
 * do consumo, então reagendar é a resposta certa — marcar como falho
 * jogaria a campanha fora por uma condição temporária.
 */
const QUOTA_RETRY_MS = 60 * 60 * 1000;

interface DueBroadcast {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  template_name: string;
  template_language: string;
  template_variables: unknown;
  audience_filter: unknown;
  header_media_url: string | null;
  /** Número gravado no agendamento (SPEC 064 D-3). `null` = campanha legada. */
  channel_id: string | null;
  /**
   * SPEC 065 §11 (migração 076, achado de code review) — de onde veio
   * `channel_id` no momento do agendamento. `null` numa linha anterior
   * a esta coluna: o motor recai no cálculo antigo a partir só de
   * `channel_id`, mesmo comportamento de antes desta migração.
   */
  channel_source: 'resource' | 'default' | null;
  scheduled_at: string;
  scheduled_timezone: string | null;
  window_override: boolean;
  /** Teste A/B (§6.6): fatia da audiência da variante A. */
  ab_split_percent: number | null;
}

/** A variante B de um agendamento A/B, quando existe. */
interface VariantRow {
  id: string;
  template_name: string;
  template_language: string;
  template_variables: unknown;
  header_media_url: string | null;
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Comparação de tempo constante, igual a /api/flows/cron: sem ela, um
  // atacante que alcança o endpoint recupera o segredo byte a byte pelos
  // deltas de tempo de resposta.
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const now = new Date();

  const { data: due, error } = await admin
    .from('broadcasts')
    .select(
      'id, account_id, user_id, name, template_name, template_language, template_variables, audience_filter, header_media_url, channel_id, channel_source, scheduled_at, scheduled_timezone, window_override, ab_split_percent'
    )
    .eq('status', 'scheduled')
    // Decisão 4 do cabeçalho: variante B não é campanha por si só.
    .is('parent_broadcast_id', null)
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    console.error('[broadcasts-cron] due scan failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // Sem agendamento vencido NÃO se retorna cedo: desde a SPEC 069 F8
  // esta rota tem uma SEGUNDA responsabilidade — varrer as campanhas
  // paradas em `awaiting_check` (R6). Sair aqui faria o disparo parcial
  // só andar nos ciclos em que, por coincidência, houvesse também um
  // agendamento vencido — que é quase nunca.
  const dueRows = (due ?? []) as DueBroadcast[];

  // SPEC 062 §4.3 ponto 1. Este cliente é `service_role` e não passa
  // por RLS: sem esta lista, a campanha agendada de uma conta bloqueada
  // dispara normalmente na hora marcada. `assertAccountCanBroadcast`
  // (§4.3 ponto 4) recusaria adiante de qualquer forma — mas só depois
  // de a campanha ter sido reivindicada e o ciclo do cron gasto, e o
  // desfecho apareceria como campanha FALHA, não como campanha de conta
  // bloqueada. Pular aqui deixa a campanha intacta em `scheduled`, para
  // sair quando (e se) a conta for desbloqueada.
  const blockedAccounts = await loadBlockedAccountIds(admin);

  let dispatched = 0;
  let postponed = 0;
  let failed = 0;
  let skippedBlocked = 0;

  for (const row of dueRows) {
    if (blockedAccounts.has(row.account_id)) {
      skippedBlocked++;
      continue;
    }
    const timeZone = resolveTimeZone(
      row.scheduled_timezone ?? DEFAULT_TIME_ZONE
    );

    // ── Janela de horário (decisão 2 do cabeçalho) ────────────────
    if (!row.window_override && !isWithinSendWindow(now, timeZone)) {
      const next = nextWindowOpening(now, timeZone);
      const { data: moved } = await admin
        .from('broadcasts')
        .update({ scheduled_at: next.toISOString() })
        .eq('id', row.id)
        // Precondição: se outra invocação já assumiu esta campanha, não
        // adiamos um disparo que está saindo.
        .eq('status', 'scheduled')
        .select('id')
        .maybeSingle();

      if (moved) {
        // A variante B (§6.6) acompanha o adiamento. Ela nunca é varrida,
        // então o horário dela é só o que a lista mostra — mas mostrar
        // duas metades do mesmo teste com horas diferentes seria pior do
        // que não mostrar hora nenhuma.
        await admin
          .from('broadcasts')
          .update({ scheduled_at: next.toISOString() })
          .eq('parent_broadcast_id', row.id)
          .eq('status', 'scheduled');

        postponed++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'postponed_window',
          broadcastId: row.id,
          broadcastName: row.name,
          templateName: row.template_name,
          scheduledAt: next.toISOString(),
          details: {
            was_due_at: row.scheduled_at,
            time_zone: timeZone,
            window: describeSendWindow(),
          },
        });
      }
      continue;
    }

    // ── Claim: o lock (decisão 3) ────────────────────────────────
    const { data: claim } = await admin
      .from('broadcasts')
      .update({ status: 'sending' })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    // ── A variante B do teste A/B (§6.6) ─────────────────────────
    // Ela é travada pelo MESMO claim, e pelo mesmo motivo: o par sai
    // junto ou não sai. Se a linha sumiu (o usuário apagou só a B) ou
    // outra invocação a assumiu, o disparo degrada para uma campanha
    // comum — metade de um teste A/B, disparada sozinha, seria pior.
    let abVariant: VariantRow | null = null;
    const { data: variantRow } = await admin
      .from('broadcasts')
      .select(
        'id, template_name, template_language, template_variables, header_media_url'
      )
      .eq('parent_broadcast_id', row.id)
      .eq('status', 'scheduled')
      .maybeSingle();

    if (variantRow) {
      const { data: variantClaim } = await admin
        .from('broadcasts')
        .update({ status: 'sending' })
        .eq('id', variantRow.id)
        .eq('status', 'scheduled')
        .select('id')
        .maybeSingle();
      if (variantClaim) abVariant = variantRow as VariantRow;
    }

    /** Devolve o par inteiro a um estado, não só a linha da variante A. */
    async function updatePair(patch: Record<string, unknown>) {
      await admin.from('broadcasts').update(patch).eq('id', row.id);
      if (abVariant) {
        await admin.from('broadcasts').update(patch).eq('id', abVariant.id);
      }
    }

    const audience = parseAudienceConfig(row.audience_filter);
    const variables = parseVariableMap(row.template_variables);
    const variantVariables = abVariant
      ? parseVariableMap(abVariant.template_variables)
      : {};

    if (!audience || !variables || !variantVariables) {
      // Um `audience_filter` que não valida é um agendamento que nunca
      // vai poder sair. Marcar como falho é o que faz o usuário VER isso
      // na lista, em vez de a campanha ficar em `sending` para sempre.
      failed++;
      await updatePair({ status: 'failed' });
      await logBroadcastAudit(admin, {
        accountId: row.account_id,
        event: 'failed',
        broadcastId: row.id,
        broadcastName: row.name,
        templateName: row.template_name,
        details: { reason: 'malformed_audience_filter' },
      });
      continue;
    }

    try {
      // Por canal (D-4): o teto reconferido tem que ser o do número
      // gravado no agendamento, não o padrão da conta — que pode ter
      // mudado desde então.
      const quota = await loadAccountQuota(admin, row.account_id, {
        channelId: row.channel_id,
      });
      const batchLimit = quota.configured
        ? quota.snapshot.batchLimit
        : Number.POSITIVE_INFINITY;

      // SPEC 057 D-1 — o cron roda sem sessão (service-role), então o
      // papel de quem AGENDOU (`row.user_id`) precisa ser lido à mão em
      // vez de vir de `requireRole`. Sem a linha (perfil apagado, conta
      // trocada), a regra conservadora vale: sem permissão de criar
      // etiquetas.
      const { data: schedulerProfile } = await admin
        .from('profiles')
        .select('account_role')
        .eq('user_id', row.user_id)
        .eq('account_id', row.account_id)
        .maybeSingle();
      const canCreateTags = schedulerProfile
        ? canEditSettings(schedulerProfile.account_role as AccountRole)
        : false;

      // ── Teste A/B agendado (§6.6) ──────────────────────────────
      // A divisão da audiência acontece AQUI, não no agendamento —
      // mesma razão da decisão 1 do cabeçalho: sortear ontem uma lista
      // que só existe hoje dividiria gente que já saiu e deixaria de
      // fora quem entrou.
      if (abVariant) {
        const ab = await planAbTestBroadcast(admin, {
          accountId: row.account_id,
          userId: row.user_id,
          batchLimit,
          adoptBroadcastId: row.id,
          adoptVariantBroadcastId: abVariant.id,
          splitPercent: row.ab_split_percent ?? undefined,
          input: {
            name: row.name,
            templateName: row.template_name,
            templateLanguage: row.template_language,
            audience,
            variables,
            headerMediaUrl: row.header_media_url ?? undefined,
            channelId: row.channel_id,
            channelSource: row.channel_source,
          },
          variant: {
            templateName: abVariant.template_name,
            templateLanguage: abVariant.template_language,
            variables: variantVariables,
            headerMediaUrl: abVariant.header_media_url ?? undefined,
          },
          canCreateTags,
        });

        dispatched++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'dispatched',
          broadcastId: ab.variantA.broadcastId,
          broadcastName: row.name,
          actorUserId: null,
          templateName: row.template_name,
          totalRecipients: ab.totalRecipients,
          excludedOptedOut: ab.excludedOptedOut,
          scheduledAt: row.scheduled_at,
          details: {
            audience_type: audience.type,
            scheduled_by: row.user_id,
            time_zone: timeZone,
            window_override: row.window_override,
            excluded_invalid_whatsapp: ab.excludedInvalidWhatsapp,
            ab_test: true,
            ab_split_percent: ab.splitPercent,
            ab_variant_broadcast_id: ab.variantB.broadcastId,
            ab_variant_template: abVariant.template_name,
            ab_accepted_a: ab.variantA.planned.length,
            ab_accepted_b: ab.variantB.planned.length,
            rejected: ab.variantA.rejected + ab.variantB.rejected,
          },
        });

        // Em sequência, pelo mesmo motivo da rota de envio: os dois
        // braços saem pelo mesmo número da Meta.
        after(async () => {
          await deliverBroadcast(admin, ab.variantA, {
            batchSize: SEND_BATCH_SIZE,
            delayMs: SEND_BATCH_DELAY_MS,
          });
          await deliverBroadcast(admin, ab.variantB, {
            batchSize: SEND_BATCH_SIZE,
            delayMs: SEND_BATCH_DELAY_MS,
          });
        });

        continue;
      }

      const plan = await planDashboardBroadcast(admin, {
        accountId: row.account_id,
        // Dono das linhas de contato que uma importação criar: quem
        // agendou, não quem (ninguém) apertou o botão agora.
        userId: row.user_id,
        batchLimit,
        // Adota a linha que acabamos de travar — sem isto o planner
        // criaria um broadcast NOVO e o agendamento ficaria pendurado em
        // `sending` para sempre, ao lado de uma cópia enviada.
        adoptBroadcastId: row.id,
        input: {
          name: row.name,
          templateName: row.template_name,
          templateLanguage: row.template_language,
          audience,
          variables,
          headerMediaUrl: row.header_media_url ?? undefined,
          channelId: row.channel_id,
          channelSource: row.channel_source,
        },
        canCreateTags,
      });

      dispatched++;
      await logBroadcastAudit(admin, {
        accountId: row.account_id,
        event: 'dispatched',
        broadcastId: plan.broadcastId,
        broadcastName: row.name,
        // NULL = sistema. O agendamento tem dono (`row.user_id`), mas o
        // disparo em si não foi ação de ninguém — e a trilha não deve
        // atribuir a um humano um clique que ele não deu.
        actorUserId: null,
        templateName: row.template_name,
        totalRecipients: plan.totalRecipients,
        excludedOptedOut: plan.excludedOptedOut,
        scheduledAt: row.scheduled_at,
        details: {
          audience_type: audience.type,
          accepted: plan.planned.length,
          rejected: plan.rejected,
          scheduled_by: row.user_id,
          time_zone: timeZone,
          window_override: row.window_override,
          excluded_invalid_whatsapp: plan.excludedInvalidWhatsapp,
        },
      });

      // Fan-out fora do caminho da resposta, como na rota de envio.
      after(() =>
        deliverBroadcast(admin, plan, {
          batchSize: SEND_BATCH_SIZE,
          delayMs: SEND_BATCH_DELAY_MS,
        })
      );
    } catch (err) {
      const code = err instanceof BroadcastError ? err.code : 'internal';

      // Cota é condição TEMPORÁRIA: a janela de 24 h desliza. Volta para
      // `scheduled` mais tarde em vez de jogar a campanha fora.
      if (code === 'quota_exceeded') {
        const retryAt = new Date(now.getTime() + QUOTA_RETRY_MS);
        // O par inteiro volta: a cota foi conferida sobre a soma dos dois
        // braços, então nenhum dos dois cabia.
        await updatePair({
          status: 'scheduled',
          scheduled_at: retryAt.toISOString(),
        });
        postponed++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'blocked_quota',
          broadcastId: row.id,
          broadcastName: row.name,
          templateName: row.template_name,
          scheduledAt: retryAt.toISOString(),
          details: {
            was_due_at: row.scheduled_at,
            message: err instanceof Error ? err.message : String(err),
          },
        });
        continue;
      }

      failed++;
      console.error('[broadcasts-cron] dispatch failed:', row.id, err);
      await updatePair({ status: 'failed' });
      await logBroadcastAudit(admin, {
        accountId: row.account_id,
        event: 'failed',
        broadcastId: row.id,
        broadcastName: row.name,
        templateName: row.template_name,
        details: {
          code,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // ── Segunda passada: o disparo parcial do R6 (SPEC 069 §7.3) ──
  const partial = await sweepAwaitingCheck(admin, now, blockedAccounts);

  return NextResponse.json({
    dispatched,
    postponed,
    failed,
    skippedBlocked,
    partialSend: partial,
  });
}

// ============================================================
// R6 — disparo parcial (SPEC 069 §7.3, F8)
// ============================================================

/**
 * Quantas campanhas em `awaiting_check` uma invocação assume.
 *
 * Mais alto que `MAX_PER_RUN` porque uma retomada é barata perto de um
 * disparo agendado: o lote de cada ciclo é o que a cota de CHECAGEM
 * liberou desde o ciclo anterior (dezenas, não milhares).
 */
const MAX_AWAITING_CHECK_PER_RUN = 20;

/**
 * Teto de itens já checados que uma retomada olha por ciclo. O lote
 * real costuma ser bem menor (o que a cota de checagem liberou em 5
 * min); este número existe para o caso de a janela de envio ter ficado
 * fechada a noite inteira e o acúmulo ser grande.
 */
const MAX_READY_PER_RUN = 5000;

interface AwaitingCheckRow {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  template_name: string;
  template_language: string;
  template_variables: unknown;
  header_media_url: string | null;
  channel_id: string | null;
  channel_source: 'resource' | 'default' | null;
  scheduled_timezone: string | null;
  window_override: boolean | null;
  check_resumed_at: string | null;
}

/**
 * Varre as campanhas paradas em `awaiting_check` e aplica a máquina de
 * estados do §7.3 a cada uma.
 *
 * Por que a varredura mora AQUI e não no cron de checagem
 *
 *   O cron de checagem só age sobre campanhas cuja fila ele acabou de
 *   processar. Uma campanha cuja fila esvaziou — porque a última fatia
 *   ficou fora da janela de envio, ou porque a instância sumiu — não
 *   teria mais nenhum item para disparar o gatilho, e ficaria parada
 *   para sempre sem ninguém para reavaliá-la. Este cron varre por
 *   ESTADO (`status = 'awaiting_check'`), não por evento, então toda
 *   campanha é reavaliada a cada ciclo independentemente do que a
 *   checagem fez.
 *
 * A variante B de um teste A/B nunca é varrida (D-11, corolário) — o
 * filtro `parent_broadcast_id IS NULL` é o mesmo raciocínio do §6.6 da
 * SPEC 044. Hoje a rota de enfileiramento recusa A/B na entrada, então
 * este filtro é a segunda tranca, não a primeira.
 */
async function sweepAwaitingCheck(
  admin: ReturnType<typeof supabaseAdmin>,
  now: Date,
  blockedAccounts: Set<string>
): Promise<{
  resumed: number;
  completed: number;
  postponed: number;
  failed: number;
  waiting: number;
}> {
  const result = {
    resumed: 0,
    completed: 0,
    postponed: 0,
    failed: 0,
    waiting: 0,
  };

  const { data: rows, error } = await admin
    .from('broadcasts')
    .select(
      'id, account_id, user_id, name, template_name, template_language, template_variables, header_media_url, channel_id, channel_source, scheduled_timezone, window_override, check_resumed_at'
    )
    .eq('status', 'awaiting_check')
    .is('parent_broadcast_id', null)
    // Quem esperou mais tempo sai primeiro; `null` (nunca retomada)
    // antes de todos.
    .order('check_resumed_at', { ascending: true, nullsFirst: true })
    .limit(MAX_AWAITING_CHECK_PER_RUN);

  if (error) {
    console.error(
      '[broadcasts-cron] awaiting_check scan failed:',
      error.message
    );
    return result;
  }

  for (const raw of rows ?? []) {
    const row = raw as unknown as AwaitingCheckRow;
    if (blockedAccounts.has(row.account_id)) continue;

    try {
      const state = await loadPartialSendState(admin, row, now);
      const decision = decidePartialSend(state.counters);

      // Contadores primeiro: mesmo quando a decisão é esperar, a tela
      // precisa mostrar o progresso da checagem avançando.
      await admin
        .from('broadcasts')
        .update({ checked_count: state.resolvedChecks })
        .eq('id', row.id);

      if (decision.action === 'wait') {
        result.waiting++;
        continue;
      }

      if (decision.action === 'complete') {
        await admin
          .from('broadcasts')
          .update({ status: 'sent' })
          .eq('id', row.id)
          .eq('status', 'awaiting_check');
        result.completed++;
        continue;
      }

      if (decision.action === 'fail') {
        await admin
          .from('broadcasts')
          .update({ status: 'failed' })
          .eq('id', row.id)
          .eq('status', 'awaiting_check');
        result.failed++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'failed',
          broadcastId: row.id,
          broadcastName: row.name,
          templateName: row.template_name,
          details: {
            reason: decision.reason,
            unresolved_checks: state.counters.unresolvedChecks,
            partial_send: true,
          },
        });
        continue;
      }

      if (decision.action === 'postpone') {
        result.postponed++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'blocked_window',
          broadcastId: row.id,
          broadcastName: row.name,
          templateName: row.template_name,
          details: {
            reason: decision.reason,
            ready_to_dispatch: state.counters.readyToDispatch,
            time_zone: state.timeZone,
            window: describeSendWindow(),
            partial_send: true,
          },
        });
        continue;
      }

      // ── Claim: o mesmo lock do disparo agendado (decisão 3 do
      // cabeçalho), aplicado aqui à fatia parcial. Sem ele, duas
      // invocações do cron sobrepostas calculam o MESMO lote pronto
      // (nenhuma inseriu `broadcast_recipients` ainda) e as duas
      // despacham — a mesma pessoa recebe o template duas vezes.
      const { data: claimed } = await admin
        .from('broadcasts')
        .update({ status: 'sending' })
        .eq('id', row.id)
        .eq('status', 'awaiting_check')
        .select('id')
        .maybeSingle();
      if (!claimed) continue;

      try {
        await dispatchPartialSlice(admin, row, state, decision.nextStatus, now);
        result.resumed++;
      } catch (dispatchErr) {
        // O claim não pode deixar a campanha travada em `sending` se o
        // disparo falhar no meio — devolve a `awaiting_check` para os
        // blocos de tratamento abaixo (que esperam esse status) agirem.
        await admin
          .from('broadcasts')
          .update({ status: 'awaiting_check' })
          .eq('id', row.id)
          .eq('status', 'sending');
        throw dispatchErr;
      }
    } catch (err) {
      // Cota da janela de 24 h é condição TEMPORÁRIA: a campanha fica
      // em `awaiting_check` e tenta de novo no próximo ciclo, sem
      // avançar `check_resumed_at` — nada do que já estava pronto se
      // perde.
      const code = err instanceof BroadcastError ? err.code : 'internal';
      if (code === 'quota_exceeded') {
        result.waiting++;
        await logBroadcastAudit(admin, {
          accountId: row.account_id,
          event: 'blocked_quota',
          broadcastId: row.id,
          broadcastName: row.name,
          templateName: row.template_name,
          details: {
            message: err instanceof Error ? err.message : String(err),
            partial_send: true,
          },
        });
        continue;
      }

      console.error('[broadcasts-cron] partial send failed:', row.id, err);
      result.failed++;
      await admin
        .from('broadcasts')
        .update({ status: 'failed' })
        .eq('id', row.id)
        .eq('status', 'awaiting_check');
      await logBroadcastAudit(admin, {
        accountId: row.account_id,
        event: 'failed',
        broadcastId: row.id,
        broadcastName: row.name,
        templateName: row.template_name,
        details: {
          code,
          message: err instanceof Error ? err.message : String(err),
          partial_send: true,
        },
      });
    }
  }

  return result;
}

interface PartialSendSnapshot {
  counters: PartialSendState;
  /** Contatos que saem AGORA — já cortados pela cota de 24 h. */
  readyContactIds: string[];
  resolvedChecks: number;
  timeZone: string;
  batchLimit: number;
}

/** Itens que saíram da fila SEM veredito (§14). */
const UNRESOLVED_STATUSES = ['failed', 'expired', 'skipped'] as const;

/**
 * Monta o estado que `decidePartialSend` consome. Tudo por contagem no
 * banco — nada é derivado de um campo que alguém precise lembrar de
 * atualizar (§15.2 item 3: `checked_count` conta itens resolvidos, não
 * subtrai do total).
 */
async function loadPartialSendState(
  admin: ReturnType<typeof supabaseAdmin>,
  row: AwaitingCheckRow,
  now: Date
): Promise<PartialSendSnapshot> {
  const timeZone = resolveTimeZone(row.scheduled_timezone ?? DEFAULT_TIME_ZONE);

  const [pendingRes, unresolvedRes, doneRes, dispatchedRes] = await Promise.all(
    [
      admin
        .from('contact_check_queue')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', row.id)
        .in('status', ['pending', 'in_progress']),
      admin
        .from('contact_check_queue')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', row.id)
        .in('status', UNRESOLVED_STATUSES),
      admin
        .from('contact_check_queue')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', row.id)
        .eq('status', 'done'),
      admin
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', row.id),
    ]
  );

  const pendingChecks = pendingRes.count ?? 0;
  const unresolvedChecks = unresolvedRes.count ?? 0;
  const doneChecks = doneRes.count ?? 0;
  const everDispatched = dispatchedRes.count ?? 0;

  const quota = await loadAccountQuota(admin, row.account_id, {
    channelId: row.channel_id,
  });
  const batchLimit = quota.configured
    ? quota.snapshot.batchLimit
    : Number.POSITIVE_INFINITY;

  const ready = await loadReadyContactIds(admin, row, batchLimit);

  return {
    counters: {
      pendingChecks,
      readyToDispatch: ready.ids.length,
      readyRemaining: ready.remaining,
      unresolvedChecks,
      everDispatched,
      withinSendWindow: isWithinSendWindow(now, timeZone),
      windowOverride: row.window_override === true,
    },
    readyContactIds: ready.ids,
    resolvedChecks: doneChecks + unresolvedChecks,
    timeZone,
    batchLimit,
  };
}

/**
 * Quem sai neste ciclo: checado, com número válido, e ainda SEM linha
 * de destinatário nesta campanha.
 *
 * Duas travas, e as duas são necessárias
 *
 *   `checked_at >= check_resumed_at` é o que impede a consulta de
 *   varrer os 100 mil itens já despachados de uma campanha grande a
 *   cada 5 minutos. A marca d'água só avança quando a fatia despachou
 *   TODO o lote pronto (`readyRemaining === 0`, ver `dispatchPartialSlice`)
 *   — se sobrou gente por causa da cota, ela fica parada, senão o
 *   próprio filtro tornaria os que ficaram para trás invisíveis para
 *   sempre (bug real corrigido em code review: o avanço incondicional
 *   escondia contatos já validados e nunca disparados).
 *
 *   A subtração pela existência de `broadcast_recipients` é a trava de
 *   correção: é ELA que garante que ninguém receba duas vezes. O claim
 *   em `sweepAwaitingCheck` (mesmo lock do disparo agendado, decisão 3
 *   do cabeçalho) impede que duas invocações sobrepostas cheguem a
 *   despachar a mesma fatia ao mesmo tempo; esta linha é o cinto e a
 *   suspensório, não a única defesa.
 *
 * Contato com `whatsapp_status = 'invalid'` é filtrado AQUI, e não
 * deixado para o pipeline de disparo, por um motivo específico do R6:
 * ele nunca vai virar destinatário, então continuaria "pronto" para
 * sempre e a campanha jamais chegaria a `complete`.
 */
async function loadReadyContactIds(
  admin: ReturnType<typeof supabaseAdmin>,
  row: AwaitingCheckRow,
  batchLimit: number
): Promise<{ ids: string[]; remaining: number }> {
  let query = admin
    .from('contact_check_queue')
    .select('contact_id, checked_at')
    .eq('broadcast_id', row.id)
    .eq('status', 'done')
    .order('checked_at', { ascending: true })
    .limit(MAX_READY_PER_RUN);

  if (row.check_resumed_at) {
    query = query.gte('checked_at', row.check_resumed_at);
  }

  const { data: doneRows, error } = await query;
  if (error || !doneRows || doneRows.length === 0) {
    return { ids: [], remaining: 0 };
  }

  const candidateIds = [
    ...new Set(doneRows.map((r) => r.contact_id as string)),
  ];

  const { data: alreadySent } = await admin
    .from('broadcast_recipients')
    .select('contact_id')
    .eq('broadcast_id', row.id)
    .in('contact_id', candidateIds);
  const sentIds = new Set(
    (alreadySent ?? []).map((r) => r.contact_id as string)
  );

  const notYetSent = candidateIds.filter((id) => !sentIds.has(id));
  if (notYetSent.length === 0) return { ids: [], remaining: 0 };

  const { data: validContacts } = await admin
    .from('contacts')
    .select('id')
    .eq('account_id', row.account_id)
    .eq('whatsapp_status', 'valid')
    .in('id', notYetSent);

  const ready = (validContacts ?? []).map((c) => c.id as string);

  // Corta pela cota de 24 h em vez de deixar `assertFitsQuota` lançar:
  // um lote maior que a cota lançaria o MESMO erro a cada ciclo, para
  // sempre. Cortado, o que cabe sai agora e o resto sai depois — e o
  // RESTO precisa ser reportado, senão a campanha seria encerrada como
  // `sent` com esses contatos nunca enviados.
  const ids = Number.isFinite(batchLimit) ? ready.slice(0, batchLimit) : ready;
  return { ids, remaining: ready.length - ids.length };
}

/**
 * Dispara UMA fatia e devolve a campanha ao estado que a máquina
 * decidiu.
 *
 * A audiência é `contact_ids` — a lista exata deste ciclo — e o
 * planejamento roda em modo `partialAppend`, que NÃO reescreve
 * `audience_filter`, `total_recipients` nem `status` (ver
 * `PlanDashboardBroadcastParams.partialAppend`). O `deliverBroadcast`
 * roda com `finalizeStatus: false` pelo mesmo motivo: quem encerra a
 * campanha é a máquina de estados, não o fim do fan-out de uma fatia.
 */
async function dispatchPartialSlice(
  admin: ReturnType<typeof supabaseAdmin>,
  row: AwaitingCheckRow,
  state: PartialSendSnapshot,
  nextStatus: 'awaiting_check' | 'sent',
  now: Date
): Promise<void> {
  const variables = parseVariableMap(row.template_variables);
  if (!variables) {
    throw new BroadcastError(
      'bad_request',
      'Broadcast has malformed template variables.',
      400
    );
  }

  const { data: schedulerProfile } = await admin
    .from('profiles')
    .select('account_role')
    .eq('user_id', row.user_id)
    .eq('account_id', row.account_id)
    .maybeSingle();
  const canCreateTags = schedulerProfile
    ? canEditSettings(schedulerProfile.account_role as AccountRole)
    : false;

  const plan = await planDashboardBroadcast(admin, {
    accountId: row.account_id,
    userId: row.user_id,
    batchLimit: state.batchLimit,
    adoptBroadcastId: row.id,
    partialAppend: true,
    canCreateTags,
    input: {
      name: row.name,
      templateName: row.template_name,
      templateLanguage: row.template_language,
      audience: { type: 'contact_ids', contactIds: state.readyContactIds },
      variables,
      headerMediaUrl: row.header_media_url ?? undefined,
      channelId: row.channel_id,
      channelSource: row.channel_source,
    },
  });

  // `total_recipients` acumula ao longo das fatias — quem soma é aqui,
  // contando as linhas que existem, não somando o que esta fatia
  // acrescentou (uma soma perderia o fio se um ciclo falhasse no meio).
  const { count: recipientCount } = await admin
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', row.id);

  // A marca d'água só avança quando o lote pronto coube INTEIRO nesta
  // fatia (`readyRemaining === 0`). Se a cota cortou o lote, os
  // contatos que ficaram de fora têm `checked_at` ANTERIOR a `now` — um
  // avanço incondicional os tornaria invisíveis para sempre em
  // `loadReadyContactIds` (filtro `checked_at >= check_resumed_at`),
  // mesmo estando prontos e nunca disparados. Sem sobra, avançar é só
  // otimização (evita revarrer uma campanha grande a cada ciclo).
  const nextCheckResumedAt =
    state.counters.readyRemaining > 0
      ? row.check_resumed_at
      : now.toISOString();

  await admin
    .from('broadcasts')
    .update({
      status: nextStatus,
      total_recipients: recipientCount ?? 0,
      check_resumed_at: nextCheckResumedAt,
    })
    .eq('id', row.id);

  await logBroadcastAudit(admin, {
    accountId: row.account_id,
    event: 'dispatched',
    broadcastId: row.id,
    broadcastName: row.name,
    actorUserId: null,
    templateName: row.template_name,
    totalRecipients: recipientCount ?? plan.totalRecipients,
    excludedOptedOut: plan.excludedOptedOut,
    details: {
      partial_send: true,
      slice_size: plan.planned.length,
      rejected: plan.rejected,
      excluded_invalid_whatsapp: plan.excludedInvalidWhatsapp,
      pending_checks: state.counters.pendingChecks,
      next_status: nextStatus,
      time_zone: state.timeZone,
    },
  });

  after(() =>
    deliverBroadcast(admin, plan, {
      batchSize: SEND_BATCH_SIZE,
      delayMs: SEND_BATCH_DELAY_MS,
      // A fatia não encerra a campanha — ver `DeliverOptions`.
      finalizeStatus: false,
    })
  );
}
