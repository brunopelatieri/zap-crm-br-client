import { describe, expect, it } from 'vitest';

import {
  RESPONSES_DEFAULT_PAGE_SIZE,
  RESPONSES_MAX_PAGE_SIZE,
  applyFilterOps,
  buildBlockContainment,
  dayStartIso,
  needsInnerContactJoin,
  nextDayStartIso,
  pageRange,
  parseResponsesFilter,
  planResponsesFilter,
  sanitizeSearchTerm,
  type FilterOp,
  type ResponsesFilter,
} from './responses-query';

const parse = (qs: string) => parseResponsesFilter(new URLSearchParams(qs));

function ok(qs: string): ResponsesFilter {
  const r = parse(qs);
  if (!r.ok) throw new Error(`esperava ok, veio ${r.reason}`);
  return r.filter;
}

describe('parseResponsesFilter', () => {
  it('padrões: página 1, 25 por página, sem filtros', () => {
    expect(ok('')).toEqual({
      page: 1,
      pageSize: RESPONSES_DEFAULT_PAGE_SIZE,
      statuses: [],
      band: null,
      from: null,
      to: null,
      source: null,
      block: null,
      search: null,
      responseId: null,
    });
  });

  it('lê todos os filtros', () => {
    const f = ok(
      'page=3&pageSize=50&status=completed,partial&band=hot&from=2026-11-01&to=2026-11-30&source=embed&block=interesse&value=opt_a&q=%20Maria%20'
    );
    expect(f).toMatchObject({
      page: 3,
      pageSize: 50,
      statuses: ['completed', 'partial'],
      band: 'hot',
      from: '2026-11-01',
      to: '2026-11-30',
      source: 'embed',
      block: { key: 'interesse', value: 'opt_a' },
      search: 'Maria',
    });
  });

  it.each([
    ['page=0', 'page'],
    ['page=abc', 'page'],
    [`pageSize=${RESPONSES_MAX_PAGE_SIZE + 1}`, 'pageSize'],
    ['status=completed,nope', 'status'],
    ['band=a b', 'band'],
    ['from=01/11/2026', 'from'],
    ['from=2026-12-01&to=2026-11-01', 'period'],
    ['from=2026-13-45', 'period'],
    ['from=2026-02-31', 'period'],
    ['to=2026-04-31', 'period'],
    ['source=carrier-pigeon', 'source'],
    ['response=nope', 'response'],
    ['block=BAD KEY&value=x', 'block'],
    ['block=ok', 'block'],
    ['value=x', 'block'],
  ])('recusa %s', (qs, reason) => {
    expect(parse(qs)).toEqual({ ok: false, reason });
  });

  it('status repetido não duplica', () => {
    expect(ok('status=completed,completed').statuses).toEqual(['completed']);
  });
});

describe('período em America/Sao_Paulo', () => {
  it('o dia começa às 03:00 UTC e o limite superior é o dia seguinte', () => {
    expect(dayStartIso('2026-11-30')).toBe('2026-11-30T03:00:00.000Z');
    expect(nextDayStartIso('2026-11-30')).toBe('2026-12-01T03:00:00.000Z');
  });
});

describe('planResponsesFilter', () => {
  const base = ok('');

  it('sem filtro: nenhuma operação', () => {
    expect(planResponsesFilter(base, null)).toEqual([]);
  });

  it('uma resposta só (link da notificação)', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    expect(planResponsesFilter(ok(`response=${id}`), null)).toEqual([
      { op: 'eq', column: 'id', value: id },
    ]);
  });

  it('um status é eq; vários são in', () => {
    expect(
      planResponsesFilter({ ...base, statuses: ['completed'] }, null)
    ).toEqual([{ op: 'eq', column: 'status', value: 'completed' }]);
    expect(
      planResponsesFilter({ ...base, statuses: ['completed', 'partial'] }, null)
    ).toEqual([
      { op: 'in', column: 'status', value: ['completed', 'partial'] },
    ]);
  });

  it('faixa, origem, período e bloco', () => {
    const ops = planResponsesFilter(
      ok('band=hot&source=link&from=2026-11-01&to=2026-11-02'),
      { interesse: { value: 'a' } }
    );
    expect(ops).toEqual([
      { op: 'eq', column: 'band_key', value: 'hot' },
      { op: 'eq', column: 'source', value: 'link' },
      { op: 'gte', column: 'started_at', value: '2026-11-01T03:00:00.000Z' },
      { op: 'lt', column: 'started_at', value: '2026-11-03T03:00:00.000Z' },
      {
        op: 'contains',
        column: 'answers',
        value: { interesse: { value: 'a' } },
      },
    ]);
  });

  it('busca por nome/telefone vira or no contato, com dígitos extras', () => {
    const [op] = planResponsesFilter(ok('q=Maria 5511'), null);
    expect(op).toEqual({
      op: 'or',
      referencedTable: 'contacts',
      filter:
        'name.ilike.%Maria 5511%,phone.ilike.%Maria 5511%,phone_normalized.ilike.%5511%',
    });
  });

  it('busca só com pontuação não gera filtro', () => {
    expect(planResponsesFilter(ok('q=%25%25,()'), null)).toEqual([]);
    expect(needsInnerContactJoin(ok('q=%25%25,()'))).toBe(false);
    expect(needsInnerContactJoin(ok('q=ana'))).toBe(true);
  });
});

