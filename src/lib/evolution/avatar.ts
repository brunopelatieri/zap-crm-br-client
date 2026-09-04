/**
 * Avatar trazido pela instância QRCode (SPEC 069 §4.8, D-12/D-13/D-14 #4).
 *
 * Detecção pelos BYTES, nunca por campo declarado
 *
 *   A armadilha já é conhecida (SPEC 040/`upload-media.ts`): o bucket
 *   compara `allowed_mime_types` como STRING LITERAL, e nem `/user/
 *   avatar` (D-14 #4, não confirmado) nem nenhum provedor de terceiro é
 *   confiável quanto ao mimetype que diz ter. A única fonte que não
 *   mente é a assinatura dos primeiros bytes do arquivo.
 *
 * Caminho `account-<uuid>/contact-<uuid>.<ext>`
 *
 *   O primeiro segmento (`account-<uuid>`) é o que a policy de leitura
 *   da migração 078 casa (mesma convenção de `chat-media`/`flow-media`
 *   desde a 040) — um caminho fora dessa forma faz a policy negar a
 *   linha em vez de vazar para outra conta (a correção que a F1 já fez
 *   na própria policy, ver migração 078 §7). `contact-<uuid>` (não o
 *   `Jid`) porque o path não pode carregar dado pessoal em texto claro
 *   nem depender de um valor que o WhatsApp pode reatribuir.
 *
 * TTL (D-13): busca quando ausente ou vencido, não a cada checagem
 *
 *   Buscar o avatar a cada ciclo transformaria "reprocessar a lista"
 *   numa segunda rajada de requisições — e a maioria das buscas não
 *   traria nada novo (foto de perfil muda raramente). `shouldFetchAvatar`
 *   é a única decisão: ausente, ou mais velho que o TTL.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { detectImageSignature } from '@/lib/image-format';
import type { EvolutionConfig } from './config';
import { fetchWhatsappAvatar } from './user';

export type DetectedImageType = 'png' | 'jpeg';

/**
 * Assinatura dos primeiros bytes. `null` = não é PNG nem JPEG — o
 * chamador recusa o upload (o bucket só aceita esses dois, migração
 * 078 §7), não tenta adivinhar por extensão nem por campo declarado.
 *
 * A detecção em si mora em `@/lib/image-format`, compartilhada com o
 * exportador de PDF (achado de code review: as duas tinham a mesma
 * tabela de assinaturas duplicada).
 */
export function detectImageType(bytes: Uint8Array): DetectedImageType | null {
  return detectImageSignature(bytes);
}

export function extensionForImageType(type: DetectedImageType): string {
  return type === 'png' ? 'png' : 'jpg';
}

export function mimeTypeForImageType(type: DetectedImageType): string {
  return type === 'png' ? 'image/png' : 'image/jpeg';
}

/**
 * D-13: buscar quando ausente, ou quando `fetchedAt` for mais velho
 * que `ttlDays`. `null` (nunca buscado) sempre busca.
 */
export function shouldFetchAvatar(
  fetchedAt: Date | null,
  ttlDays: number,
  now: Date = new Date()
): boolean {
  if (!fetchedAt) return true;
  const ageMs = now.getTime() - fetchedAt.getTime();
  return ageMs > ttlDays * 86_400_000;
}

/**
 * O caminho dentro do bucket `contact-avatars` — casa com a policy de
 * leitura da migração 078 (primeiro segmento `account-<uuid>`).
 */
export function buildAvatarPath(
  accountId: string,
  contactId: string,
  type: DetectedImageType
): string {
  return `account-${accountId}/contact-${contactId}.${extensionForImageType(type)}`;
}

export type AvatarRejectionReason =
  'invalid_base64' | 'unsupported_type' | 'too_large';

export interface DecodedAvatar {
  bytes: Buffer;
  type: DetectedImageType;
  mimeType: string;
}

