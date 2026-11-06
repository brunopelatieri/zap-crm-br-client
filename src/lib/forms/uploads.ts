// ============================================================
// Uploads do visitante (SPEC 085 E-6, §8 item 7; PRD 084 R-3).
//
// Allowlist DUPLA (MIME e extensão), tamanho por tipo, caminho dentro
// do bucket privado `form-uploads` e conferência do objeto depois do
// upload direto. O arquivo não passa pelo Node: a rota valida AQUI,
// assina a URL de upload, e no envio confere que o objeto existe com o
// tamanho declarado.
//
// A allowlist de MIME é a MESMA de `allowed_mime_types` do bucket (097):
// o Storage compara a string literal, então `baseMimeType` tira o
// parâmetro (`;codecs=…`) antes de qualquer comparação (armadilha da
// SPEC §14).
// ============================================================

import { baseMimeType } from '@/lib/storage/upload-media';

import type { FieldValidation } from './types';

export const FORM_UPLOADS_BUCKET = 'form-uploads';
export const FORM_MEDIA_BUCKET = 'form-media';

/** Teto do bucket `form-uploads` (097): 16 MB. */
export const FORM_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
/** Teto do bucket `form-media` (097): 5 MB. */
export const FORM_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export type UploadKind = 'image' | 'document' | 'audio' | 'video';

/** Teto por tipo, como `MEDIA_MAX_BYTES_BY_KIND` do chat. */
export const FORM_UPLOAD_MAX_BYTES_BY_KIND: Record<UploadKind, number> = {
  image: 5 * 1024 * 1024,
  document: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
};

/** MIME → extensões aceitas (minúsculas, sem ponto). Igual ao bucket. */
export const FORM_UPLOAD_ALLOWED: Readonly<
  Record<string, { kind: UploadKind; extensions: readonly string[] }>
