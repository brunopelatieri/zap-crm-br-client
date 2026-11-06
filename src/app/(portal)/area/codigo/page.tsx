import { getTranslations } from 'next-intl/server';

import { CodeForm } from '@/components/contact-portal/code-form';
import { PortalCard } from '@/components/contact-portal/portal-card';
import { normalizePublicCode } from '@/lib/contact-portal/code';

import { accountBrand } from '../c/[code]/account-brand';

// /area/codigo[?conta=<código>] — digitar o código recebido (web).
export default async function PortalCodePage({
  searchParams,
}: {
  searchParams: Promise<{ conta?: string }>;
}) {
  const publicCode = normalizePublicCode((await searchParams).conta);
  const t = await getTranslations('ContactPortal');
  return (
    <PortalCard
      brand={await accountBrand(publicCode)}
      title={t('code.title')}
      description={t('code.description')}
    >
      <CodeForm publicCode={publicCode} />
    </PortalCard>
  );
}
