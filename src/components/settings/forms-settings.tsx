'use client';

// ============================================================
// FormsSettings — Configurações → Formulários (SPEC 085 §10, F4).
//
// Só leitura: mostra se `FORM_LINK_SECRET` e `TURNSTILE_*` estão presentes
// no servidor (nunca o valor) e leva a `/forms`. As variáveis moram no
// ambiente do deploy, não no banco: não há o que salvar aqui. A seção só
// aparece no trilho para `admin`+ (`minRole`).
// ============================================================

import { CheckCircle2, Loader2, MinusCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

interface FormsConfig {
  featureInPlan: boolean;
  linkSecret: boolean;
  turnstile: { siteKey: boolean; secretKey: boolean };
}

type State =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; config: FormsConfig };

function StatusPill({ ok }: { ok: boolean }) {
  const t = useTranslations('Settings.forms');
  const Icon = ok ? CheckCircle2 : MinusCircle;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        ok ? 'text-emerald-500' : 'text-muted-foreground'
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {ok ? t('present') : t('absent')}
    </span>
  );
}

export function FormsSettings() {
  const t = useTranslations('Settings.forms');
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/forms/config', {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        setState({ kind: 'ok', config: (await res.json()) as FormsConfig });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        console.error(err);
        setState({ kind: 'error' });
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('desc')} />

      {state.kind === 'loading' ? (
        <div className="flex justify-center py-10">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : state.kind === 'error' ? (
        <p className="text-destructive text-sm" role="alert">
          {t('loadFailed')}
        </p>
      ) : (
        <div className="space-y-4">
          {!state.config.featureInPlan ? (
            <p
              className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-3 py-2 text-sm"
              role="status"
            >
              {t('notInPlan')}
            </p>
          ) : null}

          <Card>
            <CardContent className="space-y-2 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-foreground text-sm font-semibold">
                    {t('secretTitle')}
                  </h3>
                  <code className="text-muted-foreground text-xs">
                    {t('secretVariable')}
                  </code>
                </div>
                <StatusPill ok={state.config.linkSecret} />
              </div>
              <p className="text-muted-foreground text-sm">
                {state.config.linkSecret
                  ? t('secretPresent')
                  : t('secretAbsent')}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-2 py-4">
              <h3 className="text-foreground text-sm font-semibold">
                {t('turnstileTitle')}
              </h3>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="text-muted-foreground text-xs">
                  {t('turnstileSiteKey')}
                </code>
                <StatusPill ok={state.config.turnstile.siteKey} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="text-muted-foreground text-xs">
                  {t('turnstileSecretKey')}
                </code>
                <StatusPill ok={state.config.turnstile.secretKey} />
              </div>
              <p className="text-muted-foreground text-sm">
                {state.config.turnstile.siteKey &&
                state.config.turnstile.secretKey
                  ? t('turnstilePresent')
                  : t('turnstileAbsent')}
              </p>
            </CardContent>
          </Card>

          <Link
            href="/forms"
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('openForms')}
          </Link>
        </div>
      )}
    </div>
  );
}
