/**
 * Entrega por webhook da outbox de eventos de sistema (SPEC 063 §4.3).
 *
 * Substitui `src/lib/plans/request-webhook.ts`, preservando EXATAMENTE
 * as três garantias que ele já tinha: guarda de SSRF
 * (`isDeliverableUrl`), `redirect: 'manual'` e
 * `AbortSignal.timeout(DELIVERY_TIMEOUT_MS)`. A URL vir do `.env` nunca
 * foi motivo para pular a checagem, e continua não sendo.
 *
 * `SYSTEM_EVENT_WEBHOOK_URL` é o alias novo; `PLAN_REQUEST_WEBHOOK_URL`
 * continua valendo (compat) — se as duas existirem, a nova vence. O
 * corpo entregue é o payload gravado na outbox tal e qual (§4.3, §3.2):
 * para `plan.requested` isso inclui os campos legados no nível raiz
 * (`event`, `accountId`, `planCode`, …) que o workflow n8n já filtra em
 * produção.
 *
 * Assinatura HMAC (`X-ZapCRM-Signature`) quando
 * `SYSTEM_EVENT_WEBHOOK_SECRET` está definida — opcional, para não
 * quebrar o workflow que já existe sem verificação.
 */

import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { DELIVERY_TIMEOUT_MS } from '@/lib/webhooks/deliver';
import type { SystemEventPayload } from './types';

export interface WebhookOutcome {
  ok: boolean;
  /** `true` = sem URL configurada — não é falha, é canal desligado. */
  skipped: boolean;
  error?: string;
}

function resolveWebhookUrl(): string | null {
  const url =
    process.env.SYSTEM_EVENT_WEBHOOK_URL?.trim() ||
    process.env.PLAN_REQUEST_WEBHOOK_URL?.trim();
  return url || null;
}

export async function deliverSystemWebhook(
  payload: SystemEventPayload
): Promise<WebhookOutcome> {
  const url = resolveWebhookUrl();
  if (!url) {
    return { ok: true, skipped: true };
  }

  if (!(await isDeliverableUrl(url))) {
    console.warn(
      '[notifications/webhook] refusing non-public SYSTEM_EVENT_WEBHOOK_URL target'
    );
    return { ok: false, skipped: false, error: 'non-public target refused' };
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const secret = process.env.SYSTEM_EVENT_WEBHOOK_SECRET?.trim();
  if (secret) {
    headers['X-ZapCRM-Signature'] = buildSignatureHeader(
      body,
      secret,
      Math.floor(Date.now() / 1000)
    );
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        skipped: false,
        error: `endpoint responded ${res.status}`,
      };
    }
    return { ok: true, skipped: false };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
