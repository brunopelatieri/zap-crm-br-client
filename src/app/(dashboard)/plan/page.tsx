'use client';

import { useTranslations } from 'next-intl';
import { CreditCard } from 'lucide-react';

import { PlanPanel } from '@/components/plan/plan-panel';

/**
 * Página standalone "Plano e uso" (SPEC 059) — fora de Configurações,
 * com link próprio na navegação (sidebar + dropdown de conta). Some da
 * navegação quando `quotasEnforced` está desligado (D-1), mas a rota
 * em si continua acessível por link direto — mesma filosofia que a
 * antiga aba tinha dentro de Configurações.
 */
export default function PlanPage() {
  const t = useTranslations('Plan');

  return (
    <div>
      <div className="flex items-center gap-2">
        <CreditCard className="text-primary h-6 w-6" />
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {t('title')}
        </h1>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6">
        <PlanPanel />
      </div>
    </div>
  );
}
