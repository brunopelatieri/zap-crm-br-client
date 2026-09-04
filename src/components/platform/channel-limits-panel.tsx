'use client';

// ============================================================
// ChannelLimitsPanel — bloco "Limites de segurança do WhatsApp QRCode"
// de /admin/accounts/[accountId] (SPEC 069 §6.6/§8 ponto 8, F10).
//
// Editor de TRÊS ESTADOS por eixo (D-6) — nunca um campo numérico
// vazio, que confundiria "não configurei" com "configurei zero":
//
//   "Usar padrão"       → override removido (`null` no PUT)
//   "Valor próprio"     → número > 0 (ou >= 0 quando o eixo aceita 0)
//   "Bloquear este eixo" → grava exatamente `0` — só oferecido para
//                          eixos que aceitam bloqueio (todos, exceto
//                          o silêncio que define "frio").
//
// O teto duro (D-7) é mostrado SEMPRE ao lado do campo — o operador
// não deve descobrir o limite ao errar — e a validação real é do
// SERVIDOR: este componente só evita a viagem óbvia, nunca confia
// only nisso.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';

/** As 11 chaves de segurança (SPEC 069 D-5) — mesma ordem de §3.1/§3.2. */
const SAFETY_AXES = [
  'evolution_cold_send_silence_hours',
  'evolution_cold_send_per_hour',
  'evolution_cold_send_per_day',
  'evolution_cold_send_min_interval_seconds',
  'evolution_cold_send_warmup_days',
  'evolution_check_per_hour',
  'evolution_check_per_day',
  'evolution_check_min_interval_seconds',
  'evolution_check_batch_size',
  'evolution_harvest_per_run',
  'evolution_harvest_max_per_instance',
] as const;

/** Só este eixo não aceita bloqueio (SPEC 069 §3.4 regra 3) — `0`
 *  cairia no padrão em vez de bloquear, então oferecer a opção
 *  mentiria sobre o que ela faz. */
const NO_BLOCK_AXIS = 'evolution_cold_send_silence_hours';

interface LimitView {
  value: number;
  level: string;
  hardCap: number | null;
  override: number | null;
}

interface InstanceView {
  channelId: string;
  label: string;
  overrides: Record<string, number>;
}

interface Snapshot {
  account: Record<string, LimitView>;
  instances: InstanceView[];
}

type AxisState = 'default' | 'own' | 'blocked';

function stateOf(override: number | null): AxisState {
  if (override === null) return 'default';
  if (override === 0) return 'blocked';
  return 'own';
}

async function readError(res: Response, fallback: string): Promise<string> {
  const payload = await res.json().catch(() => ({}));
  return typeof payload?.error === 'string' ? payload.error : fallback;
}

