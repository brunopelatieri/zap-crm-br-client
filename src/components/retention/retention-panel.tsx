'use client';

// ============================================================
// AccountRetentionPanel — bloco "Retenção" de
// /admin/accounts/[accountId] (SPEC 062 §3.8, §7.5, F7)
//
// Este arquivo era o painel de Configurações do DONO DA CONTA (SPEC
// 060 §8.2). A virada de dono da 069 mudou a casa e a fonte de dados,
// não a forma: sai `<RequireRole min="owner">`, entra
// `<RequirePlatformOwner>`; sai `/api/account/retention`, entram as
// rotas por conta de `/api/platform/**`. Os três componentes filhos
// (`RetentionChannelCard`, `RetentionPreview`, `RetentionUsageBar`)
// continuam iguais.
//
// As três coisas que a SPEC 060 §8.2 obriga a dizer continuam onde
// estavam:
//   1. Prévia antes de salvar → <RetentionPreview> em cada cartão
//   2. O piso de idade        → o aviso abaixo do cabeçalho
//   3. Herdado × explícito    → placeholder cinza nos campos vazios,
//      agora resolvendo contra um nível a mais na cadeia (§5.3)
//
// O estado da varredura e o alerta de `MESSAGE_RETENTION_ENABLED`
// ausente NÃO vivem aqui: são da plataforma inteira, e por isso ficam
// em `/admin/retention`, uma vez só.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';
import {
  RetentionChannelCard,
  type RetentionChannelData,
} from './retention-channel-card';

interface AccountRetentionSnapshot {
  minAgeHours: number;
  channels: RetentionChannelData[];
}

function AccountRetentionPanelContent({ accountId }: { accountId: string }) {
  const t = useTranslations('Platform.retention');
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<AccountRetentionSnapshot | null>(
    null
  );

  const base = `/api/platform/accounts/${accountId}/retention`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      setSnapshot((await res.json()) as AccountRetentionSnapshot);
    } catch (err) {
      console.error('[AccountRetentionPanel] load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [base, t]);

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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('accountSectionTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading || !snapshot ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-primary size-6 animate-spin" />
          </div>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {t('accountSectionDescription')}
            </p>

            {/* §8.2 ponto 2 — o piso nunca pode ficar implícito, senão
                quem lê vê o total acima do teto configurado e reporta
                como bug. */}
            <Alert>
              <ShieldAlert />
              <AlertDescription>
                {t('floorNotice', { hours: snapshot.minAgeHours })}
              </AlertDescription>
            </Alert>

            {snapshot.channels.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noChannels')}</p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {snapshot.channels.map((channel) => (
                  <RetentionChannelCard
                    key={channel.type}
                    data={channel}
                    onSaved={handleCardSaved}
                    saveEndpoint={base}
                    previewEndpoint={`${base}/preview`}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function AccountRetentionPanel({ accountId }: { accountId: string }) {
  return (
    <RequirePlatformOwner>
      <AccountRetentionPanelContent accountId={accountId} />
    </RequirePlatformOwner>
  );
}
