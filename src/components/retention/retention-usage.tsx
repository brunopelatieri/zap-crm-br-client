'use client';

import { useLocale } from 'next-intl';

import { cn } from '@/lib/utils';
import { bucketStatus } from '@/lib/plans/usage';
import { formatRetentionLimit } from '@/lib/retention/format';

const BAR_COLOR: Record<ReturnType<typeof bucketStatus>, string> = {
  ok: 'bg-primary',
  warn: 'bg-amber-500',
  full: 'bg-destructive',
  over: 'bg-destructive',
};

/**
 * Uma barra "12.480 de 50.000 mensagens" (SPEC 060 §8.2). Mesma
 * linguagem visual de `PlanUsageBars` (SPEC 059) — `bucketStatus` é o
 * mesmo cálculo genérico de `@/lib/plans/usage`, reaproveitado sem
 * reimplementar limiar de aviso/estouro para uma segunda feature.
 */
export function RetentionUsageBar({
  label,
  used,
  limit,
  overCapHint,
}: {
  label: string;
  used: number;
  limit: number | null;
  /**
   * Mostrado só quando `status` é `'over'`/`'full'` (SPEC 060 §14 item
   * 8 — favoritas acima do teto perdem a estrela no PRÓXIMO ciclo, não
   * neste). Passado pelo chamador porque só a barra de favoritas
   * carrega essa nuance; a de mensagens não precisa dizer nada extra
   * aqui — o piso já é explicado uma vez, no aviso do painel.
   */
  overCapHint?: string;
}) {
  const locale = useLocale();
  const status = bucketStatus(used, limit);
  const pct =
    limit === null || limit === 0
      ? status === 'ok'
        ? 0
        : 100
      : Math.min(100, Math.round((used / limit) * 100));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-foreground font-medium">{label}</span>
        <span
          className={cn(
            'text-muted-foreground tabular-nums',
            (status === 'over' || status === 'full') &&
              'text-destructive font-medium'
          )}
        >
          {limit === null
            ? formatRetentionLimit(used, locale)
            : `${formatRetentionLimit(used, locale)} / ${formatRetentionLimit(limit, locale)}`}
        </span>
      </div>
      <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            BAR_COLOR[status]
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {overCapHint && (status === 'over' || status === 'full') && (
        <p className="text-muted-foreground text-xs">{overCapHint}</p>
      )}
    </div>
  );
}
