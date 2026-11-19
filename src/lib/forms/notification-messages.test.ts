// `Notifications.formResponseReceived` é servido por rota (a notificação é
// gravada traduzida, no idioma do FORMULÁRIO): os testes de rota mockam o
// formatador, então aqui cada mensagem compila nos dois locales e os
// placeholders batem (padrão de `messages-icu.test.ts`).

import IntlMessageFormat from 'intl-messageformat';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';

type Block = Record<string, string>;
const block = (d: unknown) =>
  (d as { Notifications: { formResponseReceived: Block } }).Notifications
    .formResponseReceived;

const KEYS = ['title', 'body', 'bodyWithBand'] as const;
const VALUES = { form: 'Captação', contact: 'Ana', band: 'Quente' };

describe('Notifications.formResponseReceived', () => {
  it.each([
    ['en', en],
    ['pt-BR', ptBR],
  ] as const)(
    '%s: todas as chaves existem e formatam sem erro',
    (locale, d) => {
      for (const key of KEYS) {
        const message = block(d)[key];
        expect(typeof message, key).toBe('string');
        const out = new IntlMessageFormat(message, locale).format(VALUES);
        expect(String(out).length).toBeGreaterThan(0);
      }
      expect(
        new IntlMessageFormat(block(d).bodyWithBand, locale).format(VALUES)
      ).toContain('Quente');
      expect(
        new IntlMessageFormat(block(d).title, locale).format(VALUES)
      ).toContain('Captação');
    }
  );

  it('os placeholders são os mesmos nos dois idiomas', () => {
    const vars = (s: string) =>
      [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    for (const key of KEYS) {
      expect(vars(block(ptBR)[key]), key).toEqual(vars(block(en)[key]));
    }
  });
});
