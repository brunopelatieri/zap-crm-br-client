'use client';

// ============================================================
// `/activity` — a página de auditoria da conta (SPEC 075 F7, D-5/D-14).
//
// O gate de papel aqui é a TERCEIRA tranca, não a primeira: a policy
// `account_activity_log_select` (migração 084) decide o que o banco
// entrega, `requireRole('admin')` em `/api/account/activity` decide
// quem a rota atende, e isto aqui decide o que a UI se dá ao trabalho
// de renderizar. Um agente que digite a URL na barra vê a recusa, não
// uma tela vazia sem explicação — e não veria dado de colega mesmo se
// as duas trancas de baixo falhassem.
// ============================================================

import { useTranslations } from 'next-intl';
import { ShieldOff } from 'lucide-react';

import { RequireRole } from '@/components/auth/require-role';
import { ActivityView } from '@/components/activity/activity-view';

export default function ActivityPage() {
  return (
    <RequireRole min="admin" fallback={<NoAccess />}>
      <ActivityView />
    </RequireRole>
  );
}

function NoAccess() {
  const t = useTranslations('Activity');
  return (
    <div className="border-border bg-card flex flex-col items-center gap-2 rounded-xl border px-6 py-16 text-center">
      <ShieldOff className="text-muted-foreground size-6" />
      <p className="text-foreground text-sm font-medium">{t('page.title')}</p>
      <p className="text-muted-foreground max-w-md text-xs">
        {t('page.noAccess')}
      </p>
    </div>
  );
}
