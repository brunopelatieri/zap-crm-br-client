'use client';

// ============================================================
// /admin/plans — o catálogo (SPEC 062 §7.4)
//
// Quotas e recursos são campos GERADOS a partir de `QUOTA_KEYS`/
// `FEATURE_KEYS` (src/lib/plans/types.ts) — não uma lista escrita à
// mão que fica velha na próxima quota. O preço anual é calculado ao
// vivo enquanto o desconto é digitado, com a MESMA `yearlyPriceCents`
// que o resto do app usa (billing.ts) — nunca uma segunda fórmula.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';
import { yearlyPriceCents } from '@/lib/plans/billing';
import { formatPlanPrice } from '@/lib/plans/format';
import { FEATURE_KEYS, QUOTA_KEYS } from '@/lib/plans/types';

interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  billing_period: 'monthly' | 'yearly' | 'custom' | 'none';
  limits: Record<string, number>;
  features: Record<string, boolean>;
  is_public: boolean;
  is_active: boolean;
  sort_order: number;
  yearly_discount_percent: number | null;
}

type DraftPlan = Omit<PlanRow, 'id'> & { id?: string };

function emptyDraft(nextSortOrder: number): DraftPlan {
  return {
    code: '',
    name: '',
    description: '',
    price_cents: 0,
    currency: 'BRL',
    billing_period: 'monthly',
    limits: {},
    features: {},
    is_public: false,
    is_active: true,
    sort_order: nextSortOrder,
    yearly_discount_percent: null,
  };
}

