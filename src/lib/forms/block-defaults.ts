// ============================================================
// Textos iniciais de um bloco recém-criado no construtor (SPEC 085 §4.3).
//
// São CONTEÚDO do formulário (o owner edita), não tradução de UI: saem no
// idioma do FORMULÁRIO (`forms.locale`), não no de quem está logado — a
// mesma regra dos modelos (`templates.ts`, docs/context/i18n.md § limites).
// Os rótulos do construtor (nome do tipo, dicas) são `Forms.builder.types.*`.
// ============================================================

import type { FieldType, FormLocale } from './types';

export interface BlockDefaultTexts {
  label: string;
  options?: string[];
}

const TEXTS: Record<FormLocale, Record<FieldType, BlockDefaultTexts>> = {
  'pt-BR': {
    short_text: { label: 'Qual é a sua resposta?' },
    long_text: { label: 'Conte mais para a gente' },
    email: { label: 'Qual é o seu e-mail?' },
    phone: { label: 'Qual é o seu WhatsApp?' },
    number: { label: 'Informe um número' },
    date: { label: 'Escolha uma data' },
    single_select: {
      label: 'Escolha uma opção',
      options: ['Opção 1', 'Opção 2'],
    },
    multi_select: {
      label: 'Escolha uma ou mais opções',
      options: ['Opção 1', 'Opção 2'],
    },
    dropdown: {
      label: 'Selecione na lista',
      options: ['Opção 1', 'Opção 2'],
    },
    yes_no: { label: 'Você concorda?', options: ['Sim', 'Não'] },
    rating: { label: 'Como você avalia?' },
    file_upload: { label: 'Envie um arquivo' },
    statement: { label: 'Uma mensagem para quem está respondendo' },
    consent: {
      label: 'Autorizo o contato pelo WhatsApp e o uso dos meus dados.',
    },
  },
  en: {
    short_text: { label: 'What is your answer?' },
    long_text: { label: 'Tell us more' },
    email: { label: 'What is your email?' },
    phone: { label: 'What is your WhatsApp number?' },
    number: { label: 'Enter a number' },
    date: { label: 'Pick a date' },
    single_select: {
      label: 'Choose an option',
      options: ['Option 1', 'Option 2'],
    },
    multi_select: {
      label: 'Choose one or more options',
      options: ['Option 1', 'Option 2'],
    },
    dropdown: {
      label: 'Select from the list',
      options: ['Option 1', 'Option 2'],
    },
    yes_no: { label: 'Do you agree?', options: ['Yes', 'No'] },
    rating: { label: 'How would you rate it?' },
    file_upload: { label: 'Upload a file' },
    statement: { label: 'A message for the person answering' },
    consent: {
      label: 'I agree to be contacted on WhatsApp and to the use of my data.',
    },
  },
};

export function blockDefaultTexts(
  type: FieldType,
  locale: FormLocale
): BlockDefaultTexts {
  return (TEXTS[locale] ?? TEXTS['pt-BR'])[type];
}

/** Rótulo do telefone de identidade criado ao ligar "aceitar link genérico". */
export function identityTexts(locale: FormLocale): {
  label: string;
  description: string;
} {
  return locale === 'en'
    ? {
        label: 'What is your WhatsApp number?',
        description:
          'With country and area code. That is where we will reach you.',
      }
    : {
        label: 'Qual é o seu WhatsApp?',
        description: 'Com DDD. É por ele que vamos falar com você.',
      };
}

/** Sufixo do nome ao duplicar (a rota de duplicar recebe o nome já pronto). */
export function copyName(name: string, locale: FormLocale): string {
  const suffix = locale === 'en' ? 'copy' : 'cópia';
  return `${name} (${suffix})`.slice(0, 120);
}
