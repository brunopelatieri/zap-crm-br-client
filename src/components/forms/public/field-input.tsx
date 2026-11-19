'use client';

// ============================================================
// Entrada de UM bloco da página pública (SPEC 085 §4.1/§4.2).
//
// Um componente por tipo, numa função só: o que muda entre os tipos é o
// controle e o formato do valor; a moldura (título, erro, botão) é do
// `PublicForm`. Só CSS variables do formulário (`--pf-*`) — o tema do
// usuário logado não entra aqui (SPEC §10).
//
// Valor em estado = o que o navegador tem na mão (`string` enquanto digita
// número; `boolean` em sim/não; `string[]` em múltipla). Quem normaliza e
// valida é `validateAnswer` (a mesma função do servidor).
// ============================================================

import { Check, Paperclip } from 'lucide-react';
import type { KeyboardEvent } from 'react';

import { applyTextMask } from '@/lib/forms/mask';
import type { PublicFormTranslator } from '@/lib/forms/public-messages';
import type { AnswerValue, PublicField } from '@/lib/forms/types';

export const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const baseInput = {
  color: 'var(--pf-text)',
  borderColor: 'color-mix(in srgb, var(--pf-text) 35%, transparent)',
  borderRadius: 'var(--pf-radius)',
  background: 'transparent',
} as const;

const inputClass =
  'w-full border-b-2 border-x-0 border-t-0 px-1 py-2 text-xl outline-none transition-colors focus:border-b-[3px] placeholder:opacity-40';

function optionStyle(selected: boolean) {
  return {
    borderRadius: 'var(--pf-radius)',
    color: 'var(--pf-text)',
    borderColor: selected
      ? 'var(--pf-primary)'
      : 'color-mix(in srgb, var(--pf-text) 30%, transparent)',
    background: selected
      ? 'color-mix(in srgb, var(--pf-primary) 14%, transparent)'
      : 'transparent',
  } as const;
}

export interface FieldInputProps {
  field: PublicField;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue | undefined) => void;
  /** Enter dentro de um campo de texto avança (Shift+Enter quebra linha em `long_text`). */
  onEnter: () => void;
  /** Escolha única: marcar e avançar sozinho em 300 ms. */
  onPick: (value: AnswerValue) => void;
  t: PublicFormTranslator;
  describedBy?: string;
  /** Na prévia (e até a F3) o envio de arquivo fica desligado. */
  filesDisabledNotice?: string | null;
  /** Foco automático ao mostrar o bloco: só na página real, não na prévia. */
  autoFocus?: boolean;
}

