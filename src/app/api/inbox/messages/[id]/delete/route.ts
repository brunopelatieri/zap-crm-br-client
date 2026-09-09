// ============================================================
// POST /api/inbox/messages/[id]/delete — SPEC 074 §6
//
// Único caminho: a política `messages_delete` (083) só libera admin+, e
// marcar (`deleted_at`) precisa gravar em `message_deletion_log`, que é
// append-only e escrito com `service_role` — um `UPDATE`/`DELETE` direto
// do navegador não consegue produzir o mesmo registro. "Apagar" é UM
// gesto (D-1): a mensagem sempre é marcada; o endpoint do provedor
// dispara quando o canal permite, independente do que o admin escolher.
//
// Corpo: `{ purge?: boolean }`. `purge: true` só para admin+ — qualquer
// outro papel recebe 403 (D-14).
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  deletionScopeFor,
  planDeletion,
  truncatePreview,
  type DeleteRefusal,
} from '@/lib/messages/delete';
import { resolveChannelContext } from '@/lib/channels/send';
import { getAdapter } from '@/lib/channels/registry';
import { can } from '@/lib/channels/capabilities';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { isUuid } from '@/lib/api/uuid';
import { recordActivity } from '@/lib/activity/record';
import type { ChannelType } from '@/lib/channels/types';
import type { MessageDeletionProviderOutcome } from '@/types';

/** Marcador cru, no mesmo padrão não-traduzido de `[sticker]`/`[image]`
 *  que `ingest.ts` já grava em `last_message_text` (D-10). */
const DELETED_PREVIEW_MARKER = '[deleted]';

