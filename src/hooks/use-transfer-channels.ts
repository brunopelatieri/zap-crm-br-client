'use client';

import { useCallback, useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { resolveSessionWindow } from '@/lib/channels/session-window';
import {
  evaluateTransferChannels,
  type TransferChannelEvaluation,
} from '@/lib/channels/transfer';

/**
 * Canais candidatos a destino de transferência para ESTE contato,
 * avaliados pela regra pura de `lib/channels/transfer.ts` (SPEC 056 §4.3).
 *
 * Espelha `fetchSiblingThreads` de `contact-sidebar.tsx`, com uma
 * diferença deliberada: aqui entram TODOS os canais da conta, não só os
 * que já têm thread com o contato — a transferência é sempre um
 * find-or-create (§1.4), então "ainda não conversaram por ali" não é
 * motivo de exclusão.
 *
 * A janela de sessão de cada canal vem da thread do CONTATO naquele
 * canal, se existir — `null` (sem thread ali) resolve para janela
 * fechada em `resolveSessionWindow`, que é exatamente a leitura que o
 * D-3 pede: uma janela que nunca abriu não está aberta.
 */
export function useTransferChannels(
  contactId: string | null | undefined,
  currentChannelId: string | null | undefined
): { evaluations: TransferChannelEvaluation[]; loading: boolean } {
  const accountChannels = useAccountChannels();
  const [evaluations, setEvaluations] = useState<TransferChannelEvaluation[]>(
    []
  );
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (
      !contactId ||
      !currentChannelId ||
      accountChannels.loading ||
      accountChannels.count <= 1
    ) {
      setEvaluations([]);
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from('conversations')
      .select('channel_id, last_customer_message_at')
      .eq('contact_id', contactId)
      .not('channel_id', 'is', null);

    if (error) {
      // Falha fechada: sem saber a janela de nenhum canal, é mais
      // seguro não oferecer nenhum destino do que oferecer um que a
      // rota recusaria (D-3).
      setEvaluations([]);
      setLoading(false);
      return;
    }

    const anchorByChannel = new Map<string, string | null>(
      (data ?? []).map((row) => [
        row.channel_id as string,
        row.last_customer_message_at as string | null,
      ])
    );

    const candidates = Array.from(accountChannels.byId.values()).map(
      (channel) => {
        const anchor = anchorByChannel.get(channel.id);
        return {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          status: channel.status,
          sessionWindow: resolveSessionWindow(
            channel.type,
            anchor ? new Date(anchor) : null
          ),
        };
      }
    );

    setEvaluations(evaluateTransferChannels(candidates, currentChannelId));
    setLoading(false);
  }, [contactId, currentChannelId, accountChannels]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return { evaluations, loading };
}
