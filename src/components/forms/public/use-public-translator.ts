'use client';

// ============================================================
// Tradutor do namespace `PublicForm` NO IDIOMA DO FORMULÁRIO (PRD 084
// D-8, SPEC 085 E-10) — e não no do usuário que está logado.
//
// O servidor entrega o mapa plano (`loadPublicFormMessages`, ICU cru, chave
// com ponto); aqui ele vira árvore e passa por `createTranslator` do
// next-intl — o mesmo formatador do resto do app, sem `NextIntlClientProvider`
// aninhado. Chave ausente devolve o próprio nome da chave (nunca lança).
// ============================================================

import { useMemo } from 'react';
import { createTranslator } from 'next-intl';

import type {
  PublicFormMessageKey,
  PublicFormTranslator,
} from '@/lib/forms/public-messages';

export type PublicFormMessages = Record<PublicFormMessageKey, string>;

/** `{ 'unavailable.title': 'x' }` → `{ unavailable: { title: 'x' } }`. */
export function nestMessages(
  flat: Record<string, string>
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = node[parts[i]];
      if (!next || typeof next !== 'object') node[parts[i]] = {};
      node = node[parts[i]] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  }
  return root;
}

export function usePublicTranslator(
  locale: string,
  messages: PublicFormMessages
): PublicFormTranslator {
  return useMemo(() => {
    const translator = createTranslator({
      locale,
      messages: { PublicForm: nestMessages(messages) },
      namespace: 'PublicForm',
      onError: () => {},
      getMessageFallback: ({ key }) => key,
    });
    return translator as unknown as PublicFormTranslator;
  }, [locale, messages]);
}
