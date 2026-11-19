import { describe, expect, it } from 'vitest';

import { parseResponsesFilter } from './responses-query';

import {
  DEFAULT_FILTERS,
  filtersToParams,
  filtersToRecord,
  hasActiveFilters,
  totalPages,
} from './responses-filters';

describe('filtersToRecord', () => {
  it('padrão: só concluídas', () => {
    expect(filtersToRecord(DEFAULT_FILTERS)).toEqual({ status: 'completed' });
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
  });

  it('bloco sem valor não filtra; com valor manda block e value', () => {
    expect(
      filtersToRecord({ ...DEFAULT_FILTERS, blockKey: 'interesse' })
    ).toEqual({ status: 'completed' });
    expect(
      filtersToRecord({
        ...DEFAULT_FILTERS,
        blockKey: 'interesse',
        blockValue: ' o1 ',
      })
    ).toEqual({ status: 'completed', block: 'interesse', value: 'o1' });
  });

  it('"todos os status" some da query', () => {
    expect(filtersToRecord({ ...DEFAULT_FILTERS, status: '' })).toEqual({});
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, status: '' })).toBe(true);
  });

  it('o que a tela monta é aceito pelo parser do servidor', () => {
    const params = filtersToParams(
      {
        q: ' Maria ',
        status: 'partial',
        band: 'hot',
        source: 'embed',
        from: '2026-11-01',
        to: '2026-11-30',
        blockKey: 'tags',
        blockValue: 't1',
      },
      2,
      50
    );
    const parsed = parseResponsesFilter(params);
    expect(parsed).toMatchObject({
      ok: true,
      filter: {
        page: 2,
        pageSize: 50,
        statuses: ['partial'],
        band: 'hot',
        source: 'embed',
        from: '2026-11-01',
        to: '2026-11-30',
        block: { key: 'tags', value: 't1' },
        search: 'Maria',
      },
    });
  });
});

describe('totalPages', () => {
  it('nunca abaixo de 1', () => {
    expect(totalPages(0, 25)).toBe(1);
    expect(totalPages(25, 25)).toBe(1);
    expect(totalPages(26, 25)).toBe(2);
  });
});
