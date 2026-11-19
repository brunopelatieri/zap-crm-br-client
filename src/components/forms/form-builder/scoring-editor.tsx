'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  hasPointsOptions,
  hasPointsRanges,
  keyFromLabel,
  maxPossibleScore,
  uniqueKey,
  type DraftField,
} from '@/lib/forms/builder';
import { validateBands } from '@/lib/forms/validate';
import type {
  AssignMode,
  Band,
  BandActions,
  PointsRange,
} from '@/lib/forms/types';

import { Field, NativeSelect, Section } from './ui';
import type { BuilderRefs } from './use-builder-refs';

function num(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Aba Classificação (PRD D-5): pontos por opção / faixa de valor, faixas de
 * pontuação e as AÇÕES de cada faixa (etiqueta, negócio, atribuição,
 * notificação). A pontuação é recalculada no SERVIDOR no envio; aqui só se
 * define a regra.
 */
export function ScoringEditor({
  fields,
  bands,
  onFields,
  onBands,
  refs,
}: {
  fields: DraftField[];
  bands: Band[];
  onFields: (fields: DraftField[]) => void;
  onBands: (bands: Band[]) => void;
  refs: BuilderRefs;
}) {
  const t = useTranslations('Forms.builder.scoring');
  const issues = validateBands(bands);
  const max = maxPossibleScore(fields);

  const patchField = (cid: string, patch: Partial<DraftField>) =>
    onFields(fields.map((f) => (f.cid === cid ? { ...f, ...patch } : f)));

  const scored = fields.filter(
    (f) => hasPointsOptions(f.type) || hasPointsRanges(f.type)
  );

  function addBand() {
    const sorted = [...bands].sort((a, b) => a.min - b.min);
    const last = sorted[sorted.length - 1];
    const label = `${t('bandDefault')} ${bands.length + 1}`;
    const min = last ? (last.max === null ? last.min + 1 : last.max + 1) : 0;
    const next = bands.map((b) =>
      // A faixa aberta deixa de ser a última: ganha um teto antes da nova.
      last && b.key === last.key && b.max === null
        ? { ...b, max: Math.max(b.min, min - 1) }
        : b
    );
    onBands([
      ...next,
      {
        key: uniqueKey(
          keyFromLabel(label, 'band'),
          bands.map((b) => b.key)
        ),
        label,
        min,
        max: null,
        actions: {},
      },
    ]);
  }

  const patchBand = (key: string, patch: Partial<Band>) =>
    onBands(bands.map((b) => (b.key === key ? { ...b, ...patch } : b)));

  return (
    <div className="grid gap-6">
      <p className="text-muted-foreground text-xs leading-relaxed">
        {t('intro')}
      </p>

      {/* Pontos por opção e por faixa de valor */}
      <Section title={t('points')} description={t('pointsHint')}>
        {scored.length === 0 && (
          <p className="text-muted-foreground text-xs">{t('noScoredBlocks')}</p>
        )}
        {scored.map((f) => (
          <div
            key={f.cid}
            className="border-border grid gap-2 rounded-lg border p-3"
          >
            <p className="text-foreground truncate text-sm font-medium">
              {f.label || f.key}
            </p>
            {hasPointsOptions(f.type) &&
              (f.options ?? []).map((o) => (
                <div
                  key={o.id}
                  className="grid grid-cols-[1fr_5rem] items-center gap-2"
                >
                  <span className="truncate text-sm">{o.label}</span>
                  <Input
                    type="number"
                    aria-label={`${t('pointsFor')} ${o.label}`}
                    value={o.points ?? 0}
                    onChange={(e) =>
                      patchField(f.cid, {
                        options: (f.options ?? []).map((x) =>
                          x.id === o.id
                            ? { ...x, points: num(e.target.value) ?? 0 }
                            : x
                        ),
                      })
                    }
                  />
                </div>
              ))}
            {hasPointsRanges(f.type) && (
              <RangesEditor
                ranges={f.validation?.points_ranges ?? []}
                onChange={(points_ranges) =>
                  patchField(f.cid, {
                    validation: { ...f.validation, points_ranges },
                  })
                }
              />
            )}
          </div>
        ))}
        <p className="text-muted-foreground text-xs">
          {t('maxScore', { max })}
        </p>
      </Section>

      {/* Faixas */}
      <Section title={t('bands')} description={t('bandsHint')}>
        {bands.map((band) => (
          <BandCard
            key={band.key}
            band={band}
            refs={refs}
            onChange={(patch) => patchBand(band.key, patch)}
            onRemove={() => onBands(bands.filter((b) => b.key !== band.key))}
          />
        ))}
        <Button variant="outline" size="sm" className="w-fit" onClick={addBand}>
          <Plus className="h-3.5 w-3.5" />
          {t('addBand')}
        </Button>
        {issues.length > 0 && (
          <ul className="text-destructive list-disc pl-4 text-xs">
            {issues.map((i, idx) => (
              <li key={`${i.code}-${i.field}-${idx}`}>
                {t(`bandIssues.${i.code}`)}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function RangesEditor({
  ranges,
  onChange,
}: {
  ranges: PointsRange[];
  onChange: (ranges: PointsRange[]) => void;
}) {
  const t = useTranslations('Forms.builder.scoring');
  const set = (i: number, patch: Partial<PointsRange>) =>
    onChange(ranges.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid gap-2">
      {ranges.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr_1fr_4.5rem_auto] items-end gap-2"
        >
          <Field label={t('rangeFrom')}>
            <Input
              type="number"
              value={r.min ?? ''}
              placeholder="−∞"
              onChange={(e) => set(i, { min: num(e.target.value) })}
            />
          </Field>
          <Field label={t('rangeTo')}>
            <Input
              type="number"
              value={r.max ?? ''}
              placeholder="+∞"
              onChange={(e) => set(i, { max: num(e.target.value) })}
            />
          </Field>
          <Field label={t('rangePoints')}>
            <Input
              type="number"
              value={r.points}
              onChange={(e) => set(i, { points: num(e.target.value) ?? 0 })}
            />
          </Field>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onChange(ranges.filter((_, idx) => idx !== i))}
            aria-label={t('removeRange')}
            className="mb-1"
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
          onChange([...ranges, { min: null, max: null, points: 0 }])
        }
      >
        <Plus className="h-3.5 w-3.5" />
        {t('addRange')}
      </Button>
    </div>
  );
}

function BandCard({
  band,
  refs,
  onChange,
  onRemove,
}: {
  band: Band;
  refs: BuilderRefs;
  onChange: (patch: Partial<Band>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('Forms.builder.scoring');
  const actions: BandActions = band.actions ?? {};
  const setActions = (patch: Partial<BandActions>) =>
    onChange({ actions: { ...actions, ...patch } });
  const deal = actions.deal ?? null;
  const pipeline = deal
    ? refs.pipelines.find((p) => p.id === deal.pipeline_id)
    : undefined;
  const toggle = (list: string[] | undefined, id: string): string[] => {
    const cur = list ?? [];
    return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  };

  return (
    <div className="border-border grid gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input
          value={band.label}
          aria-label={t('bandLabel')}
          maxLength={60}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          aria-label={t('removeBand')}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('bandMin')}>
          <Input
            type="number"
            min={0}
            value={band.min}
            onChange={(e) => onChange({ min: num(e.target.value) ?? 0 })}
          />
        </Field>
        <Field
          label={t('bandMax')}
          hint={band.max === null ? t('bandOpen') : undefined}
        >
          <Input
            type="number"
            min={0}
            value={band.max ?? ''}
            placeholder="∞"
            onChange={(e) => onChange({ max: num(e.target.value) })}
          />
        </Field>
      </div>

      <Field label={t('actionTags')}>
        {refs.tags.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('noTags')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {refs.tags.map((tag) => {
              const on = (actions.tag_ids ?? []).includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setActions({ tag_ids: toggle(actions.tag_ids, tag.id) })
                  }
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    on
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </Field>

      <Field label={t('actionDeal')}>
        <NativeSelect
          value={deal?.pipeline_id ?? ''}
          onChange={(e) => {
            const p = refs.pipelines.find((x) => x.id === e.target.value);
            setActions({
              deal: p
                ? {
                    pipeline_id: p.id,
                    stage_id: p.stages[0]?.id ?? '',
                    title_template: deal?.title_template,
                    assign: deal?.assign,
                  }
                : null,
            });
          }}
        >
          <option value="">{t('noDeal')}</option>
          {refs.pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {deal && pipeline && (
        <div className="grid gap-2 pl-2">
          <Field label={t('dealStage')}>
            <NativeSelect
              value={deal.stage_id}
              onChange={(e) =>
                setActions({ deal: { ...deal, stage_id: e.target.value } })
              }
            >
              {pipeline.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('dealTitle')} hint={t('dealTitleHint')}>
            <Input
              value={deal.title_template ?? ''}
              placeholder="{{contact.name}} — {{form.name}}"
              maxLength={200}
              onChange={(e) =>
                setActions({
                  deal: {
                    ...deal,
                    title_template: e.target.value || undefined,
                  },
                })
              }
            />
          </Field>
          <Field label={t('dealAssign')}>
            <NativeSelect
              value={deal.assign?.mode ?? ''}
              onChange={(e) => {
                const mode = e.target.value as AssignMode | '';
                setActions({
                  deal: {
                    ...deal,
                    assign: mode
                      ? { mode, user_id: deal.assign?.user_id ?? null }
                      : undefined,
                  },
                });
              }}
            >
              <option value="">{t('assignNone')}</option>
              <option value="specific">{t('assignSpecific')}</option>
              <option value="round_robin">{t('assignRoundRobin')}</option>
            </NativeSelect>
          </Field>
          {deal.assign?.mode === 'specific' && (
            <NativeSelect
              aria-label={t('dealAssign')}
              value={deal.assign.user_id ?? ''}
              onChange={(e) =>
                setActions({
                  deal: {
                    ...deal,
                    assign: {
                      mode: 'specific',
                      user_id: e.target.value || null,
                    },
                  },
                })
              }
            >
              <option value="">—</option>
              {refs.members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name || m.user_id.slice(0, 8)}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>
      )}

      <Field label={t('actionNotify')}>
        <div className="flex flex-wrap gap-1.5">
          {refs.members.map((m) => {
            const on = (actions.notify_user_ids ?? []).includes(m.user_id);
            return (
              <button
                key={m.user_id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setActions({
                    notify_user_ids: toggle(actions.notify_user_ids, m.user_id),
                  })
                }
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  on
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                {m.full_name || m.user_id.slice(0, 8)}
              </button>
            );
          })}
        </div>
      </Field>
    </div>
  );
}
