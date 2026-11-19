'use client';

import { useTranslations } from 'next-intl';

import { Input } from '@/components/ui/input';
import {
  dependentsOf,
  JUMP_FIELD_TYPES,
  type DraftField,
} from '@/lib/forms/builder';
import type { ShowIf, ShowIfOp } from '@/lib/forms/types';

import { Field, NativeSelect, Section } from './ui';

const OPS: ShowIfOp[] = ['eq', 'neq', 'contains', 'answered'];

/**
 * Lógica do bloco SELECIONADO (PRD D-6): uma condição de exibição sobre um
 * bloco ANTERIOR e, nas escolhas únicas, "pular para" um bloco POSTERIOR por
 * opção. Sem grafo, sem expressão — o que a `validateFormForPublish` garante
 * (só para frente, sem ciclo).
 */
export function LogicEditor({
  fields,
  field,
  onChange,
}: {
  fields: DraftField[];
  field: DraftField;
  onChange: (patch: Partial<DraftField>) => void;
}) {
  const t = useTranslations('Forms.builder.logic');
  const index = fields.findIndex((f) => f.cid === field.cid);
  const before = fields.slice(0, index).filter((f) => f.type !== 'statement');
  const after = fields.slice(index + 1);
  const showIf = field.show_if;
  const ref = showIf ? fields.find((f) => f.key === showIf.field_key) : null;
  const options = field.options ?? [];
  const canJump = JUMP_FIELD_TYPES.includes(field.type);
  const dependents = dependentsOf(fields, field.key);

  const setShowIf = (next: ShowIf | null) => onChange({ show_if: next });

  return (
    <div className="grid gap-6">
      <p className="text-muted-foreground text-xs leading-relaxed">
        {t('intro', { block: field.label || field.key })}
      </p>

      <Section title={t('showIf')} description={t('showIfHint')}>
        {field.is_identity ? (
          <p className="text-muted-foreground text-xs">
            {t('identityNoLogic')}
          </p>
        ) : before.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('noPrevious')}</p>
        ) : (
          <>
            <Field label={t('whenBlock')}>
              <NativeSelect
                value={showIf?.field_key ?? ''}
                onChange={(e) => {
                  const key = e.target.value;
                  setShowIf(
                    key
                      ? { field_key: key, op: showIf?.op ?? 'answered' }
                      : null
                  );
                }}
              >
                <option value="">{t('always')}</option>
                {before.map((f) => (
                  <option key={f.cid} value={f.key}>
                    {f.label || f.key}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            {showIf && (
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('operator')}>
                  <NativeSelect
                    value={showIf.op}
                    onChange={(e) =>
                      setShowIf({ ...showIf, op: e.target.value as ShowIfOp })
                    }
                  >
                    {OPS.map((op) => (
                      <option key={op} value={op}>
                        {t(`ops.${op}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                {showIf.op !== 'answered' && (
                  <Field label={t('value')}>
                    {ref?.options && ref.options.length > 0 ? (
                      <NativeSelect
                        value={String(showIf.value ?? '')}
                        onChange={(e) =>
                          setShowIf({ ...showIf, value: e.target.value })
                        }
                      >
                        <option value="">—</option>
                        {ref.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Input
                        value={String(showIf.value ?? '')}
                        onChange={(e) =>
                          setShowIf({ ...showIf, value: e.target.value })
                        }
                      />
                    )}
                  </Field>
                )}
              </div>
            )}
          </>
        )}
      </Section>

      {canJump && (
        <Section title={t('jump')} description={t('jumpHint')}>
          <div className="grid gap-2">
            {options.map((opt) => (
              <div key={opt.id} className="grid grid-cols-2 items-center gap-2">
                <span className="truncate text-sm">{opt.label}</span>
                <NativeSelect
                  value={opt.jump_to ?? ''}
                  onChange={(e) =>
                    onChange({
                      options: options.map((o) =>
                        o.id === opt.id
                          ? { ...o, jump_to: e.target.value || null }
                          : o
                      ),
                    })
                  }
                >
                  <option value="">{t('next')}</option>
                  {after.map((f) => (
                    <option key={f.cid} value={f.key}>
                      {f.label || f.key}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ))}
          </div>
        </Section>
      )}
      {field.type === 'multi_select' && (
        <p className="text-muted-foreground text-xs">{t('multiNoJump')}</p>
      )}

      {dependents.length > 0 && (
        <Section title={t('dependents')}>
          <ul className="text-muted-foreground list-disc pl-4 text-xs">
            {dependents.map((d) => (
              <li key={d.cid}>{d.label || d.key}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
