import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { blockAccount, blockUser, unblockAccount, unblockUser } from './block';

interface RecordedOp {
  table: string;
  verb: 'select' | 'update' | 'insert';
  payload?: unknown;
}

/**
 * Mock por tabela+verbo, mesmo espírito de `plan-actions.test.ts`. Uma
 * chamada a `setBlocked` faz no máximo um `update` por tabela e, só
 * quando a precondição não casa, um `select` de existência depois —
 * nunca os dois na mesma consulta, então a chave `${table}.${verb}`
 * não precisa de mais granularidade.
 *
 * Desde a SPEC 063 (F5), `setBlocked` também grava em
 * `system_notifications` (a outbox do proprietário) — `inserts` agora
 * carrega `{ table, payload }` para os testes poderem distinguir a
 * gravação de auditoria da emissão do evento sem se acoplar aos
 * detalhes internos de uma da outra.
 */
function makeDb(
  results: Record<string, { data?: unknown; error?: unknown }> = {}
) {
  const ops: RecordedOp[] = [];
  const inserts: { table: string; payload: Record<string, unknown> }[] = [];

  function builder(table: string) {
    const op: RecordedOp = { table, verb: 'select' };
    let recorded = false;
    const settle = () => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      return results[`${table}.${op.verb}`] ?? { data: null, error: null };
    };

    const chain: Record<string, unknown> = {
      update: (payload: unknown) => {
        op.verb = 'update';
        op.payload = payload;
        return chain;
      },
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, payload });
        return Promise.resolve({ data: null, error: null });
      },
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      not: () => chain,
      maybeSingle: () => Promise.resolve(settle()),
    };
    return chain;
  }

  return {
    client: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    ops,
    inserts,
    auditInserts: () =>
      inserts
        .filter((i) => i.table === 'platform_audit_log')
        .map((i) => i.payload),
    notificationInserts: () =>
      inserts
        .filter((i) => i.table === 'system_notifications')
        .map((i) => i.payload),
  };
}

const CTX = { ownerEmail: 'owner@zapcrmbr.com' };

describe('blockAccount', () => {
  it('bloqueia com sucesso e grava platform_audit_log com o motivo', async () => {
    const { client, auditInserts } = makeDb({
      'accounts.update': { data: { id: 'acct-1', name: 'Acme' }, error: null },
    });
    const result = await blockAccount(client, CTX, 'acct-1', 'inadimplência');
    expect(result).toEqual({ ok: true });
    expect(auditInserts()).toEqual([
      {
        actor: 'console:owner@zapcrmbr.com',
        action: 'account.block',
        account_id: 'acct-1',
        target_user_id: null,
        payload: { reason: 'inadimplência' },
      },
    ]);
  });

  it('emite account.blocked na outbox do proprietário (SPEC 063)', async () => {
    const { client, notificationInserts } = makeDb({
      'accounts.update': { data: { id: 'acct-1', name: 'Acme' }, error: null },
    });
    await blockAccount(client, CTX, 'acct-1', 'inadimplência');
    const [notification] = notificationInserts();
    expect(notification.type).toBe('account.blocked');
    expect(notification.account_id).toBe('acct-1');
    expect(notification.dedupe_key).toBeNull();
    expect(
      (notification.payload as { block: { reason: string } }).block.reason
    ).toBe('inadimplência');
  });

  it('já bloqueada (precondição não casa) mas existe: ok sem gravar auditoria nem evento', async () => {
    const { client, auditInserts, notificationInserts } = makeDb({
      'accounts.update': { data: null, error: null },
      'accounts.select': { data: { id: 'acct-1' }, error: null },
    });
    const result = await blockAccount(client, CTX, 'acct-1', null);
    expect(result).toEqual({ ok: true });
    expect(auditInserts()).toEqual([]);
    expect(notificationInserts()).toEqual([]);
  });

  it('conta inexistente: not_found', async () => {
    const { client, auditInserts } = makeDb({
      'accounts.update': { data: null, error: null },
      'accounts.select': { data: null, error: null },
    });
    const result = await blockAccount(client, CTX, 'sumiu', null);
    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(auditInserts()).toEqual([]);
  });

  it('falha de banco no update: update_failed, sem auditoria', async () => {
    const { client, auditInserts } = makeDb({
      'accounts.update': { data: null, error: { message: 'conflict' } },
    });
    const result = await blockAccount(client, CTX, 'acct-1', null);
    expect(result).toEqual({ ok: false, error: 'update_failed' });
    expect(auditInserts()).toEqual([]);
  });
});

