import IntlMessageFormat from 'intl-messageformat';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';

import {
  loadPublicFormMessages,
  loadPublicFormTranslator,
  PUBLIC_FORM_MESSAGE_KEYS,
  PUBLIC_FORM_NAMESPACE,
  resolveFormLocale,
} from './public-messages';

type Tree = Record<string, unknown>;

function lookup(tree: Tree, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, part) => {
    if (!node || typeof node !== 'object') return undefined;
    return (node as Tree)[part];
  }, tree);
}

const dictionaries: [string, Tree][] = [
  ['en', en as Tree],
  ['pt-BR', ptBR as Tree],
];

describe('PublicForm (SPEC 085 §10.1, PRD 084 D-8)', () => {
  it.each(dictionaries)(
    '%s tem todas as chaves que a página pública usa, e compilam em ICU',
    (locale, tree) => {
      const ns = lookup(tree, PUBLIC_FORM_NAMESPACE) as Tree;
      expect(ns).toBeDefined();
      for (const key of PUBLIC_FORM_MESSAGE_KEYS) {
        const message = lookup(ns, key);
        expect(typeof message, `${locale}: PublicForm.${key}`).toBe('string');
        expect(
          () => new IntlMessageFormat(message as string, locale),
          `${locale}: PublicForm.${key}`
        ).not.toThrow();
      }
    }
  );

  it('os placeholders são os mesmos nos dois idiomas', () => {
    const vars = (s: string) =>
      [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    for (const key of PUBLIC_FORM_MESSAGE_KEYS) {
      const a = lookup(en as Tree, `PublicForm.${key}`) as string;
      const b = lookup(ptBR as Tree, `PublicForm.${key}`) as string;
      expect(vars(b), `PublicForm.${key}`).toEqual(vars(a));
    }
  });

  it('o tradutor segue o idioma do formulário, não o do visitante', async () => {
    const t = await loadPublicFormTranslator('en');
    expect(t('submit')).toBe(
      (en as Tree & { PublicForm: Tree }).PublicForm.submit
    );
    const tp = await loadPublicFormTranslator('pt-BR');
    expect(tp('submit')).toBe(
      (ptBR as Tree & { PublicForm: Tree }).PublicForm.submit
    );
    expect(tp('submit')).not.toBe(t('submit'));
  });

  it('idioma desconhecido cai no padrão e o mapa completo nunca lança', async () => {
    expect(resolveFormLocale('fr')).toBe('pt-BR');
    expect(resolveFormLocale(null)).toBe('pt-BR');
    const all = await loadPublicFormMessages('xx');
    expect(Object.keys(all).sort()).toEqual(
      [...PUBLIC_FORM_MESSAGE_KEYS].sort()
    );
    for (const key of PUBLIC_FORM_MESSAGE_KEYS) {
      expect(all[key]).toBeTruthy();
    }
  });
});

describe('mapa cru para o cliente (achado da revisão)', () => {
  it('devolve a mensagem ICU intacta, sem passar pelo tradutor nem logar erro', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const all = await loadPublicFormMessages('pt-BR');
    expect(all.minChoices).toContain('{min, plural,');
    expect(all.progress).toBe('{current} de {total}');
    expect(all.minChoices).not.toBe('PublicForm.minChoices');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
