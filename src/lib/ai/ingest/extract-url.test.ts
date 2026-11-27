import { describe, it, expect, vi } from 'vitest';

import { IngestError } from './errors';
import { extractUrlText } from './extract-url';
import { MAX_URL_BODY_BYTES } from './limits';

// Hosts por IP literal: `isDeliverableUrl` decide sem consultar DNS, então
// o teste da guarda não depende de rede. 93.184.216.34 é público.
const PUBLIC = 'http://93.184.216.34';

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof IngestError) return err.code;
    throw err;
  }
  return 'no error';
}

describe('extractUrlText — SSRF guard (D-8)', () => {
  // Cada alvo interno, e a prova de que o `fetch` NUNCA foi chamado.
  const blocked = [
    'http://127.0.0.1/',
    'http://127.0.0.1:3000/admin',
    'http://localhost/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://0.0.0.0/',
    'http://servico.internal/',
    'http://painel.local/',
  ];

  it.each(blocked)('blocks %s without making any request', async (url) => {
    const fetchFn = vi.fn();
    expect(await codeOf(extractUrlText(url, fetchFn))).toBe('url_blocked');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('blocks a public page that redirects to an internal address (redirect: manual, guard on every hop)', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    );
    expect(await codeOf(extractUrlText(`${PUBLIC}/promo`, fetchFn))).toBe(
      'url_blocked'
    );
    // Só o primeiro salto foi requisitado, e com `redirect: 'manual'`.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('blocks a redirect to a relative path on an internal host too', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: '//127.0.0.1/admin' },
      })
    );
    expect(await codeOf(extractUrlText(`${PUBLIC}/`, fetchFn))).toBe(
      'url_blocked'
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects non-http schemes and URLs with credentials without fetching', async () => {
    const fetchFn = vi.fn();
    for (const url of [
      'file:///etc/passwd',
      'ftp://93.184.216.34/x',
      'javascript:alert(1)',
      'http://user:senha@93.184.216.34/',
      'não é url',
      '',
    ]) {
      expect(await codeOf(extractUrlText(url, fetchFn))).toBe('invalid_url');
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('follows a redirect between public hosts, re-checking each hop', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'http://93.184.216.35/destino' },
        })
      )
      .mockResolvedValueOnce(html('<h1>Destino</h1><p>Chegamos.</p>'));
    const out = await extractUrlText(`${PUBLIC}/origem`, fetchFn);
    expect(out.finalUrl).toBe('http://93.184.216.35/destino');
    expect(out.text).toContain('Chegamos.');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('stops after too many redirects', async () => {
    const fetchFn = vi.fn().mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `${PUBLIC}/outra` },
        })
    );
    expect(await codeOf(extractUrlText(`${PUBLIC}/`, fetchFn))).toBe(
      'url_too_many_redirects'
    );
    expect(fetchFn).toHaveBeenCalledTimes(4); // 1 + 3 saltos
  });
});

describe('extractUrlText — response handling (D-8)', () => {
  it('sends a manual-redirect GET with a deadline signal and no cookies', async () => {
    const fetchFn = vi.fn().mockResolvedValue(html('<p>oi</p>'));
    await extractUrlText(`${PUBLIC}/`, fetchFn);
    const init = fetchFn.mock.calls[0][1];
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.credentials).toBeUndefined();
  });

  it('extracts the text and the title of an HTML page, dropping navigation and scripts', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        html(
          '<html><head><title>Loja Exemplo</title></head><body><nav>Home Contato</nav>' +
            '<h1>Frete</h1><p>Entrega em até 5 dias úteis.</p><script>x()</script></body></html>'
        )
      );
    const out = await extractUrlText(`${PUBLIC}/frete`, fetchFn);
    expect(out.title).toBe('Loja Exemplo');
    expect(out.text).toBe('# Frete\n\nEntrega em até 5 dias úteis.');
    expect(out.mimeType).toBe('text/html');
  });

  it('accepts text/plain as is', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('linha 1\r\nlinha 2', {
        headers: { 'content-type': 'text/plain' },
      })
    );
    const out = await extractUrlText(`${PUBLIC}/a.txt`, fetchFn);
    expect(out.text).toBe('linha 1\nlinha 2');
    expect(out.mimeType).toBe('text/plain');
  });

  it('honours the charset of the response', async () => {
    const bytes = new Uint8Array([0x50, 0x72, 0x65, 0xe7, 0x6f]); // "Preço" em latin1
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(bytes, {
        headers: { 'content-type': 'text/html; charset=iso-8859-1' },
      })
    );
    expect((await extractUrlText(`${PUBLIC}/`, fetchFn)).text).toBe('Preço');
  });

  it('refuses other content types (PDF, JSON, images)', async () => {
    for (const type of ['application/pdf', 'application/json', 'image/png']) {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          new Response('x', { headers: { 'content-type': type } })
        );
      expect(await codeOf(extractUrlText(`${PUBLIC}/`, fetchFn))).toBe(
        'url_unsupported_content_type'
      );
    }
  });

  it('refuses a body over 2 MB, by the declared length and by what actually arrives', async () => {
    const declared = vi.fn().mockResolvedValue(
      html('x', {
        headers: {
          'content-type': 'text/html',
          'content-length': String(MAX_URL_BODY_BYTES + 1),
        },
      })
    );
    expect(await codeOf(extractUrlText(`${PUBLIC}/`, declared))).toBe(
      'url_too_large'
    );

    // Sem Content-Length confiável: o fluxo é cortado no limite.
    const streamed = vi
      .fn()
      .mockResolvedValue(html('a'.repeat(MAX_URL_BODY_BYTES + 10)));
    expect(await codeOf(extractUrlText(`${PUBLIC}/`, streamed))).toBe(
      'url_too_large'
    );
  });

  it('maps HTTP errors, empty pages, timeouts and network failures to codes', async () => {
    expect(
      await codeOf(
        extractUrlText(
          `${PUBLIC}/`,
          vi.fn().mockResolvedValue(new Response('no', { status: 404 }))
        )
      )
    ).toBe('url_bad_status');
    expect(
      await codeOf(
        extractUrlText(
          `${PUBLIC}/`,
          vi.fn().mockResolvedValue(html('<script>1</script>'))
        )
      )
    ).toBe('empty_text');
    expect(
      await codeOf(
        extractUrlText(
          `${PUBLIC}/`,
          vi
            .fn()
            .mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
        )
      )
    ).toBe('url_timeout');
    expect(
      await codeOf(
        extractUrlText(
          `${PUBLIC}/`,
          vi.fn().mockRejectedValue(new TypeError('fetch failed'))
        )
      )
    ).toBe('url_unreachable');
  });

  it('never echoes the response body in an error', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('SEGREDO-INTERNO', { status: 500 }));
    try {
      await extractUrlText(`${PUBLIC}/`, fetchFn);
    } catch (err) {
      expect((err as Error).message).not.toContain('SEGREDO-INTERNO');
    }
  });
});
