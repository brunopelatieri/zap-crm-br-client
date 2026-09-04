'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { BroadcastWizard } from '@/components/broadcasts/broadcast-wizard';
import {
  loadBroadcastDraft,
  type DraftLoadResult,
} from '@/lib/broadcasts/draft';
import type { BroadcastStatus } from '@/types';

/**
 * Editar um rascunho (SPEC 070 F4). O carregamento roda aqui, não no
 * `BroadcastWizard` — o assistente só deve existir depois que o
 * rascunho já foi validado (estado + propriedade), nunca com um
 * `draft` a caminho. As telas de "não editável" (§7) também vivem
 * aqui: são um estado da ROTA, não um passo do assistente.
 */
export default function EditBroadcastDraftPage() {
  const params = useParams();
  const broadcastId = params.id as string;
  const { accountId } = useAuth();
  const t = useTranslations('Broadcasts.edit');

  const [result, setResult] = useState<DraftLoadResult | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const loaded = await loadBroadcastDraft(supabase, {
        accountId,
        broadcastId,
      });
      if (!cancelled) setResult(loaded);
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, broadcastId]);

  if (!result) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!result.ok) {
    const { title, body } = notEditableCopy(result, t);
    return (
      <div className="mx-auto max-w-3xl">
        <div className="border-border bg-card flex flex-col items-center gap-4 rounded-lg border p-10 text-center">
          <ShieldAlert className="text-amber-400" size={32} />
          <h1 className="text-foreground text-lg font-semibold">{title}</h1>
          <p className="text-muted-foreground max-w-md text-sm">{body}</p>
          <Link
            href="/broadcasts"
            className="text-primary text-sm font-medium hover:underline"
          >
            {t('backToBroadcasts')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <BroadcastWizard mode="edit" draft={result.draft} initialStep="template" />
  );
}

/** Título + corpo da tela de aviso, por tipo de erro (SPEC 070 §7). */
function notEditableCopy(
  result: Extract<DraftLoadResult, { ok: false }>,
  t: ReturnType<typeof useTranslations>
): { title: string; body: string } {
  switch (result.error) {
    case 'not_found':
      return {
        title: t('notEditable.notFound.title'),
        body: t('notEditable.notFound.body'),
      };
    case 'webhook_funnel':
      return {
        title: t('notEditable.webhookFunnel.title'),
        body: t('notEditable.webhookFunnel.body'),
      };
    case 'ab_variant':
      return {
        title: t('notEditable.abVariant.title'),
        body: t('notEditable.abVariant.body'),
      };
    case 'not_a_draft': {
      const key = statusKey(result.status);
      return {
        title: t(`notEditable.status.${key}.title`),
        body: t(`notEditable.status.${key}.body`),
      };
    }
  }
}

type StatusKey =
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'streaming'
  | 'awaitingCheck'
  | 'fallback';

/**
 * Achado de code review (SPEC 070) — `Record<Exclude<BroadcastStatus,
 * 'draft'>, StatusKey>` no lugar do `switch` com `default: 'fallback'`
 * de antes. A diferença não é estilo: um `switch` sobre `status: string`
 * nunca dava erro de compilação faltando um caso — `BroadcastStatus` já
 * ganhou dois valores novos em três semanas (`streaming` na SPEC 055,
 * `awaiting_check` na SPEC 069), e cada um cairia em silêncio no
 * `fallback` genérico até alguém notar manualmente. Este objeto, sim,
 * força um erro de TypeScript (propriedade faltando) no PR que
 * adicionar o próximo valor — o `?? 'fallback'` abaixo continua sendo a
 * rede de segurança em RUNTIME (o `status` chega de um cast, não de uma
 * validação), não substitui a checagem em tempo de compilação.
 */
const STATUS_KEYS: Record<Exclude<BroadcastStatus, 'draft'>, StatusKey> = {
  scheduled: 'scheduled',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  streaming: 'streaming',
  awaiting_check: 'awaitingCheck',
};

function statusKey(status: Exclude<BroadcastStatus, 'draft'>): StatusKey {
  return STATUS_KEYS[status] ?? 'fallback';
}
