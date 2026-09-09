'use client';

// ============================================================
// A barra de filtros de `/activity` (SPEC 075 §7.3).
//
// Cinco filtros combináveis. O que cada um custa está na SPEC; o que
// importa aqui é que TODOS moram num objeto só (`ActivityUiFilters`) —
// a página não guarda cinco estados soltos, porque qualquer mudança
// precisa reiniciar a paginação por cursor junto, e cinco setters
// separados é como se esquece um.
// ============================================================

import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ACTIVITY_CATALOG } from '@/lib/activity/types';
import type { ActivityResourceType } from '@/lib/activity/types';

/** Presets do §7.3. O intervalo livre fica para a fase seguinte — os
 *  quatro presets cobrem o uso real e não exigem um date-picker novo. */
export const ACTIVITY_PERIODS = ['today', 'last7', 'last30', 'last90'] as const;
export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

const PERIOD_DAYS: Record<ActivityPeriod, number> = {
  today: 0,
  last7: 6,
  last30: 29,
  last90: 89,
};

export interface ActivityUiFilters {
  period: ActivityPeriod;
  /** `'all'`, `'system'` ou um `user_id`. */
  actor: string;
  /** `'all'` ou um `resource_type`. */
  type: string;
  /** `'all'` ou um `channel_id`. */
  channel: string;
  search: string;
}

export const DEFAULT_ACTIVITY_FILTERS: ActivityUiFilters = {
  period: 'last30',
  actor: 'all',
  type: 'all',
  channel: 'all',
  search: '',
};

/**
 * Data inicial (ISO) do preset, no fuso do NAVEGADOR.
 *
 * A conversão para UTC acontece no servidor (`queryActivity` →
 * `resolvePeriodBoundary`), mas o "hoje" precisa ser o do operador, não
 * o do banco: às 21h de Brasília, o dia UTC já virou, e "Hoje" traria a
 * madrugada errada. É o mesmo cuidado que a SPEC 067 já teve uma vez.
 */
export function periodStartIso(period: ActivityPeriod): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - PERIOD_DAYS[period]);
  return start.toISOString();
}

export interface FilterOption {
  value: string;
  label: string;
}

interface ActivityFiltersProps {
  filters: ActivityUiFilters;
  onChange: (next: ActivityUiFilters) => void;
  /** Membros da conta + os que já saíram, quando houver. */
  users: FilterOption[];
  channels: FilterOption[];
}

export function ActivityFilters({
  filters,
  onChange,
  users,
  channels,
}: ActivityFiltersProps) {
  const t = useTranslations('Activity');
  const set = (patch: Partial<ActivityUiFilters>) =>
    onChange({ ...filters, ...patch });

  const isDirty =
    filters.period !== DEFAULT_ACTIVITY_FILTERS.period ||
    filters.actor !== 'all' ||
    filters.type !== 'all' ||
    filters.channel !== 'all' ||
    filters.search !== '';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={filters.period}
        onValueChange={(v) =>
          set({ period: (v ?? 'last30') as ActivityPeriod })
        }
      >
        <SelectTrigger className="w-40" aria-label={t('filters.period')}>
          {/* `SelectValue` sem `children` mostra o VALOR CRU
              ("last30") enquanto o `SelectContent` não montou — ele é
              lazy. A função de formatação resolve o rótulo a partir do
              valor, sem depender de o portal estar aberto. */}
          <SelectValue>{() => t(`periods.${filters.period}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ACTIVITY_PERIODS.map((p) => (
            <SelectItem key={p} value={p}>
              {t(`periods.${p}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.actor}
        onValueChange={(v) => set({ actor: v ?? 'all' })}
      >
        <SelectTrigger className="w-44" aria-label={t('filters.user')}>
          <SelectValue>
            {() =>
              filters.actor === 'all'
                ? t('filters.allUsers')
                : filters.actor === 'system'
                  ? t('filters.system')
                  : (users.find((u) => u.value === filters.actor)?.label ??
                    t('filters.allUsers'))
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('filters.allUsers')}</SelectItem>
          {/* "Sistema" é opção de primeira classe: cron e motores
              respondem por boa parte do feed e não têm `actor_user_id`
              para filtrar (§13, item 7). */}
          <SelectItem value="system">{t('filters.system')}</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.value} value={u.value}>
              {u.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.type}
        onValueChange={(v) => set({ type: v ?? 'all' })}
      >
        <SelectTrigger className="w-44" aria-label={t('filters.type')}>
          <SelectValue>
            {() =>
              filters.type === 'all'
                ? t('filters.allTypes')
                : t(`resourceTypes.${filters.type}`)
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('filters.allTypes')}</SelectItem>
          {(Object.keys(ACTIVITY_CATALOG) as ActivityResourceType[])
            // `export` e `tag` existem no schema mas nenhuma ação da v1
            // os usa — oferecê-los seria um filtro que nunca acha nada.
            .filter((type) => ACTIVITY_CATALOG[type].length > 0)
            .map((type) => (
              <SelectItem key={type} value={type}>
                {t(`resourceTypes.${type}`)}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>

      {channels.length > 0 ? (
        <Select
          value={filters.channel}
          onValueChange={(v) => set({ channel: v ?? 'all' })}
        >
          <SelectTrigger className="w-44" aria-label={t('filters.channel')}>
            <SelectValue>
              {() =>
                filters.channel === 'all'
                  ? t('filters.allChannels')
                  : (channels.find((c) => c.value === filters.channel)?.label ??
                    t('filters.allChannels'))
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filters.allChannels')}</SelectItem>
            {channels.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <div className="relative min-w-[12rem] flex-1">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder={t('filters.searchPlaceholder')}
          aria-label={t('filters.search')}
          className="pl-9"
        />
      </div>

      {isDirty ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(DEFAULT_ACTIVITY_FILTERS)}
        >
          <X className="size-4" />
          {t('filters.clear')}
        </Button>
      ) : null}
    </div>
  );
}
