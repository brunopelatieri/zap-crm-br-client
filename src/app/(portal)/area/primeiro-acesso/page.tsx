import { getTranslations } from 'next-intl/server';

import { PortalCard } from '@/components/contact-portal/portal-card';
import { RequestCodeForm } from '@/components/contact-portal/request-code-form';
import { normalizePublicCode } from '@/lib/contact-portal/code';

import { accountBrand } from '../c/[code]/account-brand';

// /area/primeiro-acesso[?conta=<código>] — J3: pedir o código pela web.
export default async function PortalFirstAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ conta?: string }>;
}) {
  const publicCode = normalizePublicCode((await searchParams).conta);
  const t = await getTranslations('ContactPortal');
  return (
    <PortalCard
      brand={await accountBrand(publicCode)}
      title={t('request.firstAccessTitle')}
      description={t('request.description')}
    >
      <RequestCodeForm mode="first_access" publicCode={publicCode} />
    </PortalCard>
  );
}
