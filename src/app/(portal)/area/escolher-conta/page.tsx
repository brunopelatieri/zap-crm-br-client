import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { PortalCard } from '@/components/contact-portal/portal-card';
import { ChooseAccount } from '@/components/contact-portal/session-actions';
import { requirePortalSession } from '@/lib/contact-portal/current';

// /area/escolher-conta — a senha abriu mais de uma área (PRD 082 D-7).
export default async function PortalChooseAccountPage() {
  const session = await requirePortalSession();
  if (session.accesses.length === 1) redirect('/area/painel');

  const t = await getTranslations('ContactPortal');
  return (
    <PortalCard
      brand={t('brand')}
      title={t('choose.title')}
      description={t('choose.description')}
    >
      <ChooseAccount
        accesses={session.accesses.map((a) => ({
          contactId: a.contactId,
          accountName: a.accountName,
        }))}
      />
    </PortalCard>
  );
}
