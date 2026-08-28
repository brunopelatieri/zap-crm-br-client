import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AccountBlockedError, getCurrentAccount } from '@/lib/auth/account';
import { DashboardShell } from './dashboard-shell';

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and middleware redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
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

// SPEC 062 §4.1, camada 2. A camada 1 (RLS, via `is_account_member`)
// já impede o vazamento — esta existe só para EXPLICAR. Sem ela, o
// bloqueado veria o app inteiro carregado e vazio, e "sumiram meus
// dados" é o chamado que sai disso (§11).
//
// Aqui, e não no `middleware.ts`, de propósito: o middleware roda em
// TODA requisição, assets e webhooks inclusive, e uma consulta ao banco
// ali seria custo por request em troca de nada — a camada 1 já protege.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await getCurrentAccount();
  } catch (err) {
    if (err instanceof AccountBlockedError) {
      redirect('/blocked');
    }
    // Qualquer outra falha (sessão ausente, perfil órfão) NÃO é tratada
    // aqui: o middleware já manda quem não tem sessão para `/login`, e
    // as páginas filhas têm o próprio tratamento para o resto. Engolir
    // esses casos num redirect genérico esconderia erro real.
  }

  return <DashboardShell>{children}</DashboardShell>;
}
