import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { PortalCard } from '@/components/contact-portal/portal-card';
import { Button } from '@/components/ui/button';
import { requirePortalSession } from '@/lib/contact-portal/current';

// /area/painel — a porta do contato. Recursos futuros entram aqui, cada
// um com PRD e chave de plano próprios (PRD 082 D-5); por ora, "em breve".
export default async function PortalPanelPage() {
  const session = await requirePortalSession();
  const current = session.current;
  if (!current) redirect('/area/escolher-conta');

  const t = await getTranslations('ContactPortal');
  return (
    <PortalCard
      brand={t('brandOf', { account: current.accountName })}
      title={
        current.contactName
          ? t('panel.greeting', { name: current.contactName })
          : t('panel.greetingNoName')
      }
      description={t('panel.accountLine', { account: current.accountName })}
    >
      <div className="flex flex-col gap-4">
        <section className="border-border rounded-lg border border-dashed p-4">
          <h2 className="text-foreground text-sm font-medium">
            {t('panel.comingSoonTitle')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('panel.comingSoonBody')}
          </p>
        </section>
        {session.accesses.length > 1 && (
          <Link href="/area/escolher-conta">
            <Button variant="outline" className="w-full">
              {t('panel.switchAccount')}
            </Button>
          </Link>
        )}
        <Link href="/area/minha-conta">
          <Button variant="ghost" className="w-full">
            {t('panel.myAccount')}
          </Button>
        </Link>
      </div>
    </PortalCard>
  );
}
