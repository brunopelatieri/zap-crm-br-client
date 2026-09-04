'use client';

import { useSearchParams } from 'next/navigation';

import { BroadcastWizard } from '@/components/broadcasts/broadcast-wizard';

/**
 * Criar um disparo (SPEC 070 F3). O corpo do assistente mora em
 * `components/broadcasts/broadcast-wizard.tsx` — esta rota é só a casca
 * que lê a query e escolhe o modo, para `/broadcasts/[id]/edit` reusar
 * exatamente o mesmo componente em vez de uma cópia que divergiria na
 * primeira correção de bug (§2.1).
 *
 * `?draftId=` continua significando o que sempre significou: "voltei da
 * triagem, reidrate o template e pule para Personalizar" (SPEC 044
 * §3.3). Quem edita um rascunho de verdade entra pela rota dedicada.
 */
export default function NewBroadcastPage() {
  const searchParams = useSearchParams();

  return (
    <BroadcastWizard
      mode="create"
      resumeDraftId={searchParams.get('draftId')}
    />
  );
}
