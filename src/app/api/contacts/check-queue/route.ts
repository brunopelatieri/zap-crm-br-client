import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { resolveCheckInstance } from '@/lib/evolution/check-instance';
import { resolveCheckLimits } from '@/lib/evolution/check-limits';
import { resolveAudienceContacts } from '@/lib/audience/resolve';
import { parseAudienceConfig } from '@/lib/broadcasts/parse-input';
import { logBroadcastAudit } from '@/lib/broadcasts/audit';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';

/**
 * POST /api/contacts/check-queue (admin+) — SPEC 069 §6.2, R2/R6.
 *
 * Enfileira contatos para checagem de número na instância validadora
 * da conta, em duas formas:
 *
 *   `{contactIds, source:'contacts_import'}` — R2/R3, avulso.
 *   `{broadcastId, source:'broadcast'}`      — R6: a campanha inteira
 *                                              entra na fila e a linha
 *                                              vai para `awaiting_check`.
 *
 * Validação de posse ANTES de qualquer INSERT (contrato de teste da
 * SPEC §11.3): a consulta de posse usa o cliente de SESSÃO (RLS já
 * filtra por conta) — se o número de contatos encontrados for menor
 * que o pedido, algum id não é desta conta (ou não existe), e a rota
 * para ali, sem enfileirar nada.
 *
 * No caminho de campanha, a audiência é resolvida AGORA
 *
 *   O cron de campanhas resolve a audiência no disparo, de propósito
 *   (§6.3 daquela SPEC: congelar a lista no agendamento produz um
 *   disparo correto e factualmente velho). O R6 não tem essa escolha:
 *   não dá para checar números que ainda não foram resolvidos. A
 *   audiência de uma campanha com checagem é, portanto, congelada no
 *   momento em que ela entra na fila — quem entrar na etiqueta depois
 *   disso não recebe. É um trade-off inerente ao R6, não um descuido.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const parsed = parseBody(body);
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const admin = supabaseAdmin();

    // A instância validadora é resolvida antes dos dois caminhos: sem
    // ela não há o que enfileirar, e descobrir isso DEPOIS de resolver
    // uma audiência de 50 mil contatos seria trabalho jogado fora.
    const instance = await resolveCheckInstance(admin, accountId);
    if (!instance) {
      return NextResponse.json(
        { error: 'no instance enabled for number checking' },
        { status: 403 }
      );
    }

    let candidates: QueueCandidate[];
    let broadcastId: string | null = null;
    let broadcastName: string | null = null;

    if (parsed.source === 'broadcast') {
      const loaded = await loadBroadcastCandidates(
        admin,
        accountId,
        userId,
        parsed.broadcastId
      );
      if ('error' in loaded) {
        return NextResponse.json(
          { error: loaded.error },
          { status: loaded.status }
        );
      }
      candidates = loaded.candidates;
      broadcastId = parsed.broadcastId;
      broadcastName = loaded.broadcastName ?? null;
    } else {
      const loaded = await loadContactCandidates(supabase, parsed.contactIds);
      if ('error' in loaded) {
        return NextResponse.json(
          { error: loaded.error },
          { status: loaded.status }
        );
      }
      candidates = loaded.candidates;
    }

    // Dedupe (índice parcial da migração 078): um contato não fica duas
    // vezes na fila PELO MESMO motivo — o mesmo contato pode estar na
    // fila avulsa e na de uma campanha, porque são motivos diferentes.
    let dedupeQuery = admin
      .from('contact_check_queue')
      .select('contact_id')
      .eq('account_id', accountId)
      .in('status', ['pending', 'in_progress'])
      .in(
        'contact_id',
        candidates.map((c) => c.id)
      );
    dedupeQuery = broadcastId
      ? dedupeQuery.eq('broadcast_id', broadcastId)
      : dedupeQuery.is('broadcast_id', null);

    const { data: alreadyQueued } = await dedupeQuery;
    const alreadyQueuedIds = new Set(
      (alreadyQueued ?? []).map((r) => r.contact_id as string)
    );

    const toInsert = candidates.filter((c) => !alreadyQueuedIds.has(c.id));

    if (toInsert.length > 0) {
      const rows = toInsert.map((c) => ({
        account_id: accountId,
        contact_id: c.id,
        // `phone_normalized` é NOT NULL na fila, mas nulável em
        // `contacts` — cai em `phone` cru para não falhar o INSERT de
        // um contato antigo que nunca recalculou a coluna gerada.
        phone_normalized: c.phoneNormalized ?? c.phone,
        source: parsed.source,
        broadcast_id: broadcastId,
        check_channel_id: instance.channelId,
        requested_by: userId,
      }));

      const { error: insertError } = await admin
        .from('contact_check_queue')
        .insert(rows);
      if (insertError) {
        return NextResponse.json(
          { error: insertError.message },
          { status: 500 }
        );
      }
    }

    const { limits } = await resolveCheckLimits(admin, {
      accountId,
      channelId: instance.channelId,
    });

    const estimatedHours =
      limits.perDay > 0
        ? Math.ceil((toInsert.length / limits.perDay) * 24)
        : null;

    // A campanha só entra em `awaiting_check` DEPOIS de a fila existir.
    // Na ordem inversa, uma falha no INSERT deixaria uma campanha
    // esperando por uma fila que nunca foi criada — presa para sempre,
    // sem nada para o cron drenar.
    if (broadcastId) {
      const { error: statusError } = await admin
        .from('broadcasts')
        .update({
          status: 'awaiting_check',
          check_before_send: true,
          check_channel_id: instance.channelId,
        })
        .eq('id', broadcastId)
        .eq('account_id', accountId);
      if (statusError) {
        return NextResponse.json(
          { error: statusError.message },
          { status: 500 }
        );
      }

      await logBroadcastAudit(admin, {
        accountId,
        event: 'scheduled',
        broadcastId,
        broadcastName,
        actorUserId: userId,
        details: {
          reason: 'awaiting_check',
          queued: toInsert.length,
          skipped: alreadyQueuedIds.size,
          check_channel_id: instance.channelId,
          estimated_hours: estimatedHours,
        },
      });
    }

    return NextResponse.json(
      {
        queued: toInsert.length,
        skipped: alreadyQueuedIds.size,
        skippedReason:
          alreadyQueuedIds.size > 0 ? 'already_checked' : undefined,
        checkChannelId: instance.channelId,
        estimatedHours,
        ...(broadcastId ? { broadcastStatus: 'awaiting_check' } : {}),
      },
      { status: 202 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

interface QueueCandidate {
  id: string;
  phone: string;
  phoneNormalized: string | null;
}

type CandidateResult =
  | { candidates: QueueCandidate[]; broadcastName?: string | null }
  | { error: string; status: number };

/** R2/R3 — ids soltos, conferidos pelo cliente de SESSÃO (RLS). */
async function loadContactCandidates(
  supabase: Parameters<typeof resolveAudienceContacts>[0],
  contactIds: string[]
): Promise<CandidateResult> {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, phone, phone_normalized')
    .in('id', contactIds);

  if (error) return { error: error.message, status: 500 };
  if (!data || data.length !== contactIds.length) {
    return {
      error: 'some contactIds do not belong to this account',
      status: 403,
    };
  }

  return {
    candidates: data.map((c) => ({
      id: c.id as string,
      phone: c.phone as string,
      phoneNormalized: (c.phone_normalized as string | null) ?? null,
    })),
  };
}

