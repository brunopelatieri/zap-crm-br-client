import { describe, it, expect } from 'vitest';
import { documentIdsOf } from './sources';

const src = (documentId: string | null, chunkId = 'c') => ({
  chunkId,
  documentId,
  title: null,
  score: 0,
});

describe('documentIdsOf', () => {
  it('keeps unique document ids in first-seen order', () => {
    expect(
      documentIdsOf([src('d2', 'a'), src('d1', 'b'), src('d2', 'c')])
    ).toEqual(['d2', 'd1']);
  });

  it('skips sources without a document (legacy fallback path)', () => {
    expect(documentIdsOf([src(null), src('d1')])).toEqual(['d1']);
    expect(documentIdsOf([])).toEqual([]);
  });
});