describe('unblockAccount', () => {
  it('desbloqueia com sucesso e grava platform_audit_log sem reason', async () => {
    const { client, auditInserts } = makeDb({
      'accounts.update': { data: { id: 'acct-1', name: 'Acme' }, error: null },
    });
    const result = await unblockAccount(client, CTX, 'acct-1');
    expect(result).toEqual({ ok: true });
    expect(auditInserts()).toEqual([
      {
        actor: 'console:owner@zapcrmbr.com',
        action: 'account.unblock',
        account_id: 'acct-1',
        target_user_id: null,
        payload: {},
      },
    ]);
  });

  it('emite account.unblocked na outbox do proprietário', async () => {
    const { client, notificationInserts } = makeDb({
      'accounts.update': { data: { id: 'acct-1', name: 'Acme' }, error: null },
    });
    await unblockAccount(client, CTX, 'acct-1');
    expect(notificationInserts()[0].type).toBe('account.unblocked');
  });

  it('já desbloqueada (precondição não casa) mas existe: ok sem auditoria', async () => {
    const { client, auditInserts } = makeDb({
      'accounts.update': { data: null, error: null },
      'accounts.select': { data: { id: 'acct-1' }, error: null },
    });
    const result = await unblockAccount(client, CTX, 'acct-1');
    expect(result).toEqual({ ok: true });
    expect(auditInserts()).toEqual([]);
  });
});

describe('blockUser', () => {
  it('bloqueia com sucesso, deriva account_id da linha e grava targetUserId', async () => {
    const { client, auditInserts } = makeDb({
      'profiles.update': {
        data: {
          user_id: 'user-1',
          account_id: 'acct-9',
          email: 'carlos@acme.com',
        },
        error: null,
      },
    });
    const result = await blockUser(client, CTX, 'user-1', 'credencial vazada');
    expect(result).toEqual({ ok: true });
    expect(auditInserts()).toEqual([
      {
        actor: 'console:owner@zapcrmbr.com',
        action: 'user.block',
        account_id: 'acct-9',
        target_user_id: 'user-1',
        payload: { reason: 'credencial vazada' },
      },
    ]);
  });

  it('emite member.blocked com o e-mail do membro na outbox', async () => {
    const { client, notificationInserts } = makeDb({
      'profiles.update': {
        data: {
          user_id: 'user-1',
          account_id: 'acct-9',
          email: 'carlos@acme.com',
        },
        error: null,
      },
    });
    await blockUser(client, CTX, 'user-1', 'credencial vazada');
    const [notification] = notificationInserts();
    expect(notification.type).toBe('member.blocked');
    expect(notification.account_id).toBe('acct-9');
    expect(
      (notification.payload as { block: { memberEmail: string } }).block
        .memberEmail
    ).toBe('carlos@acme.com');
  });

  it('usuário inexistente: not_found', async () => {
    const { client } = makeDb({
      'profiles.update': { data: null, error: null },
      'profiles.select': { data: null, error: null },
    });
    const result = await blockUser(client, CTX, 'sumiu', null);
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('unblockUser', () => {
  it('desbloqueia com sucesso, deriva account_id e grava targetUserId', async () => {
    const { client, auditInserts } = makeDb({
      'profiles.update': {
        data: {
          user_id: 'user-1',
          account_id: 'acct-9',
          email: 'carlos@acme.com',
        },
        error: null,
      },
    });
    const result = await unblockUser(client, CTX, 'user-1');
    expect(result).toEqual({ ok: true });
    expect(auditInserts()).toEqual([
      {
        actor: 'console:owner@zapcrmbr.com',
        action: 'user.unblock',
        account_id: 'acct-9',
        target_user_id: 'user-1',
        payload: {},
      },
    ]);
  });

  it('emite member.unblocked na outbox', async () => {
    const { client, notificationInserts } = makeDb({
      'profiles.update': {
        data: {
          user_id: 'user-1',
          account_id: 'acct-9',
          email: 'carlos@acme.com',
        },
        error: null,
      },
    });
    await unblockUser(client, CTX, 'user-1');
    expect(notificationInserts()[0].type).toBe('member.unblocked');
  });
});
