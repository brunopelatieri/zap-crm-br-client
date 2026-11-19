'use client';

// ============================================================
// Página de preenchimento — um bloco por tela (PRD 084 D-1, SPEC 085 §4.2).
//
// É O MESMO componente da prévia do construtor e da página pública:
//   - `mode="preview"` (F2): nada grava; o último bloco leva à tela de
//     agradecimento sem enviar nada;
//   - `mode="live"` (F3): `onSubmit` recebe as respostas, o servidor
//     revalida tudo e devolve o agradecimento.
//
// O que a F3 ainda precisa acrescentar (SPEC 085 §11, F3):
//   1. `POST …/start` ao responder o bloco de identidade (e autosave por
//      bloco, `PATCH …/responses/[id]`); `identity.mode = 'token'` pula o
//      bloco de telefone (salvo `confirm_phone_with_token`);
//   2. upload de arquivo (`…/upload-url` + `PUT` na URL assinada) no lugar
//      do bloco desligado de `file_upload`;
//   3. rascunho local (`localStorage`, em try/catch) e fila de reenvio;
//   4. Turnstile quando `settings.turnstile_site_key` vier no payload;
//   5. botão "Falar no WhatsApp" com o `wa.me` do canal e o
//      redirecionamento de `redirect_url` após 3 s;
//   6. `postMessage({ type: 'zapcrm-form-resize', height })` para o embed
//      (`src/lib/forms/embed.ts`).
//
// Texto de SISTEMA vem de `PublicForm.*` no idioma do FORMULÁRIO (D-8),
// pelo `usePublicTranslator`; o texto do formulário (perguntas, opções) é
// conteúdo. Só CSS variables do tema do formulário (`--pf-*`).
// ============================================================

import { ArrowLeft, ArrowRight, Check, MessageCircle } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import { readableTextColor } from '@/lib/forms/contrast';
import { nextFieldKey, resolveVisibleFields } from '@/lib/forms/logic';
import { validateAnswer, type AnswerErrorCode } from '@/lib/forms/validate';
import type {
  AnswerValue,
  Answers,
  PublicField,
  PublicFormPayload,
} from '@/lib/forms/types';

import { FieldInput, OPTION_LETTERS } from './field-input';
import { FormMedia } from './form-media';
import {
  usePublicTranslator,
  type PublicFormMessages,
} from './use-public-translator';

export const DEFAULT_THEME_COLORS = {
  primary: '#16a34a',
  background: '#ffffff',
  text: '#111827',
  button: '#16a34a',
} as const;

