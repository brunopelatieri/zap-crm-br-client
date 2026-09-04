import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

import { createSupabaseMock, opArgs } from '@/lib/audience/supabase-mock';
import { resolveCheckInstance } from './check-instance';

describe('resolveCheckInstance', () => {
  it('devolve a instância check_enabled e conectada, com o token decriptado', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'evolution_instances') {
        return { data: { id: 'inst-1', channel_id: 'chan-1' } };
      }
      if (table === 'evolution_instance_secrets') {
        return { data: { instance_token_encrypted: 'enc-token' } };
      }
      return undefined;
    });

    const result = await resolveCheckInstance(mock.db, 'acct-1');

    expect(result).toEqual({
      instanceId: 'inst-1',
      channelId: 'chan-1',
      token: 'decrypted:enc-token',
    });
  });

  it('filtra por account_id, check_enabled=true e channels.status=connected', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'evolution_instances') {
        const eqs = ops.filter((o) => o.fn === 'eq').map((o) => o.args);
        expect(eqs).toContainEqual(['account_id', 'acct-1']);
        expect(eqs).toContainEqual(['check_enabled', true]);
        expect(eqs).toContainEqual(['channels.status', 'connected']);
        return { data: null };
      }
      return undefined;
    });

    await resolveCheckInstance(mock.db, 'acct-1');
  });

  it('ordena por created_at ascendente — a mais antiga primeiro (D-10, sem UI de escolha ainda)', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'evolution_instances') {
        expect(opArgs(ops, 'order')).toEqual([
          'created_at',
          { ascending: true },
        ]);
        return { data: null };
      }
      return undefined;
    });

    await resolveCheckInstance(mock.db, 'acct-1');
  });

  it('nenhuma instância check_enabled+conectada: devolve null', async () => {
    const mock = createSupabaseMock(() => ({ data: null }));
    expect(await resolveCheckInstance(mock.db, 'acct-1')).toBeNull();
  });

  it('erro na consulta: devolve null, não lança', async () => {
    const mock = createSupabaseMock(() => ({
      data: null,
      error: { message: 'boom' },
    }));
    expect(await resolveCheckInstance(mock.db, 'acct-1')).toBeNull();
  });

  it('instância achada mas sem segredo (linha órfã): devolve null', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'evolution_instances') {
        return { data: { id: 'inst-1', channel_id: 'chan-1' } };
      }
      if (table === 'evolution_instance_secrets') {
        return { data: null };
      }
      return undefined;
    });

    expect(await resolveCheckInstance(mock.db, 'acct-1')).toBeNull();
  });
});
