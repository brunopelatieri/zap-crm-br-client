'use client';

// ============================================================
// /admin/settings — configurações da plataforma (SPEC 062 §7.4)
//
// `quotasEnforced` é a ação de maior alcance do sistema inteiro — muda
// o comportamento de TODAS as contas de uma vez — e por isso é a única
// mudança deste formulário que pede confirmação por diálogo, com o
// número de contas afetadas em texto.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';
import type { PlatformSummary } from '@/lib/platform/summary';

interface PlatformSettingsRow {
  quotas_enforced: boolean;
  default_plan_code: string;
  payment_instructions: string | null;
  billing_contact: string | null;
  default_yearly_discount_percent: number;
  support_email: string | null;
  grace_days: number;
  self_service_enabled: boolean;
}

// SPEC 063 §6 — canais em modo leitura. `.env` nunca é editável pela
// tela; a senha do SMTP não trafega aqui nem existe neste tipo.
interface ChannelsStatus {
  email: {
    configured: boolean;
    host: string | null;
    port: number | null;
    from: string | null;
    to: string | null;
  };
  webhook: { configured: boolean; urlMasked: string | null };
}

function SettingsContent() {
  const t = useTranslations('Platform.settings');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<PlatformSettingsRow | null>(null);
  const [channels, setChannels] = useState<ChannelsStatus | null>(null);
  const [accountsTotal, setAccountsTotal] = useState(0);
  const [pendingQuotasToggle, setPendingQuotasToggle] = useState<
    boolean | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, summaryRes] = await Promise.all([
        fetch('/api/platform/settings', { cache: 'no-store' }),
        fetch('/api/platform/summary', { cache: 'no-store' }),
      ]);
      if (!settingsRes.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      const data = (await settingsRes.json()) as {
        settings: PlatformSettingsRow;
        channels: ChannelsStatus;
      };
      setSettings(data.settings);
      setChannels(data.channels);
      if (summaryRes.ok) {
        const summaryData = (await summaryRes.json()) as {
          summary: PlatformSummary;
        };
        setAccountsTotal(summaryData.summary.accountsTotal);
      }
    } catch (err) {
      console.error('[/admin/settings] load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Partial<Record<string, unknown>>) {
    setSaving(true);
    try {
      const res = await fetch('/api/platform/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      const data = (await res.json()) as { settings: PlatformSettingsRow };
      setSettings(data.settings);
      toast.success(t('saveSuccess'));
    } catch (err) {
      console.error('[/admin/settings] save failed:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  function handleFieldSave<K extends keyof PlatformSettingsRow>(
    key: K,
    value: PlatformSettingsRow[K]
  ) {
    const apiKey = {
      default_plan_code: 'defaultPlanCode',
      payment_instructions: 'paymentInstructions',
      billing_contact: 'billingContact',
      default_yearly_discount_percent: 'defaultYearlyDiscountPercent',
      support_email: 'supportEmail',
      grace_days: 'graceDays',
      self_service_enabled: 'selfServiceEnabled',
    }[key as string];
    if (!apiKey) return;
    void save({ [apiKey]: value });
  }

  if (loading || !settings) {
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
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('fieldQuotasEnforced')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground max-w-md text-sm">
            {t('fieldQuotasEnforcedHint')}
          </p>
          <Switch
            checked={settings.quotas_enforced}
            disabled={saving}
            onCheckedChange={(checked) => setPendingQuotasToggle(checked)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('fieldSelfServiceEnabled')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground max-w-md text-sm">
            {t('fieldSelfServiceEnabledHint')}
          </p>
          <Switch
            checked={settings.self_service_enabled}
            disabled={saving}
            onCheckedChange={(checked) =>
              handleFieldSave('self_service_enabled', checked)
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('fieldDefaultPlanCode')}</Label>
            <Input
              defaultValue={settings.default_plan_code}
              onBlur={(e) =>
                handleFieldSave('default_plan_code', e.target.value)
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldDefaultYearlyDiscount')}</Label>
            <Input
              type="number"
              min={0}
              max={100}
              defaultValue={settings.default_yearly_discount_percent}
              onBlur={(e) =>
                handleFieldSave(
                  'default_yearly_discount_percent',
                  Number(e.target.value) || 0
                )
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldGraceDays')}</Label>
            <Input
              type="number"
              min={0}
              defaultValue={settings.grace_days}
              onBlur={(e) =>
                handleFieldSave('grace_days', Number(e.target.value) || 0)
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldSupportEmail')}</Label>
            <Input
              type="email"
              defaultValue={settings.support_email ?? ''}
              onBlur={(e) => handleFieldSave('support_email', e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {t('fieldSupportEmailHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldBillingContact')}</Label>
            <Input
              defaultValue={settings.billing_contact ?? ''}
              onBlur={(e) => handleFieldSave('billing_contact', e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('fieldPaymentInstructions')}</Label>
            <Textarea
              defaultValue={settings.payment_instructions ?? ''}
              onBlur={(e) =>
                handleFieldSave('payment_instructions', e.target.value)
              }
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('fieldChannels')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <p className="text-foreground font-medium">{t('channelEmail')}</p>
            {channels?.email.configured ? (
              <p className="text-muted-foreground">
                {t('channelEmailDetail', {
                  host: channels.email.host ?? '',
                  port: channels.email.port ?? 0,
                  from: channels.email.from ?? '',
                  to: channels.email.to ?? '',
                })}
              </p>
            ) : (
              <p className="text-muted-foreground">{t('channelDisabled')}</p>
            )}
          </div>
          <div className="space-y-1 text-sm">
            <p className="text-foreground font-medium">{t('channelWebhook')}</p>
            {channels?.webhook.configured ? (
              <p className="text-muted-foreground">
                {channels.webhook.urlMasked}
              </p>
            ) : (
              <p className="text-muted-foreground">{t('channelDisabled')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {pendingQuotasToggle !== null ? (
        <Dialog
          open
          onOpenChange={(open) => !open && setPendingQuotasToggle(null)}
        >
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {pendingQuotasToggle
                  ? t('confirmQuotasOnTitle')
                  : t('confirmQuotasOffTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {pendingQuotasToggle
                  ? t('confirmQuotasOnBody', { count: accountsTotal })
                  : t('confirmQuotasOffBody')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setPendingQuotasToggle(null)}
                disabled={saving}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={saving}
                onClick={async () => {
                  await save({ quotasEnforced: pendingQuotasToggle });
                  setPendingQuotasToggle(null);
                }}
              >
                {saving ? <Loader2 className="animate-spin" /> : null}
                {t('confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

export default function PlatformSettingsPage() {
  return (
    <RequirePlatformOwner>
      <SettingsContent />
    </RequirePlatformOwner>
  );
}
