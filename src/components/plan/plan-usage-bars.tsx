'use client';

import { useLocale, useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { formatLimit } from '@/lib/plans/format';
import type { PlanUsageBucket } from '@/lib/plans/types';

const BAR_COLOR: Record<PlanUsageBucket['status'], string> = {
  ok: 'bg-primary',
  warn: 'bg-amber-500',
  full: 'bg-destructive',
  over: 'bg-destructive',
};

/**
 * Uma barra por quota (SPEC 059 §7.1/§8). `bucketStatus` já decidiu a
 * cor em `src/lib/plans/usage.ts` — este componente só desenha.
 */
export function PlanUsageBars({ buckets }: { buckets: PlanUsageBucket[] }) {
  const t = useTranslations('Plan');
  const locale = useLocale();

  return (
    <div className="flex flex-col gap-4">
      {buckets.map((bucket) => {
        const limitLabel = formatLimit(bucket.limit, locale);
        const pct =
          bucket.limit === null || bucket.limit === 0
            ? bucket.status === 'ok'
              ? 0
              : 100
            : Math.min(100, Math.round((bucket.used / bucket.limit) * 100));

        return (
          <div key={bucket.key} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-foreground font-medium">
                {t(`quotaLabel.${bucket.key}`)}
              </span>
              <span
                className={cn(
                  'text-muted-foreground tabular-nums',
                  (bucket.status === 'over' || bucket.status === 'full') &&
                    'text-destructive font-medium'
                )}
              >
                {bucket.limit === null
                  ? t('usageUnlimited', { used: bucket.used })
                  : `${bucket.used} / ${limitLabel}`}
              </span>
            </div>
            <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  BAR_COLOR[bucket.status]
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            {bucket.status === 'over' ? (
              <p className="text-destructive text-xs">
                {t('overageNotice', {
                  amount: bucket.used - (bucket.limit ?? bucket.used),
                })}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