> = {
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'] },
  'image/png': { kind: 'image', extensions: ['png'] },
  'image/webp': { kind: 'image', extensions: ['webp'] },
  'application/pdf': { kind: 'document', extensions: ['pdf'] },
  'application/msword': { kind: 'document', extensions: ['doc'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'document',
    extensions: ['docx'],
  },
  'application/vnd.ms-excel': { kind: 'document', extensions: ['xls'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'document',
    extensions: ['xlsx'],
  },
  'text/plain': { kind: 'document', extensions: ['txt'] },
  'text/csv': { kind: 'document', extensions: ['csv'] },
  'audio/mpeg': { kind: 'audio', extensions: ['mp3'] },
  'audio/ogg': { kind: 'audio', extensions: ['ogg', 'oga', 'opus'] },
  'video/mp4': { kind: 'video', extensions: ['mp4', 'm4v'] },
};

export const FORM_UPLOAD_ALLOWED_MIMES: readonly string[] =
  Object.keys(FORM_UPLOAD_ALLOWED);

/** `form-media` (construtor): só imagem. */
export const FORM_MEDIA_ALLOWED_MIMES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

export type UploadRejectReason =
  | 'invalid_name'
  | 'file_type_not_allowed'
  | 'extension_mismatch'
  | 'file_too_large'
  | 'accept_not_allowed';

export type UploadValidation =
  | {
      ok: true;
      mime: string;
      ext: string;
      kind: UploadKind;
      size: number;
      maxBytes: number;
    }
  | { ok: false; reason: UploadRejectReason; maxBytes?: number };

export interface UploadRequest {
  name: string;
  mime: string;
  size: number;
}

const FILE_NAME_MAX = 180;

export function fileExtension(name: string): string | null {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Valida o pedido ANTES de assinar a URL (§7.2 `upload-url`). A ordem é
 * nome → MIME → extensão → tamanho, porque é a ordem em que cada erro
 * é mais barato e mais claro. `field.validation.accept` restringe ainda
 * mais a allowlist (nunca a amplia).
 */
export function validateUploadRequest(
  req: UploadRequest,
  field?: Pick<FieldValidation, 'accept'> | null
): UploadValidation {
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  if (!name || name.length > FILE_NAME_MAX || /[\\/\u0000-\u001f]/.test(name)) {
    return { ok: false, reason: 'invalid_name' };
  }

  const mime = baseMimeType(req.mime);
  const allowed = mime ? FORM_UPLOAD_ALLOWED[mime] : undefined;
  if (!mime || !allowed) return { ok: false, reason: 'file_type_not_allowed' };

  if (field?.accept?.length) {
    const accept = new Set(
      field.accept.map((m) => baseMimeType(m)).filter(Boolean) as string[]
    );
    // `accept` fora da allowlist global não libera nada a mais.
    if (!accept.has(mime)) return { ok: false, reason: 'accept_not_allowed' };
  }

  const ext = fileExtension(name);
  if (!ext || !allowed.extensions.includes(ext)) {
    return { ok: false, reason: 'extension_mismatch' };
  }

  const maxBytes = Math.min(
    FORM_UPLOAD_MAX_BYTES,
    FORM_UPLOAD_MAX_BYTES_BY_KIND[allowed.kind]
  );
  const size = Number(req.size);
  if (!Number.isInteger(size) || size <= 0 || size > maxBytes) {
    return { ok: false, reason: 'file_too_large', maxBytes };
  }

  return { ok: true, mime, ext, kind: allowed.kind, size, maxBytes };
}

/** Só os MIME de `accept` que a allowlist global conhece (para o construtor). */
export function normalizeAccept(
  accept: readonly string[] | undefined
): string[] {
  if (!accept) return [];
  const out: string[] = [];
  for (const raw of accept) {
    const mime = baseMimeType(raw);
    if (mime && FORM_UPLOAD_ALLOWED[mime] && !out.includes(mime))
      out.push(mime);
  }
  return out;
}

export interface UploadPathParts {
  accountId: string;
  formId: string;
  responseId: string;
  ext: string;
  /** Injetável para teste; padrão `crypto.randomUUID()`. */
  objectId?: string;
}

/**
 * `account-<uuid>/<form_id>/<response_id>/<uuid>.<ext>` (SPEC §5.1). O
 * primeiro segmento é o que a policy de leitura do bucket confere; o
 * terceiro é o que a varredura usa para achar órfãos.
 */
export function buildUploadPath(parts: UploadPathParts): string {
  const id = parts.objectId ?? globalThis.crypto.randomUUID();
  return `account-${parts.accountId}/${parts.formId}/${parts.responseId}/${id}.${parts.ext}`;
}

/** `account-<uuid>/<form_id>/<uuid>.<ext>` no bucket `form-media`. */
export function buildFormMediaPath(parts: {
  accountId: string;
  formId: string;
  ext: string;
  objectId?: string;
}): string {
  const id = parts.objectId ?? globalThis.crypto.randomUUID();
  return `account-${parts.accountId}/${parts.formId}/${id}.${parts.ext}`;
}

const UPLOAD_PATH_PATTERN =
  /^account-([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.([a-z0-9]{1,8})$/;

/** Decompõe um caminho de `form-uploads`; `null` se fora da convenção. */
export function parseUploadPath(path: string): {
  accountId: string;
  formId: string;
  responseId: string;
  objectId: string;
  ext: string;
} | null {
  const m = UPLOAD_PATH_PATTERN.exec(path);
  if (!m) return null;
  return {
    accountId: m[1],
    formId: m[2],
    responseId: m[3],
    objectId: m[4],
    ext: m[5],
  };
}

/** O caminho pertence a esta conta/formulário/resposta? */
export function uploadPathBelongsTo(
  path: string,
  scope: { accountId: string; formId: string; responseId: string }
): boolean {
  const parsed = parseUploadPath(path);
  return (
    !!parsed &&
    parsed.accountId === scope.accountId &&
    parsed.formId === scope.formId &&
    parsed.responseId === scope.responseId
  );
}

/** Subconjunto do Storage que a conferência usa — injetável em teste. */
export interface StorageLister {
  from(bucket: string): {
    list(
      prefix: string,
      opts?: { limit?: number; search?: string }
    ): PromiseLike<{
      data: Array<{ name: string; metadata?: { size?: number } | null }> | null;
      error: { message: string } | null;
    }>;
  };
}

export type VerifyUploadedObjectResult =
  | { ok: true; size: number }
  | { ok: false; reason: 'not_found' | 'size_mismatch' | 'storage_error' };

/**
 * Confere, no envio, que o objeto assinado foi mesmo enviado e com o
 * tamanho declarado (E-6). `list` no prefixo da resposta com `search`
 * pelo nome do objeto — o Storage não tem `HEAD` autenticado por
 * service-role que devolva só o tamanho.
 */
export async function verifyUploadedObject(
  storage: StorageLister,
  path: string,
  expectedSize: number
): Promise<VerifyUploadedObjectResult> {
  const slash = path.lastIndexOf('/');
  const prefix = slash === -1 ? '' : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);

  const { data, error } = await storage
    .from(FORM_UPLOADS_BUCKET)
    .list(prefix, { limit: 100, search: name });
  if (error) return { ok: false, reason: 'storage_error' };

  const obj = data?.find((o) => o.name === name);
  if (!obj) return { ok: false, reason: 'not_found' };

  const size = Number(obj.metadata?.size ?? NaN);
  if (!Number.isFinite(size) || size !== expectedSize) {
    return { ok: false, reason: 'size_mismatch' };
  }
  return { ok: true, size };
}
