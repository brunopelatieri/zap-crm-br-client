import { describe, expect, it } from 'vitest';
import IntlMessageFormat from 'intl-messageformat';
import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';

import { ACTIVITY_CATALOG } from './types';

/**
 * O feed monta cada frase por CHAVE (`Activity.actions.<tipo>.<ação>`),
 * não por string interpolada — é o que tira o português cru de
 * `dashboard/queries.ts` (§7.1). Duas coisas podem quebrar isso sem o
 * `typecheck` notar (armadilha catalogada no AGENTS.md):
 *
 *   1. ICU inválido numa chave — só aparece no browser, como
 *      `INVALID_MESSAGE` no console e uma linha em branco no feed;
 *   2. uma ação NOVA no catálogo (§4) sem chave correspondente — o
 *      evento é gravado no banco e some da tela.
 *
 * Este teste fecha as duas, nos dois locales, a partir do catálogo —
 * então acrescentar uma ação em `types.ts` sem traduzi-la falha aqui.
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

/** Amostra para todo placeholder que o namespace usa. */
const SAMPLE: Record<string, unknown> = {
  actor: 'Bruno',
  label: 'Ana Paula',
  from: 'Proposta',
  to: 'Fechado',
  count: 2,
  shown: 4,
  role: 'admin',
  format: 'CSV',
  period: '30 dias',
};

const LOCALES: Array<[string, Block]> = [
  ['en', (en as Block).Activity as Block],
  ['pt-BR', (ptBR as Block).Activity as Block],
];

describe('Activity — sintaxe ICU e cobertura do catálogo', () => {
  for (const [locale, activity] of LOCALES) {
    it(`${locale}: o namespace existe com os blocos do §10`, () => {
      expect(activity).toBeDefined();
      expect(activity.page).toBeDefined();
      expect(activity.actions).toBeDefined();
      expect(activity.resourceTypes).toBeDefined();
    });

    it(`${locale}: toda mensagem compila e formata`, () => {
      const entries = flatten(activity);
      expect(entries.length).toBeGreaterThan(60);

      for (const [path, message] of entries) {
        expect(
          () => new IntlMessageFormat(message, locale).format(SAMPLE),
          `chave "${path}" tem ICU inválido: ${message}`
        ).not.toThrow();
      }
    });

    // A garantia que importa: o catálogo do §4 é a fonte, e cada ação
    // dele PRECISA de uma frase. Sem isto, um evento novo é gravado no
    // banco e não aparece em tela nenhuma.
    it(`${locale}: toda ação do catálogo tem chave de tradução`, () => {
      const actions = activity.actions as Block;
      for (const [resourceType, list] of Object.entries(ACTIVITY_CATALOG)) {
        for (const action of list as readonly string[]) {
          // 'contact.created' → bloco 'contact', chave 'created'.
          const suffix = action.slice(resourceType.length + 1);
          const block = actions[resourceType] as Block | undefined;
          expect(
            typeof block?.[suffix],
            `falta a chave Activity.actions.${resourceType}.${suffix} (ação "${action}")`
          ).toBe('string');
        }
      }
    });

    it(`${locale}: todo resource_type tem rótulo para o filtro de tipo`, () => {
      const labels = activity.resourceTypes as Block;
      for (const resourceType of Object.keys(ACTIVITY_CATALOG)) {
        expect(
          typeof labels[resourceType],
          `falta Activity.resourceTypes.${resourceType}`
        ).toBe('string');
      }
    });

    // Achado na verificação ao vivo: o contador dizia "1 eventos
    // carregados" porque o particípio ficou FORA do bloco plural. Em
    // pt-BR ele concorda em número; em en, "loaded" não flexiona e o
    // erro era invisível. Daí o teste exigir a frase INTEIRA coerente,
    // e não só o número certo.
    it(`${locale}: o contador concorda em número nos dois ramos`, () => {
      const page = activity.page as Record<string, string>;
      const one = String(
        new IntlMessageFormat(page.counter, locale).format({
          ...SAMPLE,
          shown: 1,
        })
      );
      const many = String(
        new IntlMessageFormat(page.counter, locale).format({
          ...SAMPLE,
          shown: 11,
        })
      );

      expect(one).toContain('1');
      expect(many).toContain('11');
      // Nenhuma palavra do ramo singular pode aparecer no plural com
      // terminação de singular, e vice-versa: o jeito estável de dizer
      // isso sem depender do idioma é que as duas frases, tiradas os
      // números, precisam ser DIFERENTES quando o idioma flexiona.
      const stripDigits = (s: string) => s.replace(/\d+/g, '');
      if (locale === 'pt-BR') {
        expect(stripDigits(one)).not.toBe(stripDigits(many));
        expect(one).not.toContain('eventos');
        expect(many).not.toMatch(/\bcarregado\b/);
      }
    });

    it(`${locale}: o plural de importação resolve os dois ramos`, () => {
      const actions = activity.actions as Block;
      const contact = actions.contact as Record<string, string>;
      const one = new IntlMessageFormat(contact.imported, locale).format({
        ...SAMPLE,
        count: 1,
      });
      const many = new IntlMessageFormat(contact.imported, locale).format({
        ...SAMPLE,
        count: 500,
      });
      expect(String(one)).toContain('1');
      expect(String(many)).toContain('500');
      expect(one).not.toBe(many);
    });
  }

  it('as duas árvores têm exatamente as mesmas chaves', () => {
    const keysEn = flatten(LOCALES[0][1]).map(([k]) => k);
    const keysPt = flatten(LOCALES[1][1]).map(([k]) => k);
    expect(keysPt.sort()).toEqual(keysEn.sort());
  });
});
