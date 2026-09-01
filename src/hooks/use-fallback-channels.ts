'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { FallbackChannel } from '@/lib/automations/window-fallback';
import type { ColdSendLimits } from '@/lib/channels/cold-send-limit';
import type { ChannelType } from '@/lib/channels/types';

/**
 * `FallbackChannel` mais o `type` real (SPEC 065, achado de code
 * review). `window-fallback.ts` continua puro e só enxerga
 * `freeformOutsideWindow` — mas um consumidor desta tela que precise do
 * `ChannelType` de verdade (ex.: capacidade de um passo, `can(type, …)`)
 * não precisa mais reconstruí-lo às cegas a partir do booleano, que só
 * distingue QR de Cloud e nunca daria certo para um terceiro tipo.
 */
export type FallbackChannelWithType = FallbackChannel & { type: ChannelType };

export interface ColdSendPolicy extends ColdSendLimits {
  enabled: boolean;
}

/**
 * Tetos de envio frio vigentes no deployment (PRD 047 §10.3), para
 * exibir a quem monta a automação. `null` enquanto carrega ou quando a
 * rota não responde — a interface omite o aviso em vez de inventar
 * números.
 */
export function useColdSendPolicy(): ColdSendPolicy | null {
  const [policy, setPolicy] = useState<ColdSendPolicy | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/channels/cold-send-limits');
        if (!res.ok) return;
        const data = (await res.json()) as ColdSendPolicy;
        if (!cancelled) setPolicy(data);
      } catch {
        // Silencioso de propósito: o aviso é informativo, e uma falha
        // de rede não pode quebrar o construtor de automações.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return policy;
}

/**
 * Canais que podem receber um desvio quando a janela de 24h fecha
 * (PRD 047 §10.2). Espelha `loadFallbackChannels()` do motor — o
 * construtor precisa oferecer exatamente o que o runtime aceitaria.
 *
 * Enquanto a migração 055 não roda, a tabela `channels` não existe, a
 * query erra e devolvemos lista vazia. É o que mantém a opção "desviar
 * para outro canal" FORA do menu até haver instância para escolher: um
 * item que sempre falha é pior que a ausência do item.
 *
 * Falha fechada de propósito — um erro de rede não pode fazer o
 * construtor oferecer um canal que o runtime não encontraria.
 */
export function useFallbackChannels(): FallbackChannelWithType[] {
  const { accountId } = useAuth();
  const [channels, setChannels] = useState<FallbackChannelWithType[]>([]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!accountId) {
        if (!cancelled) setChannels([]);
        return;
      }

      const { data, error } = await createClient()
        .from('channels')
        .select('id, name, type, status')
        .eq('account_id', accountId);

      if (cancelled) return;
      if (error || !data) {
        setChannels([]);
        return;
      }

      setChannels(
        (
          data as { id: string; name: string; type: string; status: string }[]
        ).map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status as FallbackChannel['status'],
          // Migra para `capabilities()` na F1, junto com o gêmeo em
          // `engine.ts`.
          freeformOutsideWindow: row.type === 'whatsapp_qr',
          type: row.type as ChannelType,
        }))
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return channels;
}
