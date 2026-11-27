import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

import { IngestError } from './errors';
import { htmlToText } from './html-to-text';
import {
  MAX_DOCUMENT_CHARS,
  MAX_URL_BODY_BYTES,
  MAX_URL_REDIRECTS,
  URL_FETCH_TIMEOUT_MS,
} from './limits';

// ============================================================
// Importar URL (SPEC 089 D-8). O servidor faz a requisição a um endereço
// que o usuário digitou: é um primitivo de SSRF, então:
//
//   - só http/https, sem usuário e senha na URL;
//   - `isDeliverableUrl` ANTES de cada requisição (resolve o host e recusa
//     loopback, rede privada, link-local, metadados de nuvem…);
//   - `redirect: 'manual'`: um 3xx nunca é seguido pelo `fetch`. Seguimos
//     à mão, no máximo `MAX_URL_REDIRECTS` saltos, e CADA salto passa de
//     novo pela guarda (senão uma página pública redirecionaria para
//     `http://169.254.169.254/`);
//   - prazo de 10 s no total, só `text/html` e `text/plain`, corpo
//     lido em fluxo e cortado em 2 MB.
//
// Risco residual (documentado em `webhooks/ssrf.ts`): DNS rebinding.
// ============================================================

export interface ExtractedText {
  title: string | null;
  text: string;
  mimeType: string;
}

export interface UrlExtraction extends ExtractedText {
  /** URL final (depois dos redirecionamentos), sem credenciais. */
  finalUrl: string;
}

const USER_AGENT = 'ZapCRM-KnowledgeImporter/1.0';

type FetchFn = typeof fetch;

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new IngestError('invalid_url', 'The URL is not valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IngestError(
      'invalid_url',
      'Only http and https URLs are accepted.'
    );
  }
  if (url.username || url.password) {
    throw new IngestError(
      'invalid_url',
      'URLs with credentials are not accepted.'
    );
  }
  return url;
}

/** Lê o corpo em fluxo e para (erro) quando passa de `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new IngestError('url_too_large', 'The page is larger than 2 MB.');
  }
  if (!res.body) return new Uint8Array();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new IngestError('url_too_large', 'The page is larger than 2 MB.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  let charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? '';
  if (!charset) {
    // `<meta charset>` nos primeiros bytes (sem decodificar a página toda duas vezes).
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() ?? '';
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Baixa a página e devolve o texto principal. Lança `IngestError`.
 * `fetchFn` existe para teste; produção usa o `fetch` global.
 */
export async function extractUrlText(
  rawUrl: string,
  fetchFn: FetchFn = fetch
): Promise<UrlExtraction> {
  let url = parseHttpUrl(rawUrl);
  const deadline = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS);

  for (let hop = 0; hop <= MAX_URL_REDIRECTS; hop++) {
    if (!(await isDeliverableUrl(url.toString()))) {
      throw new IngestError(
        'url_blocked',
        'This address is not allowed (internal, private or unresolvable host).'
      );
    }

    let res: Response;
    try {
      res = await fetchFn(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: deadline,
        headers: {
          Accept: 'text/html,text/plain;q=0.9',
          'User-Agent': USER_AGENT,
        },
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        throw new IngestError(
          'url_timeout',
          'The page took more than 10 seconds to respond.'
        );
      }
      throw new IngestError('url_unreachable', 'Could not reach the page.');
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) {
        throw new IngestError(
          'url_bad_status',
          `The page answered ${res.status} without a destination.`
        );
      }
      try {
        url = parseHttpUrl(new URL(location, url).toString());
      } catch {
        throw new IngestError(
          'url_blocked',
          'The page redirects to an address that is not allowed.'
        );
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new IngestError(
        'url_bad_status',
        `The page answered ${res.status}.`
      );
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const isHtml = contentType.startsWith('text/html');
    const isPlain = contentType.startsWith('text/plain');
    if (!isHtml && !isPlain) {
      await res.body?.cancel().catch(() => {});
      throw new IngestError(
        'url_unsupported_content_type',
        'Only HTML and plain-text pages can be imported.'
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res, MAX_URL_BODY_BYTES);
    } catch (err) {
      if (err instanceof IngestError) throw err;
      if (
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        throw new IngestError(
          'url_timeout',
          'The page took more than 10 seconds to respond.'
        );
      }
      throw new IngestError('url_unreachable', 'Could not read the page.');
    }

    const raw = decodeBody(bytes, contentType);
    const { title, text } = isHtml
      ? htmlToText(raw)
      : { title: null, text: raw.replace(/\r\n/g, '\n').trim() };

    if (!text) {
      throw new IngestError('empty_text', 'The page has no readable text.');
    }
    if (text.length > MAX_DOCUMENT_CHARS) {
      throw new IngestError(
        'text_too_long',
        'The page text is over 500,000 characters.'
      );
    }

    url.hash = '';
    return {
      title,
      text,
      mimeType: isHtml ? 'text/html' : 'text/plain',
      finalUrl: url.toString(),
    };
  }

  throw new IngestError(
    'url_too_many_redirects',
    'The page redirects too many times.'
  );
}
