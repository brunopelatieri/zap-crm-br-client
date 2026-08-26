'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useAccountPlan, type UseAccountPlanResult } from './use-account-plan';

const AccountPlanContext = createContext<UseAccountPlanResult | null>(null);

/**
 * Uma chamada só a `GET /api/account/plan` por sessão de dashboard,
 * compartilhada entre a navegação (Sidebar/Header decidindo se mostram
 * o link "Plano e uso") e a própria página `/plan` (que precisa dos
 * dados completos). Sem isto, `PlanPanel` faria sua própria chamada
 * independente da que `DashboardShell` já fez — achado de code review
 * (2026-08-25): dois GETs concorrentes ao abrir `/plan`.
 */
export function AccountPlanProvider({ children }: { children: ReactNode }) {
  const value = useAccountPlan();
  return (
    <AccountPlanContext.Provider value={value}>
      {children}
    </AccountPlanContext.Provider>
  );
}

export function useAccountPlanContext(): UseAccountPlanResult {
  const ctx = useContext(AccountPlanContext);
  if (!ctx) {
    throw new Error(
      'useAccountPlanContext must be used within AccountPlanProvider'
    );
  }
  return ctx;
}
