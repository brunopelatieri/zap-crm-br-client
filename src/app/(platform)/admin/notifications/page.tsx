'use client';

// ============================================================
// /admin/notifications — a outbox de eventos de sistema (SPEC 063 §6, F7)
//
//   As últimas 100 linhas de `system_notifications`: tipo, conta, os
//   dois status, tentativas e erro. Filtro por `failed` e botão
//   "Reenviar" (zera `next_attempt_at` e `attempts`).
//
//   Alert no topo quando o e-mail está desligado — "e-mail desligado —
//   os avisos estão indo só para o webhook" (§6). Sem esse aviso, a
//   hipótese natural do operador é que o sistema está quebrado, quando
//   o `.env` é que está incompleto.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, MailWarning, RefreshCw } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';

type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

interface NotificationRow {
  id: string;
  type: string;
  account_id: string | null;
  email_status: DeliveryStatus;
  hook_status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
  accounts: { name: string } | null;
}

interface ChannelsStatus {
  email: boolean;
  webhook: boolean;
}

function StatusBadge({ status }: { status: DeliveryStatus }) {
  const variant =
    status === 'sent'
      ? 'default'
      : status === 'failed'
        ? 'destructive'
        : 'secondary';
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

function NotificationsContent() {
  const t = useTranslations('Platform.notifications');
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [channels, setChannels] = useState<ChannelsStatus | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = onlyFailed ? '?status=failed' : '';
      const res = await fetch(`/api/platform/notifications${qs}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      const data = (await res.json()) as {
        notifications: NotificationRow[];
        channels: ChannelsStatus;
      };
      setRows(data.notifications);
      setChannels(data.channels);
    } catch (err) {
      console.error('[/admin/notifications] load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [onlyFailed, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resend(id: string) {
    setResendingId(id);
    try {
      const res = await fetch(`/api/platform/notifications/${id}/resend`, {
        method: 'POST',
      });
      if (!res.ok) {
        toast.error(t('resendFailed'));
        return;
      }
      toast.success(t('resendSuccess'));
      await load();
    } catch (err) {
      console.error('[/admin/notifications] resend failed:', err);
      toast.error(t('networkError'));
    } finally {
      setResendingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      {channels && !channels.email ? (
        <Alert>
          <MailWarning className="size-4" />
          <AlertDescription>{t('emailDisabledAlert')}</AlertDescription>
        </Alert>
      ) : null}
      {channels && !channels.webhook ? (
        <Alert>
          <MailWarning className="size-4" />
          <AlertDescription>{t('webhookDisabledAlert')}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={onlyFailed ? 'default' : 'outline'}
          onClick={() => setOnlyFailed((v) => !v)}
        >
          {onlyFailed ? t('showingFailedOnly') : t('filterFailed')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="size-4" />
          {t('refresh')}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Card key={row.id}>
              <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {row.type} — {row.accounts?.name ?? t('noAccount')}
                </CardTitle>
                <span className="text-muted-foreground text-xs">
                  {new Date(row.created_at).toLocaleString(locale, {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="flex items-center gap-1.5">
                    {t('email')}: <StatusBadge status={row.email_status} />
                  </span>
                  <span className="flex items-center gap-1.5">
                    {t('webhook')}: <StatusBadge status={row.hook_status} />
                  </span>
                  <span className="text-muted-foreground">
                    {t('attempts', { count: row.attempts })}
                  </span>
                  {row.last_error ? (
                    <span className="text-destructive max-w-md truncate">
                      {row.last_error}
                    </span>
                  ) : null}
                </div>
                {row.email_status === 'failed' ||
                row.hook_status === 'failed' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resendingId === row.id}
                    onClick={() => void resend(row.id)}
                  >
                    {resendingId === row.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {t('resend')}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlatformNotificationsPage() {
  return (
    <RequirePlatformOwner>
      <NotificationsContent />
    </RequirePlatformOwner>
  );
}
