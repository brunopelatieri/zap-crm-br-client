import { describe, expect, it } from 'vitest';

import {
  ABANDON_AFTER_MS,
  ABANDONED_FILES_GRACE_MS,
  ACCOUNTS_PER_RUN,
  FOLDERS_PRUNED_PER_ACCOUNT,
  UNREFERENCED_FILES_GRACE_MS,
  ORPHAN_SCAN_INTERVAL_MS,
  abandonStalePartials,
  expiredCutoffIso,
  nextAccountSlice,
  nextFolderSlice,
  pickAccountFolders,
  referencedFilePaths,
  runFormsSweep,
  selectResponseFoldersToRemove,
  selectUnreferencedObjects,
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

describe('referencedFilePaths', () => {
  const entry = (value: unknown, type = 'file_upload') => ({
    type,
    label: 'x',
    value,
  });

  it('junta os caminhos de todos os blocos de arquivo, em minúsculas', () => {
    const set = referencedFilePaths({
      a: entry([{ path: 'P/A.pdf' }, { path: 'p/b.pdf' }]),
      b: entry('texto', 'short_text'),
      c: entry(null),
    });
    expect([...(set ?? [])].sort()).toEqual(['p/a.pdf', 'p/b.pdf']);
  });

  it('forma inesperada devolve null (nada pode ser removido)', () => {
    expect(referencedFilePaths(null)).toBeNull();
    expect(referencedFilePaths([])).toBeNull();
    expect(referencedFilePaths('x')).toBeNull();
    expect(referencedFilePaths({ a: 'x' })).toBeNull();
    expect(referencedFilePaths({ a: entry('p/a.pdf') })).toBeNull();
    expect(
      referencedFilePaths({ a: entry([{ name: 'sem path' }]) })
    ).toBeNull();
    expect(referencedFilePaths({ a: entry([null]) })).toBeNull();
  });

  it('resposta sem arquivos é válida e vazia', () => {
    expect(referencedFilePaths({})?.size).toBe(0);
  });
});

describe('selectUnreferencedObjects', () => {
  const PREFIX = `${ACC}/${FORM}/${uuid(10)}`;
  const obj = (name: string, created: string | null | undefined) => ({
    name,
    created_at: created,
  });
  const answersWith = (...names: string[]) => ({
    doc: {
      type: 'file_upload',
      label: 'Doc',
      value: names.map((n) => ({ path: `${PREFIX}/${n}` })),
    },
  });

  it('a folga é de 24 h (maior que a URL assinada de 2 h)', () => {
    expect(UNREFERENCED_FILES_GRACE_MS).toBe(24 * H);
  });

  it('remove o antigo sem referência; mantém referenciado, recente e sem idade', () => {
    const out = selectUnreferencedObjects(
      PREFIX,
      [
        obj('ref.pdf', ago(3 * D)),
        obj('velho.pdf', ago(25 * H)),
        obj('novo.pdf', ago(23 * H)),
        obj('sem-data.pdf', null),
        obj('lixo.pdf', 'não é data'),
      ],
      answersWith('ref.pdf'),
      NOW
    );
    expect(out).toEqual([`${PREFIX}/velho.pdf`]);
  });

  it('referenciado nunca sai, por mais velho que seja', () => {
    expect(
      selectUnreferencedObjects(
        PREFIX,
        [obj('ref.pdf', ago(400 * D))],
        answersWith('ref.pdf'),
        NOW
      )
    ).toEqual([]);
  });

  it('usa o instante mais recente entre criação e alteração', () => {
    expect(
      selectUnreferencedObjects(
        PREFIX,
        [{ name: 'a.pdf', created_at: ago(3 * D), updated_at: ago(1 * H) }],
        {},
        NOW
      )
    ).toEqual([]);
  });

  it('sem answers legível nada é removido', () => {
    const objs = [obj('velho.pdf', ago(30 * D))];
    expect(selectUnreferencedObjects(PREFIX, objs, null, NOW)).toEqual([]);
    expect(selectUnreferencedObjects(PREFIX, objs, undefined, NOW)).toEqual([]);
    expect(selectUnreferencedObjects(PREFIX, objs, 'x', NOW)).toEqual([]);
  });

  it('resposta concluída sem arquivos: tudo que passou da folga sai', () => {
    expect(
      selectUnreferencedObjects(
        PREFIX,
        [obj('a.pdf', ago(2 * D)), obj('b.pdf', ago(2 * H))],
        {},
        NOW
      )
    ).toEqual([`${PREFIX}/a.pdf`]);
  });
});

describe('nextFolderSlice', () => {
  const ids = ['d', 'a', 'c', 'b'];

  it('começa depois do cursor, em ordem alfabética e circular', () => {
    expect(nextFolderSlice(ids, undefined, 2)).toEqual(['a', 'b']);
    expect(nextFolderSlice(ids, 'b', 2)).toEqual(['c', 'd']);
    expect(nextFolderSlice(ids, 'c', 3)).toEqual(['d', 'a', 'b']);
  });

  it('cursor depois do último (ou de pasta que sumiu) não perde nem repete', () => {
    expect(nextFolderSlice(ids, 'd', 2)).toEqual(['a', 'b']);
    // 'bb' já não existe: continua no primeiro maior.
    expect(nextFolderSlice(ids, 'bb', 1)).toEqual(['c']);
  });

  it('vazio e limite maior que a lista', () => {
    expect(nextFolderSlice([], undefined, 5)).toEqual([]);
    expect(nextFolderSlice(ids, undefined, 0)).toEqual([]);
    expect(nextFolderSlice(ids, undefined, 9)).toEqual(['a', 'b', 'c', 'd']);
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
  answers?: unknown;
}

type ScalarCol = 'id' | 'status' | 'updated_at';

interface TreeEntry {
  name: string;
  id: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function makeWorld(opts: {
  rows: Row[];
  /** caminho (sem barra final) → entradas */
  tree: Record<string, TreeEntry[]>;
  dbError?: boolean;
  /** Só a leitura de `answers` falha (o resto do banco responde). */
  answersError?: boolean;
  /** `list` falha nestes prefixos. */
  listErrorPrefixes?: string[];
  /** `remove` falha. */
  removeError?: boolean;
  proofsDeleted?: number;
}) {
  const proofCuts: { column: string; value: string }[] = [];
  const removed: string[][] = [];
  const updates: { ids: string[]; patch: unknown }[] = [];
  const rows = opts.rows;

  const db = {
    storage: {
      from: () => ({
        list: async (prefix: string, o: { limit: number; offset: number }) =>
          opts.listErrorPrefixes?.includes(prefix)
            ? { data: null, error: { message: 'boom' } }
            : {
                data: (opts.tree[prefix] ?? []).slice(
                  o.offset,
                  o.offset + o.limit
                ),
                error: null,
              },
        remove: async (paths: string[]) => {
          if (opts.removeError) {
            return { data: null, error: { message: 'boom' } };
          }
          removed.push(paths);
          // Como o Storage real: o objeto removido some da próxima listagem
          // e a pasta que fica vazia some junto (pasta é só prefixo).
          for (const path of paths) {
            const slash = path.lastIndexOf('/');
            const dir = path.slice(0, slash);
            opts.tree[dir] = (opts.tree[dir] ?? []).filter(
              (e) => e.name !== path.slice(slash + 1)
            );
            if (opts.tree[dir].length === 0) {
              const up = dir.lastIndexOf('/');
              const parent = dir.slice(0, up);
              opts.tree[parent] = (opts.tree[parent] ?? []).filter(
                (e) => e.name !== dir.slice(up + 1)
              );
            }
          }
          return { data: null, error: null };
        },
      }),
    },
    from: (table: string) => {
      if (table === 'form_phone_proofs') {
        // F7: a varredura também apaga provas de telefone vencidas.
        const proofs: Record<string, unknown> = {};
        proofs.delete = () => proofs;
        proofs.lt = (c: string, v: string) => {
          proofCuts.push({ column: c, value: v });
          return proofs;
        };
        proofs.select = () => proofs;
        proofs.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({
            data: opts.dbError
              ? null
              : Array.from({ length: opts.proofsDeleted ?? 0 }, (_, i) => ({
                  id: i,
                })),
            error: opts.dbError ? { message: 'boom' } : null,
          }).then(res);
        return proofs;
      }
      expect(table).toBe('form_responses');
      const ctx: {
        mode: 'select' | 'update';
        cols?: string;
        patch?: unknown;
        filters: ((r: Row) => boolean)[];
      } = { mode: 'select', filters: [] };
      const chain: Record<string, unknown> = {};
      const done = () => {
        if (opts.dbError) return { data: null, error: { message: 'boom' } };
        if (opts.answersError && ctx.cols?.includes('answers')) {
          return { data: null, error: { message: 'boom' } };
        }
        const hit = rows.filter((r) => ctx.filters.every((f) => f(r)));
        if (ctx.mode === 'update') {
          updates.push({ ids: hit.map((r) => r.id), patch: ctx.patch });
          for (const r of hit) Object.assign(r, ctx.patch);
        }
        return { data: hit, error: null };
      };
      chain.select = (cols?: string) => {
        ctx.cols = cols;
        return chain;
      };
      chain.update = (patch: unknown) => {
        ctx.mode = 'update';
        ctx.patch = patch;
        return chain;
      };
      chain.eq = (c: ScalarCol, v: string) => {
        ctx.filters.push((r) => r[c] === v);
        return chain;
      };
      chain.lt = (c: ScalarCol, v: string) => {
        ctx.filters.push((r) => r[c] < v);
        return chain;
      };
      chain.in = (c: ScalarCol, v: string[]) => {
        ctx.filters.push((r) => v.includes(r[c]));
        return chain;
      };
      chain.limit = () => chain;
      chain.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(done()).then(res);
      return chain;
    },
  };
  return { db: db as never, removed, updates, rows, proofCuts };
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
  const fresh = (): SweepState => ({
    cursor: 0,
    lastScanAt: 0,
    pruneCursors: {},
  });
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

  it('apaga provas de telefone vencidas há mais de 1 dia, em todo tick (F7)', async () => {
    const w = makeWorld({ rows: [], tree: tree(), proofsDeleted: 4 });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(res.phoneProofsRemoved).toBe(4);
    expect(w.proofCuts).toEqual([
      {
        column: 'expires_at',
        value: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);
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

describe('runFormsSweep — objetos sem referência em resposta concluída', () => {
  const fresh = (): SweepState => ({
    cursor: 0,
    lastScanAt: 0,
    pruneCursors: {},
  });
  const folder = (name: string): TreeEntry => ({ name, id: null });
  const file = (name: string, created: string | null): TreeEntry => ({
    name,
    id: `obj-${name}`,
    created_at: created,
    updated_at: created,
  });

  const RID = uuid(10);
  const PREFIX = `${ACC}/${FORM}/${RID}`;
  const answers = {
    doc: {
      type: 'file_upload',
      label: 'Doc',
      value: [{ path: `${PREFIX}/ok.pdf`, name: 'ok.pdf' }],
    },
  };

  const world = (
    over: Partial<Parameters<typeof makeWorld>[0]> = {},
    rowAnswers: unknown = answers
  ) =>
    makeWorld({
      rows: [
        {
          id: RID,
          status: 'completed',
          updated_at: ago(40 * D),
          answers: rowAnswers,
        },
      ],
      tree: {
        '': [folder(ACC)],
        [ACC]: [folder(FORM)],
        [`${ACC}/${FORM}`]: [folder(RID)],
        [PREFIX]: [
          file('ok.pdf', ago(3 * D)), // referenciado
          file('extra-1.pdf', ago(3 * D)), // sem referência e antigo
          file('extra-2.exe', ago(26 * H)), // sem referência e antigo
          file('recente.pdf', ago(2 * H)), // sem referência, dentro da folga
        ],
      },
      ...over,
    });

  it('remove o antigo sem referência; referenciado e recente ficam', async () => {
    const w = world();
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(w.removed.flat().sort()).toEqual([
      `${PREFIX}/extra-1.pdf`,
      `${PREFIX}/extra-2.exe`,
    ]);
    expect(res).toMatchObject({
      removedUnreferenced: 2,
      removedObjects: 2,
      removedFolders: 0,
      errors: 0,
    });
  });

  it('nunca remove o arquivo referenciado, por mais antigo que seja', async () => {
    const w = world({
      tree: {
        '': [folder(ACC)],
        [ACC]: [folder(FORM)],
        [`${ACC}/${FORM}`]: [folder(RID)],
        [PREFIX]: [file('ok.pdf', ago(900 * D))],
      },
    });
    await runFormsSweep(w.db, NOW, fresh());
    expect(w.removed).toEqual([]);
  });

  it('não lê a idade do objeto: nada é removido', async () => {
    const w = world({
      tree: {
        '': [folder(ACC)],
        [ACC]: [folder(FORM)],
        [`${ACC}/${FORM}`]: [folder(RID)],
        [PREFIX]: [file('extra.pdf', null)],
      },
    });
    await runFormsSweep(w.db, NOW, fresh());
    expect(w.removed).toEqual([]);
  });

  it('erro ao ler answers não remove nada e conta o erro', async () => {
    const w = world({ answersError: true });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(w.removed).toEqual([]);
    expect(res.removedUnreferenced).toBe(0);
    expect(res.errors).toBeGreaterThan(0);
  });

  it('answers ilegível (null ou forma estranha) não remove nada', async () => {
    for (const bad of [null, 'x', { doc: 'x' }]) {
      const w = world({}, bad);
      await runFormsSweep(w.db, NOW, fresh());
      expect(w.removed).toEqual([]);
    }
  });

  it('erro ao listar a pasta da resposta não remove nada', async () => {
    const w = world({ listErrorPrefixes: [PREFIX] });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(w.removed).toEqual([]);
    expect(res.errors).toBeGreaterThan(0);
  });

  it('erro no remove conta o erro e não conta objeto removido', async () => {
    const w = world({ removeError: true });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(res.removedUnreferenced).toBe(0);
    expect(res.removedObjects).toBe(0);
    expect(res.errors).toBeGreaterThan(0);
  });

  it('não mexe em resposta partial nem abandonada recente', async () => {
    for (const status of ['partial', 'abandoned']) {
      const w = makeWorld({
        rows: [{ id: RID, status, updated_at: ago(2 * D), answers: {} }],
        tree: {
          '': [folder(ACC)],
          [ACC]: [folder(FORM)],
          [`${ACC}/${FORM}`]: [folder(RID)],
          [PREFIX]: [file('x.pdf', ago(30 * D))],
        },
      });
      await runFormsSweep(w.db, NOW, fresh());
      expect(w.removed).toEqual([]);
    }
  });

  it('o teto é por conta e o cursor cobre as pastas restantes (pasta esvaziada some do Storage)', async () => {
    const total = FOLDERS_PRUNED_PER_ACCOUNT + 5;
    const ids = Array.from({ length: total }, (_, i) => uuid(1000 + i));
    const rows = ids.map((id) => ({
      id,
      status: 'completed',
      updated_at: ago(40 * D),
      answers: {},
    }));
    const tree: Record<string, TreeEntry[]> = {
      '': [folder(ACC)],
      [ACC]: [folder(FORM)],
      [`${ACC}/${FORM}`]: ids.map(folder),
    };
    for (const id of ids) {
      tree[`${ACC}/${FORM}/${id}`] = [file('velho.pdf', ago(5 * D))];
    }
    const w = makeWorld({ rows, tree });
    const state = fresh();

    const first = await runFormsSweep(w.db, NOW, state);
    expect(first.removedUnreferenced).toBe(FOLDERS_PRUNED_PER_ACCOUNT);

    const later = new Date(NOW.getTime() + ORPHAN_SCAN_INTERVAL_MS + 1);
    const second = await runFormsSweep(w.db, later, state);
    expect(second.removedUnreferenced).toBe(5);
    expect(w.removed.flat()).toHaveLength(total);
    expect(new Set(w.removed.flat()).size).toBe(total);
  });
  it('uma conta grande não esgota o orçamento das demais da mesma varredura', async () => {
    const ACC2 = `account-${uuid(7)}`;
    const FORM2 = uuid(8);
    const big = Array.from(
      { length: FOLDERS_PRUNED_PER_ACCOUNT + 20 },
      (_, i) => uuid(2000 + i)
    );
    const small = uuid(3000);
    const rows = [...big, small].map((id) => ({
      id,
      status: 'completed',
      updated_at: ago(40 * D),
      answers: {},
    }));
    const tree: Record<string, TreeEntry[]> = {
      '': [folder(ACC), folder(ACC2)],
      [ACC]: [folder(FORM)],
      [`${ACC}/${FORM}`]: big.map(folder),
      [ACC2]: [folder(FORM2)],
      [`${ACC2}/${FORM2}`]: [folder(small)],
      [`${ACC2}/${FORM2}/${small}`]: [file('velho.pdf', ago(5 * D))],
    };
    for (const id of big) {
      tree[`${ACC}/${FORM}/${id}`] = [file('velho.pdf', ago(5 * D))];
    }
    const w = makeWorld({ rows, tree });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(res.removedUnreferenced).toBe(FOLDERS_PRUNED_PER_ACCOUNT + 1);
    expect(w.removed.flat()).toContain(`${ACC2}/${FORM2}/${small}/velho.pdf`);
  });
});
