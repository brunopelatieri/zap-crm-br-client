import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGuardedLookup,
  parseToolUrl,
  safeRequest,
  SafeRequestError,
  type SafeRequestDeps,
} from './safe-request';

// A real local HTTP server drives the transport. The address checks are
// replaced (`deps`) so 127.0.0.1 can be the target; the checks themselves are
// tested separately with the production defaults.

let server: Server;
let port = 0;
let hits: string[] = [];
let lastBody = '';
let lastHeaders: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    lastHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      if (url.startsWith('/json')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ stock: 7 }));
      } else if (url.startsWith('/redirect')) {
        res.statusCode = 302;
        res.setHeader('Location', '/json');
        res.end();
      } else if (url.startsWith('/nocontent')) {
        res.statusCode = 204;
        res.end();
      } else if (url.startsWith('/image')) {
        res.setHeader('Content-Type', 'image/png');
        res.end('x');
      } else if (url.startsWith('/html')) {
        res.setHeader('Content-Type', 'text/html');
        res.end('<p>hi</p>');
      } else if (url.startsWith('/big')) {
        res.setHeader('Content-Type', 'application/json');
        res.end('x'.repeat(5000));
      } else if (url.startsWith('/stream-big')) {
        res.setHeader('Content-Type', 'text/plain');
        res.write('y'.repeat(3000));
        setTimeout(() => res.end('y'.repeat(3000)), 20);
      } else if (url.startsWith('/hang')) {
        // never answers
      } else {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"error":"nope"}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const local = (): SafeRequestDeps => ({
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  isPublicIp: () => true,
  isDeliverable: async () => true,
  allowedPorts: [port],
});

const get = (
  path: string,
  extra: Partial<Parameters<typeof safeRequest>[0]> = {}
) =>
  safeRequest(
    {
      url: `http://stock.example.test:${port}${path}`,
      method: 'GET',
      headers: {},
      timeoutMs: 2000,
      allowHttp: true,
      maxBytes: 4000,
      ...extra,
    },
    local()
  );

async function codeOf(p: Promise<unknown>): Promise<SafeRequestError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SafeRequestError);
    return e as SafeRequestError;
  }
  throw new Error('expected the request to be refused');
}

describe('safeRequest — transport', () => {
  it('reads a JSON answer and sends the headers and the body', async () => {
    hits = [];
    const res = await safeRequest(
      {
        url: `http://stock.example.test:${port}/json?a=1`,
        method: 'POST',
        headers: { 'X-Api-Key': 'k-123', 'Content-Type': 'application/json' },
        body: '{"sku":"A1"}',
        timeoutMs: 2000,
        allowHttp: true,
      },
      local()
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ stock: 7 });
    expect(lastBody).toBe('{"sku":"A1"}');
    expect(lastHeaders['x-api-key']).toBe('k-123');
    expect(hits).toEqual(['POST /json?a=1']);
  });

  it('accepts text/*', async () => {
    const res = await get('/html');
    expect(res.body).toBe('<p>hi</p>');
  });

  it('NEVER follows a redirect (a 3xx is an error and the target is not hit)', async () => {
    hits = [];
    const err = await codeOf(get('/redirect'));
    expect(err.code).toBe('redirect_blocked');
    expect(hits).toEqual(['GET /redirect']);
  });

  it('a 204 with no content type is a success (a write that answers "no content")', async () => {
    const res = await get('/nocontent');
    expect(res.status).toBe(204);
    expect(res.body).toBe('');
  });

  it('refuses an unexpected content type', async () => {
    expect((await codeOf(get('/image'))).code).toBe('unsupported_content_type');
  });

  it('refuses a body over the cap, declared or streamed', async () => {
    expect((await codeOf(get('/big'))).code).toBe('response_too_large');
    expect((await codeOf(get('/stream-big'))).code).toBe('response_too_large');
  });

  it('times out when the server never answers (the request may have been sent)', async () => {
    const err = await codeOf(get('/hang', { timeoutMs: 150 }));
    expect(err.code).toBe('timeout');
    expect(err.sent).toBe(true);
  });

  it('keeps a non-2xx status for the caller', async () => {
    const res = await get('/missing');
    expect(res.status).toBe(404);
  });
});

