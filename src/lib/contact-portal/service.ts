// ============================================================
// Wrappers tipados das `public.portal_*` do lado do contato (migração 093).
//
// Único arquivo da área que toca o banco (SPEC 083 §6): as rotas de
// `/area/api/**` importam daqui, nunca de `@/lib/supabase/*` — o teste
// de isolamento acusa a quebra. As funções só executam com
// `service_role`, então este módulo usa `supabaseAdmin()`; a autoridade
// vem da sessão resolvida, que é o primeiro parâmetro de tudo que age
// em nome de uma sessão já aberta.
//
// Erros: mensagem em inglês e SEM o que entrou (telefone, código,
// senha). O código Postgres vai junto para a rota mapear — 22023 é
// entrada que a rota deveria ter barrado antes.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/supabase/admin';

import { PORTAL_LIMITS, PORTAL_SESSION_TTL_S } from './limits';
import { toPgBytea } from './session';
import type {
  ChangePasswordStatus,
  CompleteCodeStatus,
  LoginStatus,
  PortalAccess,
  PortalCodePurpose,
  PortalSession,
  RequestCodeStatus,
} from './types';

export class PortalServiceError extends Error {
  constructor(
    readonly fn: string,
    readonly pgCode: string | null
  ) {
    super(`${fn} failed${pgCode ? ` (${pgCode})` : ''}`);
    this.name = 'PortalServiceError';
  }
}

type RpcDb = Pick<SupabaseClient, 'rpc'>;

interface ResolvedRow {
  session_id: string;
  contact_id: string;
  account_id: string;
  contact_name: string | null;
  account_name: string;
  is_current: boolean;
}

async function call<T>(
  db: RpcDb,
  fn: string,
  args: Record<string, unknown>
): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    throw new PortalServiceError(fn, (error as { code?: string }).code ?? null);
  }
  return data as T;
}

function firstRow<T>(fn: string, data: T[] | null): T {
  const row = Array.isArray(data) ? data[0] : undefined;
  if (!row) throw new PortalServiceError(fn, null);
  return row;
}

/** Monta a sessão a partir das linhas de `portal_resolve_session`. */
export function toPortalSession(
  tokenHash: string,
  rows: ResolvedRow[]
): PortalSession | null {
  if (rows.length === 0) return null;
  const accesses: PortalAccess[] = rows.map((r) => ({
    contactId: r.contact_id,
    accountId: r.account_id,
    contactName: r.contact_name,
    accountName: r.account_name,
    isCurrent: r.is_current,
  }));
  // Com um acesso só não há o que escolher, mesmo que a sessão tenha
  // nascido com vários e os outros tenham perdido a elegibilidade.
  const current =
    accesses.find((a) => a.isCurrent) ??
    (accesses.length === 1 ? accesses[0] : null);
  return { sessionId: rows[0].session_id, tokenHash, accesses, current };
}

