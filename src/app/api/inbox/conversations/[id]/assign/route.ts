import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { reassignConversation } from '@/lib/inbox/assignment';
import { isUuid } from '@/lib/api/uuid';
import { recordActivity } from '@/lib/activity/record';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/inbox/conversations/[id]/assign  (agent+)
 *
 * Body: { assigned_agent_id: string | null }
 *   - UUID  → passa a conversa para aquele agente
 *   - null  → devolve à fila (aba "Open")
 *
 * Quem pode o quê (validado no RPC `reassign_conversation`, não aqui —
 * esta rota só traduz o erro):
 *   - o agente atribuído pode devolver à fila ou manter consigo;
 *   - passar para um TERCEIRO exige admin/owner;
 *   - o destino precisa ser membro DESTA conta com papel agent+.
 *
 * Substitui o `.update({ assigned_agent_id })` que o message-thread
 * fazia direto do browser, sem gate nenhum: qualquer agente reatribuía
 * qualquer conversa a qualquer pessoa.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, userId, accountId, role } = await requireRole('agent');

    const limit = checkRateLimit(`inbox-assign:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { error: 'Invalid conversation id' },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => null);
    // `null` é um valor legítimo (devolver à fila), então checamos a
    // presença da chave — não a veracidade do valor.
    if (!body || typeof body !== 'object' || !('assigned_agent_id' in body)) {
      return NextResponse.json(
        { error: 'assigned_agent_id (string or null) is required' },
        { status: 400 }
      );
    }

    const target = (body as { assigned_agent_id: unknown }).assigned_agent_id;
    if (target !== null && !isUuid(target)) {
      return NextResponse.json(
        { error: 'assigned_agent_id must be a UUID or null' },
        { status: 400 }
      );
    }

    const result = await reassignConversation(supabase, id, target);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }

    // SPEC 075 F3 — só quando passa para ALGUÉM (§4 só tem
    // `conversation.assigned`, não "devolvido à fila"). Devolver à fila
    // (target === null) não é ausente por esquecimento: não há ator a
    // filtrar do lado do NOVO dono, e o catálogo é fechado de propósito.
    if (target !== null) {
      void recordActivity(supabase, {
        accountId,
        resourceType: 'conversation',
        action: 'conversation.assigned',
        resourceId: id,
        actor: { kind: 'user', userId, role },
        channelId: result.conversation.channel_id ?? null,
        conversationId: id,
        contactId: result.conversation.contact_id,
        metadata: { target_user_id: target },
      });
    }

    return NextResponse.json({ conversation: result.conversation });
  } catch (err) {
    return toErrorResponse(err);
  }
}
