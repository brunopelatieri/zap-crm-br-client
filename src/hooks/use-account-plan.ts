'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountPlan, Plan, PlanUsage } from '@/lib/plans/types';

export type PlanCatalogEntry = Pick<
  Plan,
  | 'id'
  | 'code'
  | 'name'
  | 'description'
  | 'priceCents'
  | 'currency'
  | 'billingPeriod'
  | 'limits'
  | 'features'
  | 'sortOrder'
  | 'yearlyDiscountPercent'
>;

export interface PendingPlanRequest {
  id: string;
  requestedPlanId: string;
  status: 'pending';
  message: string | null;
  createdAt: string;
}

export interface AccountPlanResponse {
  quotasEnforced: boolean;
  plan: Plan;
  accountPlan: AccountPlan;
  usage: PlanUsage;
  /** SPEC 062 §6.1/§7.1 — liga o modal de ciclo no lugar da fila de solicitação. */
  selfServiceEnabled: boolean;
  /** SPEC 062 §3.4/D-5 — usado quando `plan.yearlyDiscountPercent` é `null`. */
  defaultYearlyDiscountPercent: number;
  catalog: PlanCatalogEntry[];
  pendingRequest: PendingPlanRequest | null;
}

export interface UseAccountPlanResult {
  data: AccountPlanResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * `GET /api/account/plan` — plano efetivo, uso, catálogo público e
 * solicitação pendente. Usado pela aba "Plano e uso" (SPEC 059 §7.1) e
 * por qualquer tela que precise esconder um recurso desligado pelo
 * plano (§7.3) sem esperar a rota devolver 403.
 */
export function useAccountPlan(): UseAccountPlanResult {
  const [data, setData] = useState<AccountPlanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // Só a carga INICIAL ativa o spinner de tela cheia. Um `refetch()`
  // (troca de plano, cancelar/retomar) reusa este mesmo efeito — sem
  // esta guarda, `loading` voltava a `true` a cada refetch e o
  // consumidor (`PlanPanel`) substituía a árvore inteira por um
  // spinner, desmontando `PlanCatalog` e derrubando o estado local do
  // diálogo de ciclo (`cyclePlan`) antes do usuário conseguir
  // confirmar a troca — a causa do "clica em Escolher este plano e não
  // acontece nada" no autosserviço de plano pago.
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!hasLoadedRef.current) setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/account/plan', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`Failed to load account plan (${res.status})`);
        }
        const json = (await res.json()) as AccountPlanResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        console.error('[use-account-plan] failed to fetch:', err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) {
          hasLoadedRef.current = true;
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const refetch = useCallback(() => setReloadToken((t) => t + 1), []);

  return { data, loading, error, refetch };
}
