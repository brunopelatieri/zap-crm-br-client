'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ListOption {
  value: string;
  label: string;
}

export interface PipelineOption {
  id: string;
  name: string;
}

export interface StageOption {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
}

/** Above this many items a small search box is shown. */
const SEARCH_THRESHOLD = 8;

/**
 * A plain list of checkboxes over `options`. `selected` may hold values that
 * are not in `options` (deleted items): they are neither shown nor touched
 * here (the caller drops them on save).
 */
export function CheckList({
  options,
  selected,
  onChange,
  emptyLabel,
}: {
  options: ListOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyLabel: string;
}) {
  const t = useTranslations('Agents.tools');
  const baseId = useId();
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  if (options.length === 0) {
    return <p className="text-muted-foreground text-xs">{emptyLabel}</p>;
  }

  const set = new Set(selected);
  const toggle = (value: string, checked: boolean) => {
    const next = new Set(set);
    if (checked) next.add(value);
    else next.delete(value);
    onChange([...next]);
  };

  return (
    <div className="space-y-2">
      {options.length > SEARCH_THRESHOLD && (
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="h-8 max-w-xs"
        />
      )}
      <div className="grid max-h-56 gap-x-4 gap-y-1.5 overflow-y-auto sm:grid-cols-2">
        {visible.map((o, i) => {
          const id = `${baseId}-${i}`;
          return (
            <div key={o.value} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={set.has(o.value)}
                onCheckedChange={(v) => toggle(o.value, v === true)}
              />
              <Label
                htmlFor={id}
                className="min-w-0 cursor-pointer font-normal"
              >
                <span className="truncate">{o.label}</span>
              </Label>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="text-muted-foreground text-xs">{t('noMatches')}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Funnels with their stages nested (create_deal / move_deal_stage need BOTH
 * lists). Checking a funnel checks all its stages; unchecking it unchecks
 * them; stages only appear under a checked funnel and can be unchecked one
 * by one.
 */
export function PipelineStageList({
  pipelines,
  stages,
  selectedPipelines,
  selectedStages,
  onChange,
  emptyLabel,
}: {
  pipelines: PipelineOption[];
  stages: StageOption[];
  selectedPipelines: string[];
  selectedStages: string[];
  onChange: (pipelineIds: string[], stageIds: string[]) => void;
  emptyLabel: string;
}) {
  const t = useTranslations('Agents.tools');
  const baseId = useId();

  if (pipelines.length === 0) {
    return <p className="text-muted-foreground text-xs">{emptyLabel}</p>;
  }

  const pSet = new Set(selectedPipelines);
  const sSet = new Set(selectedStages);

  const togglePipeline = (pipelineId: string, checked: boolean) => {
    const own = stages.filter((s) => s.pipeline_id === pipelineId);
    const nextP = new Set(pSet);
    const nextS = new Set(sSet);
    if (checked) {
      nextP.add(pipelineId);
      own.forEach((s) => nextS.add(s.id));
    } else {
      nextP.delete(pipelineId);
      own.forEach((s) => nextS.delete(s.id));
    }
    onChange([...nextP], [...nextS]);
  };

  const toggleStage = (stageId: string, checked: boolean) => {
    const nextS = new Set(sSet);
    if (checked) nextS.add(stageId);
    else nextS.delete(stageId);
    onChange([...pSet], [...nextS]);
  };

  return (
    <div className="space-y-3">
      {pipelines.map((p, pi) => {
        const pid = `${baseId}-p${pi}`;
        const checked = pSet.has(p.id);
        const own = stages.filter((s) => s.pipeline_id === p.id);
        return (
          <div key={p.id} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                id={pid}
                checked={checked}
                onCheckedChange={(v) => togglePipeline(p.id, v === true)}
              />
              <Label htmlFor={pid} className="min-w-0 cursor-pointer">
                <span className="truncate">{p.name}</span>
              </Label>
            </div>
            {checked && (
              <div className="border-border ml-2 border-l pl-4">
                {own.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {t('noStages')}
                  </p>
                ) : (
                  <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                    {own.map((s, si) => {
                      const sid = `${baseId}-p${pi}-s${si}`;
                      return (
                        <div key={s.id} className="flex items-center gap-2">
                          <Checkbox
                            id={sid}
                            checked={sSet.has(s.id)}
                            onCheckedChange={(v) =>
                              toggleStage(s.id, v === true)
                            }
                          />
                          <Label
                            htmlFor={sid}
                            className="min-w-0 cursor-pointer font-normal"
                          >
                            <span className="truncate">{s.name}</span>
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
