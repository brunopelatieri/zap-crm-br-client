'use client';

// ============================================================
// /admin — Visão geral (SPEC 062 §7.1)
//
// Cards com os números de `GET /api/platform/summary`. Cada card é um
// link que já leva a `/admin/accounts` com o filtro aplicado — um
// número que não leva a lugar nenhum vira enfeite na segunda semana.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import Link from 'next/link';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';
import type { PlatformSummary } from '@/lib/platform/summary';

interface SummaryResponse {
  quotasEnforced: boolean;
  summary: PlatformSummary;
}

function OverviewCardBody({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <>
      <CardHeader>
        <CardTitle className="text-muted-foreground text-sm font-normal">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <span
          className={
            emphasis
              ? 'text-destructive text-3xl font-semibold tabular-nums'
              : 'text-foreground text-3xl font-semibold tabular-nums'
          }
        >
          {value}
        </span>
      </CardContent>
    </>
  );
}

function OverviewCard({
  href,
  label,
  value,
  emphasis,
}: {
  href: string;
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className="hover:ring-foreground/20 transition-shadow">
        <OverviewCardBody label={label} value={value} emphasis={emphasis} />
      </Card>
    </Link>
  );
}

function OverviewContent() {
  const t = useTranslations('Platform.overview');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SummaryResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/platform/summary', { cache: 'no-store' });
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      setData((await res.json()) as SummaryResponse);
    } catch (err) {
      console.error('[/admin] summary load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const { summary, quotasEnforced } = data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      {!quotasEnforced && (
        <Alert>
          <AlertTriangle />
          <AlertDescription>{t('quotasDisabledAlert')}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <OverviewCard
          href="/admin/accounts?status=active"
          label={t('cardActive')}
          value={summary.accountsActive}
        />
        <OverviewCard
          href="/admin/accounts?blocked=true"
          label={t('cardBlocked')}
          value={summary.accountsBlocked}
          emphasis={summary.accountsBlocked > 0}
        />
        <OverviewCard
          href="/admin/accounts?expiringInDays=7"
          label={t('cardExpiringSoon')}
          value={summary.expiringSoon}
        />
        <OverviewCard
          href="/admin/accounts?expired=true"
          label={t('cardExpired')}
          value={summary.expired}
          emphasis={summary.expired > 0}
        />
        <OverviewCard
          href="/admin/requests"
          label={t('cardPendingRequests')}
          value={summary.pendingRequests}
        />
        <OverviewCard
          href="/admin/accounts?overage=true"
          label={t('cardOverage')}
          value={summary.accountsOverage}
          emphasis={summary.accountsOverage > 0}
        />
      </div>
    </div>
  );
}

export default function PlatformOverviewPage() {
  return (
    <RequirePlatformOwner>
      <OverviewContent />
    </RequirePlatformOwner>
  );
}
