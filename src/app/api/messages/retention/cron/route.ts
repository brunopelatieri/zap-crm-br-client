import { NextResponse } from 'next/server';
import { runMessageRetention } from '@/lib/retention/sweep';

/**
 * GET /api/messages/retention/cron — porta 2 da varredura de retenção
 * (SPEC 060 §6). A porta padrão é a fase 4 de `/api/automations/cron`;
 * esta rota é OPCIONAL, para quem quer a limpeza num horário próprio
 * (ex.: `cron.schedule('zapcrm-retention-cron', '0 3 * * *', …)` em
 * `supabase/setup/cron-jobs.sql`) ou como gatilho manual de teste (F8).
 *
 * Ignora o intervalo configurado (`MESSAGE_RETENTION_INTERVAL_HOURS`) —
 * quem agenda explicitamente já decidiu a cadência. Continua respeitando
 * o interruptor (`MESSAGE_RETENTION_ENABLED`) e o claim de
 * `message_retention_state`.
 *
 * Auth: mesmo `x-cron-secret` das outras três rotas de cron
 * (`AUTOMATION_CRON_SECRET`) — um segredo só para o operador guardar.
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

  const outcome = await runMessageRetention(new Date(), {
    ignoreInterval: true,
  });

  if (!outcome.ran) {
    return NextResponse.json({ skipped: outcome.skippedReason });
  }
  return NextResponse.json({ result: outcome.result });
}
