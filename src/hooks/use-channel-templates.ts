'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  templatesForChannel,
  wabaIdOfChannel,
} from '@/lib/whatsapp/templates-for-channel';
import type { MessageTemplate } from '@/types';

export interface ChannelTemplates {
  /** Templates `APPROVED` que ESTE canal consegue enviar. */
  templates: MessageTemplate[];
  loading: boolean;
  /** Força uma releitura — para quem sincroniza templates na mesma tela. */
  refetch: () => void;
}

/**
 * Os templates que um canal pode enviar (SPEC 065 D-2).
 *
 * O hook único que as quatro telas do D-2 consomem — passo "escolher
 * template" da campanha (§2.A A2) e o seletor de variante B (A3), o
 * construtor de automações (B4), e os dois que já faziam isto à mão (o
 * `TemplatePicker` do inbox e a ficha do contato), que passam a
 * consumi-lo sem mudar de comportamento.
 *
 * A regra de decisão continua sendo `templateBelongsToWaba`, uma só —
 * este hook só junta as duas leituras (templates da conta + WABA do
 * canal) e aplica `templatesForChannel`.
 *
 * ⚠️ **Passe aqui A MESMA variável que vai no `channel_id` do envio.**
 * Filtrar a lista por um canal e enviar por outro reproduz exatamente o
 * `(#132001) Template name does not exist in the translation` que o
 * filtro existe para evitar — é o achado de code review registrado em
 * `contact-detail-view.tsx` (`effectiveTemplateChannelId`).
 *
 * `channelId` nulo (ninguém escolheu ainda, ou automação "Todos os
 * números") devolve a lista INTEIRA, sem filtrar: `wabaIdOfChannel`
 * responde `undefined` — "não sei" —, e `templatesForChannel` falha
 * aberto. Ver o porquê no cabeçalho daquele módulo.
 */
export function useChannelTemplates(
  channelId: string | null | undefined
): ChannelTemplates {
  const { accountId } = useAuth();
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    // Zera ANTES de buscar (achado de code review). Sem isto, trocar de
    // canal deixava a lista do canal ANTERIOR na tela com
    // `loading: false` — ou seja, apresentada como uma seleção válida e
    // pronta. Um clique rápido escolhia um template do WABA errado
    // enquanto `channel_id` já era o do novo canal, que é exatamente a
    // combinação que este hook existe para tornar impossível. O
    // servidor recusa depois (D-3), mas o operador merece uma lista que
    // nunca ofereceu o template errado, não uma campanha rejeitada.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTemplates(null);

    (async () => {
      // Sem conta resolvida não dá para saber o WABA do canal, e listar
      // sem filtrar mostraria templates de outro número.
      if (!accountId) return;

      const supabase = createClient();

      // As duas leituras não dependem uma da outra.
      const [templatesResult, wabaId] = await Promise.all([
        // Escopo por RLS (`message_templates_select` = `is_account_member`),
        // NÃO por `user_id`: templates são da conta, e filtrar pelo autor
        // escondia os que um colega criou.
        supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .order('created_at', { ascending: false }),
        wabaIdOfChannel(supabase, accountId, channelId),
      ]);

      if (cancelled) return;

      if (templatesResult.error) {
        // Sem a lista não há o que filtrar. Diferente de "não sei o
        // WABA", que falha aberto: aqui não existe lista nenhuma.
        console.error(
          '[use-channel-templates] falha ao carregar templates:',
          templatesResult.error
        );
        setTemplates([]);
        return;
      }

      setTemplates(
        templatesForChannel(
          (templatesResult.data as MessageTemplate[]) ?? [],
          wabaId
        )
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, channelId, nonce]);

  // Memoizado: sem isto o hook devolve um objeto novo a cada render, e
  // qualquer `useEffect` que dependa dele inteiro entra no loop
  // infinito já corrigido em `useAccountChannels()` (SPEC 056).
  return useMemo(
    () => ({
      templates: templates ?? [],
      loading: templates === null,
      refetch,
    }),
    [templates, refetch]
  );
}
