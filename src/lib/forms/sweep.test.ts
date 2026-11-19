import { describe, expect, it } from 'vitest';

import {
  ABANDON_AFTER_MS,
  ABANDONED_FILES_GRACE_MS,
  ACCOUNTS_PER_RUN,
  ORPHAN_SCAN_INTERVAL_MS,
  abandonStalePartials,
  expiredCutoffIso,
  nextAccountSlice,
  pickAccountFolders,
  runFormsSweep,
  selectResponseFoldersToRemove,
  staleCutoffIso,
  type SweepState,
} from './sweep';

const NOW = new Date('2026-11-19T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const H = 60 * 60 * 1000;
const D = 24 * H;

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACC = `account-${uuid(1)}`;
const FORM = uuid(2);

describe('cortes de tempo', () => {
  it('abandono em 24 h e arquivos em 7 dias', () => {
    expect(ABANDON_AFTER_MS).toBe(24 * H);
    expect(ABANDONED_FILES_GRACE_MS).toBe(7 * D);
    expect(staleCutoffIso(NOW)).toBe(ago(24 * H));
    expect(expiredCutoffIso(NOW)).toBe(ago(7 * D));
  });
});

describe('selectResponseFoldersToRemove', () => {
  const known = [
    { id: uuid(10), status: 'completed', updated_at: ago(30 * D) },
    { id: uuid(11), status: 'partial', updated_at: ago(30 * D) },
    { id: uuid(12), status: 'abandoned', updated_at: ago(8 * D) },
    { id: uuid(13), status: 'abandoned', updated_at: ago(6 * D) },
  ];

  it('remove órfã e abandonada há mais de 7 dias; mantém o resto', () => {
    const folders = [uuid(10), uuid(11), uuid(12), uuid(13), uuid(99)];
    expect(selectResponseFoldersToRemove(folders, known, NOW)).toEqual([
      uuid(12),
      uuid(99),
    ]);
  });

  it('concluída e parcial nunca saem, por mais velhas que sejam', () => {
    expect(
      selectResponseFoldersToRemove([uuid(10), uuid(11)], known, NOW)
    ).toEqual([]);
  });

  it('nome que não é UUID nunca é tocado', () => {
    expect(
      selectResponseFoldersToRemove(['tmp', 'lixo.txt', '../x'], [], NOW)
    ).toEqual([]);
  });

  it('compara UUID sem diferenciar maiúscula', () => {
    expect(
      selectResponseFoldersToRemove([uuid(10).toUpperCase()], known, NOW)
    ).toEqual([]);
  });
});

describe('contas e cursor', () => {
  it('só pastas account-<uuid>, ordenadas', () => {
    expect(
      pickAccountFolders([`account-${uuid(3)}`, 'outro', `account-${uuid(1)}`])
    ).toEqual([`account-${uuid(1)}`, `account-${uuid(3)}`]);
  });

  it('fatia circular e cursor', () => {
    const accounts = ['a', 'b', 'c', 'd', 'e'];
    expect(nextAccountSlice(accounts, 0, 2)).toEqual({
      slice: ['a', 'b'],
      nextCursor: 2,
    });
    expect(nextAccountSlice(accounts, 4, 2)).toEqual({
      slice: ['e', 'a'],
      nextCursor: 1,
    });
    expect(nextAccountSlice(accounts, 9, 10).slice).toHaveLength(5);
    expect(nextAccountSlice([], 3, 2)).toEqual({ slice: [], nextCursor: 0 });
  });

  it('o teto por varredura é 10 contas', () => {
    expect(ACCOUNTS_PER_RUN).toBe(10);
  });
});

// ------------------------------------------------------------
// Dublê de banco + Storage
// ------------------------------------------------------------

interface Row {
  id: string;
  status: string;
  updated_at: string;
}

function makeWorld(opts: {
  rows: Row[];
  /** caminho (sem barra final) → entradas */
  tree: Record<string, { name: string; id: string | null }[]>;
  dbError?: boolean;
}) {
  const removed: string[][] = [];
  const updates: { ids: string[]; patch: unknown }[] = [];
  const rows = opts.rows;

  const db = {
    storage: {
      from: () => ({
        list: async (prefix: string, o: { limit: number; offset: number }) => ({
          data: (opts.tree[prefix] ?? []).slice(o.offset, o.offset + o.limit),
          error: null,
        }),
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { data: null, error: null };
        },
      }),
    },
    from: (table: string) => {
      expect(table).toBe('form_responses');
      const ctx: {
        mode: 'select' | 'update';
        patch?: unknown;
        filters: ((r: Row) => boolean)[];
      } = { mode: 'select', filters: [] };
      const chain: Record<string, unknown> = {};
      const done = () => {
        if (opts.dbError) return { data: null, error: { message: 'boom' } };
        const hit = rows.filter((r) => ctx.filters.every((f) => f(r)));
        if (ctx.mode === 'update') {
          updates.push({ ids: hit.map((r) => r.id), patch: ctx.patch });
          for (const r of hit) Object.assign(r, ctx.patch);
        }
        return { data: hit, error: null };
      };
      chain.select = () => chain;
      chain.update = (patch: unknown) => {
        ctx.mode = 'update';
        ctx.patch = patch;
        return chain;
      };
      chain.eq = (c: keyof Row, v: string) => {
        ctx.filters.push((r) => r[c] === v);
        return chain;
      };
      chain.lt = (c: keyof Row, v: string) => {
        ctx.filters.push((r) => r[c] < v);
        return chain;
      };
      chain.in = (c: keyof Row, v: string[]) => {
        ctx.filters.push((r) => v.includes(r[c]));
        return chain;
      };
      chain.limit = () => chain;
      chain.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(done()).then(res);
      return chain;
    },
  };
  return { db: db as never, removed, updates, rows };
}

