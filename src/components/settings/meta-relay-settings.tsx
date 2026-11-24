'use client';

// ============================================================
// MetaRelaySettings — Settings → API keys → "Meta webhook relay"
// (SPEC 088 §6).
//
// Configures where the original Meta webhook of the account's official
// numbers is forwarded. Admin+ only (rendered inside <RequireRole> by
// ApiKeysSettings; the routes enforce it again on the server).
//
// One-time reveal: the signing key is shown in a dialog right after it
// is created or rotated and never again — the server keeps only the
// encrypted value and no endpoint returns it (same contract as
// CreateKeyDialog in api-keys-settings.tsx).
//
// Non-trivial decisions (dirty state, which buttons are enabled, how a
// test result or API error is presented) live in
// `src/lib/webhooks/meta-relay-ui.ts`.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  Radio,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import type { ApiMetaRelay } from '@/lib/webhooks/meta-relay-config';
import {
  RELAY_AUTO_DISABLE_AFTER,
  hasOfficialChannel,
  relayApiErrorKey,
  relayFormState,
  toTestView,
  wasAutoDisabled,
  type RelayTestResponse,
  type RelayTestView,
} from '@/lib/webhooks/meta-relay-ui';
import { SettingsPanelHead } from './settings-panel-head';

const ENDPOINT = '/api/account/meta-relay';

