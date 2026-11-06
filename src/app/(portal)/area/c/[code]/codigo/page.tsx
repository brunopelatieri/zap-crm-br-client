import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { CodeForm } from '@/components/contact-portal/code-form';
import { PortalCard } from '@/components/contact-portal/portal-card';
import { normalizePublicCode } from '@/lib/contact-portal/code';

import { accountBrand } from '../account-brand';

// /area/c/<código>/codigo#c=123456 — o link que vai na mensagem do
// WhatsApp (delivery.ts → accessLink). O código vem no fragmento.
export default async function PortalAccountCodePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const publicCode = normalizePublicCode((await params).code);
  if (!publicCode) notFound();

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
