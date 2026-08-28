/**
 * GET /api/whatsapp/messaging-limit[?force=1]
 *
 * Tier de mensageria da conta na Meta — o máximo de contatos que cabem
 * em um disparo em lote — mais, como informação de contexto, quantos
 * contatos já foram alcançados nas últimas 24 h (SPEC 044 §4).
 *
 * `force=1` pula o cache de 15 min e consulta a Graph API na hora. É o
 * que o botão "Checar limite" da tela de audiência usa.
 *
 * Por que isto é uma rota de servidor e não um fetch do componente
 *
 *   `whatsapp_config.access_token` está cifrado em repouso e só é
 *   decifrado aqui. Um fetch à Graph API a partir do React exporia o
 *   token de sistema da conta a qualquer usuário com o DevTools
 *   aberto — inclusive um `viewer`. Não existe variante aceitável
 *   disso, e é por isso que o CSP do projeto nem lista
 *   graph.facebook.com em `connect-src`.
 *
 * Contrato de resposta
 *
 *   Segue o padrão de /api/whatsapp/config: 200 em todo caso que não
 *   seja de autenticação, com `configured: false` + `reason` quando
 *   não dá para responder. A tela de disparo precisa renderizar um
 *   estado útil, não um 500.
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { serializeQuota } from '@/lib/whatsapp/messaging-limit';
import { loadAccountQuota } from '@/lib/whatsapp/messaging-limit-server';
import {
  RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    // `viewer` também abre a tela de disparo (em leitura), então o
    // piso aqui é a associação à conta, não o papel de agente.
    const { supabase, userId, accountId } = await requireRole('viewer');

    const limit = checkRateLimit(
      `messaging-limit:${userId}`,
      RATE_LIMITS.messagingLimit
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Toda a lógica de tier + cache + fallback mora em
    // `messaging-limit-server`, porque a rota de envio precisa
    // exatamente da mesma leitura para impor o teto (§4.5, item 4).
    const params = new URL(request.url).searchParams;
    const force = params.get('force') === '1';
    // SPEC 064 D-4: o tier é por NÚMERO. Sem `channel_id`, mede o canal
    // Cloud padrão — que é o comportamento de toda conta com um número
    // só. O cache de 15 min também passa a ser por canal, então uma
    // conta com 3 números faz até 3 chamadas à Meta por janela (§5).
    // `?channel_id=` (vazio) é ausência de id: `URLSearchParams.get`
    // devolve `''`, que não é nullish e viraria uma consulta por
    // `id = ''` em vez do canal padrão.
    const channelId = params.get('channel_id')?.trim() || null;
    const quota = await loadAccountQuota(supabase, accountId, {
      force,
      channelId,
    });

    if (!quota.configured) {
      return NextResponse.json(
        {
          configured: false,
          reason: quota.reason,
          message: 'WhatsApp não configurado.',
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { configured: true, ...serializeQuota(quota.snapshot) },
      { status: 200 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
