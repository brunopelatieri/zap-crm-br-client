import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { PlatformOwnerError, requirePlatformOwner } from '@/lib/platform/owner';
import { PlatformSignOutButton } from '@/components/platform/platform-sign-out-button';
import { PlatformNav } from '@/components/platform/platform-nav';

// SPEC 062 §2.4: /admin nunca é indexado, e um visitante não
// autorizado precisa ver exatamente o 404 padrão do Next — nada aqui
// pode entregar que a rota existe.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

// Layout independente do `(dashboard)` (§7): sem sidebar de inbox,
// sem seletor de conta — misturá-los criaria estados impossíveis
// ("qual conta está selecionada?" não faz sentido aqui, o console lê
// TODAS). Primeiro gate, no servidor: PLATFORM_OWNER_EMAILS ausente,
// sessão inválida, e-mail não confirmado ou fora da lista — os quatro
// casos da §2.2 — todos viram o MESMO 404 padrão do Next, nunca uma
// página de "acesso negado" que confirmaria a existência da rota.
export default async function PlatformAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch (err) {
    if (err instanceof PlatformOwnerError) {
      notFound();
    }
    throw err;
  }

  const t = await getTranslations('Platform.layout');

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border/60 flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
        <div className="flex items-center gap-4">
          <div className="flex items-baseline gap-3">
            <span className="text-foreground text-sm font-semibold tracking-tight">
              {t('title')}
            </span>
            <span className="text-muted-foreground text-xs">{ownerEmail}</span>
          </div>
          <PlatformNav />
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard"
            className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
          >
            {t('backToApp')}
          </Link>
          <PlatformSignOutButton label={t('signOut')} />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
