'use client';

// ============================================================
// RetentionPanel — Settings → Retenção (SPEC 060 §8.2, F5)
//
// Só Proprietário — gate duplo, de propósito. `settings-rail.tsx` já
// esconde o item da lista para quem não é owner (`SectionMeta.minRole`),
// mas isso não impede a navegação direta por `?tab=retention`; o
// `<RequireRole>` aqui é quem de fato barra o conteúdo nesse caso —
// mesma dupla camada de `/api/account/retention` (guard de servidor +
// RLS).
//
// Três coisas que a SPEC obriga o painel a dizer (§8.2), e onde cada
// uma vive neste arquivo:
//   1. Prévia antes de salvar   → <RetentionPreview> em cada cartão
//   2. O piso de idade          → o aviso logo abaixo do cabeçalho
//   3. Herdado × explícito      → placeholder cinza nos campos vazios
//      (RetentionChannelCard, via formatRetentionSource)
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Archive, Loader2, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { RequireRole } from '@/components/auth/require-role';
import { SettingsPanelHead } from '../settings/settings-panel-head';
import {
  RetentionChannelCard,
  type RetentionChannelData,
} from './retention-channel-card';

interface RetentionSnapshot {
  enabled: boolean;
  minAgeHours: number;
  intervalHours: number;
  lastRunAt: string | null;
  lastResult: {
    by_age?: number;
    by_count?: number;
    favorites_demoted?: number;
  } | null;
  channels: RetentionChannelData[];
}

function formatLastRun(
  lastRunAt: string | null,
  lastResult: RetentionSnapshot['lastResult'],
  locale: string,
  t: ReturnType<typeof useTranslations>
): string {
  if (!lastRunAt) return t('lastRunNever');
  const date = new Date(lastRunAt).toLocaleString(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const removed =
    (lastResult?.by_age ?? 0) +
    (lastResult?.by_count ?? 0) +
    (lastResult?.favorites_demoted ?? 0);
  return t('lastRun', { date, count: removed });
}

function RetentionPanelContent() {
  const t = useTranslations('Settings.retention');
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<RetentionSnapshot | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/retention', {
        cache: 'no-store',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      setSnapshot((await res.json()) as RetentionSnapshot);
    } catch (err) {
      console.error('[RetentionPanel] load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleCardSaved(updated: RetentionChannelData) {
    setSnapshot((prev) =>
      prev
        ? {
            ...prev,
            channels: prev.channels.map((c) =>
              c.type === updated.type ? updated : c
            ),
          }
        : prev
    );
  }

  if (loading || !snapshot) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {/* §8.2 ponto 2 — o piso nunca pode ficar implícito, senão o
          dono vê o total acima do teto configurado e reporta como bug. */}
      <Alert>
        <ShieldAlert />
        <AlertDescription>
          {t('floorNotice', { hours: snapshot.minAgeHours })}
        </AlertDescription>
      </Alert>

      {!snapshot.enabled && (
        <Alert variant="destructive">
          <Archive />
          <AlertDescription>{t('disabledNotice')}</AlertDescription>
        </Alert>
      )}

      <p className="text-muted-foreground text-xs">
        {formatLastRun(snapshot.lastRunAt, snapshot.lastResult, locale, t)}
      </p>

      {snapshot.channels.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noChannels')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {snapshot.channels.map((channel) => (
            <RetentionChannelCard
              key={channel.type}
              data={channel}
              onSaved={handleCardSaved}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function RetentionPanel() {
  const t = useTranslations('Settings.retention');
  return (
    <RequireRole
      min="owner"
      fallback={
        <p className="text-muted-foreground text-sm">{t('accessDenied')}</p>
      }
    >
      <RetentionPanelContent />
    </RequireRole>
  );
}
