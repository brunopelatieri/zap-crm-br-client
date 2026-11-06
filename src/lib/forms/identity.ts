// ============================================================
// Identidade do respondente (PRD 084 D-2, D-3; SPEC 085 §6 `identity.ts`).
//
// Duas portas, nunca nenhuma: token do link (vence) ou telefone. O
// contato é encontrado ou criado por `phone_normalized` na conta do
// formulário, com `created_via = 'form'` (conta na quota de contatos e
// NÃO tem a isenção do inbound, D-10). Colisão `23505` é corrida, não
// falha: relê e devolve o vencedor (mesmo molde de `findOrCreateContact`
// da API pública).
//
// `db` é o cliente de service-role da rota pública (o visitante não tem
// sessão). O `accountId` vem de `form_public_availability`, nunca do
// cliente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { normalizeContactPhone } from '@/lib/phone/br';
import { parseQuotaError } from '@/lib/plans/errors';

import { verifyFormLink } from './link-token';
import type { IdentityMode, ResponseSource } from './types';

export interface ResolveIdentityInput {
  formId: string;
  accountId: string;
  /** `?t=` do link; inválido/expirado degrada para o telefone (D-2). */
  token?: string | null;
  /** Resposta do bloco de identidade (qualquer formato; é normalizado aqui). */
  phone?: string | null;
  /** `user_id` de auditoria para o contato novo: o dono da conta (como na API v1). */
  auditUserId: string;
  /** Só para teste do telefone; em produção vem de `isBrDeployment()`. */
  brMode?: boolean;
  now?: Date;
}

export type ResolveIdentityResult =
  | {
      ok: true;
      contactId: string;
      created: boolean;
      mode: IdentityMode;
      /** Origem vinda do token (`link` quando por telefone). */
      source: ResponseSource;
      /** Telefone canônico (só dígitos), quando resolvido por telefone. */
      phone: string | null;
    }
  | {
      ok: false;
      reason:
        | 'missing_identity'
        | 'invalid_phone'
        | 'contacts_quota'
        | 'contact_not_found'
        | 'error';
    };

type Db = Pick<SupabaseClient, 'from'>;

/**
 * Resolve quem está respondendo. Ordem: token válido → contato do token
 * (precisa existir NA CONTA do formulário); senão telefone → encontra ou
 * cria. Token válido cujo contato sumiu (apagado) é tratado como
 * inválido e cai para o telefone, se houver.
 */
export async function resolveIdentity(
  db: Db,
  input: ResolveIdentityInput
): Promise<ResolveIdentityResult> {
  const claims = verifyFormLink(input.token, input.formId, input.now);
  // Token válido cujo contato sumiu cai para o telefone, mas a ORIGEM do
  // link (campanha, inbox…) continua valendo para a atribuição.
  const fallbackSource: ResponseSource = claims?.source ?? 'link';
  if (claims) {
    const { data, error } = await db
      .from('contacts')
      .select('id')
      .eq('id', claims.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle();
    if (error) return { ok: false, reason: 'error' };
    if (data?.id) {
      return {
        ok: true,
        contactId: data.id as string,
        created: false,
        mode: 'token',
        source: claims.source,
        phone: null,
      };
    }
    if (!input.phone) return { ok: false, reason: 'contact_not_found' };
  }

  if (!input.phone) return { ok: false, reason: 'missing_identity' };

  const normalized = normalizeContactPhone(
    input.phone,
    input.brMode !== undefined ? { brMode: input.brMode } : undefined
  );
  if (!normalized.ok) return { ok: false, reason: 'invalid_phone' };
  const phone = normalized.phone;

  const existing = await findByNormalizedPhone(db, input.accountId, phone);
  if (existing === 'error') return { ok: false, reason: 'error' };
  if (existing) {
    return {
      ok: true,
      contactId: existing,
      created: false,
      mode: 'phone',
      source: fallbackSource,
      phone,
    };
  }

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: input.accountId,
      user_id: input.auditUserId,
      phone,
      // `name` fica NULL de propósito: o mapeamento `contact.name` do
      // formulário "preenche se vazio" (D-4) — com o telefone no nome,
      // nunca preencheria.
      name: null,
      created_via: 'form',
    })
    .select('id')
    .single();

  if (!error && created?.id) {
    return {
      ok: true,
      contactId: created.id as string,
      created: true,
      mode: 'phone',
      source: fallbackSource,
      phone,
    };
  }

  if (isUniqueViolation(error)) {
    const raced = await findByNormalizedPhone(db, input.accountId, phone);
    if (raced && raced !== 'error') {
      return {
        ok: true,
        contactId: raced,
        created: false,
        mode: 'phone',
        source: fallbackSource,
        phone,
      };
    }
  }

  const quota = parseQuotaError(error);
  if (quota && quota.metric === 'contacts')
    return { ok: false, reason: 'contacts_quota' };

  console.error(
    '[forms/identity] contact insert failed:',
    (error as { code?: string } | null)?.code ?? 'unknown'
  );
  return { ok: false, reason: 'error' };
}

async function findByNormalizedPhone(
  db: Db,
  accountId: string,
  phone: string
): Promise<string | null | 'error'> {
  const { data, error } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone_normalized', phone)
    .maybeSingle();
  if (error) return 'error';
  return (data?.id as string | undefined) ?? null;
}
