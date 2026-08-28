// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { AccountBlockedError } from '@/lib/platform/blocked';
import { emitSystemEvent } from '@/lib/notifications/emit';
import { hasMinRole, isAccountRole, type AccountRole } from './roles';

// Reexport so dashboard call sites read exactly as SPEC 062 §4.1
// writes it (`import { AccountBlockedError } from '@/lib/auth/account'`).
// The class itself lives in `@/lib/platform/blocked` because engines and
// webhooks — which run outside a request scope — must be able to throw
// and catch it without importing `next/headers` through this module.
export { AccountBlockedError };

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  // Blocked carries a machine `code` alongside the message: the UI has
  // to tell "blocked" apart from "insufficient role" (SPEC 062 §4.1) —
  // they mean different things to the person on the other side, and
  // only one of them is fixable by asking a colleague for a promotion.
  if (err instanceof AccountBlockedError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status }
    );
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error('[toErrorResponse] uncategorized error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('account_id, account_role, blocked_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[getCurrentAccount] profile fetch error:', error);
    throw new ForbiddenError('Could not load account context');
  }

  // SPEC 062 §4.1, camada 2. The profile row stays readable while
  // blocked (`profiles_select` matches on `auth.uid() = user_id`, which
  // never goes through `is_account_member`), so this check runs before
  // anything else and gives the precise reason.
  if (data?.blocked_at) {
    throw new AccountBlockedError('user_blocked', 'This user is blocked');
  }
  if (!data || !data.account_id || !data.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError('Profile is not linked to an account');
  }
  if (!isAccountRole(data.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${data.account_role}`);
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  const { data: account, error: accountErr } = await supabase
    .from('accounts')
    .select('id, name')
    .eq('id', data.account_id)
    .maybeSingle();

  if (accountErr) {
    console.error('[getCurrentAccount] account fetch error:', accountErr);
    throw new ForbiddenError('Could not load account context');
  }
  if (!account) {
    // Two very different situations look identical from here, because
    // after migration 069 `accounts_select` runs through
    // `is_account_member()` and a BLOCKED account stops returning its
    // own row:
    //
    //   (a) the account is blocked — the person needs `/blocked` and an
    //       email address to write to;
    //   (b) the profile really is orphaned / an RLS gap — "shouldn't
    //       happen post-017".
    //
    // Guessing sends half the cases to the wrong support conversation,
    // which is exactly what the `/blocked` page (§4.2) exists to
    // prevent. One service-role point lookup settles it, and it only
    // ever runs on this already-degraded path — never on the happy one.
    // Se o service-role não estiver disponível (variável ausente num
    // ambiente que não a configura), não dá para desempatar — e não
    // saber é motivo para manter o erro que já existia, nunca para
    // inventar um bloqueio que talvez não exista.
    try {
      const { data: blockedRow } = await supabaseAdmin()
        .from('accounts')
        .select('blocked_at')
        .eq('id', data.account_id)
        .maybeSingle();

      if (blockedRow?.blocked_at) {
        throw new AccountBlockedError('account_blocked');
      }
    } catch (err) {
      if (err instanceof AccountBlockedError) throw err;
      console.error('[getCurrentAccount] blocked-account probe failed:', err);
    }
    throw new ForbiddenError('Profile is not linked to an account');
  }

  // SPEC 063 §3.3 — emitido pelo primeiro `getCurrentAccount()`
  // bem-sucedido da conta, sem tocar em `handle_new_user` (trigger não
  // faz HTTP). Chamado em TODA resolução bem-sucedida, mas nunca
  // `await`-ado: o `dedupe_key` (`account.created:<accountId>`) garante
  // uma única emissão para sempre via `UNIQUE INDEX`, então o custo aqui
  // é um `INSERT` que falha rápido por violação de unicidade em todas as
  // chamadas depois da primeira — barato, e nunca no caminho crítico
  // desta função (ver §1: o aviso nunca pode atrasar nem derrubar a ação
  // que o originou).
  void emitSystemEvent({
    type: 'account.created',
    accountId: account.id,
    account: {
      id: account.id,
      name: account.name,
      ownerEmail: user.email ?? null,
    },
  });

  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    account: { id: account.id, name: account.name },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`
    );
  }
  return ctx;
}
