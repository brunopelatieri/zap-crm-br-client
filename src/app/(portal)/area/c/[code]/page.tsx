import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { LoginForm } from '@/components/contact-portal/login-form';
import { PortalCard } from '@/components/contact-portal/portal-card';
import { normalizePublicCode } from '@/lib/contact-portal/code';
import { getPortalSession, homeOf } from '@/lib/contact-portal/current';

import { accountBrand } from './account-brand';

// /area/c/<código> — o endereço que a conta divulga (QR, bio, convite).
// Mostra o nome da conta e escopa o envio do código nela (PRD 082 D-7).
export default async function PortalAccountLoginPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const publicCode = normalizePublicCode((await params).code);
  if (!publicCode) notFound();

  const session = await getPortalSession();
  if (session) redirect(homeOf(session));

  const t = await getTranslations('ContactPortal');
  return (
    <PortalCard
      brand={await accountBrand(publicCode)}
      title={t('login.title')}
      description={t('login.description')}
    >
      <LoginForm publicCode={publicCode} />
    </PortalCard>
  );
}
