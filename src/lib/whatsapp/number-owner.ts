/**
 * Conta dona de um número oficial, para o espelho de `statuses` do webhook
 * da Meta (achado B-1 da revisão de segurança da SPEC 088).
 *
 * Um `change` só fala pela conta do PRÓPRIO número: sem isto o espelho
 * localizava a mensagem só pelo `wamid`, e o admin de A, assinando com o
 * próprio segredo um `change` do próprio número, mudava o status de uma
 * mensagem de B. A resposta vem SEMPRE da `whatsapp_config` (UNIQUE em
 * `phone_number_id`, migração 013), nunca do corpo do webhook.
 *
 * Caminho quente: chega um status por mensagem enviada, e a Meta costuma
 * mandar um por POST, então o dono fica num cache de PROCESSO. Só o
 * resultado positivo é guardado: falha de leitura e número desconhecido
 * são relidos no próximo `change` (número recém-cadastrado não espera o
 * cache, e número inventado não ocupa memória).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { errMsg } from './billing-schema';
import { maskId } from './billing-monitor';

export interface NumberOwner {
  accountId: string;
  /** `waba_id` é opcional na config; o sinal de pagamento precisa dele. */
  wabaId: string | null;
}

/** `no_config`/`multiple_configs`/`disabled`: definitivo. `error`: transitório. */
export type NumberOwnerMiss =
  'no_config' | 'multiple_configs' | 'disabled' | 'error';

export type NumberOwnerResult =
  | { owner: NumberOwner; reason: null }
  | { owner: null; reason: NumberOwnerMiss };

/** Mesma validade da sessão do sinal de pagamento (`billing-signal.ts`). */
const OWNER_TTL_MS = 15 * 1000;

const ownerCache = new Map<string, { owner: NumberOwner; expiresAt: number }>();

/** Só para teste: zera o estado de processo deste módulo. */
export function __resetNumberOwnerCacheForTests(): void {
  ownerCache.clear();
}

interface ConfigRow {
  account_id: string;
  waba_id: string | null;
  channels: { status: string } | { status: string }[] | null;
}

async function readConfigRows(
  db: SupabaseClient,
  phoneNumberId: string
): Promise<ConfigRow[]> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('account_id, waba_id, channels(status)')
    .eq('phone_number_id', phoneNumberId);
  if (error) throw error;
  return (data ?? []) as unknown as ConfigRow[];
}

/**
 * Nunca lança. `owner = null` quando o número não existe, está duplicado,
 * pertence a um canal desativado (SPEC 064 D-12, mesma regra do ingest e
 * do repetidor) ou a leitura falhou duas vezes: o chamador ignora o
 * evento.
 */
export async function resolveNumberOwner(
  db: SupabaseClient,
  phoneNumberId: unknown
): Promise<NumberOwnerResult> {
  if (typeof phoneNumberId !== 'string' || phoneNumberId === '') {
    return { owner: null, reason: 'no_config' };
  }

  const hit = ownerCache.get(phoneNumberId);
  if (hit && hit.expiresAt > Date.now()) {
    return { owner: hit.owner, reason: null };
  }

  try {
    // Uma nova tentativa (L-2): uma falha transitória descartaria TODOS os
    // statuses do `change`, inclusive um 131042, e a Meta não reenvia.
    const rows = await readConfigRows(db, phoneNumberId).catch(() =>
      readConfigRows(db, phoneNumberId)
    );
    if (rows.length !== 1) {
      ownerCache.delete(phoneNumberId);
      return {
        owner: null,
        reason: rows.length === 0 ? 'no_config' : 'multiple_configs',
      };
    }

    const row = rows[0]!;
    const channel = Array.isArray(row.channels)
      ? row.channels[0]
      : row.channels;
    if (channel?.status === 'disabled') {
      ownerCache.delete(phoneNumberId);
      return { owner: null, reason: 'disabled' };
    }

    const owner = { accountId: row.account_id, wabaId: row.waba_id ?? null };
    ownerCache.set(phoneNumberId, {
      owner,
      expiresAt: Date.now() + OWNER_TTL_MS,
    });
    return { owner, reason: null };
  } catch (err) {
    console.error(
      `[number-owner] config lookup failed pnid=${maskId(phoneNumberId)}:`,
      errMsg(err)
    );
    return { owner: null, reason: 'error' };
  }
}
