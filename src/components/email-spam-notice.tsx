'use client';

import { MailWarning } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * Aviso de caixa de spam, mostrado em toda tela que informa que um e-mail
 * do sistema foi enviado (cadastro, recuperação de senha, troca de e-mail).
 * Os avisos do ZAP CRM BR costumam cair em spam no Hotmail/Gmail, e perder
 * um link de confirmação trava o acesso à conta.
 */
export function EmailSpamNotice({ className }: { className?: string }) {
  const t = useTranslations('EmailSpamNotice');

  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-amber-800 dark:text-amber-200',
        className
      )}
    >
      <MailWarning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1 text-xs leading-relaxed">
        <p className="font-semibold">{t('title')}</p>
        <p>{t('body')}</p>
      </div>
    </div>
  );
}