export type DecodeAvatarResult =
  | { ok: true; avatar: DecodedAvatar }
  | { ok: false; reason: AvatarRejectionReason };

/**
 * Base64 → bytes → tipo → tamanho, nesta ordem: decodificar primeiro
 * (para poder inspecionar os bytes), tipo antes de tamanho (um arquivo
 * de tipo errado é descartado sem gastar a checagem de tamanho, que é
 * mais cara de justificar no log). Puro: não toca bucket nem banco —
 * `uploadContactAvatar` (impuro) é quem chama isto antes de subir.
 */
export function decodeAvatar(
  base64: string,
  maxBytes: number
): DecodeAvatarResult {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return { ok: false, reason: 'invalid_base64' };
  }
  // `Buffer.from` com base64 inválido não lança — devolve o que
  // conseguiu decodificar até travar. Base64 vazio ou lixo puro produz
  // um buffer vazio ou minúsculo, que a checagem de assinatura abaixo
  // já rejeita como tipo desconhecido; nenhum caso extra necessário.
  if (bytes.length === 0) return { ok: false, reason: 'invalid_base64' };

  const type = detectImageType(bytes);
  if (!type) return { ok: false, reason: 'unsupported_type' };

  if (bytes.length > maxBytes) return { ok: false, reason: 'too_large' };

  return {
    ok: true,
    avatar: { bytes, type, mimeType: mimeTypeForImageType(type) },
  };
}

// ------------------------------------------------------------
// A metade IMPURA: busca na Evolution, decodifica, sobe, grava.
// ------------------------------------------------------------

/**
 * Busca o avatar via `/user/avatar`, decodifica pelos bytes, sobe no
 * bucket `contact-avatars` e atualiza o contato. NUNCA lança — é
 * sempre best-effort, chamada depois de um veredito já aplicado
 * (`check-run.ts`) ou depois de uma promoção já concluída
 * (`/api/evolution/harvested/promote`): uma falha aqui não pode
 * desfazer o que já foi decidido antes dela.
 *
 * Compartilhado entre os dois chamadores de propósito — é a MESMA
 * sequência (buscar → decodificar → subir → gravar), e um segundo
 * lugar reimplementando-a é como o D-14 #4 (tipo declarado vs. bytes
 * reais) volta a vazar: um dos dois esqueceria de checar a assinatura.
 */
export async function fetchAndAttachAvatar(
  db: SupabaseClient,
  config: EvolutionConfig,
  params: {
    accountId: string;
    contactId: string;
    phoneNormalized: string;
    instanceToken: string;
    timeoutMs: number;
    maxBytes: number;
  }
): Promise<boolean> {
  try {
    const avatar = await fetchWhatsappAvatar(
      config,
      params.instanceToken,
      params.phoneNormalized,
      { timeoutMs: params.timeoutMs }
    );
    if (!avatar) return false; // contato sem foto — não é erro.

    const decoded = decodeAvatar(avatar.base64, params.maxBytes);
    if (!decoded.ok) {
      console.warn(
        `[avatar] avatar rejeitado para contato ${params.contactId}: ${decoded.reason}`
      );
      return false;
    }

    const path = buildAvatarPath(
      params.accountId,
      params.contactId,
      decoded.avatar.type
    );
    const { error: uploadError } = await db.storage
      .from('contact-avatars')
      .upload(path, decoded.avatar.bytes, {
        contentType: decoded.avatar.mimeType,
        upsert: true,
      });
    if (uploadError) {
      console.error('[avatar] upload failed:', uploadError.message);
      return false;
    }

    const { error: updateError } = await db
      .from('contacts')
      .update({
        avatar_path: path,
        avatar_source: 'whatsapp_qr',
        avatar_fetched_at: new Date().toISOString(),
      })
      .eq('id', params.contactId);
    if (updateError) {
      console.error(
        '[avatar] contact avatar_path update failed:',
        updateError.message
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error('[avatar] fetch failed:', err);
    return false;
  }
}
