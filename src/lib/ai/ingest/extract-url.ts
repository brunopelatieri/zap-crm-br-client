import {
  safeRequest,
  SafeRequestError,
  type SafeRequestDeps,
  type SafeRequestInput,
  type SafeResponse,
} from '@/lib/http/safe-request';

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
// que o usuário digitou: é um primitivo de SSRF, então a requisição sai pelo
// MESMO transporte da ferramenta HTTP (`safeRequest`, `src/lib/http/`):
//
//   - só http/https, sem usuário e senha na URL, só as portas 80, 443, 8080
//     e 8443;
//   - `isDeliverableUrl` antes (recusa clara, sem abrir socket) e, o que
//     fecha o DNS rebinding, o endereço é validado NA CONEXÃO: o socket só
//     conecta ao IP que passou pela checagem (um nome que responde IP público
//     e depois 127.0.0.1 não alcança serviço interno);
//   - `redirect: 'return'`: um 3xx nunca é seguido pelo transporte. Seguimos
//     à mão, no máximo `MAX_URL_REDIRECTS` saltos, e CADA salto passa de
//     novo por toda a guarda (senão uma página pública redirecionaria para
//     `http://169.254.169.254/`);
//   - prazo de 10 s no total (resolução de nome incluída), só `text/html` e
//     `text/plain`, corpo lido em fluxo e cortado em 2 MB.
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

/** O transporte; `safeRequest` em produção, um dublê nos testes. */
export type UrlRequestFn = (
  input: SafeRequestInput,
  deps?: SafeRequestDeps
) => Promise<SafeResponse>;

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

const TIMEOUT_MESSAGE = 'The page took more than 10 seconds to respond.';

/** Erro do transporte → erro de ingestão (código estável, sem corpo nem URL). */
function mapTransportError(err: unknown): IngestError {
  if (err instanceof SafeRequestError) {
    switch (err.code) {
      case 'blocked_url':
      case 'blocked_port':
        return new IngestError(
          'url_blocked',
          'This address is not allowed (internal, private or unresolvable host).'
        );
      case 'invalid_url':
        return new IngestError('invalid_url', 'The URL is not valid.');
      case 'timeout':
        return new IngestError('url_timeout', TIMEOUT_MESSAGE);
      case 'response_too_large':
        return new IngestError(
          'url_too_large',
          'The page is larger than 2 MB.'
        );
      case 'unsupported_content_type':
        return new IngestError(
          'url_unsupported_content_type',
          'Only HTML and plain-text pages can be imported.'
        );
      default:
        return new IngestError('url_unreachable', 'Could not reach the page.');
    }
  }
  return new IngestError('url_unreachable', 'Could not reach the page.');
}

/**
 * Baixa a página e devolve o texto principal. Lança `IngestError`.
 * `request` existe para teste; produção usa `safeRequest`.
 */
export async function extractUrlText(
  rawUrl: string,
  request: UrlRequestFn = safeRequest
): Promise<UrlExtraction> {
  let url = parseHttpUrl(rawUrl);
  const startedAt = Date.now();

  for (let hop = 0; hop <= MAX_URL_REDIRECTS; hop++) {
    // Um prazo só para todos os saltos.
    const remaining = URL_FETCH_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) throw new IngestError('url_timeout', TIMEOUT_MESSAGE);

    let res: SafeResponse;
    try {
      res = await request({
        url: url.toString(),
        method: 'GET',
        headers: {
          Accept: 'text/html,text/plain;q=0.9',
          'User-Agent': USER_AGENT,
        },
        timeoutMs: remaining,
        maxBytes: MAX_URL_BODY_BYTES,
        allowHttp: true,
        acceptContentTypes: ['text/html', 'text/plain'],
        redirect: 'return',
      });
    } catch (err) {
      throw mapTransportError(err);
    }

    if (res.status >= 300 && res.status < 400) {
      if (!res.location) {
        throw new IngestError(
          'url_bad_status',
          `The page answered ${res.status} without a destination.`
        );
      }
      try {
        url = parseHttpUrl(new URL(res.location, url).toString());
      } catch {
        throw new IngestError(
          'url_blocked',
          'The page redirects to an address that is not allowed.'
        );
      }
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new IngestError(
        'url_bad_status',
        `The page answered ${res.status}.`
      );
    }

    const contentType = res.contentType.toLowerCase();
    const isHtml = contentType.startsWith('text/html');
    const bytes = new Uint8Array(res.buffer ?? Buffer.from(res.body, 'utf8'));

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
