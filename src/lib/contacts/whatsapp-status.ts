/**
 * Auto-limpeza de números mortos (SPEC 044 §6.4).
 *
 * Dois gatilhos independentes marcam `contacts.whatsapp_status =
 * 'invalid'`:
 *
 *   1. Um erro da Meta que já significa "este número não é WhatsApp"
 *      (código 131026, `isInvalidWhatsappNumberError`) — um único
 *      strike basta, a Meta já confirmou.
 *   2. Sem esse sinal, as DUAS tentativas de entrega mais recentes ao
 *      mesmo contato terem sido `failed` — uma heurística mais barata
 *      que pega números que a Meta não rotula claramente. "Recentes",
 *      não "no total": um contato que falhou duas vezes há seis meses
 *      e recebeu normalmente desde então não é um número morto.
 *
 * Chamado dos dois pontos que escrevem `broadcast_recipients.status =
 * 'failed'` — o envio síncrono (`broadcast-core.ts`) e o webhook
 * assíncrono de status da Meta (`app/api/whatsapp/webhook/route.ts`).
 * Best-effort: uma falha aqui nunca deve derrubar o envio ou o
 * processamento do webhook que a chamou, então erros só logam.
 *
 * Reversível a qualquer momento pela tela do contato
 * (`markWhatsappValid`) — ver `contact-detail-view.tsx`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isInvalidWhatsappNumberError } from '@/lib/whatsapp/phone-utils';

export type WhatsappStatusReason =
  'consecutive_failures' | 'meta_error' | 'manual' | 'qr_check';

/** Predicado sobre uma linha de contato já carregada. */
export function isWhatsappInvalid(contact: {
  whatsapp_status?: string | null;
}): boolean {
  return contact.whatsapp_status === 'invalid';
}

/**
 * Marca o contato como número morto. Não sobrescreve um motivo já
 * registrado — `.eq('whatsapp_status', 'valid')` faz o UPDATE não
 * casar nenhuma linha se o contato já estiver `invalid`, preservando o
 * motivo ORIGINAL (o primeiro é o que importa para quem decide
 * reativar).
 *
 * Best-effort: chamadores são caminhos de sistema (webhook, despacho)
 * que não podem falhar por causa disto.
 */
