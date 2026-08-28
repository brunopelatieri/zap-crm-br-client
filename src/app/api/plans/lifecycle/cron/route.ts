import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runPlanLifecycle } from '@/lib/plans/lifecycle';

/**
 * GET /api/plans/lifecycle/cron — porta explícita opcional para o
 * vencimento de plano (SPEC 062 §8, F9). A porta padrão é a fase 5 de
 * `/api/automations/cron`; esta rota existe para quem quer horário
 * próprio (ex.: `cron.schedule('zapcrm-plan-lifecycle', '0 4 * * *', …)`
 * em `supabase/setup/cron-jobs.sql`) ou como gatilho manual de teste
 * (F10).
 *
 * Diferente da retenção (SPEC 060), o vencimento não tem intervalo
 * configurável nem interruptor de `.env` — uma conta só entra em
 * escopo quando `current_period_end` está preenchido, então rodar esta
 * rota junto da fase 5 não duplica trabalho: os dois ramos que MUDAM
 * estado são idempotentes por construção (ver `lifecycle.ts`), e os
 * dois que só avisam usam `platform_audit_log` como dedupe.
 *
 * Auth: mesmo `x-cron-secret` das outras rotas de cron
 * (`AUTOMATION_CRON_SECRET`).
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Constant-time compare, mesmo padrão de `broadcasts/cron` e
  // `flows/cron` — achado de code review: esta rota tinha ficado com a
  // comparação direta, que vaza o segredo byte a byte por delta de
  // tempo de resposta.
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runPlanLifecycle(new Date());
  return NextResponse.json({ result });
}
