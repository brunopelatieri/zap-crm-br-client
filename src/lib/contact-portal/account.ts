// ============================================================
// Lado da conta da área do contato — wrappers das `portal_account_*`
// e afins (migração 093), e o convite (J1).
//
// Quem chama já fez a autorização do usuário da conta: as rotas
// `/api/contact-portal/**` passam por `requireRole` com o cliente de
// sessão e conferem pela RLS que o contato é visível para aquele
// usuário ANTES de chegar aqui. Estas funções só garantem, no banco,
// que o contato pertence à conta informada.
//
// Recebe o cliente service-role de quem chama (`portalDb()` nas rotas;
// `ctx.db` da ingestão na palavra-chave) — as `portal_*` só executam
// com `service_role`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { generateCode } from './code';
import {
  deliverAccessCode,
  loadAuthTemplate,
  type DeliveryOutcome,
} from './delivery';
import { PORTAL_LIMITS } from './limits';
import { PortalServiceError } from './service';
import type { AccessStatus } from './types';

export interface PortalAccountSettings {
  accountId: string;
  enabled: boolean;
  channelId: string | null;
  authTemplateId: string | null;
  /** `null` = palavra-chave desligada. */
  keyword: string | null;
  publicCode: string;
  termsVersion: string | null;
  /** Área ligada + item de plano + conta não bloqueada (SPEC 083 E-1). */
  eligible: boolean;
}

interface SettingsJson {
  account_id: string;
  enabled: boolean;
  channel_id: string | null;
  auth_template_id: string | null;
  keyword: string | null;
  public_code: string;
  terms_version: string | null;
  eligible: boolean;
}

export function toPortalAccountSettings(
  raw: SettingsJson | null
): PortalAccountSettings | null {
  if (!raw) return null;
  return {
    accountId: raw.account_id,
    enabled: raw.enabled,
    channelId: raw.channel_id,
    authTemplateId: raw.auth_template_id,
    keyword: raw.keyword,
    publicCode: raw.public_code,
    termsVersion: raw.terms_version,
    eligible: raw.eligible,
  };
}

/** O que a tela de Configurações pode mudar (`portal_account_settings_set`). */
export interface PortalSettingsPatch {
  enabled?: boolean;
  channelId?: string | null;
  authTemplateId?: string | null;
  keyword?: string | null;
}

export function toSettingsPatchJson(
  patch: PortalSettingsPatch
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if (patch.channelId !== undefined) out.channel_id = patch.channelId;
  if (patch.authTemplateId !== undefined) {
    out.auth_template_id = patch.authTemplateId;
  }
  if (patch.keyword !== undefined) out.keyword = patch.keyword;
  return out;
}

export interface ContactAccessState {
  contactId: string;
  status: AccessStatus;
  invitedAt: string | null;
  activatedAt: string | null;
  lastLoginAt: string | null;
  blockedAt: string | null;
}

export interface PortalAccountSummary {
  enabled: boolean;
  eligible: boolean;
  activeCount: number;
  publicCode: string | null;
}

export type InviteStatus =
  | 'sent'
  | 'not_found'
  | 'not_eligible'
  | 'blocked'
  | 'opted_out'
  | 'invalid_phone'
  | 'throttled';

type Db = Pick<SupabaseClient, 'rpc'>;

async function call<T>(
  db: Db,
  fn: string,
  args: Record<string, unknown>
): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    throw new PortalServiceError(fn, (error as { code?: string }).code ?? null);
  }
  return data as T;
}

export function createPortalAccountService(db: Db) {
  return {
    /** `null` quando a conta nunca abriu as configurações da área. */
    async getSettings(
      accountId: string
    ): Promise<PortalAccountSettings | null> {
      return toPortalAccountSettings(
        await call<SettingsJson | null>(db, 'portal_account_settings_get', {
          p_account_id: accountId,
        })
      );
    },

    /** Cria a linha (e o código curto) na primeira gravação. */
    async setSettings(
      accountId: string,
      patch: PortalSettingsPatch,
      userId: string
    ): Promise<PortalAccountSettings> {
      const fn = 'portal_account_settings_set';
      const settings = toPortalAccountSettings(
        await call<SettingsJson | null>(db, fn, {
          p_account_id: accountId,
          p_patch: toSettingsPatchJson(patch),
          p_user_id: userId,
        })
      );
      if (!settings) throw new PortalServiceError(fn, null);
      return settings;
    },

    async accessStatus(
      accountId: string,
      contactIds: string[]
    ): Promise<ContactAccessState[]> {
      if (contactIds.length === 0) return [];
      const rows = await call<
        {
          contact_id: string;
          status: AccessStatus;
          invited_at: string | null;
          activated_at: string | null;
          last_login_at: string | null;
          blocked_at: string | null;
        }[]
      >(db, 'portal_access_status', {
        p_account_id: accountId,
        p_contact_ids: contactIds,
      });
      return (rows ?? []).map((r) => ({
        contactId: r.contact_id,
        status: r.status,
        invitedAt: r.invited_at,
        activatedAt: r.activated_at,
        lastLoginAt: r.last_login_at,
        blockedAt: r.blocked_at,
      }));
    },

    async invite(input: {
      accountId: string;
      contactId: string;
      code: string;
      userId: string;
    }): Promise<InviteStatus> {
      const fn = 'portal_invite';
      const rows = await call<{ status: InviteStatus }[] | null>(db, fn, {
        p_account_id: input.accountId,
        p_contact_id: input.contactId,
        p_code: input.code,
        p_user_id: input.userId,
        p_limits: PORTAL_LIMITS,
      });
      const status = rows?.[0]?.status;
      if (!status) throw new PortalServiceError(fn, null);
      return status;
    },

    /** `false` quando o contato não é da conta. */
    async setBlocked(input: {
      accountId: string;
      contactId: string;
      blocked: boolean;
      userId: string;
    }): Promise<boolean> {
      return call<boolean>(db, 'portal_set_blocked', {
        p_account_id: input.accountId,
        p_contact_id: input.contactId,
        p_blocked: input.blocked,
        p_user_id: input.userId,
      });
    },

    /** Quantos vínculos de sessão foram cortados. */
    async endSessions(accountId: string, contactId: string): Promise<number> {
      return call<number>(db, 'portal_end_sessions', {
        p_account_id: accountId,
        p_contact_id: contactId,
      });
    },

    /** Console do proprietário (`/admin`). */
    async summary(accountId: string): Promise<PortalAccountSummary> {
      const rows = await call<
        {
          enabled: boolean;
          eligible: boolean;
          active_count: number;
          public_code: string | null;
        }[]
      >(db, 'portal_account_summary', { p_account_id: accountId });
      const r = rows?.[0];
      return {
        enabled: r?.enabled ?? false,
        eligible: r?.eligible ?? false,
        activeCount: r?.active_count ?? 0,
        publicCode: r?.public_code ?? null,
      };
    },
  };
}

