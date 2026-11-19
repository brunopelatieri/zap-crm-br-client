// ============================================================
// O que as rotas da área tiram da requisição (SPEC 083 E-6, SPEC 083 §7.1).
//
// IP: o ÚLTIMO valor de `x-forwarded-for` (o Traefik da stack fica na
// frente e acrescenta o endereço que viu; o cliente só prefixa), depois
// `x-real-ip`, depois "unknown". Vai para o banco só como sha256 — os
// contadores de limite nunca guardam IP em claro. Depende de o proxy ser
// o único a escrever no fim da lista: o teste de campo do Traefik
// (SPEC 083 §15.5) segue sendo do mantenedor.
//
// Origem: toda escrita em `/area/api/**` confere o cabeçalho `Origin`.
// Vale se for a origem pública do app (`NEXT_PUBLIC_SITE_URL`) OU se o
// host dele for o host que serviu a requisição (`x-forwarded-host`, que
// o Traefik põe, ou `host`) — o mesmo critério das Server Actions do
// Next. Só o primeiro deixava `localhost:4000` (e qualquer outro nome
// legítimo do app) recusado com 403. Um site de fora não controla o
// `Host` da requisição que o navegador manda para cá, então o segundo
// critério não abre CSRF. O cookie é `SameSite=Lax`, que já barra POST
// de outro site; isto é a segunda tranca, e recusa quando o `Origin` não
// vem (todo navegador atual o manda em `fetch` com POST).
// ============================================================

import { createHash } from 'node:crypto';

export function getClientIp(request: Request): string {
  // O ÚLTIMO valor: é o que o proxy confiável (Traefik) acrescenta. Um
  // cliente só consegue PREFIXAR a lista (`x-forwarded-for: <forjado>`), e
  // o primeiro valor era justamente o que ele controlava (F5-03).
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

/** sha256 hex do IP — o formato que `contact_portal.attempts` aceita. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip, 'utf8').digest('hex');
}

export function clientIpHash(request: Request): string {
  return hashIp(getClientIp(request));
}

function firstHeader(request: Request, name: string): string | null {
  return request.headers.get(name)?.split(',')[0]?.trim() || null;
}

/** Host que o navegador usou para chegar aqui (atrás do proxy ou não). */
function requestHost(request: Request): string | null {
  return (
    firstHeader(request, 'x-forwarded-host') ?? firstHeader(request, 'host')
  );
}

/**
 * Origem que o navegador vê nesta requisição — para decidir o `Secure`
 * do cookie. Não é a origem pública dos links: em `localhost` as duas
 * diferem.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = requestHost(request);
  const proto =
    firstHeader(request, 'x-forwarded-proto') ?? url.protocol.replace(':', '');
  return host ? `${proto}://${host}` : url.origin;
}

export function isSameOriginWrite(request: Request): boolean {
  const raw = request.headers.get('origin');
  if (!raw) return false;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return false;
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) {
    try {
      if (new URL(site).origin === origin.origin) return true;
    } catch {
      /* URL pública malformada: segue para o critério do host */
    }
  }

  const host = requestHost(request);
  return host !== null && origin.host === host;
}

/**
 * Origem dos links que vão na mensagem do código: SÓ a configurada
 * (`NEXT_PUBLIC_SITE_URL`), nunca o `Host`/`x-forwarded-host` da
 * requisição. O pedido de código é anônimo: aceitar o host dele deixaria
 * quem pede escolher o domínio do link que chega ao contato
 * (`https://outro-site/area/c/…/codigo#c=<código>`) e ler o código no
 * fragmento (F6, achado A-2). Sem a variável, a mensagem sai sem link
 * (SPEC 083 §7).
 */
export function configuredSiteOrigin(): string | null {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!site) return null;
  try {
    return new URL(site).origin;
  } catch {
    return null;
  }
}

/**
 * Segura a resposta até `minMs` depois de `startedAt` (anti-enumeração
 * por tempo, F6 achado A-3): o pedido de código que acha contato grava
 * um bcrypt a mais no banco, e sem este piso o tempo de resposta
 * denunciaria quem é contato.
 */
export async function holdUntil(
  startedAt: number,
  minMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  const wait = startedAt + minMs - now();
  if (wait > 0) await sleep(wait);
}

/** Corpo JSON como objeto, ou `null` (corpo ausente, inválido ou não-objeto). */
export async function readJsonObject(
  request: Request
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
  maxLength = 256
): string | null {
  const v = body[key];
  return typeof v === 'string' && v.length <= maxLength ? v : null;
}