describe('safeRequest — address guard (production checks)', () => {
  const real = (host: string) =>
    safeRequest({
      url: `https://${host}/x`,
      method: 'GET',
      headers: {},
      timeoutMs: 500,
    });

  it.each([
    'localhost',
    'app.localhost',
    'printer.local',
    'db.internal',
    '127.0.0.1',
    '10.0.0.5',
    '172.16.4.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '[::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[fd00::1]',
    '[fe80::1]',
    '0.0.0.0',
    '[::ffff:169.254.169.254]',
  ])('refuses %s without opening a socket', async (host) => {
    const err = await codeOf(real(host));
    expect(err.code).toBe('blocked_url');
    expect(err.sent).toBe(false);
  });

  it.each([
    ['https://example.com:22/x', 'blocked_port'],
    ['https://example.com:3306/x', 'blocked_port'],
    ['https://example.com:6379/', 'blocked_port'],
    ['http://example.com/x', 'invalid_url'],
    ['ftp://example.com/x', 'invalid_url'],
    ['https://user:pass@example.com/x', 'invalid_url'],
    ['not a url', 'invalid_url'],
  ])('refuses the shape of %s', async (url, code) => {
    const err = await codeOf(
      safeRequest({ url, method: 'GET', headers: {}, timeoutMs: 500 })
    );
    expect(err.code).toBe(code);
  });

  it('allows the standard ports in the URL shape check', () => {
    for (const u of [
      'https://example.com/x',
      'https://example.com:443/x',
      'https://example.com:8443/x',
    ]) {
      expect('error' in parseToolUrl(u)).toBe(false);
    }
  });

  it('DNS REBINDING: a name that passed the pre-flight but resolves to an internal IP at connect time is refused, nothing is sent', async () => {
    let lookups = 0;
    const err = await codeOf(
      safeRequest(
        {
          url: 'https://rebind.example.test/x',
          method: 'POST',
          headers: { Authorization: 'secret' },
          body: '{}',
          timeoutMs: 1000,
        },
        {
          // The pre-flight sees a public address...
          isDeliverable: async () => true,
          // ...and the connect-time resolution flips to the metadata IP.
          resolve: async () => {
            lookups += 1;
            return [{ address: '169.254.169.254', family: 4 }];
          },
        }
      )
    );
    expect(err.code).toBe('blocked_url');
    expect(err.sent).toBe(false);
    expect(lookups).toBe(1);
  });

  it('a name with one public and one internal address is refused', async () => {
    const lookup = createGuardedLookup({
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ],
    });
    const outcome = await new Promise<NodeJS.ErrnoException | null>((r) =>
      lookup('mixed.example.test', { all: true }, (e) => r(e))
    );
    expect(outcome?.code).toBe('EBLOCKED');
  });

  it('the guarded lookup hands out the validated address (all and single forms)', async () => {
    const lookup = createGuardedLookup({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const all = await new Promise<unknown>((r) =>
      lookup('ok.example.test', { all: true }, (e, a) => r(a))
    );
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const one = await new Promise<unknown>((r) =>
      lookup('ok.example.test', {}, (e, a, f) => r([a, f]))
    );
    expect(one).toEqual(['93.184.216.34', 4]);
  });
});

describe('safeRequest — options for the knowledge importer', () => {
  it("redirect: 'return' hands back the 3xx and its Location without following it", async () => {
    hits = [];
    const res = await get('/redirect', { redirect: 'return' });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/json');
    expect(res.body).toBe('');
    expect(hits).toEqual(['GET /redirect']);
  });

  it('the default still refuses a redirect (the HTTP tool never follows one)', async () => {
    expect((await codeOf(get('/redirect'))).code).toBe('redirect_blocked');
  });

  it('acceptContentTypes replaces the default list', async () => {
    expect(
      (await get('/html', { acceptContentTypes: ['text/html'] })).contentType
    ).toBe('text/html');
    expect(
      (await codeOf(get('/json', { acceptContentTypes: ['text/html'] }))).code
    ).toBe('unsupported_content_type');
    // Uma lista restrita também recusa o que o padrão aceitaria.
    expect(
      (await codeOf(get('/html', { acceptContentTypes: ['text/plain'] }))).code
    ).toBe('unsupported_content_type');
  });

  it('returns the raw bytes next to the decoded text', async () => {
    const res = await get('/html');
    expect(Buffer.from(res.buffer ?? []).toString('utf8')).toBe('<p>hi</p>');
  });
});

describe('safeRequest — deadline covers name resolution (LOW)', () => {
  it('gives up when the pre-flight check never answers, instead of holding the caller', async () => {
    const t0 = performance.now();
    const err = await codeOf(
      safeRequest(
        {
          url: 'https://slow-dns.example.test/x',
          method: 'GET',
          headers: {},
          timeoutMs: 150,
        },
        { isDeliverable: () => new Promise<boolean>(() => {}) }
      )
    );
    expect(err.code).toBe('timeout');
    expect(err.sent).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('the pre-flight time counts against the same total deadline', async () => {
    const t0 = performance.now();
    const err = await codeOf(
      safeRequest(
        {
          url: `http://stock.example.test:${port}/hang`,
          method: 'GET',
          headers: {},
          timeoutMs: 300,
          allowHttp: true,
        },
        {
          ...local(),
          isDeliverable: async () => {
            await new Promise((r) => setTimeout(r, 200));
            return true;
          },
        }
      )
    );
    expect(err.code).toBe('timeout');
    expect(performance.now() - t0).toBeLessThan(450);
  });

  it('gives up when the connect-time resolution never answers', async () => {
    const err = await codeOf(
      safeRequest(
        {
          url: `http://slow.example.test:${port}/json`,
          method: 'GET',
          headers: {},
          timeoutMs: 200,
          allowHttp: true,
        },
        { ...local(), resolve: () => new Promise(() => {}) }
      )
    );
    expect(err.code).toBe('timeout');
  });
});
