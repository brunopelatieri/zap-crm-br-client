import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isDeliverableUrl, isPrivateOrReservedIp } from '@/lib/webhooks/ssrf';

// ============================================================
// Outbound HTTP to an address an ACCOUNT ADMIN typed (SPEC 089 F6).
//
// The guard of `webhooks/ssrf.ts` (`isDeliverableUrl`) resolves the host and
// refuses a private address, but `fetch` then resolves the name AGAIN to
// connect: a host that answers a public IP to the first lookup and a private
// one to the second (DNS rebinding, a TTL of 0) passes the check and still
// reaches the internal network. This module closes that gap:
//
//   1. `isDeliverableUrl` first (a clear refusal before any socket);
//   2. the connection itself goes through `guardedLookup`: the address the
//      socket connects to is validated AT CONNECT TIME, so what was checked
//      is what is used (there is no second, unchecked resolution);
//   3. an IP literal skips DNS, so it is checked here too;
//   4. a port allow-list (443, 8443, 80, 8080);
//   5. NO redirect is ever followed: a 3xx is an error (`redirect_blocked`),
//      unless the caller asks (`redirect: 'return'`) to get the 3xx and its
//      `Location` back and decide for itself (the knowledge importer follows
//      up to 3 hops by hand, each one through this whole guard again);
//   6. a deadline for the whole exchange (name resolution included), a
//      response cap read as a stream, and only `application/json`,
//      `application/*+json` and `text/*` (or the caller's explicit list).
//
// Nothing here logs a header or a body. `node:http(s)` is used instead of
// `fetch` because `fetch` does not expose the connect-time lookup.
// ============================================================

/** Ports a tool URL may use. Anything else is refused (`blocked_port`). */
export const ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443];

/** Largest response body read (bytes); more is `response_too_large`. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

export type SafeRequestErrorCode =
  | 'invalid_url'
  | 'blocked_url'
  | 'blocked_port'
  | 'redirect_blocked'
  | 'unsupported_content_type'
  | 'response_too_large'
  | 'timeout'
  | 'connection_failed';

export class SafeRequestError extends Error {
  constructor(
    public readonly code: SafeRequestErrorCode,
    /** True once the request line may have reached the server. */
    public readonly sent: boolean
  ) {
    super(code);
    this.name = 'SafeRequestError';
  }
}

export interface SafeRequestInput {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** Already serialized; only with POST. */
  body?: string;
  timeoutMs: number;
  maxBytes?: number;
  /** `https` only unless the caller passes `allowHttp` (importer, tests). */
  allowHttp?: boolean;
  /**
   * Media types accepted INSTEAD of the default (JSON and `text/*`), compared
   * to the response's type without parameters, case-insensitively.
   */
  acceptContentTypes?: readonly string[];
  /**
   * `error` (default): a 3xx is `redirect_blocked`. `return`: the 3xx is
   * resolved as a response (`location` set, empty body); it is never followed.
   */
  redirect?: 'error' | 'return';
}

export interface SafeResponse {
  status: number;
  contentType: string;
  /** UTF-8 text of the body (at most `maxBytes`). */
  body: string;
  bytes: number;
  /** The raw body (callers that decode a charset themselves). */
  buffer?: Buffer;
  /** `Location` of a 3xx, only with `redirect: 'return'`. */
  location?: string;
}

/** Dependencies, injectable for tests; production uses the defaults. */
export interface SafeRequestDeps {
  /** Resolves every address of a host (default: `dns.lookup` with `all`). */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** The check at connect time (default: `isPrivateOrReservedIp` negated). */
  isPublicIp?: (ip: string) => boolean;
  /** Pre-flight guard (default: `isDeliverableUrl`). */
  isDeliverable?: (url: string) => Promise<boolean>;
  /** Port allow-list (default `ALLOWED_PORTS`); tests use a random port. */
  allowedPorts?: readonly number[];
}

function defaultResolve(
  host: string
): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

const defaultIsPublicIp = (ip: string) => !isPrivateOrReservedIp(ip);

/**
 * A `lookup` for `http(s).request`: resolves the name and refuses to connect
 * unless EVERY address is public. The socket gets the address from here, so
 * the validated IP is the one used.
 */
export function createGuardedLookup(
  deps: SafeRequestDeps = {}
): LookupFunction {
  const resolve = deps.resolve ?? defaultResolve;
  const isPublic = deps.isPublicIp ?? defaultIsPublicIp;
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addresses) => {
        if (
          addresses.length === 0 ||
          !addresses.every((a) => isPublic(a.address))
        ) {
          callback(
            Object.assign(new Error('blocked address'), {
              code: 'EBLOCKED',
            }) as NodeJS.ErrnoException,
            '',
            0
          );
          return;
        }
        if (options.all) {
          callback(
            null,
            addresses.map((a) => ({ address: a.address, family: a.family }))
          );
          return;
        }
        const first = addresses[0];
        callback(null, first.address, first.family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, '', 0));
  };
}

