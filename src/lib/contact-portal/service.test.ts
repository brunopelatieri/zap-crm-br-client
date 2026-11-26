import { describe, expect, it, vi } from 'vitest';

import { PORTAL_LIMITS, PORTAL_SESSION_TTL_S } from './limits';
import {
  PortalServiceError,
  createPortalService,
  toPortalSession,
} from './service';
import { hashSessionToken } from './session';
import type { PortalSession } from './types';

const HASH = hashSessionToken('a'.repeat(43));
const BYTEA = `\\x${HASH}`;

function fakeDb(data: unknown, error: unknown = null) {
  return { rpc: vi.fn().mockResolvedValue({ data, error }) };
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    session_id: 's1',
    contact_id: 'c1',
    account_id: 'a1',
    contact_name: 'Ana',
    account_name: 'Valen Ranch',
    is_current: false,
    ...over,
  };
}

const session: PortalSession = {
  sessionId: 's1',
  tokenHash: HASH,
  accesses: [
    {
      contactId: 'c1',
      accountId: 'a1',
      contactName: 'Ana',
      accountName: 'Valen Ranch',
      isCurrent: true,
    },
  ],
  current: null,
};

describe('chamadas às portal_*', () => {
  it('requestCode manda candidatos, código, hash de IP e os limites', async () => {
    const db = fakeDb([{ status: 'sent', contact_id: 'c1', account_id: 'a1' }]);
    const r = await createPortalService(db).requestCode({
      phones: ['5519991234567', '551991234567'],
      publicCode: 'ABCD2345',
      purpose: 'reset',
      code: '123456',
      ipHash: 'f'.repeat(64),
    });
    expect(db.rpc).toHaveBeenCalledWith('portal_request_code', {
      p_phones: ['5519991234567', '551991234567'],
      p_public_code: 'ABCD2345',
      p_purpose: 'reset',
      p_code: '123456',
      p_ip_hash: 'f'.repeat(64),
      p_limits: PORTAL_LIMITS,
    });
    expect(r).toEqual({ status: 'sent', contactId: 'c1', accountId: 'a1' });
  });

  it('login devolve os acessos que bateram ([] quando o banco manda null)', async () => {
    const ok = createPortalService(
      fakeDb([{ status: 'ok', contact_ids: ['c1', 'c2'] }])
    );
    expect(
      await ok.login({ phones: ['1'], password: 'x', ipHash: 'h' })
    ).toEqual({ status: 'ok', contactIds: ['c1', 'c2'] });

    const bad = createPortalService(
      fakeDb([{ status: 'invalid', contact_ids: null }])
    );
    expect(
      await bad.login({ phones: ['1'], password: 'x', ipHash: 'h' })
    ).toEqual({ status: 'invalid', contactIds: [] });
  });

  it('createSession manda o hash como bytea e o TTL da sessão', async () => {
    const db = fakeDb('s1');
    expect(
      await createPortalService(db).createSession({
        tokenHash: HASH,
        contactIds: ['c1'],
      })
    ).toBe('s1');
    expect(db.rpc).toHaveBeenCalledWith('portal_create_session', {
      p_token_hash: BYTEA,
      p_contact_ids: ['c1'],
      p_ttl_s: PORTAL_SESSION_TTL_S,
    });
  });

  it('resolveSession: sem linhas → null', async () => {
    expect(
      await createPortalService(fakeDb([])).resolveSession(HASH)
    ).toBeNull();
    expect(
      await createPortalService(fakeDb(null)).resolveSession(HASH)
    ).toBeNull();
  });

  it('selectAccount recusa sem ir ao banco o que a sessão não abriu', async () => {
    const db = fakeDb(true);
    const svc = createPortalService(db);
    expect(await svc.selectAccount(session, 'c-de-outra-conta')).toBe(false);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(await svc.selectAccount(session, 'c1')).toBe(true);
    expect(db.rpc).toHaveBeenCalledWith('portal_select_account', {
      p_token_hash: BYTEA,
      p_contact_id: 'c1',
    });
  });

  it('changePassword usa o hash da sessão, nunca um id do cliente', async () => {
    const db = fakeDb([{ status: 'ok', changed: 2 }]);
    const r = await createPortalService(db).changePassword(session, {
      current: 'Atual#2026x',
      next: 'Nova#2026xy',
      ipHash: 'e'.repeat(64),
    });
    expect(r).toEqual({ status: 'ok', changed: 2 });
    expect(db.rpc.mock.calls[0][1]).toMatchObject({
      p_token_hash: BYTEA,
      p_limits: PORTAL_LIMITS,
    });
  });

  it('logout recebe o hash: funciona mesmo com a sessão já sem acesso', async () => {
    const db = fakeDb(null);
    await createPortalService(db).logout(HASH, true);
    expect(db.rpc).toHaveBeenCalledWith('portal_logout', {
      p_token_hash: BYTEA,
      p_everywhere: true,
    });
  });
});

describe('publicAccountName', () => {
  it('nome da conta ou null', async () => {
    const db = fakeDb([{ account_name: 'Valen Ranch' }]);
    expect(await createPortalService(db).publicAccountName('abcd2345')).toBe(
      'Valen Ranch'
    );
    expect(db.rpc).toHaveBeenCalledWith('portal_public_account', {
      p_public_code: 'abcd2345',
    });
    expect(
      await createPortalService(fakeDb([])).publicAccountName('X')
    ).toBeNull();
  });
});

describe('erros', () => {
  it('erro do banco vira PortalServiceError com o código, sem a entrada', async () => {
    const svc = createPortalService(
      fakeDb(null, { code: '22023', message: 'invalid phone 5519991234567' })
    );
    const err = await svc
      .login({ phones: ['5519991234567'], password: 'Segredo#1', ipHash: 'h' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalServiceError);
    expect((err as PortalServiceError).pgCode).toBe('22023');
    expect((err as Error).message).toBe('portal_login failed (22023)');
    expect((err as Error).message).not.toContain('5519991234567');
    expect((err as Error).message).not.toContain('Segredo');
  });

  it('RETURNS TABLE sem linha é erro, não "ok" silencioso', async () => {
    const svc = createPortalService(fakeDb([]));
    await expect(
      svc.login({ phones: ['1'], password: 'x', ipHash: 'h' })
    ).rejects.toBeInstanceOf(PortalServiceError);
  });
});

describe('toPortalSession', () => {
  it('marca o acesso atual', () => {
    const s = toPortalSession(HASH, [
      row(),
      row({ contact_id: 'c2', account_id: 'a2', is_current: true }),
    ]);
    expect(s?.current?.contactId).toBe('c2');
    expect(s?.accesses).toHaveLength(2);
    expect(s?.tokenHash).toBe(HASH);
  });

  it('várias contas sem escolha → current null (tela Escolher conta)', () => {
    const s = toPortalSession(HASH, [row(), row({ contact_id: 'c2' })]);
    expect(s?.current).toBeNull();
  });

  it('um acesso só → é o atual, mesmo sem marca no banco', () => {
    expect(toPortalSession(HASH, [row()])?.current?.contactId).toBe('c1');
  });

  it('sem linhas → null', () => {
    expect(toPortalSession(HASH, [])).toBeNull();
  });
});
