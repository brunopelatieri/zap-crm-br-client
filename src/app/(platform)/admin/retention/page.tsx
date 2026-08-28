'use client';

// ============================================================
// /admin/retention — o padrão global de retenção (SPEC 062 §3.8,
// §5.3, §7.5, F7)
//
// O que o `.env` definia sozinho até agora, agora editável por tipo de
// canal e acima dele na cadeia de precedência:
//
//   linha da política da conta → ESTA TELA → padrão do `.env` → sem limite
//
// Três coisas que esta tela precisa dizer, e por quê:
//   1. O piso de idade (§8.2 da 060) — senão o número na tela parece
//      não bater com o que a varredura faz;
//   2. O estado da última varredura — a prova de que ela roda;
//   3. O aviso de `MESSAGE_RETENTION_ENABLED` ausente — sem ele, o
//      proprietário configura tudo, nada acontece e ele conclui que o
//      sistema está quebrado. O interruptor continua SÓ no `.env`
//      (D-13): ligar limpeza de histórico por clique é exatamente o
//      acidente sem desfazer que a SPEC 060 §1 existe para impedir.
//
// Não há prévia nem uso aqui: `p_dry_run` precisa de um `account_id`, e
// o padrão global não pertence a nenhuma conta. As duas coisas vivem no
// bloco "Retenção" do detalhe da conta.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Archive, Loader2, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';
import {
  RetentionChannelCard,
  type RetentionChannelData,
} from '@/components/retention/retention-channel-card';

interface GlobalRetentionSnapshot {
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

const ENDPOINT = '/api/platform/retention';

function formatLastRun(
  snapshot: GlobalRetentionSnapshot,
  locale: string,
  t: ReturnType<typeof useTranslations>
): string {
  if (!snapshot.lastRunAt) return t('lastRunNever');
  const date = new Date(snapshot.lastRunAt).toLocaleString(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const removed =
    (snapshot.lastResult?.by_age ?? 0) +
    (snapshot.lastResult?.by_count ?? 0) +
    (snapshot.lastResult?.favorites_demoted ?? 0);
  return t('lastRun', { date, count: removed });
}

function GlobalRetentionContent() {
  const t = useTranslations('Platform.retention');
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<GlobalRetentionSnapshot | null>(
    null
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      setSnapshot((await res.json()) as GlobalRetentionSnapshot);
    } catch (err) {
      console.error('[/admin/retention] load failed:', err);
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
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {t('globalTitle')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('globalDescription')}
        </p>
      </div>

      {!snapshot.enabled && (
        <Alert variant="destructive">
          <Archive />
          <AlertDescription>{t('sweepDisabledNotice')}</AlertDescription>
        </Alert>
      )}

      <Alert>
        <ShieldAlert />
        <AlertDescription>
          {t('floorNotice', { hours: snapshot.minAgeHours })}
        </AlertDescription>
      </Alert>

      <p className="text-muted-foreground text-xs">
        {formatLastRun(snapshot, locale, t)} ·{' '}
        {t('intervalNotice', { hours: snapshot.intervalHours })}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {snapshot.channels.map((channel) => (
          <RetentionChannelCard
            key={channel.type}
            data={channel}
            onSaved={handleCardSaved}
            saveEndpoint={ENDPOINT}
          />
        ))}
      </div>
    </div>
  );
}

export default function PlatformRetentionPage() {
  return (
    <RequirePlatformOwner>
      <GlobalRetentionContent />
    </RequirePlatformOwner>
  );
}
