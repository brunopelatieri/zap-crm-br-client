// ============================================================
// Quem pode embutir `/f/<slug>` num iframe (SPEC 085 E-12; PRD 084 D-13).
//
// `next.config.ts` não manda `X-Frame-Options` em `/f/**`; quem decide é
// o middleware, que é o único que conhece o slug:
//   - formulário com origens de embed cadastradas →
//     `Content-Security-Policy: frame-ancestors <origens>`;
//   - sem origens, formulário inexistente ou QUALQUER falha da consulta →
//     `X-Frame-Options: DENY` + `frame-ancestors 'none'` (fail-closed).
//
// Roda no middleware (Edge): só `fetch` e `process.env`, nada de `node:`
// nem do client Supabase. A consulta usa a chave service-role porque
// `anon` não tem policy nas tabelas de formulário (SPEC 085 §8 item 1) —
// o que sai daqui é só a LISTA DE ORIGENS, nunca o formulário. Cache por
// processo de 30 s: uma página recarregada não custa uma consulta, e
// trocar a lista no construtor vale em até meio minuto.
// ============================================================

/**
 * Mesmo valor de `EMBED_ORIGINS_MAX` em `validate.ts` (o teste co-locado os
 * compara). Repetido aqui porque o middleware (Edge) não pode importar
 * `validate.ts`, que puxa telefone e Storage.
 */
const EMBED_ORIGINS_MAX = 10;
export { EMBED_ORIGINS_MAX as FRAME_EMBED_ORIGINS_MAX };

export const FRAME_DENY_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

/** `https://host` ou `https://host:porta`, sem caminho (SPEC 085 §8 item 10). */
const ORIGIN_PATTERN =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/i;

/** Só origens bem-formadas, sem repetição, no máximo `EMBED_ORIGINS_MAX`. */
export function parseEmbedOrigins(settings: unknown): string[] {
  const raw =
    settings && typeof settings === 'object'
      ? (settings as { embed_origins?: unknown }).embed_origins
      : undefined;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const origin = item.trim().toLowerCase();
    if (ORIGIN_PATTERN.test(origin) && !out.includes(origin)) out.push(origin);
    if (out.length >= EMBED_ORIGINS_MAX) break;
  }
  return out;
}

/** Cabeçalhos de resposta de `/f/<slug>` para uma lista de origens. */
export function frameHeadersFor(
  origins: readonly string[]
): Record<string, string> {
  if (origins.length === 0) return { ...FRAME_DENY_HEADERS };
  return {
    'Content-Security-Policy': `frame-ancestors ${origins.join(' ')}`,
  };
}

/** `/f/<slug>` (com ou sem barra final) → slug; qualquer outra coisa → `null`. */
export function slugFromFormPath(pathname: string): string | null {
  const m = /^\/f\/([a-z0-9][a-z0-9-]{1,58}[a-z0-9])\/?$/.exec(pathname);
  return m ? m[1] : null;
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 500;
const cache = new Map<string, { origins: string[]; expiresAt: number }>();

export function __resetFramePolicyCacheForTests() {
  cache.clear();
}

type FetchLike = (
  input: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Origens de embed do formulário PUBLICADO `slug`. Erro de rede, resposta
 * ilegível ou ambiente sem chave → `[]` (e portanto `DENY`).
 */
export async function lookupEmbedOrigins(
  slug: string,
  now: number = Date.now(),
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<string[]> {
  const hit = cache.get(slug);
  if (hit && hit.expiresAt > now) return hit.origins;

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return [];

  let origins: string[] = [];
  try {
    const url =
      `${base.replace(/\/+$/, '')}/rest/v1/forms` +
      `?select=settings&slug=eq.${encodeURIComponent(slug)}` +
      `&status=eq.published&limit=1`;
    const res = await fetchImpl(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ settings?: unknown }>;
    origins = parseEmbedOrigins(rows?.[0]?.settings);
  } catch {
    return [];
  }

  // Descarta o mais antigo (ordem de inserção do Map), nunca tudo: um robô
  // com 500 slugs inventados não pode apagar o cache dos formulários reais.
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(slug, { origins, expiresAt: now + CACHE_TTL_MS });
  return origins;
}
