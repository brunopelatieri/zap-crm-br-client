/**
 * Teto do corpo do webhook da Meta (achado M-1 da revisão da SPEC 088).
 * A Meta documenta payload de até 3 MB; 4 MiB deixa folga sem abrir mão
 * do limite. A rota está fora do matcher do middleware, então nenhum teto
 * do Next vale para ela.
 */
export const META_WEBHOOK_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Lê o corpo como texto, recusando com `null` o que passar de `maxBytes`:
 * antes de ler, se o `content-length` declarado já passa do teto; e
 * durante a leitura, contando os bytes que chegam de fato (um
 * `content-length` ausente ou mentiroso não burla o limite).
 *
 * O texto é EXATAMENTE o que `request.text()` devolveria — o HMAC da Meta
 * e o `rawBody` do repetidor dependem disso. Por isso a decodificação é a
 * do próprio runtime (`Response.text()`), sobre os bytes já reunidos: BOM
 * e UTF-8 inválido têm o mesmo tratamento de antes, e um caractere
 * partido entre dois chunks não se corrompe.
 *
 * Como em `request.text()`, erro de leitura (conexão caída) é lançado.
 */
export async function readTextWithLimit(
  request: Request,
  maxBytes: number
): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return null;

  if (!request.body) return '';

  const reader = request.body.getReader();
  // Um buffer que cresce, não uma lista de chunks: milhões de chunks de um
  // byte caberiam no teto e custariam centenas de MB em objetos.
  let bytes = new Uint8Array(64 * 1024);
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = total + value.byteLength;
    if (next > maxBytes) {
      // Sem `await`: o cancelamento depende do emissor e não pode segurar
      // a resposta.
      void reader.cancel().catch(() => {});
      return null;
    }
    if (next > bytes.byteLength) {
      const grown = new Uint8Array(
        Math.min(maxBytes, Math.max(next, bytes.byteLength * 2))
      );
      grown.set(bytes.subarray(0, total));
      bytes = grown;
    }
    bytes.set(value, total);
    total = next;
  }
  return new Response(bytes.subarray(0, total)).text();
}
