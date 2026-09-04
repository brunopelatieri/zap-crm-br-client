'use client';

// ============================================================
// useCheckInstances — SPEC 069 R2/R3/R6, D-10.
//
// Quem pode validar números agora, do lado do cliente. Os dois lugares
// que precisam disto (`import-modal.tsx`, `step2-select-audience.tsx`)
// tomam a MESMA decisão a partir do mesmo dado — uma instância
// `check_enabled` E conectada — em vez de reimplementar o filtro duas
// vezes e arriscar as duas divergirem.
//
// Com ZERO instâncias, o checkbox de checagem some por DENTRO da UI
// (desabilitado, com o motivo — a regra "nunca esconder, sempre
// explicar" do AGENTS.md); com UMA, ela é usada sem perguntar; com
// MAIS de uma (D-10), quem chama mostra um seletor.
// ============================================================

import { useEffect, useState } from 'react';

export interface CheckInstanceOption {
  channelId: string;
  name: string;
}

interface UseCheckInstancesResult {
  /** Instâncias `checkEnabled` e conectadas agora. */
  instances: CheckInstanceOption[];
  loading: boolean;
}

interface InstanceRow {
  channelId?: unknown;
  name?: unknown;
  status?: unknown;
  checkEnabled?: unknown;
}

export function useCheckInstances(): UseCheckInstancesResult {
  const [instances, setInstances] = useState<CheckInstanceOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/channels/evolution/instances', {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const payload = (await res.json()) as { instances?: InstanceRow[] };
        const options: CheckInstanceOption[] = (payload.instances ?? [])
          .filter((i) => i.checkEnabled === true && i.status === 'connected')
          .map((i) => ({
            channelId: String(i.channelId),
            name: String(i.name ?? ''),
          }));
        if (!cancelled) setInstances(options);
      } catch (err) {
        // Sem instância disponível é um estado VÁLIDO (a UI mostra o
        // checkbox desabilitado) — uma falha de rede aqui cai no mesmo
        // estado, não trava a tela.
        console.error('[useCheckInstances] load error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { instances, loading };
}