export type PortalAccountService = ReturnType<
  typeof createPortalAccountService
>;

export type InviteResult =
  | { ok: true; via: 'text' | 'template' }
  | { ok: false; reason: Exclude<InviteStatus, 'sent'> }
  | { ok: false; reason: Exclude<DeliveryOutcome, { ok: true }>['reason'] };

/**
 * J1 — a conta convida (PRD 082 §6.1). Emite um código de convite
 * (validade longa, `invite_code_ttl_s`) e o entrega já, para a ficha
 * dizer na hora se saiu ou por que não saiu (`needs_template`,
 * `opted_out`…). Do lado da conta não há anti-enumeração a proteger:
 * quem convida já vê o contato.
 */
export async function inviteContactToPortal(input: {
  db: SupabaseClient;
  accountId: string;
  accountName: string;
  contactId: string;
  userId: string;
  siteOrigin: string | null;
}): Promise<InviteResult> {
  const account = createPortalAccountService(input.db);
  const code = generateCode();
  const status = await account.invite({
    accountId: input.accountId,
    contactId: input.contactId,
    code,
    userId: input.userId,
  });
  if (status !== 'sent') return { ok: false, reason: status };

  const settings = await account.getSettings(input.accountId);
  if (!settings) return { ok: false, reason: 'not_eligible' };
  const authTemplate = await loadAuthTemplate(
    input.db,
    input.accountId,
    settings.authTemplateId
  );

  const outcome = await deliverAccessCode({
    db: input.db,
    accountId: input.accountId,
    accountName: input.accountName,
    contactId: input.contactId,
    code,
    kind: 'invite',
    publicCode: settings.publicCode,
    channelId: settings.channelId,
    authTemplate,
    siteOrigin: input.siteOrigin,
  });
  return outcome.ok
    ? { ok: true, via: outcome.via }
    : { ok: false, reason: outcome.reason };
}

/**
 * O contato existe E é visível para o usuário da conta que chama — pela
 * RLS do cliente de sessão, que aplica o escopo de contatos por papel
 * (SPEC 042). As rotas da área do lado da conta passam por aqui antes
 * de qualquer `portal_*` (que roda com `service_role` e não vê RLS).
 */
export async function visibleContact(
  sessionDb: Pick<SupabaseClient, 'from'>,
  accountId: string,
  contactId: string
): Promise<{ id: string; name: string | null } | null> {
  const { data } = await sessionDb
    .from('contacts')
    .select('id, name')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  return data
    ? { id: data.id as string, name: (data.name as string) ?? null }
    : null;
}

/** Os ids da lista que o usuário da conta enxerga (mesma RLS). */
export async function visibleContactIds(
  sessionDb: Pick<SupabaseClient, 'from'>,
  accountId: string,
  contactIds: string[]
): Promise<string[]> {
  if (contactIds.length === 0) return [];
  const { data } = await sessionDb
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('id', contactIds);
  return (data ?? []).map((r) => r.id as string);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Corpo do PATCH de Configurações → patch tipado, ou a mensagem do 400. */
export function parseSettingsPatch(
  body: unknown
): { patch: PortalSettingsPatch } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const patch: PortalSettingsPatch = {};

  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean')
      return { error: 'enabled must be a boolean' };
    patch.enabled = b.enabled;
  }
  for (const [key, field] of [
    ['channelId', 'channelId'],
    ['authTemplateId', 'authTemplateId'],
  ] as const) {
    if (key in b) {
      const v = b[key];
      if (v !== null && (typeof v !== 'string' || !UUID.test(v))) {
        return { error: `${key} must be a UUID or null` };
      }
      patch[field] = v as string | null;
    }
  }
  if ('keyword' in b) {
    const v = b.keyword;
    if (v === null) {
      patch.keyword = null;
    } else if (typeof v === 'string') {
      const k = v.trim();
      if (k.length < 2 || k.length > 32) {
        return { error: 'keyword must have 2 to 32 characters' };
      }
      patch.keyword = k;
    } else {
      return { error: 'keyword must be a string or null' };
    }
  }
  if (Object.keys(patch).length === 0) return { error: 'Nothing to update' };
  return { patch };
}
