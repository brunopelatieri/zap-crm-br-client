import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@/lib/i18n/locales';

import { maxPossibleScore, resolveBand } from './scoring';
import { makeForm } from './test-fixtures';
import { buildFormTemplate, FORM_TEMPLATE_IDS } from './templates';
import { validateFormForPublish } from './validate';

const cases = FORM_TEMPLATE_IDS.flatMap((id) =>
  SUPPORTED_LOCALES.map((locale) => [id, locale] as const)
);

describe('modelos iniciais (SPEC 085 E-14)', () => {
  it.each(cases)('%s em %s publica sem ajuste', (id, locale) => {
    const tpl = buildFormTemplate(id, locale);
    const form = makeForm({
      name: tpl.name,
      slug: `modelo-${id.replace(/_/g, '-')}`,
      locale,
      settings: tpl.settings,
      theme: tpl.theme,
      scoring: { bands: tpl.bands },
    });
    expect(validateFormForPublish(form, tpl.fields)).toEqual([]);
  });

  it('todo modelo começa pelo telefone como identidade obrigatória', () => {
    for (const id of FORM_TEMPLATE_IDS) {
      const first = buildFormTemplate(id, 'pt-BR').fields[0];
      expect(first.type).toBe('phone');
      expect(first.is_identity).toBe(true);
      expect(first.required).toBe(true);
    }
  });

  it('a captação de lead cobre toda a pontuação possível com as faixas', () => {
    const tpl = buildFormTemplate('lead_capture', 'pt-BR');
    const max = maxPossibleScore(tpl.fields);
    expect(max).toBe(100);
    expect(resolveBand(tpl.bands, 0)?.key).toBe('cold');
    expect(resolveBand(tpl.bands, max)?.key).toBe('hot');
  });

  it('os textos mudam com o idioma e cada chamada devolve objetos novos', () => {
    const pt = buildFormTemplate('satisfaction', 'pt-BR');
    const en = buildFormTemplate('satisfaction', 'en');
    expect(pt.name).not.toBe(en.name);
    expect(pt.fields[0].label).not.toBe(en.fields[0].label);
    const again = buildFormTemplate('satisfaction', 'pt-BR');
    expect(again).toEqual(pt);
    expect(again.fields).not.toBe(pt.fields);
  });
});
