/**
 * Cliente das rotas internas do monitor de cobrança (SPEC 076 §9), para a
 * UI. Só `fetch` + tradução de status HTTP em um resultado tipado — nenhuma
 * regra de negócio (essa mora em `billing-server.ts`).
 *
 * Importa SÓ tipos de `billing-dto.ts`: o módulo de servidor não entra no
 * pacote do navegador.
 */

import type { ChannelBillingDto } from './billing-dto';
import type { BillingSummaryDto } from './billing-server';

export type BillingFetchResult<T> =
  | { status: 'ok'; data: T }
  /** Flag desligado (404): a UI esconde o recurso sem erro (§11.5). */
  | { status: 'disabled' }
  /** 429 de `refresh`: `retryAfterSeconds` vem do corpo. */
  | { status: 'throttled'; retryAfterSeconds: number }
  | { status: 'error' };

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Painel de UM número. `refresh` só vale para admin+ (senão 403 → `error`). */
export async function fetchChannelBilling(
  channelId: string,
  options: { refresh?: boolean } = {}
): Promise<BillingFetchResult<ChannelBillingDto>> {
  const qs = new URLSearchParams({ channel_id: channelId });
  if (options.refresh) qs.set('refresh', '1');
  try {
    const res = await fetch(`/api/whatsapp/billing?${qs.toString()}`, {
      cache: 'no-store',
    });
    if (res.status === 404) {
      // 404 também é "canal não encontrado": o corpo distingue do flag.
      const body = (await readJson(res)) as { error?: string } | null;
      return body?.error === 'Not found'
        ? { status: 'disabled' }
        : { status: 'error' };
    }
    if (res.status === 429) {
      const body = (await readJson(res)) as {
        retry_after_seconds?: unknown;
      } | null;
      const secs = Number(body?.retry_after_seconds);
      return {
        status: 'throttled',
        retryAfterSeconds: Number.isFinite(secs) && secs > 0 ? secs : 60,
      };
    }
    if (!res.ok) return { status: 'error' };
    const data = (await readJson(res)) as ChannelBillingDto | null;
    return data ? { status: 'ok', data } : { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

/** Resumo de todos os números (só do banco). */
export async function fetchBillingSummary(): Promise<
  BillingFetchResult<BillingSummaryDto>
> {
  try {
    const res = await fetch('/api/whatsapp/billing', { cache: 'no-store' });
    if (res.status === 404) return { status: 'disabled' };
    if (!res.ok) return { status: 'error' };
    const data = (await readJson(res)) as BillingSummaryDto | null;
    return data && Array.isArray(data.channels)
      ? { status: 'ok', data }
      : { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

function laterThan(
  next: string | null | undefined,
  prev: string | null | undefined
) {
  if (!next) return false;
  const n = Date.parse(next);
  if (Number.isNaN(n)) return false;
  if (!prev) return true;
  const p = Date.parse(prev);
  return Number.isNaN(p) || n > p;
}

/**
 * O "Atualizar" trouxe leitura NOVA da Meta? A rota responde 200 também
 * quando nada foi lido — recuo vigente (`next_retry_at`, que vence até o
 * `refresh=1`) ou a Meta falhou e voltou o retrato anterior com `stale`.
 *
 * "Status atualizado" fala do STATUS DE ENVIO: o carimbo dele andou → sim.
 * Se só o consumo andou (os recuos dos dois campos são independentes), só
 * vale quando o painel não segue com erro/`stale` do status de envio —
 * senão o toast contradiria o aviso "não foi possível atualizar agora".
 */
export function refreshAdvanced(
  prev: ChannelBillingDto | null,
  next: ChannelBillingDto
): boolean {
  if (laterThan(next.send_status.checked_at, prev?.send_status.checked_at)) {
    return true;
  }
  return (
    laterThan(next.spend?.checked_at, prev?.spend?.checked_at) &&
    !next.stale &&
    next.error?.field !== 'health'
  );
}

export interface PaymentAckResult {
  cleared: boolean;
  cleared_at?: string;
}

/** "Já regularizei" (admin+). */
export async function postPaymentAck(
  channelId: string
): Promise<BillingFetchResult<PaymentAckResult>> {
  try {
    const res = await fetch('/api/whatsapp/billing/payment-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId }),
    });
    if (res.status === 404) {
      const body = (await readJson(res)) as { error?: string } | null;
      return body?.error === 'Not found'
        ? { status: 'disabled' }
        : { status: 'error' };
    }
    if (!res.ok) return { status: 'error' };
    const data = (await readJson(res)) as PaymentAckResult | null;
    return data && typeof data.cleared === 'boolean'
      ? { status: 'ok', data }
      : { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}