function PlanEditDialog({
  draft,
  defaultDiscount,
  onClose,
  onSaved,
}: {
  draft: DraftPlan;
  defaultDiscount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Platform.plans');
  const locale = useLocale();
  const [form, setForm] = useState<DraftPlan>(draft);
  const [saving, setSaving] = useState(false);

  function setField<K extends keyof DraftPlan>(key: K, value: DraftPlan[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setLimit(key: string, raw: string) {
    setForm((prev) => {
      const limits = { ...prev.limits };
      if (raw.trim() === '') {
        delete limits[key];
      } else {
        const n = Number(raw);
        if (Number.isFinite(n)) limits[key] = n;
      }
      return { ...prev, limits };
    });
  }

  function setFeature(key: string, value: boolean) {
    setForm((prev) => ({
      ...prev,
      features: { ...prev.features, [key]: value },
    }));
  }

  const effectiveDiscount = form.yearly_discount_percent ?? defaultDiscount;
  const yearlyPrice = yearlyPriceCents(
    {
      priceCents: form.price_cents,
      yearlyDiscountPercent: form.yearly_discount_percent,
    },
    defaultDiscount
  );

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/platform/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('saveSuccess'));
      onSaved();
    } catch (err) {
      console.error('[PlanEditDialog] save failed:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-border bg-popover max-h-[85vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {draft.id ? t('editPlan') : t('newPlan')}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('fieldCode')}</Label>
            <Input
              value={form.code}
              onChange={(e) => setField('code', e.target.value)}
              disabled={Boolean(draft.id)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldName')}</Label>
            <Input
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('fieldDescription')}</Label>
            <Input
              value={form.description ?? ''}
              onChange={(e) => setField('description', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldPriceCents')}</Label>
            <Input
              type="number"
              value={form.price_cents}
              onChange={(e) =>
                setField('price_cents', Number(e.target.value) || 0)
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldCurrency')}</Label>
            <Input
              value={form.currency}
              onChange={(e) =>
                setField('currency', e.target.value.toUpperCase())
              }
              maxLength={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldBillingPeriod')}</Label>
            <Select
              value={form.billing_period}
              onValueChange={(v) =>
                setField('billing_period', v as DraftPlan['billing_period'])
              }
            >
              <SelectTrigger className="border-border bg-muted text-foreground w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                <SelectItem value="monthly">monthly</SelectItem>
                <SelectItem value="yearly">yearly</SelectItem>
                <SelectItem value="custom">custom</SelectItem>
                <SelectItem value="none">none</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldYearlyDiscount')}</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={form.yearly_discount_percent ?? ''}
              placeholder={t('fieldYearlyDiscountHint', {
                percent: defaultDiscount,
              })}
              onChange={(e) =>
                setField(
                  'yearly_discount_percent',
                  e.target.value.trim() === '' ? null : Number(e.target.value)
                )
              }
            />
            <p className="text-muted-foreground text-xs">
              {form.price_cents > 0 && form.billing_period === 'monthly'
                ? `${formatPlanPrice(yearlyPrice, form.currency, locale)} ${t('perYear')} (${effectiveDiscount}%)`
                : null}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldSortOrder')}</Label>
            <Input
              type="number"
              value={form.sort_order}
              onChange={(e) =>
                setField('sort_order', Number(e.target.value) || 0)
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={form.is_public}
              onCheckedChange={(v) => setField('is_public', v === true)}
            />
            <Label className="font-normal">{t('fieldIsPublic')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={form.is_active}
              onCheckedChange={(v) => setField('is_active', v === true)}
            />
            <Label className="font-normal">{t('fieldIsActive')}</Label>
          </div>
        </div>

        <div>
          <h3 className="text-foreground mb-2 text-sm font-medium">
            {t('limitsSection')}
          </h3>
          <p className="text-muted-foreground mb-2 text-xs">
            {t('unlimitedHint')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {QUOTA_KEYS.map((key) => (
              <div key={key} className="space-y-1">
                <Label className="text-xs font-normal">{key}</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.limits[key] ?? ''}
                  onChange={(e) => setLimit(key, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-foreground mb-2 text-sm font-medium">
            {t('featuresSection')}
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {FEATURE_KEYS.map((key) => (
              <div key={key} className="flex items-center gap-2">
                <Checkbox
                  checked={form.features[key] === true}
                  onCheckedChange={(v) => setFeature(key, v === true)}
                />
                <Label className="text-xs font-normal">{key}</Label>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !form.code || !form.name}
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlansContent() {
  const t = useTranslations('Platform.plans');
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [defaultDiscount, setDefaultDiscount] = useState(17);
  const [editing, setEditing] = useState<DraftPlan | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, settingsRes] = await Promise.all([
        fetch('/api/platform/plans', { cache: 'no-store' }),
        fetch('/api/platform/settings', { cache: 'no-store' }),
      ]);
      if (!plansRes.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      const plansData = (await plansRes.json()) as { plans: PlanRow[] };
      setPlans(plansData.plans);
      if (settingsRes.ok) {
        const settingsData = (await settingsRes.json()) as {
          settings: { default_yearly_discount_percent: number } | null;
        };
        if (settingsData.settings) {
          setDefaultDiscount(
            settingsData.settings.default_yearly_discount_percent
          );
        }
      }
    } catch (err) {
      console.error('[/admin/plans] load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-foreground text-xl font-semibold tracking-tight">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() =>
            setEditing(
              emptyDraft(Math.max(0, ...plans.map((p) => p.sort_order)) + 1)
            )
          }
        >
          <Plus className="size-4" />
          {t('newPlan')}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => {
          const discount = plan.yearly_discount_percent ?? defaultDiscount;
          const yearlyPrice = yearlyPriceCents(
            {
              priceCents: plan.price_cents,
              yearlyDiscountPercent: plan.yearly_discount_percent,
            },
            defaultDiscount
          );
          return (
            <Card
              key={plan.id}
              className="hover:ring-foreground/20 cursor-pointer transition-shadow"
              onClick={() => setEditing(plan)}
            >
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{plan.name}</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    {plan.code}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-foreground text-lg font-semibold">
                  {formatPlanPrice(plan.price_cents, plan.currency, locale)}
                  <span className="text-muted-foreground text-sm font-normal">
                    {t('perMonth')}
                  </span>
                </div>
                {plan.price_cents > 0 && plan.billing_period === 'monthly' ? (
                  <div className="text-muted-foreground text-xs">
                    {formatPlanPrice(yearlyPrice, plan.currency, locale)}
                    {t('perYear')} ({discount}%)
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  <Badge variant={plan.is_public ? 'secondary' : 'outline'}>
                    {plan.is_public ? t('badgePublic') : t('badgePrivate')}
                  </Badge>
                  {!plan.is_active ? (
                    <Badge variant="destructive">{t('badgeInactive')}</Badge>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {editing ? (
        <PlanEditDialog
          draft={editing}
          defaultDiscount={defaultDiscount}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

export default function PlatformPlansPage() {
  return (
    <RequirePlatformOwner>
      <PlansContent />
    </RequirePlatformOwner>
  );
}
