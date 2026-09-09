import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// `supabaseAdmin()` é mockado no módulo, no mesmo padrão de
// `route.test.ts` da SPEC 074 — `recordActivity` SEMPRE grava por ali
// (ver o cabeçalho de record.ts sobre por que `db` não serve para o
// INSERT: a 084 revogou o grant de authenticated/anon).
// ------------------------------------------------------------
let adminInserts: Record<string, unknown>[] = [];
let insertShouldError = false;

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        adminInserts.push({ __table: table, ...row });
        return Promise.resolve({
          error: insertShouldError ? { message: 'boom' } : null,
        });
      },
    }),
  }),
}));

import { recordActivity } from './record';

function fakeSessionDb(profileRow: Record<string, unknown> | null = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: profileRow, error: null }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  adminInserts = [];
  insertShouldError = false;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('recordActivity — caminho feliz', () => {
  it('grava a linha com os campos completos quando actor.name/role já vêm no chamador', async () => {
    await recordActivity(fakeSessionDb(), {
      accountId: 'acct-1',
      resourceType: 'contact',
      action: 'contact.created',
      resourceId: 'contact-1',
      resourceLabel: 'Ana Paula',
      actor: { kind: 'user', userId: 'user-1', name: 'Bruno', role: 'owner' },
      metadata: { created_via: 'manual' },
    });

    expect(adminInserts).toEqual([
      {
        __table: 'account_activity_log',
        account_id: 'acct-1',
        actor_kind: 'user',
        actor_user_id: 'user-1',
        actor_name: 'Bruno',
        actor_role: 'owner',
        resource_type: 'contact',
        action: 'contact.created',
        resource_id: 'contact-1',
        resource_label: 'Ana Paula',
        channel_id: null,
        channel_type: null,
        conversation_id: null,
        contact_id: null,
        source_table: null,
        source_id: null,
        metadata: { created_via: 'manual' },
      },
    ]);
  });

  it('ator "system" não consulta profiles e não tem userId', async () => {
    const db = fakeSessionDb();
    const spy = vi.spyOn(db, 'from');

    await recordActivity(db, {
      accountId: 'acct-1',
      resourceType: 'broadcast',
      action: 'broadcast.dispatched',
      actor: { kind: 'system', name: 'cron' },
    });

    expect(spy).not.toHaveBeenCalled();
    expect(adminInserts[0]).toMatchObject({
      actor_kind: 'system',
      actor_user_id: null,
      actor_name: 'cron',
      actor_role: null,
    });
  });

  it('enriquece nome/papel via profiles quando o chamador não os informa', async () => {
    const db = fakeSessionDb({ full_name: 'Marina', account_role: 'agent' });

    await recordActivity(db, {
      accountId: 'acct-1',
      resourceType: 'conversation',
      action: 'conversation.assigned',
      actor: { kind: 'user', userId: 'user-2' },
    });

    expect(adminInserts[0]).toMatchObject({
      actor_user_id: 'user-2',
      actor_name: 'Marina',
      actor_role: 'agent',
    });
  });
});

describe('recordActivity — regra 1: resourceLabel truncado em 160', () => {
  it('corta o rótulo em 160 caracteres', async () => {
    const longLabel = 'x'.repeat(300);

    await recordActivity(fakeSessionDb(), {
      accountId: 'acct-1',
      resourceType: 'deal',
      action: 'deal.created',
      resourceLabel: longLabel,
      actor: { kind: 'system' },
    });

    const row = adminInserts[0];
    expect((row.resource_label as string).length).toBe(160);
  });

  it('rótulo ausente vira null, não string vazia', async () => {
    await recordActivity(fakeSessionDb(), {
      accountId: 'acct-1',
      resourceType: 'deal',
      action: 'deal.created',
      actor: { kind: 'system' },
    });

    expect(adminInserts[0].resource_label).toBeNull();
  });
});