export async function markWhatsappInvalid(
  db: SupabaseClient,
  contactId: string,
  reason: WhatsappStatusReason
): Promise<void> {
  const { error } = await db
    .from('contacts')
    .update({
      whatsapp_status: 'invalid',
      whatsapp_status_reason: reason,
      whatsapp_status_updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .eq('whatsapp_status', 'valid');

  if (error) {
    console.error('[whatsapp-status] mark invalid failed:', error);
  }
}

/**
 * Reverte manualmente — a ação da tela do contato. Ao contrário de
 * {@link markWhatsappInvalid}, lança em erro: é uma ação do usuário e
 * o chamador mostra o toast.
 */
export async function markWhatsappValid(
  db: SupabaseClient,
  contactId: string
): Promise<void> {
  const { error } = await db
    .from('contacts')
    .update({
      whatsapp_status: 'valid',
      whatsapp_status_reason: 'manual',
      whatsapp_status_updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);

  if (error) throw error;
}

export interface DetectDeadNumberParams {
  contactId: string;
  /** Mensagem de erro da tentativa que acabou de falhar. */
  errorMessage?: string | null;
}

/**
 * Roda logo depois que uma linha de `broadcast_recipients` é marcada
 * `failed`. Ver o cabeçalho do arquivo para os dois gatilhos.
 */
export async function detectDeadNumberOnFailure(
  db: SupabaseClient,
  { contactId, errorMessage }: DetectDeadNumberParams
): Promise<void> {
  if (isInvalidWhatsappNumberError(errorMessage ?? '')) {
    await markWhatsappInvalid(db, contactId, 'meta_error');
    return;
  }

  // As duas tentativas mais recentes — não o histórico inteiro (essa é
  // a contagem vitalícia que a triagem já mostra como "problematic",
  // §5.1/§6.5). "Consecutivas" é o que distingue as duas.
  const { data, error } = await db
    .from('broadcast_recipients')
    .select('status')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(2);

  if (error) {
    console.error(
      '[whatsapp-status] consecutive-failure lookup failed:',
      error
    );
    return;
  }

  const rows = (data ?? []) as { status: string }[];
  if (rows.length === 2 && rows.every((r) => r.status === 'failed')) {
    await markWhatsappInvalid(db, contactId, 'consecutive_failures');
  }
}

/**
 * A Evolution vira a TERCEIRA fonte de `whatsapp_status` (SPEC 069 D-2).
 * Regras invioláveis:
 *
 *   1. `IsInWhatsapp: false` marca `invalid` com motivo `qr_check` —
 *      reusa {@link markWhatsappInvalid}, que já não sobrescreve um
 *      motivo existente (`.eq('whatsapp_status', 'valid')`).
 *   2. **A Evolution NUNCA reverte um `invalid` de outra fonte.** Não
 *      existe UPDATE de volta para `valid` neste caminho — só
 *      {@link markWhatsappValid} (ação de tela) faz isso.
 *   3. **Discordância é sinal, não decisão.** `IsInWhatsapp: true`
 *      contra um contato já `invalid` (por `meta_error` ou `manual`)
 *      não muda o status — grava `qr_check_conflict` em
 *      `whatsapp_check_note` (slug, não frase — a UI que traduz,
 *      mesma convenção de `whatsapp_status_reason`) e para aí. O
 *      número pode existir no WhatsApp e ainda assim não receber
 *      mensagem de negócio deste remetente; os dois fatos são
 *      compatíveis.
 *   4. **Proveniência sempre grava**, mudando o status ou não —
 *      `whatsapp_checked_at`/`whatsapp_checked_channel_id` respondem
 *      "quando, e por qual instância" mesmo quando o veredito não
 *      altera nada.
 *
 * Best-effort: chamado do cron de checagem (F5); uma falha aqui não
 * pode derrubar o lote inteiro por causa de UM contato.
 */
export async function applyQrCheckVerdict(
  db: SupabaseClient,
  params: {
    contactId: string;
    channelId: string;
    isInWhatsapp: boolean;
  }
): Promise<void> {
  const { contactId, channelId, isInWhatsapp } = params;

  try {
    const { data: contact, error: readError } = await db
      .from('contacts')
      .select('whatsapp_status')
      .eq('id', contactId)
      .maybeSingle();

    if (readError || !contact) {
      console.error(
        '[whatsapp-status] qr check verdict: contact lookup failed:',
        readError?.message ?? 'not found'
      );
      return;
    }

    const currentStatus = contact.whatsapp_status as string;
    const now = new Date().toISOString();

    if (!isInWhatsapp) {
      // Regra 1: só marca se ainda `valid` — markWhatsappInvalid já
      // faz a checagem condicional e preserva um motivo anterior.
      if (currentStatus === 'valid') {
        await markWhatsappInvalid(db, contactId, 'qr_check');
      }
      const { error } = await db
        .from('contacts')
        .update({
          whatsapp_checked_at: now,
          whatsapp_checked_channel_id: channelId,
        })
        .eq('id', contactId);
      if (error) {
        console.error('[whatsapp-status] provenance update failed:', error);
      }
      return;
    }

    // isInWhatsapp === true. Proveniência sempre grava — campos que
    // nenhum outro escritor toca, seguros como UPDATE incondicional.
    const { error } = await db
      .from('contacts')
      .update({
        whatsapp_checked_at: now,
        whatsapp_checked_channel_id: channelId,
      })
      .eq('id', contactId);
    if (error) {
      console.error('[whatsapp-status] provenance update failed:', error);
    }

    // ✅ Correção (code review): a nota de conflito decidia por
    // `currentStatus`, lido ANTES deste UPDATE — um envio falhando no
    // mesmo instante (`detectDeadNumberOnFailure`, que roda tanto no
    // envio síncrono quanto no webhook da Meta) podia virar o contato
    // para `invalid` bem no meio da janela entre a leitura e esta
    // escrita, e a nota saía calculada contra um status que já não
    // valia mais. Trocado por uma condição no WHERE — `.eq(...,
    // 'invalid')` — que só casa se o contato ESTIVER `invalid` no
    // instante exato desta escrita, não no instante da leitura lá em
    // cima. Regra 3 continua valendo: sem conflito agora, nada aqui
    // apaga uma nota antiga — o UPDATE simplesmente não casa nenhuma
    // linha.
    const { error: noteError } = await db
      .from('contacts')
      .update({ whatsapp_check_note: 'qr_check_conflict' })
      .eq('id', contactId)
      .eq('whatsapp_status', 'invalid');
    if (noteError) {
      console.error(
        '[whatsapp-status] conflict note update failed:',
        noteError
      );
    }
  } catch (err) {
    console.error('[whatsapp-status] qr check verdict failed:', err);
  }
}
