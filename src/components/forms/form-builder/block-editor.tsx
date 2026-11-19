'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { newOptionId, type DraftField } from '@/lib/forms/builder';
import {
  MAPPING_TARGETS_BY_TYPE,
  MAX_FILES_MAX,
  RATING_SCALE_MAX,
  RATING_SCALE_MIN,
} from '@/lib/forms/validate';
import type {
  FieldMapping,
  FieldMedia,
  FieldValidation,
  TextMask,
} from '@/lib/forms/types';

import { MediaField } from './media-field';
import { Field, NativeSelect, Section, ToggleRow } from './ui';
import type { BuilderRefs } from './use-builder-refs';

/** Grupos de MIME oferecidos em "tipos aceitos" (subconjunto da allowlist de `uploads.ts`). */
const ACCEPT_GROUPS: { id: string; mimes: string[] }[] = [
  { id: 'images', mimes: ['image/jpeg', 'image/png', 'image/webp'] },
  { id: 'pdf', mimes: ['application/pdf'] },
  {
    id: 'office',
    mimes: [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },
  { id: 'text', mimes: ['text/plain', 'text/csv'] },
  { id: 'audio', mimes: ['audio/mpeg', 'audio/ogg'] },
  { id: 'video', mimes: ['video/mp4'] },
];

function num(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export interface BlockEditorProps {
  field: DraftField;
  formId: string;
  onChange: (patch: Partial<DraftField>) => void;
  onRenameKey: (key: string) => void;
  /** A chave digitada é válida (CHECK do banco) e não repete? */
  isKeyAvailable: (key: string) => boolean;
  onToggleIdentity: (on: boolean) => void;
  acceptGenericLink: boolean;
  refs: BuilderRefs;
  mediaUrls: Record<string, string>;
  onMediaUrl: (path: string, url: string) => void;
}

export function BlockEditor({
  field,
  formId,
  onChange,
  onRenameKey,
  isKeyAvailable,
  onToggleIdentity,
  acceptGenericLink,
  refs,
  mediaUrls,
  onMediaUrl,
}: BlockEditorProps) {
  const t = useTranslations('Forms.builder.editor');
  const v = field.validation ?? {};
  const setValidation = (patch: Partial<FieldValidation>) => {
    const next = { ...v, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next))
      if (next[k] === undefined) delete next[k];
    onChange({ validation: next as FieldValidation });
  };
  const isChoice =
    field.type === 'single_select' ||
    field.type === 'multi_select' ||
    field.type === 'dropdown';
  const options = field.options ?? [];

  return (
    <div className="grid gap-6">
      <Section title={t('content')}>
        <Field label={field.type === 'consent' ? t('consentText') : t('label')}>
          <Textarea
            value={field.label}
            rows={2}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </Field>
        <Field label={t('description')}>
          <Textarea
            value={field.description ?? ''}
            rows={2}
            onChange={(e) => onChange({ description: e.target.value || null })}
          />
        </Field>
        {field.type !== 'statement' && (
          <ToggleRow
            label={t('required')}
            hint={
              field.type === 'consent'
                ? t('consentRequiredHint')
                : field.is_identity
                  ? t('identityRequiredHint')
                  : undefined
            }
          >
            <Switch
              checked={field.required}
              disabled={field.type === 'consent' || field.is_identity}
              onCheckedChange={(checked) => onChange({ required: checked })}
            />
          </ToggleRow>
        )}
        {field.type === 'phone' && (
          <ToggleRow
            label={t('identity')}
            hint={
              acceptGenericLink ? t('identityHintGeneric') : t('identityHint')
            }
          >
            <Switch
              checked={field.is_identity}
              disabled={field.is_identity && acceptGenericLink}
              onCheckedChange={onToggleIdentity}
            />
          </ToggleRow>
        )}
      </Section>

      {/* Opções */}
      {isChoice && (
        <Section title={t('options')} description={t('optionsHint')}>
          <div className="grid gap-2">
            {options.map((opt, i) => (
              <div key={opt.id} className="flex items-center gap-2">
                <span className="bg-muted text-muted-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold">
                  {String.fromCharCode(65 + i)}
                </span>
                <Input
                  value={opt.label}
                  onChange={(e) =>
                    onChange({
                      options: options.map((o) =>
                        o.id === opt.id ? { ...o, label: e.target.value } : o
                      ),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={options.length <= 2}
                  onClick={() =>
                    onChange({
                      options: options.filter((o) => o.id !== opt.id),
                    })
                  }
                  aria-label={t('removeOption')}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() =>
                onChange({
                  options: [
                    ...options,
                    {
                      id: newOptionId(options.map((o) => o.id)),
                      label: `${t('optionDefault')} ${options.length + 1}`,
                      points: 0,
                    },
                  ],
                })
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {t('addOption')}
            </Button>
          </div>
        </Section>
      )}
      {field.type === 'yes_no' && (
        <Section title={t('options')}>
          <div className="grid grid-cols-2 gap-2">
            {options.map((opt) => (
              <Input
                key={opt.id}
                value={opt.label}
                onChange={(e) =>
                  onChange({
                    options: options.map((o) =>
                      o.id === opt.id ? { ...o, label: e.target.value } : o
                    ),
                  })
                }
              />
            ))}
          </div>
        </Section>
      )}

      {/* Regras por tipo */}
      {(field.type === 'short_text' ||
        field.type === 'long_text' ||
        field.type === 'number' ||
        field.type === 'rating' ||
        field.type === 'multi_select' ||
        field.type === 'file_upload') && (
        <Section title={t('rules')}>
          {(field.type === 'short_text' || field.type === 'long_text') && (
            <Field label={t('maxLength')}>
              <Input
                type="number"
                min={1}
                value={v.max_length ?? ''}
                onChange={(e) =>
                  setValidation({ max_length: num(e.target.value) })
                }
              />
            </Field>
          )}
          {field.type === 'short_text' && (
            <Field label={t('mask')} hint={t('maskHint')}>
              <NativeSelect
                value={v.mask ?? 'none'}
                onChange={(e) =>
                  setValidation({ mask: e.target.value as TextMask })
                }
              >
                <option value="none">{t('maskNone')}</option>
                <option value="cpf">CPF</option>
                <option value="cep">CEP</option>
              </NativeSelect>
            </Field>
          )}
          {field.type === 'number' && (
            <div className="grid grid-cols-3 gap-2">
              <Field label={t('min')}>
                <Input
                  type="number"
                  value={v.min ?? ''}
                  onChange={(e) => setValidation({ min: num(e.target.value) })}
                />
              </Field>
              <Field label={t('max')}>
                <Input
                  type="number"
                  value={v.max ?? ''}
                  onChange={(e) => setValidation({ max: num(e.target.value) })}
                />
              </Field>
              <Field label={t('step')}>
                <Input
                  type="number"
                  min={0}
                  value={v.step ?? ''}
                  onChange={(e) => setValidation({ step: num(e.target.value) })}
                />
              </Field>
            </div>
          )}
          {field.type === 'rating' && (
            <Field label={t('scale')} hint={t('scaleHint')}>
              <Input
                type="number"
                min={RATING_SCALE_MIN}
                max={RATING_SCALE_MAX}
                value={v.scale ?? 5}
                onChange={(e) => setValidation({ scale: num(e.target.value) })}
              />
            </Field>
          )}
          {field.type === 'multi_select' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('minChoices')}>
                <Input
                  type="number"
                  min={0}
                  value={v.min_choices ?? ''}
                  onChange={(e) =>
                    setValidation({ min_choices: num(e.target.value) })
                  }
                />
              </Field>
              <Field label={t('maxChoices')}>
                <Input
                  type="number"
                  min={0}
                  value={v.max_choices ?? ''}
                  onChange={(e) =>
                    setValidation({ max_choices: num(e.target.value) })
                  }
                />
              </Field>
            </div>
          )}
          {field.type === 'file_upload' && (
            <>
              <Field label={t('maxFiles')}>
                <Input
                  type="number"
                  min={1}
                  max={MAX_FILES_MAX}
                  value={v.max_files ?? 1}
                  onChange={(e) =>
                    setValidation({ max_files: num(e.target.value) })
                  }
                />
              </Field>
              <Field label={t('accept')} hint={t('acceptHint')}>
                <div className="grid gap-1.5">
                  {ACCEPT_GROUPS.map((group) => {
                    const accepted = v.accept ?? [];
                    const on = group.mimes.every((m) => accepted.includes(m));
                    return (
                      <label
                        key={group.id}
                        className="flex cursor-pointer items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const rest = accepted.filter(
                              (m) => !group.mimes.includes(m)
                            );
                            const next = e.target.checked
                              ? [...rest, ...group.mimes]
                              : rest;
                            setValidation({
                              accept: next.length ? next : undefined,
                            });
                          }}
                        />
                        {t(`acceptGroups.${group.id}`)}
                      </label>
                    );
                  })}
                </div>
              </Field>
            </>
          )}
        </Section>
      )}

      <Section title={t('media')} description={t('mediaHint')}>
        <MediaField
          formId={formId}
          value={field.media}
          onChange={(media: FieldMedia | null) => onChange({ media })}
          mediaUrls={mediaUrls}
          onMediaUrl={onMediaUrl}
        />
      </Section>

      <MappingEditor field={field} onChange={onChange} refs={refs} />

      <Section title={t('advanced')}>
        <KeyInput
          // Reinicia o rascunho local ao trocar de bloco.
          key={field.cid}
          current={field.key}
          isAvailable={isKeyAvailable}
          onCommit={onRenameKey}
        />
      </Section>
    </div>
  );
}

/**
 * A `key` é referência (show_if, jump_to, respostas): só muda quando o texto
 * digitado é VÁLIDO e livre — um valor pela metade não pode apontar para
 * lugar nenhum. Aplica ao sair do campo ou com Enter; senão mostra o erro e
 * volta ao valor atual.
 */
function KeyInput({
  current,
  isAvailable,
  onCommit,
}: {
  current: string;
  isAvailable: (key: string) => boolean;
  onCommit: (key: string) => void;
}) {
  const t = useTranslations('Forms.builder.editor');
  const [text, setText] = useState(current);
  const [bad, setBad] = useState(false);

  function commit() {
    if (text === current) return setBad(false);
    if (isAvailable(text)) {
      setBad(false);
      onCommit(text);
    } else {
      setBad(true);
      setText(current);
    }
  }

  return (
    <Field label={t('key')} hint={bad ? undefined : t('keyHint')}>
      <Input
        value={text}
        maxLength={40}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        aria-invalid={bad}
        className="font-mono"
      />
      {bad && <p className="text-destructive text-xs">{t('keyInvalid')}</p>}
    </Field>
  );
}

// ------------------------------------------------------------
// Mapeamento (PRD D-4): só o que o owner mapeou chega ao contato.
// ------------------------------------------------------------

function MappingEditor({
  field,
  onChange,
  refs,
}: {
  field: DraftField;
  onChange: (patch: Partial<DraftField>) => void;
  refs: BuilderRefs;
}) {
  const t = useTranslations('Forms.builder.editor.mapping');
  const allowed = MAPPING_TARGETS_BY_TYPE[field.type];
  if (allowed.length === 0) return null;

  const mapping = field.mapping;
  const kind = !mapping
    ? ''
    : mapping.target.startsWith('custom:')
      ? 'custom'
      : mapping.target;
  const options = field.options ?? [];

  const set = (m: FieldMapping | null) => onChange({ mapping: m });

  return (
    <Section title={t('title')} description={t('description')}>
      <Field label={t('target')}>
        <NativeSelect
          value={kind}
          onChange={(e) => {
            const k = e.target.value;
            if (!k) return set(null);
            if (k === 'custom') {
              const first = refs.customFields[0];
              return set({
                target: `custom:${first?.id ?? ''}`,
                overwrite: mapping?.overwrite,
              });
            }
            if (k === 'tag') return set({ target: 'tag', tag_by_option: {} });
            set({
              target: k as FieldMapping['target'],
              overwrite: mapping?.overwrite,
            });
          }}
        >
          <option value="">{t('none')}</option>
          {allowed.includes('contact.name') && (
            <option value="contact.name">{t('contactName')}</option>
          )}
          {allowed.includes('contact.email') && (
            <option value="contact.email">{t('contactEmail')}</option>
          )}
          {allowed.includes('contact.company') && (
            <option value="contact.company">{t('contactCompany')}</option>
          )}
          {allowed.includes('contact.opt_in') && (
            <option value="contact.opt_in">{t('contactOptIn')}</option>
          )}
          {allowed.includes('custom') && (
            <option value="custom">{t('customField')}</option>
          )}
          {allowed.includes('tag') && <option value="tag">{t('tag')}</option>}
        </NativeSelect>
      </Field>

      {kind === 'custom' && mapping && (
        <Field
          label={t('customField')}
          hint={
            refs.customFields.length === 0 ? t('noCustomFields') : undefined
          }
        >
          <NativeSelect
            value={mapping.target.replace('custom:', '')}
            onChange={(e) =>
              set({ ...mapping, target: `custom:${e.target.value}` })
            }
          >
            {refs.customFields.map((cf) => (
              <option key={cf.id} value={cf.id}>
                {cf.field_name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}

      {kind === 'tag' && mapping && (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs">{t('tagHint')}</p>
          {options.map((opt) => (
            <div key={opt.id} className="grid grid-cols-2 items-center gap-2">
              <span className="truncate text-sm">{opt.label}</span>
              <NativeSelect
                value={mapping.tag_by_option?.[opt.id] ?? ''}
                onChange={(e) => {
                  const map = { ...(mapping.tag_by_option ?? {}) };
                  if (e.target.value) map[opt.id] = e.target.value;
                  else delete map[opt.id];
                  set({ ...mapping, tag_by_option: map });
                }}
              >
                <option value="">{t('noTag')}</option>
                {refs.tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ))}
        </div>
      )}

      {mapping && kind !== 'tag' && kind !== 'contact.opt_in' && (
        <ToggleRow label={t('overwrite')} hint={t('overwriteHint')}>
          <Switch
            checked={mapping.overwrite === true}
            onCheckedChange={(checked) =>
              set({ ...mapping, overwrite: checked })
            }
          />
        </ToggleRow>
      )}
    </Section>
  );
}
