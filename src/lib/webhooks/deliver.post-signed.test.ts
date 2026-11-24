import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { DELIVERY_TIMEOUT_MS, postSignedPayload } from './deliver';
import { verifySignatureHeader } from './sign';
import { isDeliverableUrl } from './ssrf';

type FetchCall = [string, RequestInit & { headers: Record<string, string> }];

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

const base = { url: 'https://t.test/hook', secret: 's3cret', body: '{"a":1}' };

describe('postSignedPayload', () => {
  it('assina os bytes exatos, não segue redirect e usa timeout curto', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await postSignedPayload({
      ...base,
      tsSeconds: 1700000000,
      headers: { 'X-Wacrm-Event': 'x.y' },
    });

    expect(result).toEqual({
      ok: true,
      status: 204,
      durationMs: expect.any(Number),
    });
    const [url, opts] = fetchMock.mock.calls[0] as FetchCall;
    expect(url).toBe(base.url);
    expect(opts.method).toBe('POST');
    expect(opts.redirect).toBe('manual');
    expect(opts.body).toBe(base.body);
    expect(opts.headers['X-Wacrm-Event']).toBe('x.y');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(
      verifySignatureHeader(
        opts.headers['X-Wacrm-Signature'],
        base.body,
        base.secret,
        1700000000
      )
    ).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(DELIVERY_TIMEOUT_MS);
  });

  it('cabeçalhos extras não substituem Content-Type nem a assinatura', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await postSignedPayload({
      ...base,
      tsSeconds: 1700000000,
      headers: {
        'Content-Type': 'text/plain',
        'X-Wacrm-Signature': 'forged',
      },
    });

    const opts = (fetchMock.mock.calls[0] as FetchCall)[1];
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(/^t=1700000000,v1=/);
  });

  it('destino não público: not_public, sem fetch', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await postSignedPayload(base);

    expect(result).toMatchObject({
      ok: false,
      error: 'not_public',
      status: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('guarda SSRF que lança vira not_public (fail-closed)', async () => {
    vi.mocked(isDeliverableUrl).mockRejectedValue(new Error('dns exploded'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await postSignedPayload(base);

    expect(result).toMatchObject({ ok: false, error: 'not_public' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('não-2xx (inclui 3xx do redirect manual): http_error com o status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 302 })
    );
    expect(await postSignedPayload(base)).toMatchObject({
      ok: false,
      error: 'http_error',
      status: 302,
    });
  });

  it('timeout e erro de rede são distinguidos e nunca lançam', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    );
    expect(await postSignedPayload(base)).toMatchObject({
      ok: false,
      error: 'timeout',
      status: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    );
    expect(await postSignedPayload(base)).toMatchObject({
      ok: false,
      error: 'network',
      status: null,
    });
  });

  it('a mensagem de falha não carrega URL nem chave', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );
    const result = await postSignedPayload(base);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).not.toContain('t.test');
    expect(result.message).not.toContain(base.secret);
  });
});
