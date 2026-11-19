// ============================================================
// Componente de preenchimento (SPEC 085 §4.2) — renderização no servidor.
//
// Sem biblioteca de DOM no projeto, o que dá para travar aqui é a TELA
// INICIAL: o idioma do FORMULÁRIO (não o do usuário), o tema por CSS
// variables, o ICU formatado, o escape de conteúdo do owner. A navegação
// bloco a bloco é regra pura e já tem teste em `logic.test.ts` e
// `validate.test.ts`; o que muda de tela é só estado de React.
// ============================================================

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildFormTemplate } from '@/lib/forms/templates';
import { buildPreviewPayload } from '@/lib/forms/preview';
import { makeForm } from '@/lib/forms/test-fixtures';

import ptBR from '../../../../messages/pt-BR.json';
import en from '../../../../messages/en.json';

import { PublicForm } from './public-form';
import { nestMessages, type PublicFormMessages } from './use-public-translator';

import { PUBLIC_FORM_MESSAGE_KEYS } from '@/lib/forms/public-messages';

function flatMessages(dict: Record<string, unknown>): PublicFormMessages {
  const ns = dict.PublicForm as Record<string, unknown>;
  const out = {} as Record<string, string>;
  for (const key of PUBLIC_FORM_MESSAGE_KEYS) {
    out[key] = key
      .split('.')
      .reduce<unknown>(
        (n, part) => (n as Record<string, unknown> | undefined)?.[part],
        ns
      ) as string;
  }
  return out as PublicFormMessages;
}

const PT = flatMessages(ptBR as Record<string, unknown>);
const EN = flatMessages(en as Record<string, unknown>);

function payloadOf(locale: 'pt-BR' | 'en', over = {}) {
  const t = buildFormTemplate('lead_capture', locale);
  const form = makeForm({
    locale,
    name: t.name,
    theme: t.theme,
    settings: t.settings,
    ...over,
  });
  return buildPreviewPayload(form, t.fields);
}

describe('nestMessages', () => {
  it('chave com ponto vira árvore', () => {
    expect(
      nestMessages({
        start: 'a',
        'unavailable.title': 'b',
        'unavailable.body': 'c',
      })
    ).toEqual({ start: 'a', unavailable: { title: 'b', body: 'c' } });
  });
});

describe('PublicForm — tela de boas-vindas', () => {
  it('usa o idioma do formulário e formata o ICU (tempo estimado, rodapé)', () => {
    const pt = renderToString(
      <PublicForm payload={payloadOf('pt-BR')} messages={PT} mode="preview" />
    );
    expect(pt).toContain('Começar');
    expect(pt).toContain('Vamos entender o que você precisa');
    expect(pt).toContain('lang="pt-BR"');
    // 6 blocos com entrada × 10 s = 1 minuto.
    expect(pt).toContain('Leva cerca de 1 minuto');
    expect(pt).toContain('Feito com ZAP CRM BR');

    const english = renderToString(
      <PublicForm payload={payloadOf('en')} messages={EN} mode="preview" />
    );
    expect(english).toContain('Start');
    expect(english).toContain('Made with ZAP CRM BR');
    expect(english).not.toContain('Começar');
  });

  it('tema vira CSS variables; o botão usa texto legível sobre a cor dele', () => {
    const html = renderToString(
      <PublicForm
        payload={payloadOf('pt-BR', {
          theme: {
            colors: {
              primary: '#ff0000',
              background: '#000000',
              text: '#ffffff',
              button: '#ffff00',
            },
            radius: 'square',
          },
        })}
        messages={PT}
        mode="preview"
      />
    );
    expect(html).toContain('--pf-primary:#ff0000');
    expect(html).toContain('--pf-bg:#000000');
    expect(html).toContain('--pf-radius:0px');
    // Amarelo claro → texto preto.
    expect(html).toContain('--pf-button-text:#000000');
  });

  it('cor fora do formato hex não chega ao CSS (a projeção descarta)', () => {
    const html = renderToString(
      <PublicForm
        payload={payloadOf('pt-BR', {
          theme: { colors: { primary: 'red; background:url(x)' } },
        })}
        messages={PT}
        mode="preview"
      />
    );
    expect(html).not.toContain('url(x)');
    expect(html).toContain('--pf-primary:#16a34a');
  });

  it('texto do owner é escapado (nada vira HTML)', () => {
    const html = renderToString(
      <PublicForm
        payload={payloadOf('pt-BR', {
          theme: { welcome: { title: '<img src=x onerror=alert(1)>' } },
        })}
        messages={PT}
        mode="preview"
      />
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('a prévia não carrega pontos nem ids internos no HTML', () => {
    const html = renderToString(
      <PublicForm payload={payloadOf('pt-BR')} messages={PT} mode="preview" />
    );
    expect(html).not.toContain('points');
    expect(html).not.toContain('account_id');
  });
});
