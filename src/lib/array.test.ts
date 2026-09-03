import { describe, expect, it } from 'vitest';
import { chunkArray } from './array';

describe('chunkArray', () => {
  it('divide em blocos completos quando o tamanho é múltiplo', () => {
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('último bloco fica menor quando não é múltiplo', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('array vazio devolve lista de blocos vazia', () => {
    expect(chunkArray([], 5)).toEqual([]);
  });

  it('tamanho de bloco maior que o array devolve um único bloco', () => {
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('preserva a ordem e não perde nem duplica itens', () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const chunks = chunkArray(items, 7);
    expect(chunks.flat()).toEqual(items);
    expect(chunks.map((c) => c.length)).toEqual([7, 7, 7, 2]);
  });
});
