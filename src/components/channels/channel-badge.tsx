'use client';

/**
 * Selo de canal — mesmo ícone + nome do inbox (`conversation-list.tsx`),
 * agora reaproveitado pelas listas de automação, fluxo e campanha
 * (SPEC 065 §7.4/D-10 item 5).
 *
 * `channel` ausente (recurso "Todos os números", ou canal apagado sem
 * fallback) não renderiza nada — não há o que rotular. Cabe ao chamador
 * decidir SE mostra o selo (a regra é sempre "só com mais de um canal na
 * conta" — repetir "WhatsApp Oficial" em toda linha de uma conta de
 * número único é ruído puro, mesmo critério do inbox).
 */

import { BadgeCheck, QrCode } from 'lucide-react';

import type { Channel } from '@/lib/channels/types';

export function ChannelBadge({
  channel,
}: {
  channel: Channel | null | undefined;
}) {
  if (!channel) return null;
  return (
    <span
      className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-[10px]"
      title={channel.name}
    >
      {channel.type === 'whatsapp_qr' ? (
        <QrCode className="h-3 w-3 shrink-0" />
      ) : (
        <BadgeCheck className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{channel.name}</span>
    </span>
  );
}
