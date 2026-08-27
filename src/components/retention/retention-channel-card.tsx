'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, BadgeCheck, Loader2, QrCode, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ChannelType } from '@/lib/channels/types';
import {
  formatRetentionDaysSource,
  formatRetentionSource,
} from '@/lib/retention/format';
import type {
  EffectivePolicyWithSource,
  RetentionPolicyRow,
} from '@/lib/retention/types';
import { RetentionPreview } from './retention-preview';
import { RetentionUsageBar } from './retention-usage';

export interface RetentionChannelData {
  type: ChannelType;
  policy: RetentionPolicyRow | null;
  effective: EffectivePolicyWithSource;
  /**
   * `usageError: true` (achado de code review, SPEC 060) → a chamada de
   * uso falhou no servidor; `messagesTotal`/`favoritesTotal` vêm
   * `null` em vez de um `0` que pareceria "canal vazio" e mentiria
   * bem na tela que o dono usa para decidir se um limite é seguro.
   */
  usage:
    | { messagesTotal: number; favoritesTotal: number; usageError: false }
    | { messagesTotal: null; favoritesTotal: null; usageError: true };
}

/** `null`/coluna ausente vira campo vazio — o valor que o formulário
 *  envia de volta como "herdar" (§3.4). */
function toFieldValue(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

export function RetentionChannelCard({
  data,
  onSaved,
}: {
  data: RetentionChannelData;
  onSaved: (updated: RetentionChannelData) => void;
}) {
  const t = useTranslations('Settings.retention');
  const locale = useLocale();

  const [maxMessages, setMaxMessages] = useState(
    toFieldValue(data.policy?.maxMessages)
  );
  const [retentionDays, setRetentionDays] = useState(
    toFieldValue(data.policy?.retentionDays)
  );
  const [maxFavorites, setMaxFavorites] = useState(
    toFieldValue(data.policy?.maxFavorites)
  );
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/account/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelType: data.type,
          maxMessages: maxMessages === '' ? null : maxMessages,
          retentionDays: retentionDays === '' ? null : retentionDays,
          maxFavorites: maxFavorites === '' ? null : maxFavorites,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('saveSuccess'));
      onSaved({
        ...data,
        policy: payload.policy,
        effective: payload.effective,
      });
    } catch (err) {
      console.error('[RetentionChannelCard] save failed:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  const channelLabel = t(`channelType.${data.type}`);
  const ChannelIcon = data.type === 'whatsapp_qr' ? QrCode : BadgeCheck;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChannelIcon className="text-muted-foreground size-4" />
          {channelLabel}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* Empilhado, não em grade de 3 colunas: este cartão divide a
            largura com outro (dois canais lado a lado no painel, mais o
            rail de Configurações à esquerda) — `sm:grid-cols-3` inicia a
            grade pela largura da VIEWPORT, não a do cartão, e a 640px de
            viewport o cartão real tem menos de 200px, espremendo rótulo e
            placeholder até truncar. Ver captura da verificação em
            navegador (SPEC 060 F5/F8). */}
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${data.type}-max-messages`}>
              {t('fieldMaxMessages')}
            </Label>
            <Input
              id={`${data.type}-max-messages`}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={maxMessages}
              onChange={(e) => setMaxMessages(e.target.value)}
              placeholder={
                formatRetentionSource(
                  data.effective.maxMessagesSource,
                  data.effective.maxMessages,
                  locale
                ) || undefined
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${data.type}-retention-days`}>
              {t('fieldRetentionDays')}
            </Label>
            <Input
              id={`${data.type}-retention-days`}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              placeholder={
                formatRetentionDaysSource(
                  data.effective.retentionDaysSource,
                  data.effective.retentionDays,
                  locale
                ) || undefined
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${data.type}-max-favorites`}>
              {t('fieldMaxFavorites')}
            </Label>
            <Input
              id={`${data.type}-max-favorites`}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={maxFavorites}
              onChange={(e) => setMaxFavorites(e.target.value)}
              placeholder={
                formatRetentionSource(
                  data.effective.maxFavoritesSource,
                  data.effective.maxFavorites,
                  locale
                ) || undefined
              }
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">{t('fieldsHint')}</p>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <RetentionPreview
            channelType={data.type}
            maxMessages={maxMessages}
            retentionDays={retentionDays}
            maxFavorites={maxFavorites}
          />
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            {t('saveButton')}
          </Button>
        </div>

        <div className="flex flex-col gap-3 border-t pt-4">
          {data.usage.usageError ? (
            <p className="text-destructive flex items-center gap-1.5 text-xs">
              <AlertTriangle className="size-3.5 shrink-0" />
              {t('usageLoadFailed')}
            </p>
          ) : (
            <>
              <RetentionUsageBar
                label={t('usageMessages')}
                used={data.usage.messagesTotal}
                limit={data.effective.maxMessages}
              />
              <RetentionUsageBar
                label={t('usageFavorites')}
                used={data.usage.favoritesTotal}
                limit={data.effective.maxFavorites}
                overCapHint={t('favoritesOverCapHint')}
              />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
