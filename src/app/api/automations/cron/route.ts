import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resumePendingExecution } from '@/lib/automations/engine';
import type { AutomationContext } from '@/lib/automations/engine';
import { scanSessionWindows } from '@/lib/automations/window-scan';
import { scanSchedules } from '@/lib/automations/schedule-scan';
import { runMessageRetention } from '@/lib/retention/sweep';
import { runPlanLifecycle } from '@/lib/plans/lifecycle';
import { deliverPending } from '@/lib/notifications/dispatch';

/**
 * Cinco fases, um único agendamento:
 *
 *   1. **Drenar** as `automation_pending_executions` vencidas (o step
 *      `wait`). Comportamento original desta rota.
 *   2. **Varrer** as janelas de 24h prestes a fechar (SPEC 045 §5.5).
 *   3. **Varrer** os agendamentos do gatilho `time_based` (SPEC 046 §6).
 *   4. **Varrer** a retenção de mensagens, respeitando o intervalo
 *      configurado (SPEC 060 §6, porta 1 — a padrão).
 *   5. **Varrer** o vencimento de plano — avisos, `past_due`, carência
 *      encerrada e a efetivação de cancelamentos agendados
 *      (SPEC 062 §8, F9).
 *   6. **Reentregar** a outbox de notificações do sistema — a porta 2
 *      da SPEC 063 §5, rede de segurança para tudo que a porta 1
 *      (`after()` na rota que emitiu o evento) perdeu.
 *
 * Por que a varredura mora AQUI e não numa rota nova (§5.5.1, e o mesmo
 * argumento vale para a fase 3 — SPEC 046 §6.1 —, para a fase 4 —
 * SPEC 060 §6 —, para a fase 5 — SPEC 062 §8 — e para a fase 6 —
 * SPEC 063 §5)
 *
 *   O agendamento não é código: vive em `supabase/setup/cron-jobs.sql`,
 *   que não é uma migração — é configuração de ambiente, carrega a URL e
 *   o segredo do deploy, e instrui o operador a preencher, rodar e
 *   descartar sem commitar. Uma rota nova significaria um quarto
 *   `cron.schedule` e, portanto, uma ação MANUAL de todo operador já em
 *   produção (incluindo forks). Quem não fizesse essa ação teria a
 *   feature aparecendo na UI, salvando automação, ativando — e nunca
 *   disparando, sem nenhum erro em lugar nenhum. É o pior modo de falha
 *   possível para uma feature de automação. Pendurando na rota que já é
 *   pingada a cada 5 min, quem já configurou o cron ganha a feature no
 *   deploy.
 *
 * Auth: segredo compartilhado via header `x-cron-secret`, conferido
 * contra `AUTOMATION_CRON_SECRET`.
 *
 * O claim (status = 'running') serve de lock simples para que
 * invocações sobrepostas não processem a mesma linha duas vezes.
 * Best-effort: um `SELECT ... FOR UPDATE` caro é evitado em favor de um
 * UPDATE-por-id em dois passos. As varreduras das fases 2 e 3 têm cada
 * uma o seu próprio lock, pelo mesmo motivo e com o mesmo formato
 * (§5.5.2 e SPEC 046 §6.3, respectivamente — tabelas de claim distintas
 * porque a chave de idempotência é diferente: conversa×janela numa,
 * contato×ocorrência na outra).
 */

/**
 * Mesmo teto de `/api/broadcasts/cron`, e pela mesma razão: as fases 2
 * e 3 rodam em `after()` e podem encostar em dezenas de envios pela
 * Meta em série. Sem declarar isto, valeria o padrão da plataforma e o
 * corte aconteceria NO MEIO de um envio — deixando a dúvida mais cara
 * possível: a mensagem saiu para a Meta e o INSERT local não aconteceu?
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret');
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  // ── Fase 1: drenagem ──────────────────────────────────────────────
  //
  // Nada de `return` antecipado quando a fila está vazia: fila vazia é o
  // caso COMUM, e sair aqui pularia a varredura quase sempre — a feature
  // inteira nunca dispararia.
  let processed = 0;
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    });
    processed++;
  }

  // ── Fases 2 a 5: varreduras de janela, agendamento, retenção e ciclo de plano ──
  //
  // Depois da drenagem (a ordem que §5.5.1 pede) e FORA do caminho da
  // resposta. `after()` casa com o `timeout_milliseconds := 20000` do
  // job de pg_cron, que corta apenas a ESPERA pela resposta, não o
  // trabalho no servidor: o HTTP responde assim que a drenagem termina e
  // as varreduras seguem dentro do `maxDuration` acima.
  //
  // Sequenciais, não `Promise.all` — todas competem pelo mesmo teto
  // de `maxDuration`, e rodá-las em série mantém o corte previsível
  // (cada fase nunca começa sem saber quanto tempo a anterior já
  // consumiu). Nenhuma delas lança — aqui dentro não há quem leia uma
  // exceção.
  after(async () => {
    const windowResult = await scanSessionWindows();
    if (windowResult.dispatched > 0 || windowResult.failed > 0) {
      console.log(
        '[automations-cron] window scan:',
        JSON.stringify(windowResult)
      );
    }

    const scheduleResult = await scanSchedules();
    // `truncated` entra na condição de propósito: uma audiência acima
    // do teto do tick é justamente o caso que precisa aparecer no log,
    // mesmo quando o despacho em si correu sem falha.
    if (
      scheduleResult.dispatched > 0 ||
      scheduleResult.failed > 0 ||
      scheduleResult.truncated
    ) {
      console.log(
        '[automations-cron] schedule scan:',
        JSON.stringify(scheduleResult)
      );
    }

    // Porta 1 da retenção (SPEC 060 §6) — respeita
    // `MESSAGE_RETENTION_INTERVAL_HOURS` (`ignoreInterval` não passado)
    // e sai cedo, sem custo, enquanto `MESSAGE_RETENTION_ENABLED`
    // estiver ausente.
    const retentionOutcome = await runMessageRetention(new Date());
    if (retentionOutcome.ran) {
      console.log(
        '[automations-cron] retention sweep:',
        JSON.stringify(retentionOutcome.result)
      );
    }

    // Fase 5 (SPEC 062 §8) — sem interruptor de `.env`: ao contrário da
    // retenção, o vencimento de plano não tem um "nasce desligado" —
    // uma conta só entra no escopo quando tem `current_period_end`
    // preenchido, e nenhuma migração inventa isso para quem já é
    // cliente (069 §3.3). Contas sem vencimento continuam custando
    // zero nesta fase.
    const lifecycleResult = await runPlanLifecycle(new Date());
    if (
      lifecycleResult.expiringNotices > 0 ||
      lifecycleResult.expired > 0 ||
      lifecycleResult.canceledApplied > 0 ||
      lifecycleResult.graceEnded > 0 ||
      lifecycleResult.errors > 0
    ) {
      console.log(
        '[automations-cron] plan lifecycle:',
        JSON.stringify(lifecycleResult)
      );
    }

    // Fase 6 (SPEC 063 §5, porta 2) — reentrega o que a porta 1 perdeu
    // (processo reiniciado, SMTP fora do ar, evento emitido pelo
    // próprio cron na fase 5 acima). Roda por último de propósito: dá
    // à fase 5 a chance de já ter agendado sua própria porta 1 antes
    // desta varredura rodar.
    const notificationsResult = await deliverPending(new Date());
    if (notificationsResult.claimed > 0) {
      console.log(
        '[automations-cron] notifications dispatch:',
        JSON.stringify(notificationsResult)
      );
    }
  });

  return NextResponse.json({ processed, scan: 'scheduled' });
}
