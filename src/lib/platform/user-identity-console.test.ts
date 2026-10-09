import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// `owner.ts` importa o cliente SSR (next/headers) — o teste só precisa de
// `parseOwnerEmails`, que é pura.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

const writePlatformAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('./audit', async () => {
  const actual = await vi.importActual<typeof import('./audit')>('./audit');
  return {
    ...actual,
    writePlatformAudit: (...args: unknown[]) => writePlatformAudit(...args),
  };
});

const recordActivity = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivity(...args),
}));

const deliverEmailChangeNotice = vi.fn();
vi.mock('@/lib/mailer/send', () => ({
  deliverEmailChangeNotice: (...args: unknown[]) =>
    deliverEmailChangeNotice(...args),
}));

import { editUserIdentity } from './user-identity-console';

const USER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OWNER = 'bruno@zapcrmbr.com';
const PROFILE: {
  user_id: string;
  account_id: string | null;
  full_name: string;
  email: string;
} = {
  user_id: USER,
  account_id: ACCOUNT,
  full_name: 'Ana Souza',
  email: 'ana@cliente.com',
};

interface FakeOptions {
  profile?: typeof PROFILE | null;
  authResults?: { error: Record<string, unknown> | null }[];
  profileUpdateResult?: { data: unknown; error: { message: string } | null };
}

