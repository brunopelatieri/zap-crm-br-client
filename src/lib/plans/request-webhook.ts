/**
 * Aviso opcional de solicitação de plano (SPEC 059 D-8/§6). O botão
 * "Escolher este plano" grava `plan_change_requests` — quem efetiva a
 * troca é sempre o operador, fora do sistema; este webhook só avisa
 * (ex.: um workflow n8n que posta no Slack/WhatsApp do mantenedor).
 *
 * Sem `PLAN_REQUEST_WEBHOOK_URL` no servidor, é um no-op silencioso —
 * o recurso é opcional, diferente das rotas de cron/admin que
 * respondem 503 quando o segredo falta (aqui não há segredo, só uma
 * URL de destino, e nada depende dela para a solicitação funcionar).
 *
 * Reaproveita a MESMA guarda de SSRF que `src/lib/webhooks/deliver.ts`
 * usa para webhooks de saída por conta — a URL vindo do `.env` não é
 * motivo para pular a checagem.
 */

import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { DELIVERY_TIMEOUT_MS } from '@/lib/webhooks/deliver';

export interface PlanRequestWebhookPayload {
  accountId: string;
  accountName: string;
  planCode: string;
  planName: string;
  message: string | null;
}

export async function deliverPlanRequestWebhook(
  payload: PlanRequestWebhookPayload
): Promise<void> {
  const url = process.env.PLAN_REQUEST_WEBHOOK_URL?.trim();
  if (!url) return;

  if (!(await isDeliverableUrl(url))) {
    console.warn(
      '[plans/request-webhook] refusing non-public PLAN_REQUEST_WEBHOOK_URL target'
    );
    return;
  }

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'plan_change_requested',
      ...payload,
      requestedAt: new Date().toISOString(),
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
}