export function FieldInput({
  field,
  value,
  onChange,
  onEnter,
  onPick,
  t,
  describedBy,
  filesDisabledNotice,
  autoFocus = true,
}: FieldInputProps) {
  const v = field.validation;
  const text = typeof value === 'string' ? value : '';

  const enterKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onEnter();
    }
  };

  switch (field.type) {
    case 'short_text':
    case 'email':
    case 'phone':
      return (
        <input
          aria-describedby={describedBy}
          aria-label={field.label}
          className={inputClass}
          style={baseInput}
          type={
            field.type === 'email'
              ? 'email'
              : field.type === 'phone'
                ? 'tel'
                : 'text'
          }
          inputMode={
            field.type === 'email'
              ? 'email'
              : field.type === 'phone'
                ? 'tel'
                : v.mask && v.mask !== 'none'
                  ? 'numeric'
                  : undefined
          }
          autoComplete={
            field.type === 'email'
              ? 'email'
              : field.type === 'phone'
                ? 'tel'
                : 'off'
          }
          maxLength={v.max_length}
          value={text}
          onChange={(e) =>
            onChange(
              field.type === 'short_text'
                ? applyTextMask(e.target.value, v.mask)
                : e.target.value
            )
          }
          onKeyDown={enterKey}
          autoFocus={autoFocus}
        />
      );

    case 'long_text':
      return (
        <textarea
          aria-describedby={describedBy}
          aria-label={field.label}
          className={`${inputClass} resize-none border-2 px-3`}
          style={baseInput}
          rows={4}
          maxLength={v.max_length}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={enterKey}
          autoFocus={autoFocus}
        />
      );

    case 'number':
      return (
        <input
          aria-describedby={describedBy}
          aria-label={field.label}
          className={inputClass}
          style={baseInput}
          type="number"
          inputMode="decimal"
          min={v.min}
          max={v.max}
          step={v.step ?? 'any'}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={enterKey}
          autoFocus={autoFocus}
        />
      );

    case 'date':
      return (
        <input
          aria-describedby={describedBy}
          aria-label={field.label}
          className={inputClass}
          style={baseInput}
          type="date"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={enterKey}
          autoFocus={autoFocus}
        />
      );

    case 'dropdown':
      return (
        <select
          aria-describedby={describedBy}
          aria-label={field.label}
          className={`${inputClass} border-2 px-3`}
          style={baseInput}
          value={text}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );

    case 'single_select':
    case 'yes_no': {
      const isYesNo = field.type === 'yes_no';
      return (
        <div
          role="radiogroup"
          aria-label={field.label}
          aria-describedby={describedBy}
          className="flex flex-col gap-2"
        >
          {(field.options ?? []).map((o, i) => {
            const selected = isYesNo
              ? value === (o.id === 'yes')
              : value === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onPick(isYesNo ? o.id === 'yes' : o.id)}
                className="flex items-center gap-3 border-2 px-3 py-3 text-left text-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  ...optionStyle(selected),
                  outlineColor: 'var(--pf-primary)',
                }}
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center border text-xs font-semibold"
                  style={{
                    borderRadius: 'calc(var(--pf-radius) / 2)',
                    borderColor: 'currentColor',
                  }}
                  aria-hidden="true"
                >
                  {OPTION_LETTERS[i] ?? ''}
                </span>
                <span className="flex-1">{o.label}</span>
                {selected && <Check className="h-5 w-5" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      );
    }

    case 'multi_select': {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div
          role="group"
          aria-label={field.label}
          aria-describedby={describedBy}
          className="flex flex-col gap-2"
        >
          {(field.options ?? []).map((o, i) => {
            const selected = chosen.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="checkbox"
                aria-checked={selected}
                onClick={() => {
                  const next = selected
                    ? chosen.filter((id) => id !== o.id)
                    : [...chosen, o.id];
                  onChange(next.length ? next : undefined);
                }}
                className="flex items-center gap-3 border-2 px-3 py-3 text-left text-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  ...optionStyle(selected),
                  outlineColor: 'var(--pf-primary)',
                }}
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center border text-xs font-semibold"
                  style={{
                    borderRadius: 'calc(var(--pf-radius) / 2)',
                    borderColor: 'currentColor',
                  }}
                  aria-hidden="true"
                >
                  {selected ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    (OPTION_LETTERS[i] ?? '')
                  )}
                </span>
                <span className="flex-1">{o.label}</span>
              </button>
            );
          })}
        </div>
      );
    }

    case 'rating': {
      const scale = v.scale ?? 5;
      const current = typeof value === 'number' ? value : Number(value) || 0;
      return (
        <div
          role="radiogroup"
          aria-label={field.label}
          aria-describedby={describedBy}
          className="flex flex-wrap gap-2"
        >
          {Array.from({ length: scale }, (_, i) => i + 1).map((n) => {
            const selected = current === n;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onPick(n)}
                className="flex h-12 min-w-12 items-center justify-center border-2 px-3 text-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  ...optionStyle(selected),
                  outlineColor: 'var(--pf-primary)',
                }}
              >
                {n}
              </button>
            );
          })}
        </div>
      );
    }

    case 'consent':
      return (
        <button
          type="button"
          role="checkbox"
          aria-checked={value === true}
          aria-describedby={describedBy}
          onClick={() => onChange(value === true ? undefined : true)}
          className="flex items-start gap-3 border-2 px-3 py-3 text-left text-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            ...optionStyle(value === true),
            outlineColor: 'var(--pf-primary)',
          }}
        >
          <span
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border-2"
            style={{
              borderRadius: 'calc(var(--pf-radius) / 2)',
              borderColor: 'currentColor',
            }}
            aria-hidden="true"
          >
            {value === true && <Check className="h-4 w-4" />}
          </span>
          <span className="flex-1">{field.label}</span>
        </button>
      );

    case 'file_upload':
      return (
        <div
          className="flex flex-col items-center gap-2 border-2 border-dashed px-4 py-8 text-center"
          style={{ ...baseInput, opacity: 0.8 }}
          aria-describedby={describedBy}
        >
          <Paperclip className="h-6 w-6" aria-hidden="true" />
          <span className="text-base font-medium">{t('chooseFile')}</span>
          {filesDisabledNotice ? (
            <span className="text-xs opacity-70">{filesDisabledNotice}</span>
          ) : null}
        </div>
      );

    case 'statement':
    default:
      return null;
  }
}