function ChannelLimitsPanelContent({ accountId }: { accountId: string }) {
  const t = useTranslations('Platform.channelLimits');
  const base = `/api/platform/accounts/${accountId}/channel-limits`;

  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // Rascunho local por eixo — só sai daqui para o servidor no blur/troca.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (!res.ok) {
        toast.error(await readError(res, t('saveError')));
        return;
      }
      const data = (await res.json()) as Snapshot;
      setSnapshot(data);
      const nextDrafts: Record<string, string> = {};
      for (const axis of SAFETY_AXES) {
        const override = data.account[axis]?.override ?? null;
        nextDrafts[axis] = override !== null ? String(override) : '';
      }
      setDrafts(nextDrafts);
    } catch (err) {
      console.error('[ChannelLimitsPanel] load failed:', err);
      toast.error(t('saveError'));
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const instanceOverrideCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const axis of SAFETY_AXES) counts[axis] = 0;
    for (const instance of snapshot?.instances ?? []) {
      for (const axis of Object.keys(instance.overrides)) {
        counts[axis] = (counts[axis] ?? 0) + 1;
      }
    }
    return counts;
  }, [snapshot]);

  async function save(axis: string, value: number | null) {
    setSaving(axis);
    try {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: { [axis]: value } }),
      });
      if (!res.ok) {
        toast.error(await readError(res, t('saveError')));
        return;
      }
      toast.success(t('saveSuccess'));
      await load();
    } catch (err) {
      console.error('[ChannelLimitsPanel] save failed:', err);
      toast.error(t('saveError'));
    } finally {
      setSaving(null);
    }
  }

  function handleStateChange(axis: string, next: AxisState) {
    if (next === 'default') {
      void save(axis, null);
      return;
    }
    if (next === 'blocked') {
      void save(axis, 0);
      return;
    }
    // 'own' — não salva ainda: o operador precisa digitar um valor.
    const view = snapshot?.account[axis];
    const fallback = view && view.value > 0 ? view.value : 1;
    setDrafts((prev) => ({ ...prev, [axis]: String(fallback) }));
  }

  function commitOwnValue(axis: string) {
    const raw = drafts[axis]?.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed) || parsed < 0) return;
    const current = snapshot?.account[axis]?.override ?? null;
    if (current === parsed) return;
    void save(axis, parsed);
  }

  if (loading || !snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-primary size-6 animate-spin" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-muted-foreground text-sm">{t('description')}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          {SAFETY_AXES.map((axis) => {
            const view = snapshot.account[axis];
            const state = stateOf(view?.override ?? null);
            const overrideCount = instanceOverrideCounts[axis] ?? 0;
            const allowsBlock = axis !== NO_BLOCK_AXIS;

            return (
              <div key={axis} className="space-y-1.5">
                <Label className="text-xs">{t(`axis.${axis}`)}</Label>
                <div className="flex items-center gap-2">
                  <Select
                    value={state}
                    onValueChange={(v) =>
                      handleStateChange(axis, v as AxisState)
                    }
                    disabled={saving === axis}
                  >
                    <SelectTrigger className="h-8 flex-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        {t('useDefault')} ({view?.value ?? '—'})
                      </SelectItem>
                      <SelectItem value="own">{t('ownValue')}</SelectItem>
                      {allowsBlock && (
                        <SelectItem value="blocked">
                          {t('blockAxis')}
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {state === 'own' && (
                    <Input
                      type="number"
                      min={0}
                      className="h-8 w-20 text-xs"
                      value={drafts[axis] ?? ''}
                      disabled={saving === axis}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [axis]: e.target.value,
                        }))
                      }
                      onBlur={() => commitOwnValue(axis)}
                    />
                  )}
                  {saving === axis && (
                    <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
                  )}
                </div>
                {view?.hardCap !== null && view?.hardCap !== undefined && (
                  <p className="text-muted-foreground text-[10px]">
                    {t('hardCapHint', { max: view.hardCap })}
                  </p>
                )}
                {overrideCount > 0 && (
                  <Alert className="border-amber-500/30 bg-amber-500/5 py-1.5">
                    <AlertDescription className="text-[11px]">
                      {t('instanceOverridesWarning', { count: overrideCount })}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-border space-y-2 border-t pt-4">
          <p className="text-foreground text-sm font-medium">
            {t('instancesTitle')}
          </p>
          {snapshot.instances.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('noInstances')}</p>
          ) : (
            <div className="space-y-1 text-xs">
              {snapshot.instances.map((instance) => (
                <div
                  key={instance.channelId}
                  className="text-muted-foreground flex items-center justify-between gap-2"
                >
                  <span className="text-foreground">{instance.label}</span>
                  <span>
                    {Object.keys(instance.overrides).length > 0
                      ? Object.entries(instance.overrides)
                          .map(([k, v]) => `${t(`axis.${k}`)}: ${v}`)
                          .join(' · ')
                      : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function ChannelLimitsPanel({ accountId }: { accountId: string }) {
  return (
    <RequirePlatformOwner>
      <ChannelLimitsPanelContent accountId={accountId} />
    </RequirePlatformOwner>
  );
}
