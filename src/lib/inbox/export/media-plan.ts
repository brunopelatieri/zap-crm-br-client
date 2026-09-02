/**
 * Plano de mídia da exportação de conversa (SPEC 067 §4). Puro — decide
 * o nome de cada arquivo dentro do `.zip` ANTES de qualquer byte ser
 * baixado, para que o PDF possa citar o caminho e o manifesto conferir.
 *
 * O nome dentro do zip (`zipPath`) é só código: índice cronológico +
 * tipo + hex do id da mensagem, nunca texto do usuário — é por isso que
 * ele não precisa da mesma sanitização de `deriveMediaFilename`
 * (`displayName`, o nome "reconhecível", é o que carrega esse risco).
 */

import type { MediaRef } from '@/lib/storage/media-url';
import { guessExtensionFromRef } from './model';
import type { TranscriptAttachment, TranscriptBlock } from './model';

export interface MediaPlanEntry {
  /** 1-based, ordem cronológica. */
  index: number;
  messageId: string;
  ref: MediaRef;
  contentType: TranscriptAttachment['contentType'];
  /** Caminho dentro do zip: `midias/0007-imagem-3f2a1b9c.jpg` */
  zipPath: string;
  displayName: string;
  /** `created_at` da mensagem (ISO) — `mtime` da entrada no zip. */
  createdAt: string;
  /** Canal dono da mídia — a credencial do download `proxy` sai dele. */
  channelId: string | null;
  /** Mensagens que apontam para o MESMO objeto (encaminhamento). */
  duplicateOfIndex: number | null;
}

const ZIP_INDEX_DIGITS = 4;
const SHORT_HEX_LENGTH = 8;

function shortHex(messageId: string): string {
  const hex = messageId.replace(/[^a-f0-9]/gi, '').toLowerCase();
  const padded =
    hex.length >= SHORT_HEX_LENGTH ? hex : hex.padEnd(SHORT_HEX_LENGTH, '0');
  return padded.slice(0, SHORT_HEX_LENGTH);
}

function mediaDedupeKey(ref: MediaRef): string | null {
  switch (ref.kind) {
    case 'storage':
      return `storage:${ref.bucket}:${ref.path}`;
    case 'proxy':
      return `proxy:${ref.mediaId}`;
    case 'external':
      return `external:${ref.url}`;
    case 'none':
      return null;
  }
}

export function buildMediaPlan(blocks: TranscriptBlock[]): MediaPlanEntry[] {
  const entries: MediaPlanEntry[] = [];
  const firstIndexByKey = new Map<string, number>();
  const zipPathByIndex = new Map<number, string>();

  let index = 0;
  for (const block of blocks) {
    if (block.kind !== 'bubble') continue;
    const attachment = block.bubble.attachment;
    if (!attachment || attachment.ref.kind === 'none') continue;

    index += 1;
    const key = mediaDedupeKey(attachment.ref);
    const duplicateOfIndex = key ? (firstIndexByKey.get(key) ?? null) : null;

    const zipPath = duplicateOfIndex
      ? (zipPathByIndex.get(duplicateOfIndex) ?? '')
      : `midias/${String(index).padStart(ZIP_INDEX_DIGITS, '0')}-${attachment.contentType}-${shortHex(attachment.messageId)}.${guessExtensionFromRef(attachment.ref)}`;

    entries.push({
      index,
      messageId: attachment.messageId,
      ref: attachment.ref,
      contentType: attachment.contentType,
      zipPath,
      displayName: attachment.displayName,
      createdAt: attachment.createdAt,
      channelId: attachment.channelId,
      duplicateOfIndex,
    });

    zipPathByIndex.set(index, zipPath);
    if (key && duplicateOfIndex === null) {
      firstIndexByKey.set(key, index);
    }
  }

  return entries;
}
