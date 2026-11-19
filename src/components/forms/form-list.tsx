'use client';

// ============================================================
// Lista `/forms` (SPEC 085 §4.4): cartões com nome, status, respostas no
// mês, taxa de conclusão e última resposta; medidor de quota; filtro por
// status; criação a partir de um dos 4 modelos.
//
// Conta sem o item no plano (PRD 084 D-11): a rota responde 200 com
// `featureInPlan: false`; aqui sai o aviso e NADA é clicável.
// ============================================================

import { formatDistanceToNow } from 'date-fns';
import {
  ClipboardList,
  FileText,
  Loader2,
  Lock,
  MessageCircle,
  Plus,
  Star,
  Ticket,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { PlanUsageBars } from '@/components/plan/plan-usage-bars';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import { useCan } from '@/hooks/use-can';
import { isFormsApiErrorCode } from '@/lib/forms/error-codes';
import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';
import { isAppLocale, DEFAULT_LOCALE } from '@/lib/i18n/locales';
import type { PlanUsageBucket } from '@/lib/plans/types';
import { FORM_TEMPLATE_IDS, type FormTemplateId } from '@/lib/forms/templates';
import type { FormLocale, FormStatus } from '@/lib/forms/types';
import { cn } from '@/lib/utils';

import { NativeSelect } from './form-builder/ui';
import { STATUS_STYLES } from './form-builder/publish-bar';

interface FormRow {
  id: string;
  name: string;
  slug: string;
  status: FormStatus;
  locale: FormLocale;
  started_count: number;
  completed_count: number;
  completed_month: number;
  completion_rate: number | null;
  last_response_at: string | null;
  updated_at: string;
}

interface ListResponse {
  featureInPlan: boolean;
  forms: FormRow[];
  usage: PlanUsageBucket[];
  canCreate: boolean;
}

type StatusFilter = 'all' | FormStatus;

const TEMPLATE_ICONS: Record<FormTemplateId, typeof FileText> = {
  blank: FileText,
  lead_capture: MessageCircle,
  satisfaction: Star,
  event_signup: Ticket,
};

export function FormList() {
  const t = useTranslations('Forms.list');
  const tc = useTranslations('Forms.create');
  const ts = useTranslations('Forms.status');
  const te = useTranslations('Forms.errors');
  const router = useRouter();
  const locale = useLocale();
  const canEdit = useCan('edit-settings');

  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [formLocale, setFormLocale] = useState<FormLocale>(
    isAppLocale(locale) ? locale : DEFAULT_LOCALE
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/forms');
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as ListResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        console.error(err);
        if (!cancelled) toast.error(t('loadError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(template: FormTemplateId) {
    setCreating(true);
    try {
      const res = await fetch('/api/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template,
          locale: formLocale,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          limit?: number;
        };
        toast.error(
          isFormsApiErrorCode(body.error)
            ? te(body.error, { limit: body.limit ?? 0 })
            : te('generic')
        );
        return;
      }
      const json = (await res.json()) as { form: { id: string } };
      router.push(`/forms/${json.form.id}`);
    } catch (err) {
      console.error(err);
      toast.error(te('generic'));
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  const featureInPlan = data?.featureInPlan ?? false;
  const forms = data?.forms ?? [];
  const visible = forms.filter((f) => filter === 'all' || f.status === filter);
  const quotaFull = data ? !data.canCreate : false;

  return (
    <div className="space-y-6 p-2 sm:p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-semibold">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <GatedButton
          canAct={canEdit && featureInPlan && !quotaFull}
          gateReason="create forms"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t('newForm')}
        </GatedButton>
      </header>

      {!featureInPlan ? (
        <div
          className="border-border bg-card/50 flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center"
          role="status"
        >
          <div className="bg-muted flex h-14 w-14 items-center justify-center rounded-full">
            <Lock className="text-muted-foreground h-6 w-6" />
          </div>
          <h2 className="text-foreground mt-4 text-base font-medium">
            {t('notInPlanTitle')}
          </h2>
          <p className="text-muted-foreground mt-1 max-w-md text-sm">
            {t('notInPlanBody')}
          </p>
        </div>
      ) : (
        <>
          {data && data.usage.length > 0 && (
            <div className="border-border bg-card rounded-lg border p-4">
              <PlanUsageBars buckets={data.usage} />
              {quotaFull && (
                <p className="text-destructive mt-3 text-xs">
                  {t('quotaFull')}
                </p>
              )}
            </div>
          )}

          <div
            className="border-border bg-muted inline-flex gap-0.5 rounded-lg border p-0.5"
            role="group"
            aria-label={t('filterLabel')}
          >
            {(['all', 'draft', 'published', 'archived'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  filter === f
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f === 'all' ? t('filterAll') : ts(f)}
              </button>
            ))}
          </div>

          {forms.length === 0 ? (
            <div className="border-border bg-card/50 flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center">
              <div className="bg-muted flex h-14 w-14 items-center justify-center rounded-full">
                <ClipboardList className="text-muted-foreground h-6 w-6" />
              </div>
              <h2 className="text-foreground mt-4 text-base font-medium">
                {t('emptyTitle')}
              </h2>
              <p className="text-muted-foreground mt-1 max-w-md text-sm">
                {t('emptyBody')}
              </p>
              <GatedButton
                canAct={canEdit && !quotaFull}
                gateReason="create forms"
                onClick={() => setCreateOpen(true)}
                className="mt-5"
              >
                <Plus className="h-4 w-4" />
                {t('createFirst')}
              </GatedButton>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noMatches')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((form) => (
                <FormCard
                  key={form.id}
                  form={form}
                  locale={locale}
                  onOpen={() => router.push(`/forms/${form.id}`)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{tc('title')}</DialogTitle>
            <DialogDescription>{tc('description')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label
                className="text-muted-foreground text-sm"
                htmlFor="new-form-name"
              >
                {tc('name')}
              </label>
              <Input
                id="new-form-name"
                value={name}
                maxLength={120}
                placeholder={tc('namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <label
                className="text-muted-foreground text-sm"
                htmlFor="new-form-locale"
              >
                {tc('language')}
              </label>
              <NativeSelect
                id="new-form-locale"
                value={formLocale}
                onChange={(e) => setFormLocale(e.target.value as FormLocale)}
              >
                <option value="pt-BR">Português (Brasil)</option>
                <option value="en">English</option>
              </NativeSelect>
            </div>
          </div>

          <p className="text-muted-foreground text-xs">{tc('languageHint')}</p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FORM_TEMPLATE_IDS.map((id) => {
              const Icon = TEMPLATE_ICONS[id];
              return (
                <button
                  key={id}
                  type="button"
                  disabled={creating}
                  onClick={() => void create(id)}
                  className="border-border bg-background hover:border-primary/40 hover:bg-muted flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors disabled:opacity-50"
                >
                  <Icon className="text-primary h-5 w-5" />
                  <span className="text-foreground text-sm font-semibold">
                    {tc(`templates.${id}.name`)}
                  </span>
                  <span className="text-muted-foreground text-xs leading-relaxed">
                    {tc(`templates.${id}.description`)}
                  </span>
                </button>
              );
            })}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {tc('cancel')}
            </Button>
          </DialogFooter>
          {creating && (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tc('creating')}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FormCard({
  form,
  locale,
  onOpen,
}: {
  form: FormRow;
  locale: string;
  onOpen: () => void;
}) {
  const t = useTranslations('Forms.list');
  const ts = useTranslations('Forms.status');
  const rate =
    form.completion_rate === null
      ? t('noRate')
      : `${Math.round(form.completion_rate * 100)}%`;

  return (
    <li className="relative">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'border-border bg-card hover:border-primary/40 flex w-full flex-col rounded-lg border p-4 pb-10 text-left transition-colors',
          form.status === 'archived' && 'opacity-70'
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-foreground truncate text-sm font-semibold">
              {form.name}
            </h3>
            <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
              /f/{form.slug}
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn('shrink-0 text-[10px]', STATUS_STYLES[form.status])}
          >
            {ts(form.status)}
          </Badge>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">{t('responsesMonth')}</dt>
            <dd className="text-foreground mt-0.5 text-base font-semibold tabular-nums">
              {form.completed_month}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('completionRate')}</dt>
            <dd className="text-foreground mt-0.5 text-base font-semibold tabular-nums">
              {rate}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('lastResponse')}</dt>
            <dd className="text-foreground mt-0.5 text-sm">
              {form.last_response_at
                ? formatDistanceToNow(new Date(form.last_response_at), {
                    addSuffix: true,
                    locale: getDateFnsLocale(locale),
                  })
                : t('never')}
            </dd>
          </div>
        </dl>
      </button>
      <Link
        href={`/forms/${form.id}/respostas`}
        className="text-primary absolute right-4 bottom-3 text-xs font-medium hover:underline"
      >
        {t('viewResponses')}
      </Link>
    </li>
  );
}
