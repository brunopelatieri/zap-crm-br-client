import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Cifra "visível": um vazamento de texto claro no banco quebra o teste.
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, '$1'),
}));

import {
  META_RELAY_PUBLIC_COLUMNS,
  META_RELAY_SECRET_PREFIX,
  deleteRelayConfig,
  generateRelaySecret,
  readRelayConfig,
  readRelayDeliveryConfig,
  rotateRelaySecret,
  saveRelayConfig,
  serializeMetaRelay,
} from './meta-relay-config';

type Row = Record<string, unknown>;

/** Tabela única em memória, com projeção de colunas como o PostgREST. */
function makeDb(initial: Row[] = [], opts: { conflictOnce?: Row } = {}) {
  let conflicted = false;
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const log: { selects: string[] } = { selects: [] };

  const from = () => {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let cols = '*';
    let payload: Row = {};
    const filters: Array<[string, unknown]> = [];

    const matched = () =>
      rows.filter((r) => filters.every(([c, v]) => r[c] === v));
    const project = (r: Row) => {
      if (cols === '*') return { ...r };
      const out: Row = {};
      for (const c of cols.split(',').map((x) => x.trim())) out[c] = r[c];
      return out;
    };

    const exec = (): {
      data: Row[];
      error: { code?: string; message: string } | null;
    } => {
      if (op === 'insert') {
        if (opts.conflictOnce && !conflicted) {
          // Outra requisição criou a linha um instante antes.
          conflicted = true;
          rows.push({ ...opts.conflictOnce });
          return {
            data: [],
            error: { code: '23505', message: 'duplicate key' },
          };
        }
        const row = {
          failure_count: 0,
          is_enabled: false,
          last_delivery_at: null,
          last_failure_at: null,
          auto_disabled_at: null,
          ...payload,
        };
        rows.push(row);
        return { data: [project(row)], error: null };
      }
      if (op === 'update') {
        const hit = matched();
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit.map(project), error: null };
      }
      if (op === 'delete') {
        const hit = matched();
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return { data: hit.map(project), error: null };
      }
      return { data: matched().map(project), error: null };
    };

    const b: Record<string, unknown> = {
      select: (c?: string) => {
        if (c) {
          cols = c;
          if (op === 'select') log.selects.push(c);
        }
        return b;
      },
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return b;
      },
      insert: (p: Row) => {
        op = 'insert';
        payload = p;
        return b;
      },
      update: (p: Row) => {
        op = 'update';
        payload = p;
        return b;
      },
      delete: () => {
        op = 'delete';
        return b;
      },
      maybeSingle: async () => {
        const r = exec();
        return { data: r.data[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = exec();
        return { data: r.data[0] ?? null, error: r.error };
      },
      then: (resolve: (v: unknown) => unknown) => resolve(exec()),
    };
    return b;
  };

  return { db: { from } as unknown as SupabaseClient, rows, log };
}

const existing = (over: Row = {}): Row => ({
  account_id: 'acct-a',
  url: 'https://a.test/hook',
  secret: 'enc(whrelay_old)',
  is_enabled: true,
  failure_count: 4,
  last_delivery_at: null,
  last_failure_at: '2026-11-01T00:00:00Z',
  auto_disabled_at: null,
  updated_at: '2026-11-01T00:00:00Z',
  ...over,
});

