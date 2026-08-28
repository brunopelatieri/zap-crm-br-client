import { afterEach, describe, expect, it, vi } from 'vitest';

// getCurrentAccount resolves the caller's account context. The
// regression this file guards (issue #294): account loading must NOT
// depend on a PostgREST embedded FK join (`accounts!inner`), because a
// stale schema cache makes that embed fail hard and blanks the whole
// context. It must instead read the profile and then the account with
// two plain point queries.

// ------------------------------------------------------------
// Chainable Supabase query-builder mock. Each `.from(table)` hands back
// a thenable builder pre-loaded with the result queued for that table,
// so we can assert which tables were queried and with what filters.
// ------------------------------------------------------------
interface BuilderCall {
  table: string;
  columns?: string;
  eqArgs: [string, unknown][];
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  byTable: Record<string, { data: unknown; error: unknown }>;
}) {
  const calls: BuilderCall[] = [];

  const from = (table: string) => {
    const call: BuilderCall = { table, eqArgs: [] };
    calls.push(call);
    const builder = {
      select(columns: string) {
        call.columns = columns;
        return builder;
      },
      eq(col: string, val: unknown) {
        call.eqArgs.push([col, val]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(
          opts.byTable[table] ?? { data: null, error: null }
        );
      },
    };
    return builder;
  };

  return {
    calls,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      from,
    },
  };
}

const createClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createClient(),
}));

// SPEC 062 §4.1. Quando a linha de `accounts` não volta, getCurrentAccount
// faz UMA sondagem por service-role para desempatar "conta bloqueada" de
// "perfil órfão" — os dois ficaram indistinguíveis pela sessão do cliente
// depois que a 069 pôs `blocked_at` dentro de `is_account_member()`.
// `blockedProbe` é o que essa sondagem devolve.
const blockedProbe = { blocked_at: null as string | null };
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: blockedProbe, error: null }),
      };
      return chain;
    },
  }),
}));

const {
  getCurrentAccount,
  UnauthorizedError,
  ForbiddenError,
  AccountBlockedError,
} = await import('./account');

afterEach(() => {
  vi.clearAllMocks();
  blockedProbe.blocked_at = null;
});

describe('getCurrentAccount', () => {
  it('resolves context via a plain accounts lookup, not an embedded join', async () => {
    const { client, calls } = makeClient({
      user: { id: 'user-1' },
      byTable: {
        profiles: {
          data: { account_id: 'acct-1', account_role: 'owner' },
          error: null,
        },
        accounts: { data: { id: 'acct-1', name: 'Acme' }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: 'user-1',
      accountId: 'acct-1',
      role: 'owner',
      account: { id: 'acct-1', name: 'Acme' },
    });

    // Two queries: profiles by user_id, then accounts by id. Neither
    // selects an embedded relationship — the regression guard.
    expect(calls.map((c) => c.table)).toEqual(['profiles', 'accounts']);
    expect(calls[0].columns).not.toMatch(/accounts!/);
    expect(calls[0].eqArgs).toEqual([['user_id', 'user-1']]);
    expect(calls[1].columns).not.toMatch(/accounts!/);
    expect(calls[1].eqArgs).toEqual([['id', 'acct-1']]);
  });

  it('throws UnauthorizedError when there is no session', async () => {
    const { client } = makeClient({ user: null, byTable: {} });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps a profiles query error to 'Could not load account context'", async () => {
    const { client } = makeClient({
      user: { id: 'user-1' },
      byTable: {
        profiles: { data: null, error: { code: 'PGRST200' } },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      'Could not load account context'
    );
  });

  it("maps an accounts query error to 'Could not load account context'", async () => {
    // The exact #294 shape if the embed were still in play, but now on
    // the decoupled accounts lookup: profile resolves, account read errors.
    const { client } = makeClient({
      user: { id: 'user-1' },
      byTable: {
        profiles: {
          data: { account_id: 'acct-1', account_role: 'admin' },
          error: null,
        },
        accounts: { data: null, error: { code: 'PGRST200' } },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe('Could not load account context');
  });

  it('rejects a profile not linked to an account', async () => {
    const { client } = makeClient({
      user: { id: 'user-1' },
      byTable: {
        profiles: {
          data: { account_id: null, account_role: null },
          error: null,
        },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      'Profile is not linked to an account'
    );
  });

  it('rejects an account_id that resolves to no readable account', async () => {
    const { client } = makeClient({
      user: { id: 'user-1' },
      byTable: {
        profiles: {
          data: { account_id: 'acct-1', account_role: 'viewer' },
          error: null,
        },
        accounts: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      'Profile is not linked to an account'
    );
  });
});

// SPEC 062 §4.1, camada 2 — a que EXPLICA. A camada 1 (RLS) já barrou o
// dado; o que estes testes travam é o erro chegar com o `code` certo,
// porque é ele que manda a pessoa para `/blocked` em vez de para uma
// tela de "sem permissão" que ela não consegue resolver.
describe('getCurrentAccount — bloqueio (SPEC 062 §4.1)', () => {
  it('perfil bloqueado devolve user_blocked, e nem lê a conta', async () => {
    const { client, calls } = makeClient({
      user: { id: 'user-1' },
      byTable: {
        profiles: {
          data: {
            account_id: 'acct-1',
            account_role: 'owner',
            blocked_at: '2026-08-27T00:00:00Z',
          },
          error: null,
        },
      },
    });
    createClient.mockReturnValue(client);

    await expect(getCurrentAccount()).rejects.toMatchObject({
      code: 'user_blocked',
      status: 403,
    });
    // A linha de `profiles` continua legível para o próprio dono
    // (`profiles_select` casa em `auth.uid() = user_id`), então o motivo
    // preciso sai sem uma segunda consulta.
    expect(calls.map((c) => c.table)).toEqual(['profiles']);
  });

  it('conta bloqueada devolve account_blocked, desempatado por service-role', async () => {
    const { client } = makeClient({
      user: { id: 'user-1' },
      byTable: {
        profiles: {
          data: {
            account_id: 'acct-1',
            account_role: 'owner',
            blocked_at: null,
          },
          error: null,
        },
        // A 069 pôs `blocked_at` dentro de `is_account_member()`: a
        // linha da própria conta some para quem está bloqueado.
        accounts: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    blockedProbe.blocked_at = '2026-08-27T00:00:00Z';

    await expect(getCurrentAccount()).rejects.toMatchObject({
      code: 'account_blocked',
      status: 403,
    });
  });

  it('perfil realmente órfão continua sendo ForbiddenError, não bloqueio', async () => {
    const { client } = makeClient({
      user: { id: 'user-1' },
      byTable: {
        profiles: {
          data: {
            account_id: 'acct-1',
            account_role: 'owner',
            blocked_at: null,
          },
          error: null,
        },
        accounts: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    blockedProbe.blocked_at = null;

    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).not.toBeInstanceOf(AccountBlockedError);
  });
});
