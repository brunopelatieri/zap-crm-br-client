/**
 * Revogação vinda do CONTATO (SPEC 074 §9) — simetria com o botão
 * "Apagar" do agente: se o cliente apaga a mensagem DELE, o CRM marca e
 * registra, em vez de continuar exibindo o texto original para sempre.
 *
 * Compartilhado pelos dois webhooks (`whatsapp/webhook/route.ts` e
 * `channels/evolution/webhook/[secret]/route.ts`) — cada um traduz o
 * formato do próprio provedor e chama isto com o id da mensagem NO
 * PROVEDOR; a decisão de banco (localizar, guardar, marcar, logar) mora
 * aqui uma vez só.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { truncatePreview } from './delete';
import { recordActivity } from '@/lib/activity/record';

interface RevokeTargetRow {
  id: string;
  conversation_id: string;
  channel_id: string | null;
  content_type: string;
  content_text: string | null;
  media_path: string | null;
  created_at: string;
  deleted_at: string | null;
  // PostgREST tipa o embed como array ou objeto único conforme o
  // relacionamento inferido — o `!inner` aqui é 1:1, mas o cliente
  // genérico (sem tipos gerados) não garante a forma em compile-time.
  conversations:
    | { account_id: string; channel_id: string | null; contact_id: string }
    | { account_id: string; channel_id: string | null; contact_id: string }[]
    | null;
}

function channelIdOf(row: RevokeTargetRow): string | null {
  const conversationRow = Array.isArray(row.conversations)
    ? row.conversations[0]
    : row.conversations;
  return row.channel_id ?? conversationRow?.channel_id ?? null;
}

function contactIdOf(row: RevokeTargetRow): string | null {
  const conversationRow = Array.isArray(row.conversations)
    ? row.conversations[0]
    : row.conversations;
  return conversationRow?.contact_id ?? null;
}

/**
 * `messages.message_id` NÃO é único (migração 009) — por isso a busca é
 * escopada por CONTA via o join com `conversations`, e todo achado é
 * processado (não só o primeiro).
 *
 * Guarda §9.3.1: se a linha JÁ tem `deleted_at`, a gravação é pulada —
 * a primeira vence, para que o eco da nossa própria revogação (agente)
 * nunca reescreva `deletion_actor` para 'contact'.
 */
export async function markRevokedByContact(
  db: SupabaseClient,
  accountId: string,
  providerMessageId: string
): Promise<void> {
  if (!providerMessageId) return;

  const { data: rows, error } = await db
    .from('messages')
    .select(
      'id, conversation_id, channel_id, content_type, content_text, media_path, created_at, deleted_at, conversations!inner(account_id, channel_id, contact_id)'
    )
    .eq('message_id', providerMessageId)
    .eq('conversations.account_id', accountId);

  if (error) {
    console.error('[revoke-by-contact] lookup failed:', error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  // Guarda §9.3.1 primeiro — só o que de fato vai ser marcado precisa do
  // resto do trabalho (canal, log).
  const targets = (rows as RevokeTargetRow[]).filter((row) => !row.deleted_at);
  if (targets.length === 0) return;

  // Resolve TODOS os canais de uma vez, não um `SELECT` por linha —
  // achado de code review: `message_id` não é único, e várias linhas do
  // mesmo lote (o mesmo evento de revogação pode casar mais de uma)
  // muito provavelmente compartilham o mesmo canal.
  const channelIds = [
    ...new Set(targets.map(channelIdOf).filter((id): id is string => !!id)),
  ];
  const channelTypeById = new Map<string, string>();
  if (channelIds.length > 0) {
    const { data: channelRows } = await db
      .from('channels')
      .select('id, type')
      .in('id', channelIds);
    for (const c of channelRows ?? []) {
      channelTypeById.set(c.id as string, c.type as string);
    }
  }

  for (const row of targets) {
    const { error: updateError } = await db
      .from('messages')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: null,
        deletion_scope: 'revoked',
        deletion_actor: 'contact',
      })
      .eq('id', row.id)
      .is('deleted_at', null);
    if (updateError) {
      console.error('[revoke-by-contact] update failed:', updateError.message);
      continue;
    }

    const channelId = channelIdOf(row);
    const channelType = channelId
      ? (channelTypeById.get(channelId) ?? null)
      : null;
    // SPEC 075 F3 — o único caso de ator 'contact' do catálogo. `db`
    // aqui é sempre um cliente de service-role (o chamador é um
    // webhook), o mesmo que grava `message_deletion_log` abaixo.
    const contactId = contactIdOf(row);

    // As duas escritas abaixo são auditoria independente uma da outra
    // (nenhuma lê o resultado da outra) — rodam em paralelo em vez de
    // sequenciais, porque isto roda no caminho de resposta de um
    // webhook inbound e cada linha de `targets` já soma duas idas ao
    // banco.
    const [logResult, activityResult] = await Promise.allSettled([
      db.from('message_deletion_log').insert({
        account_id: accountId,
        conversation_id: row.conversation_id,
        message_id: row.id,
        provider_message_id: providerMessageId,
        channel_id: channelId,
        channel_type: channelType,
        action: 'mark',
        // Não houve endpoint NOSSO a disparar — foi o contato quem apagou.
        provider_outcome: 'not_attempted',
        provider_error: null,
        actor: 'contact',
        actor_user_id: null,
        actor_role: null,
        content_type: row.content_type,
        content_preview: truncatePreview(row.content_text),
        had_media: !!row.media_path,
        media_path: row.media_path,
        media_removed: null,
        message_created_at: row.created_at,
      }),
      recordActivity(db, {
        accountId,
        resourceType: 'message',
        action: 'message.deleted_by_contact',
        resourceId: row.id,
        resourceLabel: truncatePreview(row.content_text),
        actor: contactId
          ? { kind: 'contact', contactId }
          : { kind: 'system', name: 'webhook' },
        channelId,
        channelType: (channelType as 'whatsapp_cloud' | 'whatsapp_qr') ?? null,
        conversationId: row.conversation_id,
        contactId,
        // `source_id` aqui é `messages.id` (não o PK da linha de log que
        // acabou de ser inserida, que este loop não captura de volta) —
        // é a chave que "ver detalhes" usa para filtrar
        // `message_deletion_log.message_id`, o suficiente para achar o
        // registro.
        source: { table: 'message_deletion_log', id: row.id },
      }),
    ]);

    if (logResult.status === 'rejected') {
      console.error('[revoke-by-contact] log insert threw:', logResult.reason);
    } else if (logResult.value.error) {
      console.error(
        '[revoke-by-contact] log insert failed:',
        logResult.value.error.message
      );
    }
    if (activityResult.status === 'rejected') {
      // `recordActivity` nunca lança pelo próprio contrato — defensivo,
      // caso isso mude no futuro.
      console.error(
        '[revoke-by-contact] recordActivity threw:',
        activityResult.reason
      );
    }
  }
}
