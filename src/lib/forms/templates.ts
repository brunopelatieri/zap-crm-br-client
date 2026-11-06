// ============================================================
// Modelos iniciais (SPEC 085 E-14).
//
// "Em branco", "Captação de lead", "Pesquisa de satisfação" e "Inscrição
// em evento", nos dois idiomas. O texto dos blocos é CONTEÚDO do
// formulário (o owner edita), não tradução de UI — por isso vive aqui,
// pelo `locale` escolhido na criação, e não no dicionário (mesma regra
// dos templates de automação, docs/context/i18n.md § limites). Só o nome
// e a descrição do modelo na galeria serão traduzidos na F2 (`Forms.*`).
//
// Cada modelo passa em `validateFormForPublish` (teste co-locado): o
// `admin` que publicar sem mexer em nada não pode receber erro.
// ============================================================

import type { FormLocale } from './types';
import type { Band, FormFieldInput, FormSettings, FormTheme } from './types';

export type FormTemplateId =
  'blank' | 'lead_capture' | 'satisfaction' | 'event_signup';

export const FORM_TEMPLATE_IDS: readonly FormTemplateId[] = [
  'blank',
  'lead_capture',
  'satisfaction',
  'event_signup',
];

export interface FormTemplate {
  id: FormTemplateId;
  name: string;
  description: string | null;
  settings: FormSettings;
  theme: FormTheme;
  bands: Band[];
  fields: FormFieldInput[];
}

type Texts = Record<string, string>;

const T: Record<FormLocale, Texts> = {
  'pt-BR': {
    blank_name: 'Novo formulário',
    phone_label: 'Qual é o seu WhatsApp?',
    phone_desc: 'Com DDD. É por ele que vamos falar com você.',
    name_label: 'Como podemos te chamar?',
    email_label: 'Qual é o seu e-mail?',
    continue: 'Continuar',
    start: 'Começar',
    thanks_title: 'Obrigado!',
    thanks_body: 'Recebemos suas respostas. Em breve falamos com você.',
    // Captação de lead
    lead_name: 'Captação de lead',
    lead_desc:
      'Nome, WhatsApp, interesse, orçamento, prazo e consentimento, com pontuação por faixa.',
    lead_welcome_title: 'Vamos entender o que você precisa',
    lead_welcome_desc: 'Leva menos de um minuto.',
    lead_interest: 'O que você procura?',
    lead_interest_a: 'Quero contratar agora',
    lead_interest_b: 'Estou comparando opções',
    lead_interest_c: 'Só curiosidade',
    lead_budget: 'Qual é o seu orçamento?',
    lead_budget_a: 'Até R$ 1.000',
    lead_budget_b: 'De R$ 1.000 a R$ 5.000',
    lead_budget_c: 'Acima de R$ 5.000',
    lead_deadline: 'Para quando?',
    lead_deadline_a: 'Este mês',
    lead_deadline_b: 'Nos próximos 3 meses',
    lead_deadline_c: 'Sem data definida',
    lead_consent:
      'Autorizo o contato pelo WhatsApp e o uso dos meus dados para esta proposta.',
    band_cold: 'Frio',
    band_warm: 'Morno',
    band_hot: 'Quente',
    // Satisfação
    sat_name: 'Pesquisa de satisfação',
    sat_desc: 'Nota de 1 a 10 e o que podemos melhorar.',
    sat_welcome_title: 'Como foi a sua experiência?',
    sat_welcome_desc: 'Duas perguntas rápidas.',
    sat_rating: 'De 1 a 10, quanto você recomendaria a gente?',
    sat_improve: 'O que podemos melhorar?',
    sat_improve_desc: 'Opcional, mas ajuda muito.',
    // Evento
    evt_name: 'Inscrição em evento',
    evt_desc: 'Nome, WhatsApp, e-mail, acompanhantes e restrições.',
    evt_welcome_title: 'Garanta a sua vaga',
    evt_welcome_desc: 'Preencha para confirmar a inscrição.',
    evt_guests: 'Vai levar acompanhantes?',
    evt_guests_desc: 'Quantas pessoas além de você (0 se nenhuma).',
    evt_restrictions: 'Alguma restrição alimentar ou de acessibilidade?',
    evt_thanks_body:
      'Inscrição recebida! Enviaremos os detalhes pelo WhatsApp.',
  },
  en: {
    blank_name: 'New form',
    phone_label: 'What is your WhatsApp number?',
    phone_desc: 'With country and area code. That is where we will reach you.',
    name_label: 'What should we call you?',
    email_label: 'What is your email?',
    continue: 'Continue',
    start: 'Start',
    thanks_title: 'Thank you!',
    thanks_body: 'We got your answers. We will be in touch soon.',
    lead_name: 'Lead capture',
    lead_desc:
      'Name, WhatsApp, interest, budget, timeline and consent, scored by band.',
    lead_welcome_title: 'Let us understand what you need',
    lead_welcome_desc: 'It takes less than a minute.',
    lead_interest: 'What are you looking for?',
    lead_interest_a: 'I want to hire now',
    lead_interest_b: 'I am comparing options',
    lead_interest_c: 'Just curious',
    lead_budget: 'What is your budget?',
    lead_budget_a: 'Up to $1,000',
    lead_budget_b: '$1,000 to $5,000',
    lead_budget_c: 'Above $5,000',
    lead_deadline: 'When do you need it?',
    lead_deadline_a: 'This month',
    lead_deadline_b: 'In the next 3 months',
    lead_deadline_c: 'No date yet',
    lead_consent:
      'I agree to be contacted on WhatsApp and to the use of my data for this proposal.',
    band_cold: 'Cold',
    band_warm: 'Warm',
    band_hot: 'Hot',
    sat_name: 'Satisfaction survey',
    sat_desc: 'A 1–10 score and what we could do better.',
    sat_welcome_title: 'How was your experience?',
    sat_welcome_desc: 'Two quick questions.',
    sat_rating: 'From 1 to 10, how likely are you to recommend us?',
    sat_improve: 'What could we do better?',
    sat_improve_desc: 'Optional, but it helps a lot.',
    evt_name: 'Event registration',
    evt_desc: 'Name, WhatsApp, email, guests and restrictions.',
    evt_welcome_title: 'Save your spot',
    evt_welcome_desc: 'Fill in to confirm your registration.',
    evt_guests: 'Bringing guests?',
    evt_guests_desc: 'How many people besides you (0 if none).',
    evt_restrictions: 'Any dietary or accessibility needs?',
    evt_thanks_body:
      'Registration received! We will send the details on WhatsApp.',
  },
};