describe('colunas e serialização', () => {
  it('as colunas públicas nunca incluem `secret`', () => {
    expect(
      META_RELAY_PUBLIC_COLUMNS.split(',').map((c) => c.trim())
    ).not.toContain('secret');
  });

  it('serializeMetaRelay não deixa passar um `secret` presente na linha', () => {
    const out = serializeMetaRelay({
      ...existing(),
      secret: 'enc(whrelay_old)',
    });
    expect(Object.keys(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('whrelay_old');
  });

  it('generateRelaySecret: prefixo, entropia e unicidade', () => {
    const a = generateRelaySecret();
    const b = generateRelaySecret();
    expect(a.startsWith(META_RELAY_SECRET_PREFIX)).toBe(true);
    expect(a.length).toBeGreaterThan(META_RELAY_SECRET_PREFIX.length + 40);
    expect(a).not.toBe(b);
  });
});

describe('leitura', () => {
  it('readRelayConfig: null sem linha; com linha, nunca o segredo', async () => {
    const { db, log } = makeDb([existing()]);
    expect(await readRelayConfig(db, 'acct-zzz')).toBeNull();
    const relay = await readRelayConfig(db, 'acct-a');
    expect(relay).toMatchObject({
      url: 'https://a.test/hook',
      failure_count: 4,
    });
    expect(JSON.stringify(relay)).not.toContain('whrelay_old');
    expect(log.selects.every((c) => !c.includes('secret'))).toBe(true);
  });

  it('readRelayDeliveryConfig decifra a chave; a conta B não lê a da A', async () => {
    const { db } = makeDb([existing()]);
    expect(await readRelayDeliveryConfig(db, 'acct-a')).toEqual({
      url: 'https://a.test/hook',
      secret: 'whrelay_old',
    });
    expect(await readRelayDeliveryConfig(db, 'acct-b')).toBeNull();
  });
});

describe('saveRelayConfig', () => {
  it('criação: gera a chave, devolve em claro UMA vez e grava cifrada', async () => {
    const { db, rows } = makeDb();
    const res = await saveRelayConfig(db, 'acct-a', {
      url: 'https://a.test/hook',
      isEnabled: false,
      userId: 'user-1',
    });

    expect(res.secret).toMatch(/^whrelay_/);
    expect(rows).toHaveLength(1);
    expect(rows[0].secret).toBe(`enc(${res.secret})`);
    expect(rows[0].secret).not.toBe(res.secret);
    expect(rows[0].updated_by).toBe('user-1');
    expect(JSON.stringify(res.relay)).not.toContain(res.secret as string);
    expect(Object.keys(res.relay)).not.toContain('secret');

    // Ler depois não devolve mais a chave.
    expect(JSON.stringify(await readRelayConfig(db, 'acct-a'))).not.toContain(
      res.secret as string
    );
  });

  it('duas primeiras gravações simultâneas: a perdedora vira atualização, sem erro e sem segunda chave', async () => {
    const { db, rows } = makeDb([], {
      conflictOnce: existing({ failure_count: 0 }),
    });
    const res = await saveRelayConfig(db, 'acct-a', {
      url: 'https://a2.test/hook',
      isEnabled: false,
      userId: 'user-1',
    });
    expect(res.secret).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0].secret).toBe('enc(whrelay_old)');
    expect(rows[0].url).toBe('https://a2.test/hook');
  });

  it('atualização: não devolve chave nem a altera', async () => {
    const { db, rows } = makeDb([existing({ failure_count: 0 })]);
    const res = await saveRelayConfig(db, 'acct-a', {
      url: 'https://a.test/hook',
      isEnabled: true,
      userId: 'user-2',
    });
    expect(res.secret).toBeUndefined();
    expect(rows[0].secret).toBe('enc(whrelay_old)');
    expect(rows[0].updated_by).toBe('user-2');
  });

  it('religar zera failure_count e auto_disabled_at', async () => {
    const { db, rows } = makeDb([
      existing({
        is_enabled: false,
        failure_count: 15,
        auto_disabled_at: '2026-11-02T00:00:00Z',
      }),
    ]);
    const res = await saveRelayConfig(db, 'acct-a', {
      url: 'https://a.test/hook',
      isEnabled: true,
      userId: null,
    });
    expect(rows[0]).toMatchObject({
      is_enabled: true,
      failure_count: 0,
      auto_disabled_at: null,
    });
    expect(res.relay).toMatchObject({
      failure_count: 0,
      auto_disabled_at: null,
    });
  });

  it('só gravar (sem religar nem trocar a URL) preserva os contadores', async () => {
    const { db, rows } = makeDb([existing({ failure_count: 4 })]);
    await saveRelayConfig(db, 'acct-a', {
      url: 'https://a.test/hook',
      isEnabled: true,
      userId: null,
    });
    expect(rows[0].failure_count).toBe(4);
  });

  it('só mexe na linha da conta informada', async () => {
    const { db, rows } = makeDb([
      existing(),
      existing({ account_id: 'acct-b', url: 'https://b.test/hook' }),
    ]);
    await saveRelayConfig(db, 'acct-a', {
      url: 'https://a2.test/hook',
      isEnabled: true,
      userId: null,
    });
    expect(rows[1].url).toBe('https://b.test/hook');
  });
});

describe('rotateRelaySecret e deleteRelayConfig', () => {
  it('rotação: chave nova cifrada, a antiga some; null sem config', async () => {
    const { db, rows } = makeDb([existing()]);
    const next = await rotateRelaySecret(db, 'acct-a', 'user-1');
    expect(next).toMatch(/^whrelay_/);
    expect(next).not.toBe('whrelay_old');
    expect(rows[0].secret).toBe(`enc(${next})`);
    expect((await readRelayDeliveryConfig(db, 'acct-a'))?.secret).toBe(next);

    expect(await rotateRelaySecret(db, 'acct-b', null)).toBeNull();
  });

  it('remoção apaga só a conta informada', async () => {
    const { db, rows } = makeDb([
      existing(),
      existing({ account_id: 'acct-b' }),
    ]);
    expect(await deleteRelayConfig(db, 'acct-a')).toBe(true);
    expect(await deleteRelayConfig(db, 'acct-a')).toBe(false);
    expect(rows.map((r) => r.account_id)).toEqual(['acct-b']);
  });
});
