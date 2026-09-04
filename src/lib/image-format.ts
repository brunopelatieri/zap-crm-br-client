// ============================================================
// `detectImageSignature` — PNG/JPEG pelos MAGIC BYTES, nunca pelo
// campo declarado (MIME/extensão).
//
// Um MIME/extensão vem do bucket, da Meta ou de um provedor de
// terceiro e pode mentir (a armadilha da SPEC 040/`upload-media.ts`:
// o bucket compara `allowed_mime_types` como string literal). A única
// fonte que não mente é a assinatura dos primeiros bytes do arquivo.
//
// A mesma tabela de assinaturas existia, duplicada, em
// `src/lib/inbox/export/pdf.ts` (`detectEmbeddableImage`, SPEC 067) e
// `src/lib/evolution/avatar.ts` (`detectImageType`, SPEC 069) — achado
// de code review: as duas resolvem exatamente o mesmo problema pela
// mesma razão, e uma correção num dos dois lados (ex.: um bug no
// comprimento da assinatura) não teria propagado para o outro. Este
// módulo é a versão compartilhada; os dois call sites importam daqui.
// ============================================================

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function matchesSignature(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

/** `null` = nem PNG nem JPEG — o chamador decide o que fazer (recusar
 *  upload, tratar como não-embutível etc.), este módulo só identifica. */
export function detectImageSignature(
  bytes: Uint8Array | null
): 'jpeg' | 'png' | null {
  if (!bytes) return null;
  if (matchesSignature(bytes, JPEG_SIGNATURE)) return 'jpeg';
  if (matchesSignature(bytes, PNG_SIGNATURE)) return 'png';
  return null;
}
