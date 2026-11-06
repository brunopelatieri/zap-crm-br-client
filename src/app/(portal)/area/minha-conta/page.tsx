import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { PortalCard } from '@/components/contact-portal/portal-card';
import {
  ChangePasswordForm,
  SignOutButton,
} from '@/components/contact-portal/session-actions';
import { Separator } from '@/components/ui/separator';
import { requirePortalSession } from '@/lib/contact-portal/current';
import { maskedPhoneOf } from '@/lib/contact-portal/journeys';

// /area/minha-conta — nome (só leitura nesta entrega), telefone
// mascarado, trocar senha, sair (PRD 082 §6.2).
export default async function PortalMyAccountPage() {
  const session = await requirePortalSession();
  const current = session.current;
  if (!current) redirect('/area/escolher-conta');

  const t = await getTranslations('ContactPortal');
  const phone = await maskedPhoneOf(session).catch(() => null);

  return (
    <PortalCard
      brand={t('brandOf', { account: current.accountName })}
      title={t('account.title')}
    >
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('account.name')}</dt>
          <dd className="text-foreground">{current.contactName ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('account.phone')}</dt>
          <dd className="text-foreground">{phone ?? '—'}</dd>
        </dl>
        <Separator />
        <h2 className="text-foreground text-sm font-medium">
          {t('account.changePasswordTitle')}
        </h2>
        <ChangePasswordForm />
        <Separator />
        <div className="flex flex-col gap-2">
          <SignOutButton />
          <SignOutButton everywhere />
          <Link
            href="/area/painel"
            className="text-muted-foreground hover:text-foreground mt-2 text-center text-sm hover:underline"
          >
            {t('account.back')}
          </Link>
        </div>
      </div>
    </PortalCard>
  );
}