function field(
  position: number,
  partial: Partial<FormFieldInput> &
    Pick<FormFieldInput, 'key' | 'type' | 'label'>
): FormFieldInput {
  return {
    position,
    description: null,
    required: false,
    is_identity: false,
    options: null,
    validation: {},
    media: null,
    mapping: null,
    show_if: null,
    ...partial,
  };
}

function phoneField(t: Texts, position = 0): FormFieldInput {
  return field(position, {
    key: 'phone',
    type: 'phone',
    label: t.phone_label,
    description: t.phone_desc,
    required: true,
    is_identity: true,
  });
}

function nameField(t: Texts, position: number): FormFieldInput {
  return field(position, {
    key: 'name',
    type: 'short_text',
    label: t.name_label,
    required: true,
    validation: { max_length: 120 },
    mapping: { target: 'contact.name', overwrite: false },
  });
}

function baseTheme(
  t: Texts,
  welcomeTitle: string,
  welcomeDesc: string,
  thanksBody?: string
): FormTheme {
  return {
    colors: {
      primary: '#16a34a',
      background: '#ffffff',
      text: '#111827',
      button: '#16a34a',
    },
    font: 'system',
    radius: 'rounded',
    welcome: {
      title: welcomeTitle,
      description: welcomeDesc,
      button_label: t.start,
      media: null,
    },
    thank_you: {
      title: t.thanks_title,
      body: thanksBody ?? t.thanks_body,
      whatsapp_cta: false,
      redirect_url: null,
    },
  };
}

const DEFAULT_SETTINGS: FormSettings = {
  accept_generic_link: true,
  confirm_phone_with_token: false,
  allow_multiple_responses: false,
  token_ttl_days: 30,
  turnstile: false,
  embed_origins: [],
  robots_noindex: false,
};