describe('sanitizeSearchTerm (injeção na sintaxe do .or)', () => {
  it('tira vírgula, parêntese, aspas, curingas e separadores', () => {
    expect(sanitizeSearchTerm('a,b(c)"d"*%_\\e')).toBe('a b c d e');
  });
  it('um termo malicioso não consegue abrir outro filtro', () => {
    const t = sanitizeSearchTerm('x%,account_id.eq.123');
    expect(t).not.toMatch(/[,%()]/);
  });
  it('mantém ponto e apóstrofo de nomes reais', () => {
    expect(sanitizeSearchTerm("D'Ávila j.silva")).toBe("D'Ávila j.silva");
  });
});

describe('buildBlockContainment', () => {
  const f = (type: string) => ({ key: 'k', type }) as never;

  it('escolha única e lista: id da opção', () => {
    expect(buildBlockContainment(f('single_select'), 'o1')).toEqual({
      k: { value: 'o1' },
    });
    expect(buildBlockContainment(f('dropdown'), 'o1')).toEqual({
      k: { value: 'o1' },
    });
  });

  it('multi_select: array que contém o id', () => {
    expect(buildBlockContainment(f('multi_select'), 'o1')).toEqual({
      k: { value: ['o1'] },
    });
  });

  it('sim/não e consentimento viram booleano', () => {
    expect(buildBlockContainment(f('yes_no'), 'yes')).toEqual({
      k: { value: true },
    });
    expect(buildBlockContainment(f('yes_no'), 'no')).toEqual({
      k: { value: false },
    });
    expect(buildBlockContainment(f('consent'), 'maybe')).toBeNull();
  });

  it('número e nota viram número; texto inválido recusa', () => {
    expect(buildBlockContainment(f('rating'), '5')).toEqual({
      k: { value: 5 },
    });
    expect(buildBlockContainment(f('number'), 'abc')).toBeNull();
    expect(buildBlockContainment(f('number'), '')).toBeNull();
  });

  it('texto curto: igualdade exata; texto longo e arquivo não filtram', () => {
    expect(buildBlockContainment(f('email'), 'a@b.c')).toEqual({
      k: { value: 'a@b.c' },
    });
    expect(buildBlockContainment(f('long_text'), 'x')).toBeNull();
    expect(buildBlockContainment(f('file_upload'), 'x')).toBeNull();
  });

  it('bloco inexistente: null', () => {
    expect(buildBlockContainment(undefined, 'x')).toBeNull();
  });
});

describe('pageRange e applyFilterOps', () => {
  it('página → intervalo do .range()', () => {
    expect(pageRange({ page: 1, pageSize: 25 })).toEqual({ from: 0, to: 24 });
    expect(pageRange({ page: 3, pageSize: 10 })).toEqual({ from: 20, to: 29 });
  });

  it('aplica cada operação no builder, na ordem', () => {
    const calls: string[] = [];
    const q: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ['eq', 'in', 'gte', 'lt', 'contains', 'or']) {
      q[m] = (...a: unknown[]) => {
        calls.push(`${m}:${JSON.stringify(a)}`);
        return q;
      };
    }
    const ops: FilterOp[] = [
      { op: 'eq', column: 'status', value: 'completed' },
      { op: 'contains', column: 'answers', value: { k: { value: 1 } } },
      { op: 'or', filter: 'name.ilike.%a%', referencedTable: 'contacts' },
    ];
    applyFilterOps(q as never, ops);
    expect(calls).toEqual([
      'eq:["status","completed"]',
      'contains:["answers",{"k":{"value":1}}]',
      'or:["name.ilike.%a%",{"referencedTable":"contacts"}]',
    ]);
  });
});
