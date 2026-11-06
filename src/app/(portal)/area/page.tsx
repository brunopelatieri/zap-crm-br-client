import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { LoginForm } from '@/components/contact-portal/login-form';
import { PortalCard } from '@/components/contact-portal/portal-card';
import { getPortalSession, homeOf } from '@/lib/contact-portal/current';

// /area — entrar pelo endereço genérico (J4).
export default async function PortalLoginPage() {
  const session = await getPortalSession();
  if (session) redirect(homeOf(session));

  const t = await getTranslations('ContactPortal');
  return (
    <PortalCard
      brand={t('brand')}
      title={t('login.title')}
      description={t('login.description')}
    >
      <LoginForm publicCode={null} />
    </PortalCard>
  );
}
