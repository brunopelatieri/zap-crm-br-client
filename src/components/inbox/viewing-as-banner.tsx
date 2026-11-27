'use client';

import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { truncateMemberName } from '@/lib/member-name';

interface ViewingAsBannerProps {
  /** Nome completo do membro observado; o corte de exibição é feito aqui. */
  memberName: string;
  onBack: () => void;
}

/**
 * Faixa "vendo a carteira de {nome}" (SPEC 042, D7), no topo da lista de
 * conversas. Só é montada quando o admin observa outra pessoa. Texto
 * enxuto para caber na coluna estreita: ícone + nome (até 22 caracteres)
 * + "Voltar". O nome completo fica no `title` e o texto longo do botão
 * no `aria-label`.
 */
export function ViewingAsBanner({ memberName, onBack }: ViewingAsBannerProps) {
  const t = useTranslations('Inbox.page');

  return (
    <div className="border-primary/20 bg-primary/5 flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
      <span
        className="text-foreground flex min-w-0 items-center gap-1.5"
        title={t('viewingOthersInbox', { name: memberName })}
      >
        <Eye className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate font-medium">
          {truncateMemberName(memberName)}
        </span>
      </span>
      <button
        type="button"
        onClick={onBack}
        aria-label={t('backToMineLong')}
        title={t('backToMineLong')}
        className="text-primary shrink-0 font-medium hover:underline"
      >
        {t('backToMine')}
      </button>
    </div>
  );
}
