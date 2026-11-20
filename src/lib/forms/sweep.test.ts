import { describe, expect, it } from 'vitest';

import {
  ABANDON_AFTER_MS,
  ABANDONED_FILES_GRACE_MS,
  ACCOUNTS_PER_RUN,
  FOLDERS_PRUNED_PER_ACCOUNT,
  UNREFERENCED_FILES_GRACE_MS,
  ORPHAN_SCAN_INTERVAL_MS,
  abandonStalePartials,
  answersReferenceText,
  expiredCutoffIso,
  isReferenced,
  nextAccountSlice,
  nextFolderSlice,
  pickAccountFolders,
  pruneDryRunFromEnv,
  pruneStaleCursors,
  runFormsSweep,
  selectResponseFoldersToRemove,
  selectUnreferencedObjects,
  staleCutoffIso,
  type SweepState,
} from './sweep';

const NOW = new Date('2026-11-19T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60 * 1000;
const H = 60 * MIN;
const D = 24 * H;

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACC = `account-${uuid(1)}`;
const FORM = uuid(2);
/** Nome de objeto no padrão `<uuid>.<ext>` (o único que a poda pode remover). */
const oname = (n: number, ext = 'pdf') => `${uuid(900000 + n)}.${ext}`;

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

describe('answersReferenceText / isReferenced (M-2)', () => {
  const PATH = `${ACC}/${FORM}/${uuid(10)}/${oname(1)}`;
  const entry = (value: unknown, type = 'file_upload') => ({
    type,
    label: 'x',
    value,
  });
  const refs = (answers: unknown, name = oname(1)) => {
    const text = answersReferenceText(answers);
    return text !== null && isReferenced(text, name.split('.')[0]);
  };

  it('bloco file_upload: caminho em { path }', () => {
    expect(refs({ doc: entry([{ path: PATH, name: 'a.pdf' }]) })).toBe(true);
  });

  it('bloco de TIPO DESCONHECIDO que guarda o caminho continua referenciando', () => {
    expect(refs({ sig: entry([{ path: PATH }], 'signature') })).toBe(true);
    expect(refs({ sig: entry(PATH, 'image_choice') })).toBe(true);
    expect(refs({ sig: { label: 'sem type', value: PATH } })).toBe(true);
  });

  it('valor aninhado, objeto com `path` e string solta', () => {
    expect(
      refs({ x: entry({ deep: [{ a: { b: [{ path: PATH }] } }] }, 'novo') })
    ).toBe(true);
    expect(refs({ x: entry({ path: PATH }, 'novo') })).toBe(true);
    expect(refs({ x: entry(`veja ${PATH} no anexo`, 'short_text') })).toBe(
      true
    );
    // só o `<objectId>.<ext>` do segmento final (sem a pasta) basta.
    expect(refs({ x: entry(oname(1), 'short_text') })).toBe(true);
  });

  it('compara sem diferenciar maiúsculas e olha as chaves também', () => {
    expect(refs({ doc: entry([{ path: PATH.toUpperCase() }]) })).toBe(true);
    expect(refs({ [PATH]: entry('x', 'short_text') })).toBe(true);
  });

  it('objeto que ninguém cita não é referenciado', () => {
    expect(
      refs({
        doc: entry([{ path: `${ACC}/${FORM}/${uuid(10)}/${oname(2)}` }]),
        t: entry('texto', 'short_text'),
        n: entry(3, 'number'),
      })
    ).toBe(false);
  });

  it('forma inesperada devolve null (nada pode ser removido)', () => {
    expect(answersReferenceText(null)).toBeNull();
    expect(answersReferenceText([])).toBeNull();
    expect(answersReferenceText('x')).toBeNull();
    expect(answersReferenceText({ a: 'x' })).toBeNull();
    expect(answersReferenceText({ a: entry('p/a.pdf') })).toBeNull();
    expect(
      answersReferenceText({ a: entry([{ name: 'sem path' }]) })
    ).toBeNull();
    expect(answersReferenceText({ a: entry([null]) })).toBeNull();
  });

  it('JSON fundo demais não é julgado: null', () => {
    let deep: unknown = PATH;
    for (let i = 0; i < 50; i++) deep = { n: deep };
    expect(answersReferenceText({ a: entry(deep, 'novo') })).toBeNull();
  });

  it('resposta sem arquivos é válida e vazia', () => {
    expect(answersReferenceText({})).toBe('');
  });
});

describe('selectUnreferencedObjects', () => {
  const PREFIX = `${ACC}/${FORM}/${uuid(10)}`;
  const obj = (name: string, created: string | null | undefined) => ({
    name,
    created_at: created,
    updated_at: created,
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
        obj(oname(1), ago(3 * D)),
        obj(oname(2), ago(25 * H)),
        obj(oname(3), ago(23 * H)),
        obj(oname(4), null),
        obj(oname(5), 'não é data'),
      ],
      answersWith(oname(1)),
      NOW
    );
    expect(out.remove).toEqual([`${PREFIX}/${oname(2)}`]);
    expect(out.skippedNoDate).toBe(2);
  });

  it('referenciado nunca sai, por mais velho que seja', () => {
    expect(
      selectUnreferencedObjects(
        PREFIX,
        [obj(oname(1), ago(400 * D))],
        answersWith(oname(1)),
        NOW
      ).remove
    ).toEqual([]);
  });

  it('perto do limite de 24 h: 23h59 fica, exatamente 24 h fica, 24h01 sai', () => {
    const out = selectUnreferencedObjects(
      PREFIX,
      [
        obj(oname(1), ago(24 * H - MIN)),
        obj(oname(2), ago(24 * H)),
        obj(oname(3), ago(24 * H + MIN)),
      ],
      {},
      NOW
    );
    expect(out.remove).toEqual([`${PREFIX}/${oname(3)}`]);
  });

  it('data futura (relógio fora de sincronia) não remove', () => {
    expect(
      selectUnreferencedObjects(
        PREFIX,
        [obj(oname(1), new Date(NOW.getTime() + D).toISOString())],
        {},
        NOW
      ).remove
    ).toEqual([]);
  });

  it('usa o instante mais recente entre criação e alteração', () => {
    expect(
      selectUnreferencedObjects(
        PREFIX,
        [
          {
            name: oname(1),
            created_at: ago(3 * D),
            updated_at: ago(1 * H),
          },
        ],
        {},
        NOW
      ).remove
    ).toEqual([]);
  });

  it('created_at OU updated_at ausente/ilegível: não remove e conta', () => {
    const out = selectUnreferencedObjects(
      PREFIX,
      [
        { name: oname(1), created_at: ago(5 * D) },
        { name: oname(2), updated_at: ago(5 * D) },
        { name: oname(3), created_at: ago(5 * D), updated_at: 'xx' },
        { name: oname(4), created_at: '', updated_at: ago(5 * D) },
      ],
      {},
      NOW
    );
    expect(out.remove).toEqual([]);
    expect(out.skippedNoDate).toBe(4);
  });

  it('sem answers legível nada é removido', () => {
    const objs = [obj(oname(1), ago(30 * D))];
    for (const bad of [null, undefined, 'x', [], { a: 'x' }]) {
      expect(selectUnreferencedObjects(PREFIX, objs, bad, NOW)).toEqual({
        remove: [],
        skippedNoDate: 0,
      });
    }
  });

  it('resposta concluída sem arquivos: tudo que passou da folga sai', () => {
    expect(
      selectUnreferencedObjects(
        PREFIX,
        [obj(oname(1), ago(2 * D)), obj(oname(2), ago(2 * H))],
        {},
        NOW
      ).remove
    ).toEqual([`${PREFIX}/${oname(1)}`]);
  });

  it('só remove nome na convenção da própria pasta (L-1)', () => {
    const out = selectUnreferencedObjects(
      PREFIX,
      [
        obj('.emptyFolderPlaceholder', ago(30 * D)),
        obj('a.pdf', ago(30 * D)),
        obj(`${uuid(900001)}.PDF`, ago(30 * D)), // extensão fora do padrão
        obj(oname(7), ago(30 * D)),
      ],
      {},
      NOW
    );
    expect(out.remove).toEqual([`${PREFIX}/${oname(7)}`]);
  });

  it('prefixo que não é conta/formulário/resposta: nada', () => {
    const objs = [obj(oname(1), ago(30 * D))];
    expect(
      selectUnreferencedObjects(`${ACC}/${FORM}`, objs, {}, NOW).remove
    ).toEqual([]);
    expect(
      selectUnreferencedObjects(`xx/${FORM}/${uuid(10)}`, objs, {}, NOW).remove
    ).toEqual([]);
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

describe('pruneStaleCursors (L-3)', () => {
  it('descarta conta e formulário que não existem mais; mantém o resto', () => {
    const cursors: Record<string, string> = {
      'account-a/f1': 'x',
      'account-a/f2': 'x',
      'account-b/f1': 'x',
      'account-c/f1': 'x',
    };
    pruneStaleCursors(
      cursors,
      new Set(['account-a', 'account-b']),
      new Map([['account-a', new Set(['f1'])]])
    );
    // a/f2 sumiu; c some com a conta; b não foi varrida: intacta.
    expect(Object.keys(cursors).sort()).toEqual([
      'account-a/f1',
      'account-b/f1',
    ]);
  });
});

describe('pruneDryRunFromEnv', () => {
  it('só 1 ou true ligam', () => {
    expect(pruneDryRunFromEnv({ FORMS_SWEEP_PRUNE_DRY_RUN: '1' })).toBe(true);
    expect(pruneDryRunFromEnv({ FORMS_SWEEP_PRUNE_DRY_RUN: ' TRUE ' })).toBe(
      true
    );
    expect(pruneDryRunFromEnv({ FORMS_SWEEP_PRUNE_DRY_RUN: '0' })).toBe(false);
    expect(pruneDryRunFromEnv({ FORMS_SWEEP_PRUNE_DRY_RUN: 'sim' })).toBe(
      false
    );
    expect(pruneDryRunFromEnv({})).toBe(false);
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
  /** Padrão: deduzido da árvore (a pasta `account-…/<form>` onde a resposta aparece). */
  account_id?: string;
  form_id?: string;
}

type ScalarCol = 'id' | 'status' | 'updated_at' | 'account_id' | 'form_id';

interface TreeEntry {
  name: string;
  id: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const SCOPE_KEY = /^account-([0-9a-f-]{36})\/([0-9a-f-]{36})$/;

function makeWorld(opts: {
  rows: Row[];
  /** caminho (sem barra final) → entradas */
  tree: Record<string, TreeEntry[]>;
  dbError?: boolean;
  /** Só a leitura de `answers` falha (o resto do banco responde). */
  answersError?: boolean;
  /** `list` falha nestes prefixos. */
  listErrorPrefixes?: string[];
  /** `remove` falha (erro devolvido). */
  removeError?: boolean;
  /** `remove` falha nestas chamadas (1-based). */
  removeErrorOnCalls?: number[];
  /** `remove` lança nestas chamadas (1-based). */
  removeThrowOnCalls?: number[];
  /** O servidor devolve no máximo isto por `list`, ignorando o `limit` pedido. */
  listMax?: number;
  proofsDeleted?: number;
}) {
  const proofCuts: { column: string; value: string }[] = [];
  const removed: string[][] = [];
  const updates: { ids: string[]; patch: unknown }[] = [];
  const listCalls: { prefix: string; offset: number }[] = [];
  const answerFilters: [string, string][][] = [];
  let removeCalls = 0;
  const rows = opts.rows;

  // Escopo das respostas, como o banco teria: conta/formulário da pasta.
  for (const [key, entries] of Object.entries(opts.tree)) {
    const m = SCOPE_KEY.exec(key);
    if (!m) continue;
    for (const e of entries) {
      for (const r of rows) {
        if (r.id === e.name) {
          r.account_id ??= m[1];
          r.form_id ??= m[2];
        }
      }
    }
  }

  const db = {
    storage: {
      from: () => ({
        list: async (prefix: string, o: { limit: number; offset: number }) => {
          listCalls.push({ prefix, offset: o.offset });
          if (opts.listErrorPrefixes?.includes(prefix)) {
            return { data: null, error: { message: 'boom' } };
          }
          const limit = Math.min(o.limit, opts.listMax ?? o.limit);
          return {
            data: (opts.tree[prefix] ?? []).slice(o.offset, o.offset + limit),
            error: null,
          };
        },
        remove: async (paths: string[]) => {
          removeCalls++;
          if (opts.removeThrowOnCalls?.includes(removeCalls)) {
            throw new Error('rede caiu');
          }
          if (
            opts.removeError ||
            opts.removeErrorOnCalls?.includes(removeCalls)
          ) {
            return { data: null, error: { message: 'boom' } };
          }
          removed.push(paths);
          // Como o Storage real: o objeto removido some da próxima listagem
          // e a pasta que fica vazia some junto (pasta é só prefixo).
          const gone = new Set(paths);
          const dirs = new Set(
            paths.map((p) => p.slice(0, p.lastIndexOf('/')))
          );
          for (const dir of dirs) {
            opts.tree[dir] = (opts.tree[dir] ?? []).filter(
              (e) => !gone.has(`${dir}/${e.name}`)
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
        eqs: [string, string][];
      } = { mode: 'select', filters: [], eqs: [] };
      const chain: Record<string, unknown> = {};
      const done = () => {
        if (opts.dbError) return { data: null, error: { message: 'boom' } };
        if (opts.answersError && ctx.cols?.includes('answers')) {
          return { data: null, error: { message: 'boom' } };
        }
        if (ctx.cols?.includes('answers')) answerFilters.push(ctx.eqs);
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
        ctx.eqs.push([c, v]);
        ctx.filters.push((r) => r[c] === v);
        return chain;
      };
      chain.lt = (c: ScalarCol, v: string) => {
        ctx.filters.push((r) => (r[c] ?? '') < v);
        return chain;
      };
      chain.in = (c: ScalarCol, v: string[]) => {
        ctx.filters.push((r) => v.includes(r[c] ?? ''));
        return chain;
      };
      chain.limit = () => chain;
      chain.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(done()).then(res);
      return chain;
    },
  };
  return {
    db: db as never,
    removed,
    updates,
    rows,
    proofCuts,
    listCalls,
    answerFilters,
    tree: opts.tree,
  };
}

const folder = (name: string): TreeEntry => ({ name, id: null });
const file = (name: string, created: string | null = null): TreeEntry => ({
  name,
  id: `obj-${name}`,
  created_at: created,
  updated_at: created,
});
const fresh = (): SweepState => ({
  cursor: 0,
  lastScanAt: 0,
  pruneCursors: {},
});
const LATER = new Date(NOW.getTime() + ORPHAN_SCAN_INTERVAL_MS + 1);

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
    const later = await runFormsSweep(w.db, LATER, state);
    expect(later.storageScanned).toBe(true);
  });

  it('falha do banco ao consultar respostas não remove NADA', async () => {
    const w = makeWorld({ rows: [], tree: tree(), dbError: true });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(w.removed).toEqual([]);
    expect(res.removedObjects).toBe(0);
    expect(res.errors).toBeGreaterThan(0);
  });

  it('falha no list de uma pasta de formulário não remove nada e não derruba o resto', async () => {
    const w = makeWorld({
      rows: [{ id: uuid(12), status: 'abandoned', updated_at: ago(8 * D) }],
      tree: tree(),
      listErrorPrefixes: [`${ACC}/${FORM}`],
    });
    const res = await runFormsSweep(w.db, NOW, fresh());
    expect(w.removed).toEqual([]);
    expect(res.errors).toBe(1);
  });

  it('linha da resposta de OUTRO formulário/conta (fora da convenção): a pasta é preservada (L-1)', async () => {
    const other = uuid(77);
    const w = makeWorld({
      rows: [
        // abandonada há 8 dias, mas pertence a outro formulário
        {
          id: uuid(12),
          status: 'abandoned',
          updated_at: ago(8 * D),
          form_id: other,
        },
        // existe, mas em outra conta
        {
          id: uuid(10),
          status: 'completed',
          updated_at: ago(8 * D),
          account_id: uuid(88),
          answers: {},
        },
      ],
      tree: tree(),
    });
    const res = await runFormsSweep(w.db, NOW, fresh());
    // só a pasta sem linha nenhuma (99) sai
    expect(w.removed.flat()).toEqual([`${ACC}/${FORM}/${uuid(99)}/c.pdf`]);
    expect(res.removedUnreferenced).toBe(0);
  });

  it('falha ao remover uma pasta órfã não impede as outras (L-5)', async () => {
    const w = makeWorld({
      rows: [
        { id: uuid(10), status: 'completed', updated_at: ago(40 * D) },
        { id: uuid(12), status: 'abandoned', updated_at: ago(8 * D) },
      ],
      tree: tree(),
      removeThrowOnCalls: [1],
    });
    const res = await runFormsSweep(w.db, NOW, fresh());
    // 1ª pasta (12): remove lançou; 2ª (99, sem linha): saiu.
    expect(w.removed.flat()).toEqual([`${ACC}/${FORM}/${uuid(99)}/c.pdf`]);
    expect(res).toMatchObject({
      removedFolders: 1,
      removedObjects: 1,
      errors: 1,
    });
  });
});

describe('runFormsSweep — poda de objetos sem referência em resposta concluída', () => {
  const RID = uuid(10);
  const PREFIX = `${ACC}/${FORM}/${RID}`;
  const answers = {
    doc: {
      type: 'file_upload',
      label: 'Doc',
      value: [{ path: `${PREFIX}/${oname(1)}`, name: 'ok.pdf' }],
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
          file(oname(1), ago(3 * D)), // referenciado
          file(oname(2), ago(3 * D)), // sem referência e antigo
          file(oname(3, 'exe'), ago(26 * H)), // sem referência e antigo
          file(oname(4), ago(2 * H)), // sem referência, dentro da folga
          file('.emptyFolderPlaceholder', ago(30 * D)), // fora do padrão
        ],
      },
      ...over,
    });

  it('remove o antigo sem referência; referenciado, recente e fora do padrão ficam', async () => {
    const w = world();
    const res = await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    expect(w.removed.flat().sort()).toEqual([
      `${PREFIX}/${oname(2)}`,
      `${PREFIX}/${oname(3, 'exe')}`,
    ]);
    expect(res).toMatchObject({
      removedUnreferenced: 2,
      removedObjects: 2,
      removedFolders: 0,
      prunedInspected: 1,
      dryRun: false,
      errors: 0,
    });
  });

  it('a consulta de answers filtra também por conta e formulário (L-1)', async () => {
    const w = world();
    await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    expect(w.answerFilters).toHaveLength(1);
    const eqs = Object.fromEntries(w.answerFilters[0]);
    expect(eqs).toEqual({
      account_id: uuid(1),
      form_id: FORM,
      status: 'completed',
    });
  });

  it('bloco de tipo desconhecido que cita o objeto: nada sai (M-2, ponta a ponta)', async () => {
    const w = world(
      {},
      {
        sig: {
          type: 'signature_v2',
          label: 'Assinatura',
          value: { meta: { files: [{ path: `${PREFIX}/${oname(2)}` }] } },
        },
        doc: answers.doc,
      }
    );
    await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    // oname(2) está citado no bloco novo; só oname(3) sai.
    expect(w.removed.flat()).toEqual([`${PREFIX}/${oname(3, 'exe')}`]);
  });

  it('nunca remove o arquivo referenciado, por mais antigo que seja', async () => {
    const w = world({
      tree: {
        '': [folder(ACC)],
        [ACC]: [folder(FORM)],
        [`${ACC}/${FORM}`]: [folder(RID)],
        [PREFIX]: [file(oname(1), ago(900 * D))],
      },
    });
    await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    expect(w.removed).toEqual([]);
  });

  it('sem data legível no list: nada é removido e skippedNoDate deixa a inércia visível (L-2)', async () => {
    const w = world({
      tree: {
        '': [folder(ACC)],
        [ACC]: [folder(FORM)],
        [`${ACC}/${FORM}`]: [folder(RID)],
        [PREFIX]: [file(oname(2), null), file(oname(3), null)],
      },
    });
    const res = await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    expect(w.removed).toEqual([]);
    expect(res.skippedNoDate).toBe(2);
    expect(res.removedUnreferenced).toBe(0);
  });

  it('erro ao ler answers não remove nada, conta o erro e o cursor não anda', async () => {
    const w = world({ answersError: true });
    const state = fresh();
    const res = await runFormsSweep(w.db, NOW, state, { pruneDryRun: false });
    expect(w.removed).toEqual([]);
    expect(res.removedUnreferenced).toBe(0);
    expect(res.errors).toBeGreaterThan(0);
    expect(state.pruneCursors?.[`${ACC}/${FORM}`]).toBeUndefined();
  });

  it('answers ilegível (null ou forma estranha) não remove nada', async () => {
    for (const bad of [null, 'x', { doc: 'x' }]) {
      const w = world({}, bad);
      await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
      expect(w.removed).toEqual([]);
    }
  });

  it('erro ao listar a pasta da resposta não remove nada', async () => {
    const w = world({ listErrorPrefixes: [PREFIX] });
    const res = await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    expect(w.removed).toEqual([]);
    expect(res.errors).toBeGreaterThan(0);
  });

  it('erro no remove conta o erro e não conta objeto removido', async () => {
    const w = world({ removeError: true });
    const res = await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    expect(res.removedUnreferenced).toBe(0);
    expect(res.removedObjects).toBe(0);
    expect(res.errors).toBeGreaterThan(0);
  });

  it('remove que LANÇA não aborta a varredura e não conta objeto removido (L-5)', async () => {
    const w = world({ removeThrowOnCalls: [1] });
    const res = await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    expect(res.removedUnreferenced).toBe(0);
    expect(res.errors).toBe(1);
    expect(res.storageScanned).toBe(true);
  });

  it('lote com falha não zera o que os outros lotes removeram (contadores corretos, L-5)', async () => {
    const n = 250; // 3 lotes de remoção (100 + 100 + 50)
    const names = Array.from({ length: n }, (_, i) => oname(100 + i));
    const w = world({
      tree: {
        '': [folder(ACC)],
        [ACC]: [folder(FORM)],
        [`${ACC}/${FORM}`]: [folder(RID)],
        [PREFIX]: names.map((nm) => file(nm, ago(5 * D))),
      },
      removeErrorOnCalls: [2],
    });
    const res = await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
    expect(w.removed.map((c) => c.length)).toEqual([100, 50]);
    expect(res.removedUnreferenced).toBe(150);
    expect(res.removedObjects).toBe(150);
    expect(res.errors).toBe(1);
  });

  it('erro numa pasta não impede as demais da fatia nem desloca o cursor (L-5)', async () => {
    const ids = [uuid(20), uuid(21), uuid(22)];
    const tree: Record<string, TreeEntry[]> = {
      '': [folder(ACC)],
      [ACC]: [folder(FORM)],
      [`${ACC}/${FORM}`]: ids.map(folder),
    };
    for (const id of ids) {
      tree[`${ACC}/${FORM}/${id}`] = [file(oname(1), ago(5 * D))];
    }
    const w = makeWorld({
      rows: ids.map((id) => ({
        id,
        status: 'completed',
        updated_at: ago(40 * D),
        answers: {},
      })),
      tree,
      listErrorPrefixes: [`${ACC}/${FORM}/${ids[0]}`],
    });
    const state = fresh();
    const res = await runFormsSweep(w.db, NOW, state, { pruneDryRun: false });
    expect(res.errors).toBe(1);
    expect(res.removedUnreferenced).toBe(2);
    // todas as três foram tentadas: o cursor está na última.
    expect(state.pruneCursors?.[`${ACC}/${FORM}`]).toBe(ids[2]);
  });

  it('não mexe em resposta partial nem abandonada recente', async () => {
    for (const status of ['partial', 'abandoned']) {
      const w = makeWorld({
        rows: [{ id: RID, status, updated_at: ago(2 * D), answers: {} }],
        tree: {
          '': [folder(ACC)],
          [ACC]: [folder(FORM)],
          [`${ACC}/${FORM}`]: [folder(RID)],
          [PREFIX]: [file(oname(1), ago(30 * D))],
        },
      });
      await runFormsSweep(w.db, NOW, fresh(), { pruneDryRun: false });
      expect(w.removed).toEqual([]);
    }
  });

  describe('dry-run (FORMS_SWEEP_PRUNE_DRY_RUN)', () => {
    it('nada é removido; os caminhos são logados e contados', async () => {
      const w = world();
      const logs: string[] = [];
      const res = await runFormsSweep(w.db, NOW, fresh(), {
        pruneDryRun: true,
        log: (m) => logs.push(m),
      });
      expect(w.removed).toEqual([]);
      expect(res).toMatchObject({
        dryRun: true,
        wouldRemoveUnreferenced: 2,
        removedUnreferenced: 0,
        removedObjects: 0,
        errors: 0,
      });
      const text = logs.join('\n');
      expect(text).toContain(`${PREFIX}/${oname(2)}`);
      expect(text).toContain(`${PREFIX}/${oname(3, 'exe')}`);
      expect(text).not.toContain(`${PREFIX}/${oname(1)}`); // referenciado
      expect(text).not.toContain(oname(4)); // dentro da folga
    });

    it('o log de caminhos é limitado; o contador continua exato', async () => {
      const n = 230;
      const w = world({
        tree: {
          '': [folder(ACC)],
          [ACC]: [folder(FORM)],
          [`${ACC}/${FORM}`]: [folder(RID)],
          [PREFIX]: Array.from({ length: n }, (_, i) =>
            file(oname(100 + i), ago(5 * D))
          ),
        },
      });
      const logs: string[] = [];
      const res = await runFormsSweep(w.db, NOW, fresh(), {
        pruneDryRun: true,
        log: (m) => logs.push(m),
      });
      expect(res.wouldRemoveUnreferenced).toBe(n);
      expect(w.removed).toEqual([]);
      expect(logs.length).toBe(201); // 200 caminhos + aviso de omissão
    });

    it('padrão vem da variável de ambiente', async () => {
      const prev = process.env.FORMS_SWEEP_PRUNE_DRY_RUN;
      process.env.FORMS_SWEEP_PRUNE_DRY_RUN = '1';
      try {
        const w = world();
        const res = await runFormsSweep(w.db, NOW, fresh(), {
          log: () => {},
        });
        expect(res.dryRun).toBe(true);
        expect(w.removed).toEqual([]);
      } finally {
        if (prev === undefined) delete process.env.FORMS_SWEEP_PRUNE_DRY_RUN;
        else process.env.FORMS_SWEEP_PRUNE_DRY_RUN = prev;
      }
    });

    it('não impede a remoção de órfãs e abandonadas (só o passo 3 é simulado)', async () => {
      const w = makeWorld({
        rows: [{ id: uuid(12), status: 'abandoned', updated_at: ago(8 * D) }],
        tree: {
          '': [folder(ACC)],
          [ACC]: [folder(FORM)],
          [`${ACC}/${FORM}`]: [folder(uuid(12))],
          [`${ACC}/${FORM}/${uuid(12)}`]: [file('a.pdf')],
        },
      });
      const res = await runFormsSweep(w.db, NOW, fresh(), {
        pruneDryRun: true,
        log: () => {},
      });
      expect(res.removedFolders).toBe(1);
    });
  });

  describe('orçamento e cursor', () => {
    /** Pastas `completed` com 1 arquivo referenciado (sobrevive) + 1 órfão antigo. */
    const survivingFolders = (
      accountFolder: string,
      formId: string,
      ids: readonly string[],
      tree: Record<string, TreeEntry[]>
    ) =>
      ids.map((id) => {
        const prefix = `${accountFolder}/${formId}/${id}`;
        tree[prefix] = [
          file(oname(1), ago(30 * D)), // referenciado
          file(oname(2), ago(5 * D)), // órfão antigo
        ];
        return {
          id,
          status: 'completed',
          updated_at: ago(40 * D),
          answers: {
            doc: {
              type: 'file_upload',
              label: 'Doc',
              value: [{ path: `${prefix}/${oname(1)}`, name: 'a.pdf' }],
            },
          },
        };
      });

    it('o cursor cobre as pastas que SOBREVIVEM (M-3): 100, depois 5, sem repetir', async () => {
      const total = FOLDERS_PRUNED_PER_ACCOUNT + 5;
      const ids = Array.from({ length: total }, (_, i) => uuid(1000 + i));
      const tree: Record<string, TreeEntry[]> = {
        '': [folder(ACC)],
        [ACC]: [folder(FORM)],
        [`${ACC}/${FORM}`]: ids.map(folder),
      };
      const rows = survivingFolders(ACC, FORM, ids, tree);
      const w = makeWorld({ rows, tree });
      const state = fresh();
      const opts = { pruneDryRun: false };

      const first = await runFormsSweep(w.db, NOW, state, opts);
      expect(first.removedUnreferenced).toBe(FOLDERS_PRUNED_PER_ACCOUNT);
      expect(w.removed.flat()).toEqual(
        ids
          .slice(0, FOLDERS_PRUNED_PER_ACCOUNT)
          .map((id) => `${ACC}/${FORM}/${id}/${oname(2)}`)
      );
      expect(state.pruneCursors?.[`${ACC}/${FORM}`]).toBe(
        ids[FOLDERS_PRUNED_PER_ACCOUNT - 1]
      );
      // as 105 pastas continuam no Storage (o arquivo referenciado ficou)
      expect(tree[`${ACC}/${FORM}`]).toHaveLength(total);

      const second = await runFormsSweep(w.db, LATER, state, opts);
      expect(second.removedUnreferenced).toBe(5);
      expect(new Set(w.removed.flat()).size).toBe(total);

      // ciclo completo: a próxima volta ao começo e não acha mais nada
      const third = await runFormsSweep(
        w.db,
        new Date(LATER.getTime() + ORPHAN_SCAN_INTERVAL_MS + 1),
        state,
        opts
      );
      expect(third.removedUnreferenced).toBe(0);
      expect(w.removed.flat()).toHaveLength(total);
    });

    it('o 1º formulário não consome o orçamento da conta: o 2º também é podado (M-1)', async () => {
      const FORM_B = uuid(3); // vem depois de FORM na listagem por nome
      const a = Array.from(
        { length: FOLDERS_PRUNED_PER_ACCOUNT + 20 },
        (_, i) => uuid(2000 + i)
      );
      const b = [uuid(5000)];
      const tree: Record<string, TreeEntry[]> = {
        '': [folder(ACC)],
        [ACC]: [folder(FORM), folder(FORM_B)],
        [`${ACC}/${FORM}`]: a.map(folder),
        [`${ACC}/${FORM_B}`]: b.map(folder),
      };
      const rows = [
        ...survivingFolders(ACC, FORM, a, tree),
        ...survivingFolders(ACC, FORM_B, b, tree),
      ];
      const w = makeWorld({ rows, tree });
      const res = await runFormsSweep(w.db, NOW, fresh(), {
        pruneDryRun: false,
      });
      expect(w.removed.flat()).toContain(
        `${ACC}/${FORM_B}/${b[0]}/${oname(2)}`
      );
      // A fica com a fatia justa; nada passa do teto da conta
      expect(res.removedUnreferenced).toBe(FOLDERS_PRUNED_PER_ACCOUNT / 2 + 1);
    });

    it('uma conta grande não esgota o orçamento das demais da mesma varredura', async () => {
      const ACC2 = `account-${uuid(7)}`;
      const FORM2 = uuid(8);
      const big = Array.from(
        { length: FOLDERS_PRUNED_PER_ACCOUNT + 20 },
        (_, i) => uuid(2000 + i)
      );
      const small = uuid(3000);
      const tree: Record<string, TreeEntry[]> = {
        '': [folder(ACC), folder(ACC2)],
        [ACC]: [folder(FORM)],
        [`${ACC}/${FORM}`]: big.map(folder),
        [ACC2]: [folder(FORM2)],
        [`${ACC2}/${FORM2}`]: [folder(small)],
      };
      const rows = [
        ...survivingFolders(ACC, FORM, big, tree),
        ...survivingFolders(ACC2, FORM2, [small], tree),
      ];
      const w = makeWorld({ rows, tree });
      const res = await runFormsSweep(w.db, NOW, fresh(), {
        pruneDryRun: false,
      });
      expect(res.removedUnreferenced).toBe(FOLDERS_PRUNED_PER_ACCOUNT + 1);
      expect(w.removed.flat()).toContain(
        `${ACC2}/${FORM2}/${small}/${oname(2)}`
      );
    });

    it('descarta cursor de conta e de formulário que sumiram (L-3)', async () => {
      const w = world();
      const state = fresh();
      state.pruneCursors = {
        [`${ACC}/${uuid(404)}`]: 'x', // formulário apagado, conta varrida
        [`account-${uuid(405)}/${FORM}`]: 'x', // conta apagada
      };
      await runFormsSweep(w.db, NOW, state, { pruneDryRun: false });
      expect(Object.keys(state.pruneCursors)).toEqual([`${ACC}/${FORM}`]);
    });

    it('listagem de contas ou de formulários com falha não descarta cursor nenhum', async () => {
      const w = world({ listErrorPrefixes: [ACC] });
      const state = fresh();
      state.pruneCursors = { [`${ACC}/${uuid(404)}`]: 'x' };
      await runFormsSweep(w.db, NOW, state, { pruneDryRun: false });
      expect(state.pruneCursors).toEqual({ [`${ACC}/${uuid(404)}`]: 'x' });
    });
  });

  describe('paginação do list (L-4)', () => {
    const bigFolder = (count: number, listMax?: number) =>
      world({
        tree: {
          '': [folder(ACC)],
          [ACC]: [folder(FORM)],
          [`${ACC}/${FORM}`]: [folder(RID)],
          [PREFIX]: Array.from({ length: count }, (_, i) =>
            file(oname(10 + i), ago(5 * D))
          ),
        },
        listMax,
      });

    it('mais de 1000 objetos na pasta: lê todas as páginas', async () => {
      const w = bigFolder(1150);
      const res = await runFormsSweep(w.db, NOW, fresh(), {
        pruneDryRun: false,
      });
      expect(res.removedUnreferenced).toBe(1150);
      const offsets = w.listCalls
        .filter((c) => c.prefix === PREFIX)
        .map((c) => c.offset);
      expect(offsets).toEqual([0, 1000]);
    });

    it('servidor que limita a página (100) abaixo do pedido: continua até acabar', async () => {
      const w = bigFolder(250, 100);
      const res = await runFormsSweep(w.db, NOW, fresh(), {
        pruneDryRun: false,
      });
      expect(res.removedUnreferenced).toBe(250);
    });

    it('lista truncada de uma pasta não decide remoção: nada sai e o log mostra', async () => {
      const w = bigFolder(20 * 1000 + 5);
      const res = await runFormsSweep(w.db, NOW, fresh(), {
        pruneDryRun: false,
      });
      expect(w.removed).toEqual([]);
      expect(res.truncatedLists).toBe(1);
      expect(res.prunedInspected).toBe(0);
    });
  });
});
