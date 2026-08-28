'use client';

// ============================================================
// RequirePlatformOwner — gate duplo do console (SPEC 062 §7)
//
// O layout de `/admin` já barra no servidor (`requirePlatformOwner()`
// + `notFound()`) — quem chega até este componente já passou por lá.
// Este é o SEGUNDO gate, no cliente, mesma dupla camada que
// `retention-panel.tsx` usa com `<RequireRole>`: útil se o app
// evoluir para navegação client-side entre seções do console sem
// reexecutar o layout do servidor a cada troca.
//
// Alimentado por `GET /api/platform/summary` — NUNCA por uma flag em
// `localStorage` (§7): o único jeito de saber se a sessão é do
// proprietário é perguntar ao servidor, que valida contra
// `PLATFORM_OWNER_EMAILS` a cada chamada.
// ============================================================

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

type GateState = 'loading' | 'ok' | 'denied';

export function RequirePlatformOwner({ children }: { children: ReactNode }) {
  const t = useTranslations('Platform.common');
  const [state, setState] = useState<GateState>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/platform/summary', { cache: 'no-store' })
      .then((res) => {
        if (!cancelled) setState(res.ok ? 'ok' : 'denied');
      })
      .catch(() => {
        if (!cancelled) setState('denied');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <p className="text-muted-foreground text-sm">{t('notAuthorized')}</p>
    );
  }

  return <>{children}</>;
}
