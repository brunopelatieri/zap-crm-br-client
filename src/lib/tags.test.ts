import { describe, expect, it } from 'vitest';
import {
  flattenContactTagsEmbed,
  toContactTagRows,
  toContactTagRowsFromTags,
} from './tags';
import type { Tag } from '@/types';

function makeTag(id: string, overrides: Partial<Tag> = {}): Tag {
  return {
    id,
    user_id: 'user-1',
    account_id: 'account-1',
    name: `Tag ${id}`,
    color: '#3b82f6',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Tag;
}

describe('toContactTagRows', () => {
  it('monta um ContactTag por id, com contact_id e tag_id iguais ao id', () => {
    const rows = toContactTagRows(['t1', 't2'], 'contact-1');
    expect(rows).toEqual([
      { id: 't1', contact_id: 'contact-1', tag_id: 't1' },
      { id: 't2', contact_id: 'contact-1', tag_id: 't2' },
    ]);
  });

  it('lista vazia devolve array vazio', () => {
    expect(toContactTagRows([], 'contact-1')).toEqual([]);
  });
});

describe('toContactTagRowsFromTags', () => {
  it('extrai o id de cada Tag e delega para toContactTagRows', () => {
    const rows = toContactTagRowsFromTags(
      [makeTag('t1'), makeTag('t2')],
      'contact-1'
    );
    expect(rows).toEqual([
      { id: 't1', contact_id: 'contact-1', tag_id: 't1' },
      { id: 't2', contact_id: 'contact-1', tag_id: 't2' },
    ]);
  });
});

describe('flattenContactTagsEmbed', () => {
  it('achata o embed contact_tags(tags(*)) em ContactTag[]', () => {
    const rows = flattenContactTagsEmbed(
      [{ tags: makeTag('t1') }, { tags: makeTag('t2') }],
      'contact-1'
    );
    expect(rows).toEqual([
      { id: 't1', contact_id: 'contact-1', tag_id: 't1' },
      { id: 't2', contact_id: 'contact-1', tag_id: 't2' },
    ]);
  });

  it('descarta entradas com tags nulo (FK sem embed resolvido)', () => {
    const rows = flattenContactTagsEmbed(
      [{ tags: makeTag('t1') }, { tags: null }],
      'contact-1'
    );
    expect(rows).toEqual([{ id: 't1', contact_id: 'contact-1', tag_id: 't1' }]);
  });

  it('embed ausente (undefined/null) devolve array vazio', () => {
    expect(flattenContactTagsEmbed(undefined, 'contact-1')).toEqual([]);
    expect(flattenContactTagsEmbed(null, 'contact-1')).toEqual([]);
  });
});
