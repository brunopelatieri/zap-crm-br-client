'use client';

// ============================================================
// ContactPortalSettings — Configurações → Área do contato (SPEC 083).
//
// PRD 082 §6.3: ligar/desligar, canal que envia os códigos, template de
// autenticação (só número oficial), palavra-chave e o endereço para
// divulgar. Lê e grava por `/api/contact-portal/settings` (`admin`+);
// a seção nem aparece no trilho para quem está abaixo disso.
//
// QR code do endereço: fica para depois — o projeto não tem gerador de
// QR no cliente, e o endereço copiável já cobre a divulgação.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Copy, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import type { PortalAccountSettings } from '@/lib/contact-portal/account';
import { createClient } from '@/lib/supabase/client';
import { SettingsPanelHead } from './settings-panel-head';

const DEFAULT_CHANNEL = '__default__';
const NO_TEMPLATE = '__none__';

interface SettingsView {
  /**
   * `contact_portal_enabled` no plano da conta (SPEC 083 §8.4, PRD 082
   * D-4). Decidido pelo servidor (`plan_feature_strict`), nunca por
   * `useAccountPlan().plan.features`: o cliente não vê a exceção por
   * conta (`limit_overrides`). `false` = aviso e controles desabilitados.
   */
  featureInPlan: boolean;
  settings: PortalAccountSettings | null;
  portalUrl: string | null;
}

export function ContactPortalSettings() {
  const t = useTranslations('Settings.contactPortal');
  const channels = useAccountChannels();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<SettingsView | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>(
    []
  );

  const [enabled, setEnabled] = useState(false);
  const [channelId, setChannelId] = useState(DEFAULT_CHANNEL);
  const [templateId, setTemplateId] = useState(NO_TEMPLATE);
  const [keywordOn, setKeywordOn] = useState(true);
  const [keyword, setKeyword] = useState('SENHA');

  const applyView = useCallback((v: SettingsView) => {
    setView(v);
    const s = v.settings;
    setEnabled(s?.enabled ?? false);
    setChannelId(s?.channelId ?? DEFAULT_CHANNEL);
    setTemplateId(s?.authTemplateId ?? NO_TEMPLATE);
    setKeywordOn(s ? s.keyword !== null : true);
    setKeyword(s?.keyword ?? 'SENHA');
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [res, tpl] = await Promise.all([
        fetch('/api/contact-portal/settings'),
        // RLS: só templates da própria conta.
        createClient()
          .from('message_templates')
          .select('id, name')
          .eq('category', 'Authentication')
          .eq('status', 'APPROVED')
          .order('name'),
      ]);
      if (!alive) return;
      if (!res.ok) {
        toast.error(t('loadFailed'));
        setLoading(false);
        return;
      }
      applyView((await res.json()) as SettingsView);
      setTemplates((tpl.data ?? []) as { id: string; name: string }[]);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [applyView, t]);

  const connected = useMemo(
    () =>
      Array.from(channels.byId.values()).filter(
        (c) => c.status === 'connected'
      ),
    [channels]
  );

  const save = async () => {
    setSaving(true);
    const res = await fetch('/api/contact-portal/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled,
        channelId: channelId === DEFAULT_CHANNEL ? null : channelId,
        authTemplateId: templateId === NO_TEMPLATE ? null : templateId,
        keyword: keywordOn ? keyword : null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(t('saveFailed'));
      return;
    }
    applyView((await res.json()) as SettingsView);
    toast.success(t('saved'));
  };

  const copyUrl = async () => {
    if (!view?.portalUrl) return;
    try {
      await navigator.clipboard.writeText(view.portalUrl);
      toast.success(t('copied'));
    } catch {
      /* clipboard bloqueado: o endereço continua visível para copiar à mão */
    }
  };

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  const settings = view?.settings ?? null;
  // Plano sem o item: a aba continua visível (o admin precisa descobrir
  // que o recurso existe e depende do plano), mas nada é editável. Sem
  // resposta do GET (`view` nulo, o toast já avisou) também trava, mas
  // sem afirmar "não está no plano" — isso só quando o servidor disse.
  const notInPlan = view !== null && !view.featureInPlan;
  const locked = view === null || notInPlan;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('desc')} />
      <Card className="border-border bg-card">
        <CardContent className="space-y-6 pt-6">
          {notInPlan && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {t('notInPlan')}
            </div>
          )}

          <div className="flex items-start justify-between gap-4">
            <div>
              <Label className="text-foreground">{t('enabledLabel')}</Label>
              <p className="text-muted-foreground mt-1 text-xs">
                {t('enabledHint')}
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={locked}
            />
          </div>

          {settings?.enabled && !settings.eligible && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {t('notEligible')}
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('channelLabel')}</Label>
            <Select
              value={channelId}
              onValueChange={(v) => v && setChannelId(v)}
              disabled={locked}
            >
              <SelectTrigger className="bg-muted border-border text-foreground w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_CHANNEL}>
                  {t('channelDefault')}
                </SelectItem>
                {connected.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">
              {t('templateLabel')}
            </Label>
            <Select
              value={templateId}
              onValueChange={(v) => v && setTemplateId(v)}
              disabled={locked}
            >
              <SelectTrigger className="bg-muted border-border text-foreground w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEMPLATE}>{t('templateNone')}</SelectItem>
                {templates.map((tpl) => (
                  <SelectItem key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {templates.length === 0 ? t('templateEmpty') : t('templateHint')}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <Label className="text-muted-foreground">
                {t('keywordLabel')}
              </Label>
              <Switch
                checked={keywordOn}
                onCheckedChange={setKeywordOn}
                disabled={locked}
              />
            </div>
            {keywordOn ? (
              <Input
                value={keyword}
                maxLength={32}
                onChange={(e) => setKeyword(e.target.value)}
                disabled={locked}
                className="bg-muted border-border max-w-xs uppercase"
              />
            ) : (
              <p className="text-muted-foreground text-sm">{t('keywordOff')}</p>
            )}
            <p className="text-muted-foreground text-xs">{t('keywordHint')}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('urlLabel')}</Label>
            {view?.portalUrl ? (
              <div className="flex items-center gap-2">
                <code className="bg-muted text-foreground min-w-0 flex-1 truncate rounded-md px-3 py-2 text-sm">
                  {view.portalUrl}
                </code>
                <Button variant="outline" size="sm" onClick={copyUrl}>
                  <Copy className="size-3.5" />
                  {t('copy')}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                {t('neverConfigured')}
              </p>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving || locked}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
