import { getTranslations } from 'next-intl/server';

import { PortalCard } from '@/components/contact-portal/portal-card';
import { RequestCodeForm } from '@/components/contact-portal/request-code-form';
import { normalizePublicCode } from '@/lib/contact-portal/code';

import { accountBrand } from '../c/[code]/account-brand';

// /area/recuperar[?conta=<código>] — J5: esqueci minha senha.
export default async function PortalRecoverPage({
  searchParams,
}: {
  searchParams: Promise<{ conta?: string }>;
}) {
  const publicCode = normalizePublicCode((await searchParams).conta);
  const t = await getTranslations('ContactPortal');
  return (
    <PortalCard
      brand={await accountBrand(publicCode)}
      title={t('request.recoverTitle')}
      description={t('request.description')}
    >
      <RequestCodeForm mode="reset" publicCode={publicCode} />
    </PortalCard>
  );
}