function makeDb(options: FakeOptions = {}) {
  const authCalls: Record<string, unknown>[] = [];
  const profileUpdates: Record<string, unknown>[] = [];
  let authIndex = 0;
  const db = {
    auth: {
      admin: {
        updateUserById: (_id: string, attributes: Record<string, unknown>) => {
          authCalls.push(attributes);
          return Promise.resolve(
            options.authResults?.[authIndex++] ?? { error: null }
          );
        },
      },
    },
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`tabela inesperada: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: options.profile === undefined ? PROFILE : options.profile,
                error: null,
              }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          profileUpdates.push(payload);
          const c = {
            eq: () => c,
            select: () =>
              Promise.resolve(
                options.profileUpdateResult ?? {
                  data: [{ user_id: USER }],
                  error: null,
                }
              ),
          };
          return c;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, authCalls, profileUpdates };
}

const OWNER_LIST = ['bruno@zapcrmbr.com'];

const run = (db: SupabaseClient, body: Record<string, unknown> | null) =>
  editUserIdentity(db, {
    userId: USER,
    ownerEmail: OWNER,
    body,
    ownerEmails: OWNER_LIST,
  });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  deliverEmailChangeNotice.mockResolvedValue({ ok: true, skipped: false });
});

describe('editUserIdentity', () => {
  it('corpo ausente → 400 invalid_body', async () => {
    const { db } = makeDb();
    expect(await run(db, null)).toMatchObject({
      ok: false,
      status: 400,
      code: 'invalid_body',
    });
  });

  it('nem nome nem e-mail → 400 no_changes', async () => {
    const { db } = makeDb();
    expect(await run(db, { reason: 'x' })).toMatchObject({
      ok: false,
      status: 400,
      code: 'no_changes',
    });
  });

  it('usuário sem perfil → 404 user_not_found', async () => {
    const { db } = makeDb({ profile: null });
    expect(await run(db, { fullName: 'Nova' })).toMatchObject({
      ok: false,
      status: 404,
      code: 'user_not_found',
    });
  });

  it('troca de e-mail: Auth com email_confirm, auditoria com antes/depois, atividade SEM endereços', async () => {
    const { db, authCalls } = makeDb();
    const result = await run(db, {
      email: '  Novo@Cliente.com ',
      reason: 'perdeu acesso ao antigo',
    });

    expect(result).toEqual({
      ok: true,
      data: { fields: ['email'], oldEmailNotice: 'sent' },
    });
    expect(authCalls[0]).toEqual({
      email: 'novo@cliente.com',
      email_confirm: true,
    });
    expect(writePlatformAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        actor: `console:${OWNER}`,
        action: 'user.profile_update',
        accountId: ACCOUNT,
        targetUserId: USER,
        payload: expect.objectContaining({
          fields: ['email'],
          previousEmail: 'ana@cliente.com',
          newEmail: 'novo@cliente.com',
          previousName: null,
          newName: null,
          reason: 'perdeu acesso ao antigo',
        }),
      })
    );
    const entry = recordActivity.mock.calls[0][1];
    expect(entry).toMatchObject({
      accountId: ACCOUNT,
      resourceType: 'member',
      action: 'member.profile_updated',
      actor: { kind: 'system', name: 'platform' },
      metadata: { fields: ['email'] },
    });
    expect(JSON.stringify(entry)).not.toContain('cliente.com');
  });

  it('troca de nome: grava profiles e a cópia do Auth; accounts não é tocada', async () => {
    const { db, profileUpdates, authCalls } = makeDb();
    const result = await run(db, { fullName: '  Ana Paula Souza ' });

    expect(result).toEqual({
      ok: true,
      data: { fields: ['fullName'], oldEmailNotice: null },
    });
    expect(profileUpdates).toEqual([{ full_name: 'Ana Paula Souza' }]);
    expect(authCalls).toEqual([
      { user_metadata: { full_name: 'Ana Paula Souza' } },
    ]);
    expect(writePlatformAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        payload: expect.objectContaining({
          previousName: 'Ana Souza',
          newName: 'Ana Paula Souza',
        }),
      })
    );
    expect(recordActivity.mock.calls[0][1]).toMatchObject({
      resourceLabel: 'Ana Paula Souza',
    });
  });

  it('nome igual ao atual e sem e-mail → 400 no_changes, nada gravado', async () => {
    const { db, profileUpdates } = makeDb();
    expect(await run(db, { fullName: ' Ana Souza ' })).toMatchObject({
      ok: false,
      status: 400,
      code: 'no_changes',
    });
    expect(profileUpdates).toEqual([]);
    expect(writePlatformAudit).not.toHaveBeenCalled();
  });

  it('nome inválido → 400 name_invalid', async () => {
    const { db } = makeDb();
    expect(await run(db, { fullName: '   ' })).toMatchObject({
      ok: false,
      status: 400,
      code: 'name_invalid',
    });
  });

  it.each([
    [{ email: 'sem-arroba' }, 'email_invalid'],
    [{ email: 'ANA@cliente.com' }, 'email_unchanged'],
    [{ email: 'bruno@zapcrmbr.com' }, 'email_reserved_for_platform_owner'],
  ])('guarda %j → 400 %s, sem escrita', async (body, code) => {
    const { db, authCalls } = makeDb();
    expect(await run(db, body)).toMatchObject({ ok: false, status: 400, code });
    expect(authCalls).toEqual([]);
    expect(writePlatformAudit).not.toHaveBeenCalled();
  });

  it('alvo é o proprietário da plataforma: e-mail recusado, mas o NOME pode mudar', async () => {
    const owner = { ...PROFILE, email: 'bruno@zapcrmbr.com' };
    const { db } = makeDb({ profile: owner });
    expect(await run(db, { email: 'outro@zapcrmbr.com' })).toMatchObject({
      ok: false,
      status: 400,
      code: 'cannot_edit_platform_owner_email',
    });
    expect(await run(db, { fullName: 'Bruno P.' })).toEqual({
      ok: true,
      data: { fields: ['fullName'], oldEmailNotice: null },
    });
  });

  it('e-mail de outro usuário → 409 email_taken, e o nome enviado junto NÃO é gravado', async () => {
    const { db, profileUpdates } = makeDb({
      authResults: [{ error: { code: 'email_exists', status: 422 } }],
    });
    expect(
      await run(db, { email: 'ocupado@cliente.com', fullName: 'Outro Nome' })
    ).toMatchObject({ ok: false, status: 409, code: 'email_taken' });
    expect(profileUpdates).toEqual([]);
    expect(writePlatformAudit).not.toHaveBeenCalled();
  });

  it('nome falha depois do e-mail → 500 partial_update com emailUpdated, e o rastro registra o e-mail', async () => {
    const { db } = makeDb({
      profileUpdateResult: { data: null, error: { message: 'db down' } },
    });
    const result = await run(db, {
      email: 'novo@cliente.com',
      fullName: 'Nova Pessoa',
    });
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      code: 'partial_update',
      extra: { emailUpdated: true },
    });
    expect(writePlatformAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        payload: expect.objectContaining({
          fields: ['email'],
          newEmail: 'novo@cliente.com',
          newName: null,
          partial: true,
        }),
      })
    );
    // O login mudou: o cliente vê em /activity só o campo, não o endereço.
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0][1]).toMatchObject({
      action: 'member.profile_updated',
      metadata: { fields: ['email'] },
    });
  });

  it('usuário sem conta (account_id nulo): audita, mas não registra atividade', async () => {
    const { db } = makeDb({ profile: { ...PROFILE, account_id: null } });
    await run(db, { fullName: 'Nova' });
    expect(writePlatformAudit).toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  describe('aviso ao e-mail antigo (SPEC 078 §5.5, D-11)', () => {
    it('troca de e-mail: avisa o endereço ANTIGO (o que estava no perfil), nunca o novo', async () => {
      const { db } = makeDb();
      await run(db, { email: 'novo@cliente.com' });
      expect(deliverEmailChangeNotice).toHaveBeenCalledTimes(1);
      expect(deliverEmailChangeNotice).toHaveBeenCalledWith('ana@cliente.com');
    });

    it('o desfecho vai para a auditoria', async () => {
      const { db } = makeDb();
      await run(db, { email: 'novo@cliente.com' });
      expect(writePlatformAudit).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          payload: expect.objectContaining({ oldEmailNotice: 'sent' }),
        })
      );
    });

    it('só o nome mudou: nenhum aviso é enviado', async () => {
      const { db } = makeDb();
      await run(db, { fullName: 'Ana Paula' });
      expect(deliverEmailChangeNotice).not.toHaveBeenCalled();
      expect(writePlatformAudit.mock.calls[0][1].payload).not.toHaveProperty(
        'oldEmailNotice'
      );
    });

    it('SMTP desligado: a troca funciona e o desfecho é skipped', async () => {
      deliverEmailChangeNotice.mockResolvedValue({ ok: true, skipped: true });
      const { db } = makeDb();
      expect(await run(db, { email: 'novo@cliente.com' })).toEqual({
        ok: true,
        data: { fields: ['email'], oldEmailNotice: 'skipped' },
      });
    });

    it('SMTP com erro: a troca NÃO falha, o desfecho é failed', async () => {
      deliverEmailChangeNotice.mockResolvedValue({
        ok: false,
        skipped: false,
        error: 'connect ETIMEDOUT',
      });
      const { db } = makeDb();
      expect(await run(db, { email: 'novo@cliente.com' })).toEqual({
        ok: true,
        data: { fields: ['email'], oldEmailNotice: 'failed' },
      });
    });

    it('e-mail repetido (nada gravado): não avisa ninguém', async () => {
      const { db } = makeDb({
        authResults: [{ error: { code: 'email_exists', status: 422 } }],
      });
      await run(db, { email: 'ocupado@cliente.com' });
      expect(deliverEmailChangeNotice).not.toHaveBeenCalled();
    });

    it('partial_update: o login JÁ mudou, então o aviso sai e vai na resposta', async () => {
      const { db } = makeDb({
        profileUpdateResult: { data: null, error: { message: 'db down' } },
      });
      const result = await run(db, {
        email: 'novo@cliente.com',
        fullName: 'Nova Pessoa',
      });
      expect(deliverEmailChangeNotice).toHaveBeenCalledWith('ana@cliente.com');
      expect(result).toMatchObject({
        ok: false,
        code: 'partial_update',
        extra: { emailUpdated: true, oldEmailNotice: 'sent' },
      });
    });
  });
});