describe('abandonStalePartials', () => {
  it('marca só partial com updated_at > 24 h', async () => {
    const w = makeWorld({
      rows: [
        { id: 'old', status: 'partial', updated_at: ago(25 * H) },
        { id: 'fresh', status: 'partial', updated_at: ago(2 * H) },
        { id: 'done', status: 'completed', updated_at: ago(40 * D) },
      ],
      tree: {},
    });
    const r = await abandonStalePartials(w.db, NOW);
    expect(r).toEqual({ count: 1, error: false });
    expect(w.rows.map((x) => x.status)).toEqual([
      'abandoned',
      'partial',
      'completed',
    ]);
  });

  it('erro do banco não lança', async () => {
    const w = makeWorld({ rows: [], tree: {}, dbError: true });
    expect(await abandonStalePartials(w.db, NOW)).toEqual({
      count: 0,
      error: true,
    });
  });
});

describe('runFormsSweep', () => {
  const fresh = (): SweepState => ({ cursor: 0, lastScanAt: 0 });
  const folder = (name: string) => ({ name, id: null });
  const file = (name: string) => ({ name, id: `obj-${name}` });

  const tree = () => ({
    '': [folder(ACC), folder('lixo')],
    [ACC]: [folder(FORM)],
    [`${ACC}/${FORM}`]: [
      folder(uuid(10)), // concluída
      folder(uuid(12)), // abandonada há 8 dias
      folder(uuid(99)), // sem linha
    ],
    [`${ACC}/${FORM}/${uuid(12)}`]: [file('a.pdf'), file('b.png')],
    [`${ACC}/${FORM}/${uuid(99)}`]: [file('c.pdf')],
    [`${ACC}/${FORM}/${uuid(10)}`]: [file('keep.pdf')],
  });

  it('remove só os objetos órfãos e de abandonadas antigas, sem Storage real', async () => {
    const w = makeWorld({
      rows: [
        { id: uuid(10), status: 'completed', updated_at: ago(40 * D) },
        { id: uuid(12), status: 'abandoned', updated_at: ago(8 * D) },
        { id: 'stale', status: 'partial', updated_at: ago(30 * H) },
      ],
      tree: tree(),
    });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(res).toMatchObject({
      abandoned: 1,
      storageScanned: true,
      scannedFolders: 3,
      removedFolders: 2,
      removedObjects: 3,
      errors: 0,
    });
    expect(w.removed.flat().sort()).toEqual(
      [
        `${ACC}/${FORM}/${uuid(12)}/a.pdf`,
        `${ACC}/${FORM}/${uuid(12)}/b.png`,
        `${ACC}/${FORM}/${uuid(99)}/c.pdf`,
      ].sort()
    );
  });

  it('a varredura de Storage roda no máximo 1 vez por hora; o abandono, sempre', async () => {
    const w = makeWorld({
      rows: [{ id: 'x', status: 'partial', updated_at: ago(30 * H) }],
      tree: tree(),
    });
    const state = fresh();
    await runFormsSweep(w.db, NOW, state);
    const again = await runFormsSweep(
      w.db,
      new Date(NOW.getTime() + 5 * 60 * 1000),
      state
    );
    expect(again.storageScanned).toBe(false);
    const later = await runFormsSweep(
      w.db,
      new Date(NOW.getTime() + ORPHAN_SCAN_INTERVAL_MS + 1),
      state
    );
    expect(later.storageScanned).toBe(true);
  });

  it('falha do banco ao consultar respostas não remove NADA', async () => {
    const w = makeWorld({ rows: [], tree: tree(), dbError: true });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(w.removed).toEqual([]);
    expect(res.removedObjects).toBe(0);
    expect(res.errors).toBeGreaterThan(0);
  });
});