export function MetaRelaySettings() {
  const t = useTranslations('Settings.apiKeys.metaRelay');
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const channels = useAccountChannels();

  const [loading, setLoading] = useState(true);
  const [relay, setRelay] = useState<ApiMetaRelay | null>(null);
  const [url, setUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testView, setTestView] = useState<RelayTestView | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const applySaved = useCallback((next: ApiMetaRelay | null) => {
    setRelay(next);
    setUrl(next?.url ?? '');
    setEnabled(next?.is_enabled ?? false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(ENDPOINT, { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) toast.error(t('loadFailed'));
          return;
        }
        const data = (await res.json()) as { relay: ApiMetaRelay | null };
        if (!cancelled) applySaved(data.relay);
      } catch (err) {
        console.error('[MetaRelaySettings] load error:', err);
        if (!cancelled) toast.error(t('networkError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const form = useMemo(
    () => relayFormState(relay, { url, isEnabled: enabled }),
    [relay, url, enabled]
  );
  const showNoOfficialHint =
    !channels.loading &&
    !hasOfficialChannel(Array.from(channels.byId.values()));

  function fmtDateTime(iso: string): string {
    return format(new Date(iso), 'PPp', { locale: dateFnsLocale });
  }

  async function handleSave() {
    setUrlError(null);
    setSaving(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), is_enabled: enabled }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const key = relayApiErrorKey(res.status, payload.error);
        if (key === 'invalidUrl' || key === 'urlNotPublic') {
          setUrlError(t(key));
        } else {
          toast.error(key ? t(key) : t('saveFailed'));
        }
        return;
      }
      applySaved(payload.relay as ApiMetaRelay);
      setTestView(null);
      toast.success(t('saved'));
      // Only a creation returns the key — show it once.
      if (typeof payload.secret === 'string') setRevealedKey(payload.secret);
    } catch (err) {
      console.error('[MetaRelaySettings] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      const res = await fetch(`${ENDPOINT}/secret`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || typeof payload.secret !== 'string') {
        toast.error(t('regenerateFailed'));
        return;
      }
      setRegenOpen(false);
      setRevealedKey(payload.secret);
    } catch (err) {
      console.error('[MetaRelaySettings] regenerate error:', err);
      toast.error(t('networkError'));
    } finally {
      setRegenerating(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestView(null);
    try {
      const res = await fetch(`${ENDPOINT}/test`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const key = relayApiErrorKey(res.status, payload.error);
        toast.error(key === 'rateLimited' ? t(key) : t('testFailed'));
        return;
      }
      setTestView(toTestView(payload as RelayTestResponse));
    } catch (err) {
      console.error('[MetaRelaySettings] test error:', err);
      toast.error(t('networkError'));
    } finally {
      setTesting(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch(ENDPOINT, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('removeFailed'));
        return;
      }
      applySaved(null);
      setTestView(null);
      setUrlError(null);
      setRemoveOpen(false);
      toast.success(t('removed'));
    } catch (err) {
      console.error('[MetaRelaySettings] remove error:', err);
      toast.error(t('networkError'));
    } finally {
      setRemoving(false);
    }
  }

  async function copyKey() {
    if (!revealedKey) return;
    try {
      await navigator.clipboard.writeText(revealedKey);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  function testMessage(view: RelayTestView): string {
    if (view.kind === 'connected') {
      return t('testConnected', {
        status: view.status,
        ms: view.durationMs,
      });
    }
    switch (view.reason) {
      case 'timeout':
        return t('testTimeout');
      case 'not_public':
        return t('testNotPublic');
      case 'http_error':
        return t('testHttpError', { status: view.status ?? '—' });
      default:
        return t('testNetwork');
    }
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        className="mb-0"
      />

      <Card>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="text-primary size-5 animate-spin" />
            </div>
          ) : (
            <>
              {/* LGPD: o destino recebe dado pessoal dos contatos. */}
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <p className="text-xs">{t('privacyWarning')}</p>
              </div>

              {showNoOfficialHint && (
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Radio className="size-4 shrink-0" />
                  {t('noOfficialHint')}
                </p>
              )}

              {wasAutoDisabled(relay) && relay?.auto_disabled_at && (
                <div className="flex gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3">
                  <XCircle className="mt-0.5 size-4 shrink-0 text-red-400" />
                  <p className="text-xs">
                    {t('autoDisabled', {
                      count: RELAY_AUTO_DISABLE_AFTER,
                      date: fmtDateTime(relay.auto_disabled_at),
                    })}
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label
                  htmlFor="meta-relay-url"
                  className="text-muted-foreground"
                >
                  {t('urlLabel')}
                </Label>
                <Input
                  id="meta-relay-url"
                  type="url"
                  inputMode="url"
                  value={url}
                  maxLength={2048}
                  placeholder={t('urlPlaceholder')}
                  aria-invalid={urlError ? true : undefined}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setUrlError(null);
                    setTestView(null);
                  }}
                />
                {urlError ? (
                  <p className="text-xs text-red-400">{urlError}</p>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {t('urlHint')}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <Label
                    htmlFor="meta-relay-enabled"
                    className="text-foreground"
                  >
                    {t('enabledLabel')}
                  </Label>
                  {!form.canToggle && (
                    <p className="text-muted-foreground text-xs">
                      {t('enabledHint')}
                    </p>
                  )}
                </div>
                <Switch
                  id="meta-relay-enabled"
                  checked={enabled}
                  disabled={!form.canToggle || saving}
                  onCheckedChange={(next) => {
                    setEnabled(next === true);
                    setTestView(null);
                  }}
                />
              </div>

              {relay && (
                <p className="text-muted-foreground text-xs">
                  {relay.last_delivery_at
                    ? t('statusLastDelivery', {
                        date: fmtDateTime(relay.last_delivery_at),
                      })
                    : t('statusNoDelivery')}
                  {' · '}
                  {t('statusFailures', { count: relay.failure_count })}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleSave} disabled={!form.canSave || saving}>
                  {saving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('saving')}
                    </>
                  ) : (
                    t('save')
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={!form.canTest || testing}
                  title={
                    relay && !form.canTest ? t('testNeedsSave') : undefined
                  }
                >
                  {testing ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('testing')}
                    </>
                  ) : (
                    t('test')
                  )}
                </Button>
                {relay && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setRegenOpen(true)}
                    >
                      <RefreshCw className="size-4" />
                      {t('regenerate')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setRemoveOpen(true)}
                      className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                    >
                      <Trash2 className="size-4" />
                      {t('remove')}
                    </Button>
                  </>
                )}
              </div>

              {testView && (
                <p
                  role="status"
                  className={`flex items-center gap-2 text-sm ${
                    testView.kind === 'connected'
                      ? 'text-emerald-400'
                      : 'text-red-400'
                  }`}
                >
                  {testView.kind === 'connected' ? (
                    <CheckCircle2 className="size-4 shrink-0" />
                  ) : (
                    <XCircle className="size-4 shrink-0" />
                  )}
                  {testMessage(testView)}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* One-time reveal of the signing key. */}
      <Dialog
        open={revealedKey !== null}
        onOpenChange={(next) => {
          if (!next) setRevealedKey(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('keyDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('keyDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t('keyLabel')}</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={revealedKey ?? ''}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button type="button" variant="outline" onClick={copyKey}>
                <Copy className="size-4" />
                {t('copy')}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setRevealedKey(null)}>{t('done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm: new key. */}
      <Dialog open={regenOpen} onOpenChange={setRegenOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('regenerateTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('regenerateDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRegenOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button onClick={handleRegenerate} disabled={regenerating}>
              {regenerating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('regenerating')}
                </>
              ) : (
                t('regenerateConfirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm: remove. */}
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('removeTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('removeDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('removing')}
                </>
              ) : (
                t('removeConfirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