/** Constrói o modelo no idioma. Cada chamada devolve objetos novos. */
export function buildFormTemplate(
  id: FormTemplateId,
  locale: FormLocale
): FormTemplate {
  const t = T[locale] ?? T['pt-BR'];

  switch (id) {
    case 'blank':
      return {
        id,
        name: t.blank_name,
        description: null,
        settings: { ...DEFAULT_SETTINGS },
        theme: baseTheme(t, t.blank_name, ''),
        bands: [],
        fields: [phoneField(t)],
      };

    case 'lead_capture':
      return {
        id,
        name: t.lead_name,
        description: t.lead_desc,
        settings: { ...DEFAULT_SETTINGS },
        theme: baseTheme(t, t.lead_welcome_title, t.lead_welcome_desc),
        bands: [
          { key: 'cold', label: t.band_cold, min: 0, max: 20, actions: {} },
          { key: 'warm', label: t.band_warm, min: 21, max: 60, actions: {} },
          { key: 'hot', label: t.band_hot, min: 61, max: null, actions: {} },
        ],
        fields: [
          phoneField(t, 0),
          nameField(t, 1),
          field(2, {
            key: 'interest',
            type: 'single_select',
            label: t.lead_interest,
            required: true,
            options: [
              { id: 'now', label: t.lead_interest_a, points: 40 },
              { id: 'comparing', label: t.lead_interest_b, points: 20 },
              { id: 'curious', label: t.lead_interest_c, points: 0 },
            ],
          }),
          field(3, {
            key: 'budget',
            type: 'single_select',
            label: t.lead_budget,
            required: true,
            options: [
              { id: 'low', label: t.lead_budget_a, points: 5 },
              { id: 'mid', label: t.lead_budget_b, points: 15 },
              { id: 'high', label: t.lead_budget_c, points: 30 },
            ],
          }),
          field(4, {
            key: 'deadline',
            type: 'single_select',
            label: t.lead_deadline,
            required: true,
            options: [
              { id: 'month', label: t.lead_deadline_a, points: 30 },
              { id: 'quarter', label: t.lead_deadline_b, points: 15 },
              { id: 'none', label: t.lead_deadline_c, points: 0 },
            ],
          }),
          field(5, {
            key: 'consent',
            type: 'consent',
            label: t.lead_consent,
            required: true,
            mapping: { target: 'contact.opt_in' },
          }),
        ],
      };

    case 'satisfaction':
      return {
        id,
        name: t.sat_name,
        description: t.sat_desc,
        settings: { ...DEFAULT_SETTINGS, allow_multiple_responses: true },
        theme: baseTheme(t, t.sat_welcome_title, t.sat_welcome_desc),
        bands: [],
        fields: [
          phoneField(t, 0),
          field(1, {
            key: 'score',
            type: 'rating',
            label: t.sat_rating,
            required: true,
            validation: { scale: 10 },
          }),
          field(2, {
            key: 'improve',
            type: 'long_text',
            label: t.sat_improve,
            description: t.sat_improve_desc,
            required: false,
            validation: { max_length: 2000 },
          }),
        ],
      };

    case 'event_signup':
      return {
        id,
        name: t.evt_name,
        description: t.evt_desc,
        settings: { ...DEFAULT_SETTINGS },
        theme: baseTheme(
          t,
          t.evt_welcome_title,
          t.evt_welcome_desc,
          t.evt_thanks_body
        ),
        bands: [],
        fields: [
          phoneField(t, 0),
          nameField(t, 1),
          field(2, {
            key: 'email',
            type: 'email',
            label: t.email_label,
            required: true,
            mapping: { target: 'contact.email', overwrite: false },
          }),
          field(3, {
            key: 'guests',
            type: 'number',
            label: t.evt_guests,
            description: t.evt_guests_desc,
            required: true,
            validation: { min: 0, max: 10, step: 1 },
          }),
          field(4, {
            key: 'restrictions',
            type: 'long_text',
            label: t.evt_restrictions,
            required: false,
            validation: { max_length: 1000 },
          }),
        ],
      };

    default: {
      const never: never = id;
      throw new Error(`Unknown form template: ${String(never)}`);
    }
  }
}