/** Validate the URL's shape before any network access. */
export function parseToolUrl(
  raw: string,
  allowHttp = false,
  allowedPorts: readonly number[] = ALLOWED_PORTS
): { url: URL } | { error: 'invalid_url' | 'blocked_port' | 'blocked_url' } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid_url' };
  }
  const okProtocol =
    url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (!okProtocol) return { error: 'invalid_url' };
  if (url.username || url.password) return { error: 'invalid_url' };
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;
  if (!allowedPorts.includes(port)) return { error: 'blocked_port' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // An IP literal never reaches `lookup`: check it here.
  if (isIP(host) && isPrivateOrReservedIp(host)) {
    return { error: 'blocked_url' };
  }
  return { url };
}

function isAllowedContentType(
  contentType: string,
  accept?: readonly string[]
): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (accept) return accept.includes(type);
  return (
    type === 'application/json' ||
    (type.startsWith('application/') && type.endsWith('+json')) ||
    type.startsWith('text/')
  );
}

/**
 * One guarded request. Throws `SafeRequestError`; never follows a redirect.
 */
export async function safeRequest(
  input: SafeRequestInput,
  deps: SafeRequestDeps = {}
): Promise<SafeResponse> {
  const parsed = parseToolUrl(
    input.url,
    input.allowHttp === true,
    deps.allowedPorts
  );
  if ('error' in parsed) throw new SafeRequestError(parsed.error, false);
  const { url } = parsed;

  // One deadline for everything, name resolution included: a host whose DNS
  // server never answers must not hold the caller (and a libuv thread's
  // caller) forever. `getaddrinfo` itself cannot be cancelled; this frees the
  // caller at the deadline.
  const startedAt = Date.now();
  const totalMs = Math.max(1, input.timeoutMs);
  const isDeliverable = deps.isDeliverable ?? isDeliverableUrl;
  let preflightTimer: ReturnType<typeof setTimeout> | undefined;
  let deliverable: boolean;
  try {
    deliverable = await Promise.race([
      isDeliverable(url.toString()),
      new Promise<never>((_, rejectDeadline) => {
        preflightTimer = setTimeout(
          () => rejectDeadline(new SafeRequestError('timeout', false)),
          totalMs
        );
      }),
    ]);
  } finally {
    clearTimeout(preflightTimer);
  }
  if (!deliverable) throw new SafeRequestError('blocked_url', false);
  const remainingMs = totalMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw new SafeRequestError('timeout', false);

  const maxBytes = input.maxBytes ?? MAX_RESPONSE_BYTES;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const lookup = createGuardedLookup(deps);

  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    let sent = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    let req: ReturnType<typeof send>;
    try {
      req = send(
        url,
        {
          method: input.method,
          headers: input.body
            ? {
                ...input.headers,
                'Content-Length': String(Buffer.byteLength(input.body)),
              }
            : input.headers,
          lookup,
          // No keep-alive pool: a socket is never reused for another host.
          agent: false,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            if (input.redirect === 'return') {
              const location = res.headers.location;
              done(() =>
                resolve({
                  status,
                  contentType: '',
                  body: '',
                  bytes: 0,
                  buffer: Buffer.alloc(0),
                  location: typeof location === 'string' ? location : undefined,
                })
              );
              return;
            }
            done(() => reject(new SafeRequestError('redirect_blocked', true)));
            return;
          }
          const contentType = String(res.headers['content-type'] ?? '');
          // A 204/205 or an explicit `Content-Length: 0` has no body, hence no
          // content type: a successful write that answers "no content" is not
          // an unsupported response.
          const emptyBody =
            status === 204 ||
            status === 205 ||
            res.headers['content-length'] === '0';
          if (
            !emptyBody &&
            !isAllowedContentType(contentType, input.acceptContentTypes)
          ) {
            res.destroy();
            done(() =>
              reject(new SafeRequestError('unsupported_content_type', true))
            );
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            done(() =>
              reject(new SafeRequestError('response_too_large', true))
            );
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              res.destroy();
              done(() =>
                reject(new SafeRequestError('response_too_large', true))
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            done(() => {
              const buffer = Buffer.concat(chunks);
              resolve({
                status,
                contentType,
                body: buffer.toString('utf8'),
                bytes: total,
                buffer,
              });
            })
          );
          res.on('error', () =>
            done(() => reject(new SafeRequestError('connection_failed', true)))
          );
        }
      );
    } catch {
      // The runtime refused the request before any socket (bad header
      // character, …): nothing was sent.
      reject(new SafeRequestError('connection_failed', false));
      return;
    }

    const timer = setTimeout(
      () => {
        req.destroy();
        done(() => reject(new SafeRequestError('timeout', sent)));
      },
      Math.max(1, remainingMs)
    );

    req.on('socket', (socket) => {
      // The request line is on the wire once the socket is connected.
      socket.once('connect', () => {
        sent = true;
      });
      socket.once('secureConnect', () => {
        sent = true;
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      // EBLOCKED comes from the guarded lookup: nothing was connected.
      if (err.code === 'EBLOCKED') {
        done(() => reject(new SafeRequestError('blocked_url', false)));
      } else {
        done(() => reject(new SafeRequestError('connection_failed', sent)));
      }
    });

    if (input.body) req.write(input.body);
    req.end();
  });
}