export function createPortalService(db: RpcDb) {
  return {
    async requestCode(input: {
      phones: string[];
      publicCode: string | null;
      purpose: PortalCodePurpose;
      code: string;
      ipHash: string;
    }): Promise<{
      status: RequestCodeStatus;
      contactId: string | null;
      accountId: string | null;
    }> {
      const fn = 'portal_request_code';
      const row = firstRow(
        fn,
        await call<
          {
            status: RequestCodeStatus;
            contact_id: string | null;
            account_id: string | null;
          }[]
        >(db, fn, {
          p_phones: input.phones,
          p_public_code: input.publicCode,
          p_purpose: input.purpose,
          p_code: input.code,
          p_ip_hash: input.ipHash,
          p_limits: PORTAL_LIMITS,
        })
      );
      return {
        status: row.status,
        contactId: row.contact_id,
        accountId: row.account_id,
      };
    },

    async completeCode(input: {
      phones: string[];
      publicCode: string | null;
      code: string;
      password: string;
      termsVersion: string | null;
      ipHash: string;
    }): Promise<{
      status: CompleteCodeStatus;
      contactId: string | null;
      accountId: string | null;
    }> {
      const fn = 'portal_complete_code';
      const row = firstRow(
        fn,
        await call<
          {
            status: CompleteCodeStatus;
            contact_id: string | null;
            account_id: string | null;
          }[]
        >(db, fn, {
          p_phones: input.phones,
          p_public_code: input.publicCode,
          p_code: input.code,
          p_password: input.password,
          p_terms_version: input.termsVersion,
          p_ip_hash: input.ipHash,
          p_limits: PORTAL_LIMITS,
        })
      );
      return {
        status: row.status,
        contactId: row.contact_id,
        accountId: row.account_id,
      };
    },

    async login(input: {
      phones: string[];
      password: string;
      ipHash: string;
    }): Promise<{ status: LoginStatus; contactIds: string[] }> {
      const fn = 'portal_login';
      const row = firstRow(
        fn,
        await call<{ status: LoginStatus; contact_ids: string[] | null }[]>(
          db,
          fn,
          {
            p_phones: input.phones,
            p_password: input.password,
            p_ip_hash: input.ipHash,
            p_limits: PORTAL_LIMITS,
          }
        )
      );
      return { status: row.status, contactIds: row.contact_ids ?? [] };
    },

    /** `null` quando nenhum dos acessos é elegível — a rota não grava cookie. */
    async createSession(input: {
      tokenHash: string;
      contactIds: string[];
    }): Promise<string | null> {
      return call<string | null>(db, 'portal_create_session', {
        p_token_hash: toPgBytea(input.tokenHash),
        p_contact_ids: input.contactIds,
        p_ttl_s: PORTAL_SESSION_TTL_S,
      });
    },

    async resolveSession(tokenHash: string): Promise<PortalSession | null> {
      const rows = await call<ResolvedRow[] | null>(
        db,
        'portal_resolve_session',
        { p_token_hash: toPgBytea(tokenHash), p_ttl_s: PORTAL_SESSION_TTL_S }
      );
      return toPortalSession(tokenHash, rows ?? []);
    },

    async selectAccount(
      session: PortalSession,
      contactId: string
    ): Promise<boolean> {
      // Recusa cedo o que a sessão não abriu; o banco reconfere.
      if (!session.accesses.some((a) => a.contactId === contactId)) {
        return false;
      }
      return call<boolean>(db, 'portal_select_account', {
        p_token_hash: toPgBytea(session.tokenHash),
        p_contact_id: contactId,
      });
    },

    async changePassword(
      session: PortalSession,
      input: { current: string; next: string; ipHash: string }
    ): Promise<{ status: ChangePasswordStatus; changed: number }> {
      const fn = 'portal_change_password';
      const row = firstRow(
        fn,
        await call<{ status: ChangePasswordStatus; changed: number }[]>(
          db,
          fn,
          {
            p_token_hash: toPgBytea(session.tokenHash),
            p_current: input.current,
            p_new: input.next,
            p_ip_hash: input.ipHash,
            p_limits: PORTAL_LIMITS,
          }
        )
      );
      return { status: row.status, changed: row.changed };
    },

    /**
     * Nome da conta dona do endereço `/area/c/<código>` (migração 094),
     * ou `null` se o código não existe ou a área dela não está elegível.
     */
    async publicAccountName(publicCode: string): Promise<string | null> {
      const rows = await call<{ account_name: string }[] | null>(
        db,
        'portal_public_account',
        { p_public_code: publicCode }
      );
      return rows?.[0]?.account_name ?? null;
    },

    /**
     * Recebe o hash, não a sessão: sair tem de funcionar mesmo quando a
     * sessão já não resolve (área desligada, conta bloqueada).
     */
    async logout(tokenHash: string, everywhere: boolean): Promise<void> {
      await call<null>(db, 'portal_logout', {
        p_token_hash: toPgBytea(tokenHash),
        p_everywhere: everywhere,
      });
    },
  };
}

export type PortalService = ReturnType<typeof createPortalService>;

export function portalService(): PortalService {
  return createPortalService(supabaseAdmin());
}

/**
 * O cliente service-role para os outros módulos da área (`journeys.ts`,
 * `delivery.ts`, `keyword.ts`), que o recebem como parâmetro. Só este
 * arquivo e `account.ts` importam `@/lib/supabase/*` (teste de
 * isolamento).
 */
export function portalDb(): SupabaseClient {
  return supabaseAdmin();
}