const FONT_STACKS = {
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  rounded: 'ui-rounded, "Nunito", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

const AUTO_ADVANCE_MS = 300;
const BRAND = 'ZAP CRM BR';

type Screen =
  { kind: 'welcome' } | { kind: 'field'; key: string } | { kind: 'thanks' };

export interface PublicFormProps {
  payload: PublicFormPayload;
  messages: PublicFormMessages;
  mode: 'preview' | 'live';
  /** `live` (F3): chamado no último bloco com as respostas cruas. */
  onSubmit?: (answers: Answers) => Promise<void> | void;
  /** Texto do aviso do bloco de arquivo na prévia (vem do namespace `Forms`). */
  filesDisabledNotice?: string | null;
  /**
   * Prévia: `key` de um bloco para mostrar agora (o construtor passa o bloco
   * selecionado). Só reage quando o valor MUDA; `null` não faz nada.
   */
  jumpTo?: string | null;
}

export function PublicForm({
  payload,
  messages,
  mode,
  onSubmit,
  filesDisabledNotice,
  jumpTo,
}: PublicFormProps) {
  const t = usePublicTranslator(payload.locale, messages);

  const fields = useMemo(
    () => payload.fields.map((f, i) => ({ ...f, position: i })),
    [payload.fields]
  );
  const [screen, setScreen] = useState<Screen>({ kind: 'welcome' });
  const [answers, setAnswers] = useState<Answers>({});
  const [history, setHistory] = useState<string[]>([]);
  const [errorCode, setErrorCode] = useState<AnswerErrorCode | null>(null);
  // Quem mudou de tela? Na prévia, o foco só vai para a moldura quando foi quem
  // está respondendo (Enter, botão); mudança vinda do construtor (`jumpTo`) não
  // pode tirar o foco do painel de edição.
  const [userDriven, setUserDriven] = useState(false);
  const focusInside = mode === 'live' || userDriven;
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  // Prévia: mostra o bloco que o construtor selecionou.
  useEffect(() => {
    if (!jumpTo) return;
    if (fields.some((f) => f.key === jumpTo)) {
      setErrorCode(null);
      // Mesmo bloco → mesmo objeto: sem render nem efeito de foco a cada tecla
      // digitada no painel do construtor.
      setScreen((prev) =>
        prev.kind === 'field' && prev.key === jumpTo
          ? prev
          : { kind: 'field', key: jumpTo }
      );
      setUserDriven(false);
    }
  }, [jumpTo, fields]);
  // O bloco da tela foi apagado/renomeado no construtor: volta ao início.
  useEffect(() => {
    if (screen.kind === 'field' && !fields.some((f) => f.key === screen.key)) {
      setScreen({ kind: 'welcome' });
    }
  }, [fields, screen]);
  // Foco no contêiner a cada tela: Enter e atalhos de letra funcionam sem
  // clicar (os campos de texto pegam o foco por conta própria).
  // Só na página de verdade: na prévia o foco é do painel do construtor.
  useEffect(() => {
    if (focusInside) rootRef.current?.focus({ preventScroll: true });
  }, [screen, focusInside]);

  const colors = { ...DEFAULT_THEME_COLORS, ...payload.theme.colors };
  const radius = payload.theme.radius === 'square' ? '0px' : '0.75rem';
  const vars = {
    '--pf-primary': colors.primary,
    '--pf-bg': colors.background,
    '--pf-text': colors.text,
    '--pf-button': colors.button,
    '--pf-button-text': readableTextColor(colors.button),
    '--pf-radius': radius,
    background: colors.background,
    color: colors.text,
    fontFamily: FONT_STACKS[payload.theme.font] ?? FONT_STACKS.system,
  } as CSSProperties;

  const field =
    screen.kind === 'field'
      ? (fields.find((f) => f.key === screen.key) ?? null)
      : null;

  const visible = useMemo(
    () => resolveVisibleFields(fields, answers),
    [fields, answers]
  );
  const current = field ? visible.findIndex((f) => f.key === field.key) + 1 : 0;
  const total = visible.length;
  const pct =
    screen.kind === 'thanks'
      ? 100
      : screen.kind === 'welcome' || total === 0
        ? 0
        : Math.round(((current - 1) / total) * 100);

  const setAnswer = useCallback(
    (key: string, value: AnswerValue | undefined) => {
      setErrorCode(null);
      setAnswers((prev) => {
        const next = { ...prev };
        if (value === undefined) delete next[key];
        else next[key] = value;
        return next;
      });
    },
    []
  );

  const finish = useCallback(
    async (finalAnswers: Answers) => {
      if (mode === 'live' && onSubmit) {
        setSubmitting(true);
        try {
          await onSubmit(finalAnswers);
        } finally {
          setSubmitting(false);
        }
      }
      setScreen({ kind: 'thanks' });
    },
    [mode, onSubmit]
  );

  const advance = useCallback(
    (from: PublicField, answersNow: Answers) => {
      // Na prévia o envio de arquivo está desligado: validar bloqueava o
      // fluxo num `file_upload` obrigatório.
      const result =
        mode === 'preview' && from.type === 'file_upload'
          ? null
          : validateAnswer(from, answersNow[from.key], {});
      if (result && 'code' in result) {
        setErrorCode(result.code);
        return;
      }
      setErrorCode(null);
      setUserDriven(true);
      const next = nextFieldKey(fields, answersNow, from.key);
      if (next) {
        setHistory((h) => [...h, from.key]);
        setScreen({ kind: 'field', key: next });
      } else {
        void finish(answersNow);
      }
    },
    [fields, finish, mode]
  );

  const start = () => {
    setUserDriven(true);
    const first = nextFieldKey(fields, answers, null);
    if (first) setScreen({ kind: 'field', key: first });
    else setScreen({ kind: 'thanks' });
  };

  const back = () => {
    setErrorCode(null);
    setUserDriven(true);
    const prev = history[history.length - 1];
    if (prev === undefined) {
      setScreen({ kind: 'welcome' });
      return;
    }
    setHistory((h) => h.slice(0, -1));
    setScreen({ kind: 'field', key: prev });
  };

  const pick = (f: PublicField, value: AnswerValue) => {
    const nextAnswers = { ...answers, [f.key]: value };
    setAnswer(f.key, value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => advance(f, nextAnswers), AUTO_ADVANCE_MS);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (screen.kind === 'welcome' && e.key === 'Enter') {
      e.preventDefault();
      start();
      return;
    }
    if (!field) return;

    // Atalhos de letra nas escolhas (A, B, C…).
    if (
      /^[a-z]$/i.test(e.key) &&
      field.options &&
      (field.type === 'single_select' ||
        field.type === 'yes_no' ||
        field.type === 'multi_select')
    ) {
      const idx = OPTION_LETTERS.indexOf(e.key.toUpperCase());
      const option = idx >= 0 ? field.options[idx] : undefined;
      if (!option) return;
      e.preventDefault();
      if (field.type === 'multi_select') {
        const chosen = Array.isArray(answers[field.key])
          ? (answers[field.key] as string[])
          : [];
        const next = chosen.includes(option.id)
          ? chosen.filter((id) => id !== option.id)
          : [...chosen, option.id];
        setAnswer(field.key, next.length ? next : undefined);
      } else {
        pick(field, field.type === 'yes_no' ? option.id === 'yes' : option.id);
      }
      return;
    }

    // Enter num botão já o aciona; fora dele, avança.
    if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault();
      advance(field, answers);
    }
  };

  const welcome = payload.theme.welcome;
  const thanks = payload.theme.thank_you;
  const isLast = field
    ? nextFieldKey(fields, answers, field.key) === null
    : false;
  const minutes = Math.max(1, Math.ceil(payload.estimated_seconds / 60));
  const errorId = field ? `pf-error-${field.key}` : undefined;

  const buttonStyle: CSSProperties = {
    background: 'var(--pf-button)',
    color: 'var(--pf-button-text)',
    borderRadius: 'var(--pf-radius)',
  };
  const buttonClass =
    'inline-flex items-center gap-2 px-5 py-3 text-base font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2';

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative flex h-full min-h-[480px] w-full flex-col overflow-hidden outline-none"
      style={vars}
      lang={payload.locale}
    >
      {/* Progresso */}
      <div
        className="h-1 w-full shrink-0"
        style={{
          background: 'color-mix(in srgb, var(--pf-text) 12%, transparent)',
        }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="h-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: 'var(--pf-primary)' }}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-6 py-10">
          {screen.kind === 'welcome' && (
            <div className="flex flex-col items-start gap-4">
              {payload.theme.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={payload.theme.logo_url}
                  alt=""
                  className="mb-2 max-h-14 w-auto"
                />
              ) : null}
              <FormMedia
                media={welcome.media}
                radius={radius}
                title={welcome.title || payload.name}
              />
              <h1 className="text-3xl leading-tight font-bold">
                {welcome.title || payload.name}
              </h1>
              {(welcome.description || payload.description) && (
                <p className="text-lg opacity-80">
                  {welcome.description || payload.description}
                </p>
              )}
              <button
                type="button"
                onClick={start}
                className={`${buttonClass} mt-2`}
                style={{ ...buttonStyle, outlineColor: 'var(--pf-primary)' }}
              >
                {welcome.button_label || t('start')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
              {payload.estimated_seconds > 0 && (
                <p className="text-sm opacity-60">
                  {t('estimatedTime', { minutes })}
                </p>
              )}
            </div>
          )}

          {field && (
            <div key={field.key} className="flex flex-col gap-4">
              <div className="flex items-center justify-between text-sm opacity-60">
                <button
                  type="button"
                  onClick={back}
                  aria-label={t('back')}
                  className="inline-flex items-center gap-1 rounded p-1 hover:opacity-100 focus-visible:outline-2"
                  style={{ outlineColor: 'var(--pf-primary)' }}
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  {t('back')}
                </button>
                <span>{t('progress', { current, total })}</span>
              </div>

              <FormMedia
                media={field.media}
                radius={radius}
                title={field.label}
              />

              {field.type !== 'consent' && (
                <h2 className="text-2xl leading-snug font-semibold">
                  {field.label}
                  {!field.required && field.type !== 'statement' ? (
                    <span className="ml-2 align-middle text-sm font-normal opacity-60">
                      {t('optional')}
                    </span>
                  ) : null}
                </h2>
              )}
              {field.description && (
                <p className="text-base opacity-70">{field.description}</p>
              )}

              <FieldInput
                field={field}
                value={answers[field.key]}
                onChange={(value) => setAnswer(field.key, value)}
                onEnter={() => advance(field, answers)}
                onPick={(value) => pick(field, value)}
                t={t}
                describedBy={errorCode ? errorId : undefined}
                filesDisabledNotice={filesDisabledNotice}
                autoFocus={focusInside}
              />

              <p
                id={errorId}
                role="alert"
                aria-live="polite"
                className="min-h-5 text-sm font-medium"
                style={{ color: '#dc2626' }}
              >
                {errorCode ? errorMessage(t, errorCode, field) : ''}
              </p>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => advance(field, answers)}
                  className={buttonClass}
                  style={{ ...buttonStyle, outlineColor: 'var(--pf-primary)' }}
                >
                  {submitting
                    ? t('submitting')
                    : isLast
                      ? t('submit')
                      : field.type === 'statement'
                        ? t('continue')
                        : t('ok')}
                  {!isLast && !submitting && field.type !== 'statement' ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : null}
                </button>
                <span className="hidden text-xs opacity-50 sm:inline">
                  {t('pressEnter')}
                </span>
              </div>
            </div>
          )}

          {screen.kind === 'thanks' && (
            <div className="flex flex-col items-start gap-4">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-full"
                style={{
                  background: 'var(--pf-primary)',
                  color: 'var(--pf-button-text)',
                }}
                aria-hidden="true"
              >
                <Check className="h-6 w-6" />
              </div>
              {thanks.title ? (
                <h1 className="text-3xl leading-tight font-bold">
                  {thanks.title}
                </h1>
              ) : null}
              <p className="text-lg opacity-80">
                {thanks.body || t('thankYou.default')}
              </p>
              {thanks.whatsapp_cta ? (
                <button
                  type="button"
                  disabled
                  className={buttonClass}
                  style={buttonStyle}
                >
                  <MessageCircle className="h-4 w-4" aria-hidden="true" />
                  {t('thankYou.whatsapp')}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <footer className="shrink-0 px-6 pb-3 text-center text-xs opacity-50">
        {t('footer.madeWith', { brand: BRAND })}
      </footer>
    </div>
  );
}

function errorMessage(
  t: ReturnType<typeof usePublicTranslator>,
  code: AnswerErrorCode,
  field: PublicField
): string {
  const v = field.validation;
  switch (code) {
    case 'required':
      return t('required');
    case 'consentRequired':
      return t('consentRequired');
    case 'invalidEmail':
      return t('invalidEmail');
    case 'invalidPhone':
      return t('invalidPhone');
    case 'invalidNumber':
      return t('invalidNumber');
    case 'invalidDate':
      return t('invalidDate');
    case 'minChoices':
      return t('minChoices', { min: v.min_choices ?? 1 });
    case 'maxChoices':
      return t('maxChoices', { max: v.max_choices ?? 1 });
    case 'maxLength':
      return t('maxLength', { max: v.max_length ?? 500 });
    case 'minValue':
      return t('minValue', { min: v.min ?? 0 });
    case 'maxValue':
      return t('maxValue', { max: v.max ?? 0 });
    case 'tooManyFiles':
      return t('tooManyFiles', { max: v.max_files ?? 1 });
    case 'invalidFile':
      return t('invalidFile');
    case 'invalidOption':
    case 'invalidType':
    default:
      return t('invalidOption');
  }
}