/**
 * R6 — a audiência da campanha vira fila.
 *
 * Teste A/B é recusado de propósito
 *
 *   Um teste A/B divide a MESMA audiência entre dois templates, e a
 *   divisão acontece no disparo (§6.6 da SPEC 044). O disparo parcial
 *   entrega a audiência em fatias, ao longo de dias. Casar as duas
 *   coisas exigiria decidir como dividir CADA fatia entre os braços
 *   sem enviesar o teste — uma decisão de produto que a SPEC 069 não
 *   tomou. Recusar é honesto; deixar passar dispararia só o braço A e
 *   chamaria isso de teste A/B.
 */
async function loadBroadcastCandidates(
  admin: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  userId: string,
  broadcastId: string
): Promise<CandidateResult> {
  const { data: broadcast, error } = await admin
    .from('broadcasts')
    .select('id, name, status, audience_filter, parent_broadcast_id')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) return { error: error.message, status: 500 };
  if (!broadcast) return { error: 'broadcast not found', status: 404 };

  if (broadcast.parent_broadcast_id) {
    return {
      error:
        'this broadcast is an A/B variant and cannot be checked on its own',
      status: 400,
    };
  }

  const { data: variant } = await admin
    .from('broadcasts')
    .select('id')
    .eq('parent_broadcast_id', broadcastId)
    .maybeSingle();
  if (variant) {
    return {
      error: 'checking before sending is not supported for A/B tests',
      status: 400,
    };
  }

  // Só faz sentido antes de disparar. `sending`/`sent`/`failed` já
  // passaram do ponto, e `awaiting_check` já está na fila.
  const status = broadcast.status as string;
  if (status !== 'draft' && status !== 'scheduled') {
    return {
      error: `broadcast is '${status}'; only draft or scheduled can be queued for checking`,
      status: 409,
    };
  }

  const audience = parseAudienceConfig(broadcast.audience_filter);
  if (!audience) {
    return { error: 'broadcast has a malformed audience filter', status: 400 };
  }

  try {
    const contacts = await resolveAudienceContacts(admin, {
      accountId,
      userId,
      audience,
      // Enfileirar não é hora de criar etiqueta nova: a resolução aqui
      // existe para saber QUEM checar, não para materializar a
      // organização da planilha. Isso continua acontecendo no disparo.
      canCreateTags: false,
    });

    if (contacts.length === 0) {
      return {
        error: 'no contacts found for this broadcast audience',
        status: 400,
      };
    }

    return {
      broadcastName: (broadcast.name as string) ?? null,
      candidates: contacts.map((c) => ({
        id: c.id,
        phone: c.phone,
        phoneNormalized: c.phone_normalized ?? null,
      })),
    };
  } catch (err) {
    if (err instanceof BroadcastError) {
      return { error: err.message, status: err.status };
    }
    throw err;
  }
}

interface ParsedImportBody {
  source: 'contacts_import';
  contactIds: string[];
}
interface ParsedBroadcastBody {
  source: 'broadcast';
  broadcastId: string;
}

function parseBody(
  body: unknown
): ParsedImportBody | ParsedBroadcastBody | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Body must be a JSON object' };
  }
  const { contactIds, broadcastId, source } = body as Record<string, unknown>;

  if (source === 'broadcast') {
    if (typeof broadcastId !== 'string' || !broadcastId) {
      return { error: 'broadcastId must be a non-empty string' };
    }
    return { source: 'broadcast', broadcastId };
  }

  if (source === 'contacts_import') {
    if (
      !Array.isArray(contactIds) ||
      contactIds.length === 0 ||
      !contactIds.every((id) => typeof id === 'string' && id)
    ) {
      return { error: 'contactIds must be a non-empty array of strings' };
    }
    return { source: 'contacts_import', contactIds };
  }

  return {
    error: 'source must be "contacts_import" or "broadcast"',
  };
}