function refusalResponse(reason: DeleteRefusal): NextResponse {
  switch (reason) {
    case 'not_outbound':
      return NextResponse.json(
        { error: 'Cannot delete an inbound message', code: reason },
        { status: 400 }
      );
    case 'no_permission':
      return NextResponse.json(
        {
          error: 'You do not have permission to delete this message',
          code: reason,
        },
        { status: 403 }
      );
    case 'nothing_to_do':
      return NextResponse.json(
        {
          error: 'This message is already marked as deleted',
          code: reason,
        },
        { status: 400 }
      );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const limit = checkRateLimit(
    `msgdelete:${ctx.userId}`,
    RATE_LIMITS.msgDelete
  );
  if (!limit.success) return rateLimitResponse(limit);

  const { id: messageId } = await params;
  if (!isUuid(messageId)) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const purge = (body as { purge?: unknown })?.purge === true;

  const { data: message, error: msgError } = await ctx.supabase
    .from('messages')
    .select(
      'id, message_id, conversation_id, sender_type, status, content_type, content_text, media_path, created_at, channel_id, deleted_at, deletion_scope'
    )
    .eq('id', messageId)
    .maybeSingle();
  if (msgError || !message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  // Conversa filtrada por `account_id` — 404 se não for da conta (a RLS
  // já cobre isto; a checagem explícita é defesa em profundidade, mesmo
  // padrão de `/api/whatsapp/react`).
  const { data: conversation, error: convError } = await ctx.supabase
    .from('conversations')
    .select('id, channel_id, contact_id, contact:contacts(phone)')
    .eq('id', message.conversation_id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (convError || !conversation) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  // O canal é o DA MENSAGEM quando preenchido (desvio SPEC 049 F6.3),
  // senão o da conversa.
  const channelId = message.channel_id ?? conversation.channel_id;
  if (!channelId) {
    return NextResponse.json(
      { error: 'Conversation has no channel configured' },
      { status: 400 }
    );
  }
  const { data: channelRow, error: channelErr } = await ctx.supabase
    .from('channels')
    .select('type')
    .eq('id', channelId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (channelErr || !channelRow) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 400 });
  }
  const channelType = channelRow.type as ChannelType;

  const ageHours =
    (Date.now() - new Date(message.created_at).getTime()) / 3_600_000;

  const plan = planDeletion({
    channelType,
    senderType: message.sender_type,
    status: message.status,
    providerMessageId: message.message_id ?? null,
    deletedAt: message.deleted_at ?? null,
    deletionScope: message.deletion_scope ?? null,
    ageHours,
    role: ctx.role,
  });

  if (plan.action === 'refuse') {
    return refusalResponse(plan.reason);
  }
  if (purge && !plan.canPurge) {
    return NextResponse.json(
      {
        error: 'Only admin+ can delete a message from the system',
        code: 'no_permission',
      },
      { status: 403 }
    );
  }

  // Retomada de uma revogação que falhou (§6, action = 'revoke_retry'):
  // a mensagem já está marcada e o pedido não é de exclusão — refaz só
  // o disparo do endpoint, sem tocar em `deleted_at`/`deleted_by`.
  const isRetry = plan.alreadyMarked && !purge;

  // ------------------------------------------------------------
  // Disparo do endpoint do provedor, quando cabe (§6 passo 6).
  // ------------------------------------------------------------
  let providerOutcome: MessageDeletionProviderOutcome;
  let providerError: string | null = null;

  if (plan.revoke) {
    try {
      const { ctx: channelCtx } = await resolveChannelContext(
        ctx.supabase,
        ctx.accountId,
        channelType,
        channelId
      );
      const contactRow = Array.isArray(conversation.contact)
        ? conversation.contact[0]
        : conversation.contact;
      const phone = (contactRow as { phone?: string } | null)?.phone;
      if (!phone) throw new Error('Contact phone number not found');

      const adapter = getAdapter(channelType);
      if (!adapter.deleteMessage) {
        throw new Error(
          `channel type "${channelType}" declares deleteForEveryone but its adapter has no deleteMessage()`
        );
      }
      await adapter.deleteMessage(channelCtx, {
        to: sanitizePhoneForMeta(phone),
        providerMessageId: message.message_id as string,
      });
      providerOutcome = 'revoked';
    } catch (err) {
      // A falha NÃO aborta o resto (D-6) — o operador pediu para apagar,
      // e apagar no CRM continua sendo feito. O que a falha faz é
      // aparecer, com motivo, e habilitar "tentar de novo".
      providerOutcome = 'revoke_failed';
      providerError =
        err instanceof Error ? err.message : 'Unknown provider error';
      console.error(
        '[inbox/messages/delete] provider revoke failed:',
        providerError
      );
    }
  } else {
    providerOutcome = can(channelType, 'deleteForEveryone')
      ? 'not_attempted'
      : 'not_supported';
  }

  // ------------------------------------------------------------
  // Persistência (§6 passos 7-8).
  // ------------------------------------------------------------
  const admin = supabaseAdmin();
  const nowIso = new Date().toISOString();

  if (isRetry) {
    const { error: updateError } = await ctx.supabase
      .from('messages')
      .update({
        deletion_scope: deletionScopeFor(providerOutcome),
        deletion_error: providerError,
      })
      .eq('id', message.id);
    if (updateError) {
      console.error(
        '[inbox/messages/delete] retry update failed:',
        updateError.message
      );
      return NextResponse.json(
        { error: 'Failed to record the retry' },
        { status: 500 }
      );
    }

    const { error: logErr } = await admin.from('message_deletion_log').insert({
      account_id: ctx.accountId,
      conversation_id: message.conversation_id,
      message_id: message.id,
      provider_message_id: message.message_id ?? null,
      channel_id: channelId,
      channel_type: channelType,
      action: 'revoke_retry',
      provider_outcome: providerOutcome,
      provider_error: providerError,
      actor: 'agent',
      actor_user_id: ctx.userId,
      actor_role: ctx.role,
      content_type: message.content_type,
      content_preview: truncatePreview(message.content_text),
      had_media: !!message.media_path,
      media_path: message.media_path ?? null,
      media_removed: null,
      message_created_at: message.created_at,
    });
    if (logErr) {
      console.error(
        '[inbox/messages/delete] log insert failed:',
        logErr.message
      );
    }

    return NextResponse.json({
      ok: true,
      purged: false,
      provider_outcome: providerOutcome,
      ...(providerError ? { provider_error: providerError } : {}),
    });
  }

  // Última mensagem da conversa? Calculado ANTES de apagar/excluir —
  // decide se o preview da lista precisa virar o marcador (D-10).
  const { data: latestMessage } = await ctx.supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', message.conversation_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const isLastMessage = latestMessage?.id === message.id;

  if (!purge) {
    // Marca (§6 passo 7, primeiro apagamento desta mensagem).
    const { error: updateError } = await ctx.supabase
      .from('messages')
      .update({
        deleted_at: nowIso,
        deleted_by: ctx.userId,
        deletion_scope: deletionScopeFor(providerOutcome),
        deletion_actor: 'agent',
        deletion_error: providerError,
      })
      .eq('id', message.id);
    if (updateError) {
      console.error(
        '[inbox/messages/delete] mark update failed:',
        updateError.message
      );
      return NextResponse.json(
        { error: 'Failed to mark the message as deleted' },
        { status: 500 }
      );
    }

    const { error: logErr } = await admin.from('message_deletion_log').insert({
      account_id: ctx.accountId,
      conversation_id: message.conversation_id,
      message_id: message.id,
      provider_message_id: message.message_id ?? null,
      channel_id: channelId,
      channel_type: channelType,
      action: 'mark',
      provider_outcome: providerOutcome,
      provider_error: providerError,
      actor: 'agent',
      actor_user_id: ctx.userId,
      actor_role: ctx.role,
      content_type: message.content_type,
      content_preview: truncatePreview(message.content_text),
      had_media: !!message.media_path,
      media_path: message.media_path ?? null,
      media_removed: null,
      message_created_at: message.created_at,
    });
    if (logErr) {
      console.error(
        '[inbox/messages/delete] log insert failed:',
        logErr.message
      );
    }

    // SPEC 075 F3 — o caminho quente que motivou a SPEC inteira (§ Contexto).
    void recordActivity(ctx.supabase, {
      accountId: ctx.accountId,
      resourceType: 'message',
      action: 'message.deleted',
      resourceId: message.id,
      resourceLabel: truncatePreview(message.content_text),
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
      channelId,
      channelType,
      conversationId: message.conversation_id,
      contactId: conversation.contact_id,
      source: { table: 'message_deletion_log', id: message.id },
      metadata: { provider_outcome: providerOutcome },
    });

    if (isLastMessage) {
      await ctx.supabase
        .from('conversations')
        .update({ last_message_text: DELETED_PREVIEW_MARKER })
        .eq('id', message.conversation_id);
    }

    return NextResponse.json({
      ok: true,
      purged: false,
      provider_outcome: providerOutcome,
      ...(providerError ? { provider_error: providerError } : {}),
    });
  }

  // Exclusão do sistema (§6 passo 7, admin escolheu a opção 2 / D-14):
  // log PRIMEIRO — um DELETE que acontece antes do registro é um
  // apagamento sem rastro (mesma ordem canônica da SPEC 073) — depois a
  // mídia do bucket, por fim a linha de `messages`.
  const { data: insertedLog, error: logErr } = await admin
    .from('message_deletion_log')
    .insert({
      account_id: ctx.accountId,
      conversation_id: message.conversation_id,
      message_id: message.id,
      provider_message_id: message.message_id ?? null,
      channel_id: channelId,
      channel_type: channelType,
      action: 'purge',
      provider_outcome: providerOutcome,
      provider_error: providerError,
      actor: 'agent',
      actor_user_id: ctx.userId,
      actor_role: ctx.role,
      content_type: message.content_type,
      content_preview: truncatePreview(message.content_text),
      had_media: !!message.media_path,
      media_path: message.media_path ?? null,
      media_removed: null,
      message_created_at: message.created_at,
    })
    .select('id')
    .maybeSingle();
  if (logErr || !insertedLog) {
    console.error(
      '[inbox/messages/delete] purge log insert failed:',
      logErr?.message
    );
    return NextResponse.json(
      { error: 'Failed to record the deletion log' },
      { status: 500 }
    );
  }

  let mediaRemoved: boolean | null = null;
  if (message.media_path) {
    const { error: storageErr } = await admin.storage
      .from('chat-media')
      .remove([message.media_path]);
    mediaRemoved = !storageErr;
    if (storageErr) {
      console.error(
        '[inbox/messages/delete] media remove failed:',
        storageErr.message
      );
    }
    await admin
      .from('message_deletion_log')
      .update({ media_removed: mediaRemoved })
      .eq('id', insertedLog.id);
  }

  // A mídia falhando não bloqueia o pedido do admin — a falha fica
  // registrada (media_removed = false) em vez de travar a exclusão.
  const { error: delError } = await ctx.supabase
    .from('messages')
    .delete()
    .eq('id', message.id);
  if (delError) {
    console.error(
      '[inbox/messages/delete] purge delete failed:',
      delError.message
    );
    return NextResponse.json(
      { error: 'Failed to delete the message' },
      { status: 500 }
    );
  }

  // SPEC 075 F3 — depois do DELETE de propósito: `resource_id` sem FK
  // (§3.1) é exatamente para registrar um recurso que acabou de deixar
  // de existir.
  await recordActivity(ctx.supabase, {
    accountId: ctx.accountId,
    resourceType: 'message',
    action: 'message.purged',
    resourceId: message.id,
    resourceLabel: truncatePreview(message.content_text),
    actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
    channelId,
    channelType,
    conversationId: message.conversation_id,
    contactId: conversation.contact_id,
    source: { table: 'message_deletion_log', id: message.id },
    metadata: {
      provider_outcome: providerOutcome,
      media_removed: mediaRemoved,
    },
  });

  if (isLastMessage) {
    await ctx.supabase
      .from('conversations')
      .update({ last_message_text: DELETED_PREVIEW_MARKER })
      .eq('id', message.conversation_id);
  }

  return NextResponse.json({
    ok: true,
    purged: true,
    provider_outcome: providerOutcome,
    ...(providerError ? { provider_error: providerError } : {}),
  });
}