describe('recordActivity — regra 2: nenhum segredo em metadata', () => {
  it('remove chaves proibidas em qualquer profundidade, sem lançar', async () => {
    await recordActivity(fakeSessionDb(), {
      accountId: 'acct-1',
      resourceType: 'channel',
      action: 'channel.connected',
      actor: { kind: 'system' },
      metadata: {
        note: 'ok',
        token: 'segredo',
        nested: { apiKey: 'segredo-2', fine: 'ok-2' },
        Authorization: 'Bearer segredo-3',
      },
    });

    expect(adminInserts[0].metadata).toEqual({
      note: 'ok',
      nested: { fine: 'ok-2' },
    });
  });

  it('metadata ausente vira objeto vazio', async () => {
    await recordActivity(fakeSessionDb(), {
      accountId: 'acct-1',
      resourceType: 'channel',
      action: 'channel.connected',
      actor: { kind: 'system' },
    });

    expect(adminInserts[0].metadata).toEqual({});
  });
});

describe('recordActivity — regra 3: metadata truncado em 4 KB', () => {
  it('substitui metadata grande por um marcador, sem lançar', async () => {
    await recordActivity(fakeSessionDb(), {
      accountId: 'acct-1',
      resourceType: 'broadcast',
      action: 'broadcast.created',
      actor: { kind: 'system' },
      metadata: {
        recipients: Array.from({ length: 3000 }, (_, i) => `+551199999${i}`),
      },
    });

    const md = adminInserts[0].metadata as Record<string, unknown>;
    expect(md.truncated).toBe(true);
  });
});

describe('recordActivity — regra 4: actor "user" exige userId', () => {
  it('descarta o evento (não grava) quando userId está vazio', async () => {
    await recordActivity(fakeSessionDb(), {
      accountId: 'acct-1',
      resourceType: 'contact',
      action: 'contact.created',
      actor: { kind: 'user', userId: '' },
    });

    expect(adminInserts).toHaveLength(0);
  });
});

describe('recordActivity — catálogo fechado', () => {
  it('descarta uma action que não pertence ao resourceType', async () => {
    await recordActivity(fakeSessionDb(), {
      accountId: 'acct-1',
      resourceType: 'contact',
      // 'deal.created' é uma ActivityAction válida (união fechada), só
      // não pertence ao catálogo de 'contact' — é isso que o teste
      // verifica: a checagem por par (resourceType, action) é em
      // runtime, não só em tipo.
      action: 'deal.created',
      actor: { kind: 'system' },
    });

    expect(adminInserts).toHaveLength(0);
  });
});

describe('recordActivity — regra 5: nunca lança', () => {
  it('resolve normalmente quando o INSERT falha — só loga', async () => {
    insertShouldError = true;

    await expect(
      recordActivity(fakeSessionDb(), {
        accountId: 'acct-1',
        resourceType: 'plan',
        action: 'plan.changed',
        actor: { kind: 'system' },
      })
    ).resolves.toBeUndefined();
  });

  it('resolve normalmente mesmo sem accountId', async () => {
    await expect(
      recordActivity(fakeSessionDb(), {
        accountId: '',
        resourceType: 'plan',
        action: 'plan.changed',
        actor: { kind: 'system' },
      })
    ).resolves.toBeUndefined();
    expect(adminInserts).toHaveLength(0);
  });

  it('resolve normalmente quando a consulta de enriquecimento lança', async () => {
    const throwingDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.reject(new Error('conexão caiu')),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      recordActivity(throwingDb, {
        accountId: 'acct-1',
        resourceType: 'contact',
        action: 'contact.created',
        actor: { kind: 'user', userId: 'user-3' },
      })
    ).resolves.toBeUndefined();

    // O evento ainda é gravado, sem nome/papel.
    expect(adminInserts[0]).toMatchObject({
      actor_user_id: 'user-3',
      actor_name: null,
      actor_role: null,
    });
  });
});
