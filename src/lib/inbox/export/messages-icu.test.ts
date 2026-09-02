import { describe, expect, it } from 'vitest';
import IntlMessageFormat from 'intl-messageformat';
import en from '../../../../messages/en.json';
import ptBR from '../../../../messages/pt-BR.json';

/**
 * As mensagens do documento exportado são consumidas pela ROTA, não pela
 * UI — e o teste da rota mocka `getTranslations`, então a sintaxe ICU
 * delas nunca passaria por um formatador de verdade. Uma chave com ICU
 * quebrado só apareceria em produção, na hora de exportar, e o
 * `typecheck` não pega isso (armadilha catalogada no AGENTS.md).
 *
 * Este teste compila cada mensagem do bloco nos dois locales.
 */

type Block = Record<string, unknown>;

function flatten(obj: Block, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push([path, value]);
    else if (value && typeof value === 'object')
      out.push(...flatten(value as Block, path));
  }
  return out;
}

/** Valores de amostra para cada placeholder que o bloco usa. */
const SAMPLE: Record<string, unknown> = {
  count: 2,
  current: 1,
  total: 3,
  name: 'Maria Silva',
  date: '02/09/2026 14:31',
  from: '12/08/2026',
  to: '13/08/2026',
  by: 'João Pereira',
  id: '1111-2222',
  included: 2,
  minutes: 5,
  messages: 12,
  attachments: 3,
};

const LOCALES: Array<[string, Block]> = [
  ['en', (en as Block).Inbox as Block],
  ['pt-BR', (ptBR as Block).Inbox as Block],
];

describe('Inbox.exportConversation — sintaxe ICU', () => {
  for (const [locale, inbox] of LOCALES) {
    const block = inbox.exportConversation as Block;

    it(`${locale}: o bloco existe`, () => {
      expect(block).toBeDefined();
      expect(block.doc).toBeDefined();
      expect(block.manifest).toBeDefined();
      expect(block.readme).toBeDefined();
    });

    it(`${locale}: toda mensagem compila e formata`, () => {
      const entries = flatten(block);
      expect(entries.length).toBeGreaterThan(50);

      for (const [path, message] of entries) {
        expect(
          () => new IntlMessageFormat(message, locale).format(SAMPLE),
          `chave "${path}" tem ICU inválido: ${message}`
        ).not.toThrow();
      }
    });

    it(`${locale}: o plural de mensagens/anexos resolve os dois ramos`, () => {
      const doc = block.doc as Record<string, string>;
      const one = new IntlMessageFormat(doc.messageCount, locale).format({
        count: 1,
      });
      const many = new IntlMessageFormat(doc.messageCount, locale).format({
        count: 5,
      });
      expect(String(one)).toContain('1');
      expect(String(many)).toContain('5');
      expect(one).not.toBe(many);
    });

    it(`${locale}: nenhum rótulo do documento usa símbolo sem glifo nas fontes`, () => {
      // ★ (U+2605), → (U+2192) e ✓ (U+2713) não existem nem na NotoSans
      // nem na NotoEmoji vendorizadas: sairiam removidos pelo
      // `sanitizeForPdf`, deixando o selo mudo no documento.
      const semGlifo = [0x2605, 0x2192, 0x2713, 0x2606, 0x25b8];
      for (const [path, message] of flatten(block)) {
        for (const ch of message) {
          expect(
            semGlifo.includes(ch.codePointAt(0) ?? 0),
            `chave "${path}" usa "${ch}", que não tem glifo nas fontes do PDF`
          ).toBe(false);
        }
      }
    });
  }

  it('as duas árvores têm exatamente as mesmas chaves', () => {
    const keysEn = flatten(
      (LOCALES[0][1].exportConversation as Block) ?? {}
    ).map(([k]) => k);
    const keysPt = flatten(
      (LOCALES[1][1].exportConversation as Block) ?? {}
    ).map(([k]) => k);
    expect(keysPt.sort()).toEqual(keysEn.sort());
  });
});
