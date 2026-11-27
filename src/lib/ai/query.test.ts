import { describe, it, expect } from 'vitest';
import {
  buildLexicalQuery,
  buildRetrievalQuery,
  LEXICAL_MAX_TERMS,
  QUERY_MAX_CHARS,
} from './query';

describe('buildRetrievalQuery (D-13)', () => {
  const u = (content: string) => ({ role: 'user' as const, content });
  const a = (content: string) => ({ role: 'assistant' as const, content });

  it('joins the last 3 customer messages, oldest first, skipping the assistant', () => {
    expect(
      buildRetrievalQuery([
        u('um'),
        a('resposta'),
        u('dois'),
        u('tres'),
        u('quatro'),
      ])
    ).toBe('dois\ntres\nquatro');
  });

  it('lets "e quanto custa?" carry the topic of the message before it', () => {
    expect(
      buildRetrievalQuery([
        u('Qual o plano premium?'),
        a('É o plano com suporte 24h.'),
        u('E quanto custa?'),
      ])
    ).toBe('Qual o plano premium?\nE quanto custa?');
  });

  it('caps at 600 chars keeping the newest text and never a half word', () => {
    const old = 'antigo '.repeat(100); // 700 chars
    const out = buildRetrievalQuery([u(old), u('pergunta final sobre prazo')]);
    expect(out.length).toBeLessThanOrEqual(QUERY_MAX_CHARS);
    expect(out.endsWith('pergunta final sobre prazo')).toBe(true);
    expect(out.startsWith('antigo')).toBe(true); // no fragment like "tigo"
  });

  it('falls back to the last message of any role, then to empty', () => {
    expect(buildRetrievalQuery([a('so assistente')])).toBe('so assistente');
    expect(buildRetrievalQuery([])).toBe('');
    expect(buildRetrievalQuery([u('   ')])).toBe('');
  });
});

describe('buildLexicalQuery', () => {
  it('keeps topical words and joins them with "or" (websearch syntax)', () => {
    expect(
      buildLexicalQuery('Oi, gostaria de saber o preço do plano premium?')
    ).toBe('preço or plano or premium');
  });

  it('drops stopwords, short words and repeats; keeps numbers of 2+ digits', () => {
    expect(buildLexicalQuery('o de da em 99 7 plano plano')).toBe(
      '99 or plano'
    );
  });

  it('keeps a word whose accent arrives decomposed (NFD input)', () => {
    const nfd = 'preços do plano'.normalize('NFD');
    expect(nfd).not.toBe('preços do plano');
    expect(buildLexicalQuery(nfd)).toBe('preços or plano');
  });

  it('can never inject a websearch operator or the word "or"', () => {
    const q = buildLexicalQuery('plano -premium "exato" or entrega OR frete');
    expect(q).toBe('plano or premium or exato or entrega or frete');
    expect(q).not.toMatch(/["-]/);
  });

  it('returns empty when no topical word is left', () => {
    expect(buildLexicalQuery('oi, o que é isso?')).toBe('');
    expect(buildLexicalQuery('   ')).toBe('');
  });

  it('caps the number of terms', () => {
    const many = Array.from({ length: 50 }, (_, i) => `termo${i}`).join(' ');
    expect(buildLexicalQuery(many).split(' or ')).toHaveLength(
      LEXICAL_MAX_TERMS
    );
  });
});
