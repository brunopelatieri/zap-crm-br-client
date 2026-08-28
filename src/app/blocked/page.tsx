// ============================================================
// /blocked — a página que evita o chamado errado (SPEC 062 §4.2)
//
// Fora do grupo `(dashboard)` de propósito: aquele layout redireciona
// para cá, e uma página de bloqueio dentro dele seria um laço.
//
// Três regras que a §4.2 fixa, e que a implementação não pode afrouxar:
//
//   1. **Nunca diz QUAL dos dois bloqueios está ativo.** A pessoa não
//      precisa saber se foi ela ou a empresa dela — quem sabe é quem
//      bloqueou. Por isso o texto é um só, e o motivo (quando existe) é
//      resolvido sem dizer de onde veio.
//   2. **Diz que o dado continua lá.** "Listas vazias são
//      indistinguíveis de perda de dados" (§11) — é exatamente o
//      chamado desesperado que esta tela existe para não acontecer.
//   3. **Dá para quem escrever.** `platform_settings.support_email`;
//      sem ele, o bloqueado não tem para quem reclamar e liga para
//      qualquer um.
//
// Leitura por `service_role`: a sessão já foi validada acima (sem ela
// o middleware manda para `/login`), e o alcance é estritamente o
// próprio usuário e a própria conta dele. Necessário porque a 069 fez
// `accounts_select` passar por `is_account_member()` — para uma conta
// bloqueada, a linha da própria conta ficou invisível pela sessão do
// cliente, `blocked_reason` inclusive.
// ============================================================

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { BlockedSignOutButton } from '@/components/platform/blocked-sign-out-button';

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function BlockedPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const db = supabaseAdmin();

  const { data: profile } = await db
    .from('profiles')
    .select('account_id, blocked_at, blocked_reason')
    .eq('user_id', user.id)
    .maybeSingle();

  const { data: account } = profile?.account_id
    ? await db
        .from('accounts')
        .select('blocked_at, blocked_reason')
        .eq('id', profile.account_id)
        .maybeSingle()
    : { data: null };

  // Quem não está bloqueado não tem o que fazer aqui — sem isto, um
  // link salvo nos favoritos mostraria "acesso suspenso" para alguém
  // com acesso perfeitamente normal.
  const isBlocked =
    Boolean(profile?.blocked_at) || Boolean(account?.blocked_at);
  if (!isBlocked) redirect('/dashboard');

  // O motivo do PERFIL vem primeiro só porque é o mais específico dos
  // dois quando ambos existem. A tela não revela qual deles é (§4.2,
  // regra 1) — apenas mostra um motivo, se houver algum.
  const reason = profile?.blocked_reason ?? account?.blocked_reason ?? null;

  const { data: settings } = await db
    .from('platform_settings')
    .select('support_email')
    .maybeSingle();
  const supportEmail = (settings?.support_email as string | null) ?? null;

  const t = await getTranslations('Blocked');

  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-md space-y-5">
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {t('title')}
        </h1>

        <p className="text-muted-foreground text-sm leading-relaxed">
          {t('body')}
        </p>

        {reason ? (
          <div className="border-border/60 bg-muted/40 space-y-1 rounded-lg border px-4 py-3">
            <p className="text-muted-foreground text-xs font-medium">
              {t('reasonLabel')}
            </p>
            <p className="text-foreground text-sm">{reason}</p>
          </div>
        ) : null}

        <p className="text-muted-foreground text-sm">
          {supportEmail
            ? t('contactPrompt', { email: supportEmail })
            : t('contactMissing')}
        </p>

        <BlockedSignOutButton label={t('signOut')} />
      </div>
    </main>
  );
}
