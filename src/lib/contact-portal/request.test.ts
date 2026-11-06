import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clientIpHash,
  configuredSiteOrigin,
  getClientIp,
  hashIp,
  holdUntil,
  isSameOriginWrite,
  requestOrigin,
} from './request';

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IP do cliente', () => {
  it('primeiro valor de x-forwarded-for, depois x-real-ip, depois "unknown"', () => {
    expect(
      getClientIp(
        req('http://x/', { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })
      )
    ).toBe('203.0.113.7');
    expect(getClientIp(req('http://x/', { 'x-real-ip': '198.51.100.2' }))).toBe(
      '198.51.100.2'
    );
    expect(getClientIp(req('http://x/'))).toBe('unknown');
  });

  it('vai para o banco só como sha256 hex', () => {
    const h = hashIp('203.0.113.7');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('203');
    expect(
      clientIpHash(req('http://x/', { 'x-forwarded-for': '203.0.113.7' }))
    ).toBe(h);
  });
});

describe('isSameOriginWrite', () => {
  it('aceita Origin igual à origem pública (NEXT_PUBLIC_SITE_URL)', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dev.valenranch.com.br/');
    expect(
      isSameOriginWrite(
        req('http://0.0.0.0:3000/area/api/login', {
          origin: 'https://dev.valenranch.com.br',
        })
      )
    ).toBe(true);
  });

  it('recusa outra origem e recusa quando o Origin não vem', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dev.valenranch.com.br');
    expect(
      isSameOriginWrite(
        req('http://0.0.0.0:3000/area/api/login', {
          origin: 'https://evil.example',
        })
      )
    ).toBe(false);
    expect(isSameOriginWrite(req('http://0.0.0.0:3000/area/api/login'))).toBe(
      false
    );
    expect(
      isSameOriginWrite(
        req('http://0.0.0.0:3000/area/api/login', { origin: 'null' })
      )
    ).toBe(false);
  });

  it('sem NEXT_PUBLIC_SITE_URL, usa o host da requisição (dev local)', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(
      isSameOriginWrite(
        req('http://localhost:4000/area/api/login', {
          host: 'localhost:4000',
          origin: 'http://localhost:4000',
        })
      )
    ).toBe(true);
  });
});

describe('isSameOriginWrite — host da requisição', () => {
  it('aceita localhost:4000 mesmo com NEXT_PUBLIC_SITE_URL apontando para o domínio público', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dev.valenranch.com.br');
    expect(
      isSameOriginWrite(
        req('http://localhost:4000/area/api/request-code', {
          host: 'localhost:4000',
          origin: 'http://localhost:4000',
        })
      )
    ).toBe(true);
  });

  it('atrás do proxy vale o x-forwarded-host', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(
      isSameOriginWrite(
        req('http://0.0.0.0:3000/area/api/login', {
          host: '0.0.0.0:3000',
          'x-forwarded-host': 'outro.valenranch.com.br',
          origin: 'https://outro.valenranch.com.br',
        })
      )
    ).toBe(true);
  });

  it('origem de fora continua recusada, mesmo com host conhecido', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dev.valenranch.com.br');
    expect(
      isSameOriginWrite(
        req('http://0.0.0.0:3000/area/api/login', {
          host: 'dev.valenranch.com.br',
          origin: 'https://dev.valenranch.com.br.evil.example',
        })
      )
    ).toBe(false);
  });
});

describe('requestOrigin (Secure do cookie)', () => {
  it('usa x-forwarded-proto e x-forwarded-host quando há proxy', () => {
    expect(
      requestOrigin(
        req('http://0.0.0.0:3000/x', {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'dev.valenranch.com.br',
        })
      )
    ).toBe('https://dev.valenranch.com.br');
  });

  it('em localhost fica http://localhost:4000', () => {
    expect(
      requestOrigin(req('http://localhost:4000/x', { host: 'localhost:4000' }))
    ).toBe('http://localhost:4000');
  });
});

describe('configuredSiteOrigin (link da mensagem do código, F6 A-2)', () => {
  it('só a NEXT_PUBLIC_SITE_URL, sem barra no fim', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://dev.valenranch.com.br/');
    expect(configuredSiteOrigin()).toBe('https://dev.valenranch.com.br');
  });

  it('sem a variável (ou malformada) é null — nunca o host da requisição', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(configuredSiteOrigin()).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'não é url');
    expect(configuredSiteOrigin()).toBeNull();
  });
});

describe('holdUntil (piso de tempo, F6 A-3)', () => {
  it('dorme o que falta até o piso', async () => {
    const sleep = vi.fn(async () => undefined);
    await holdUntil(1_000, 750, () => 1_200, sleep);
    expect(sleep).toHaveBeenCalledWith(550);
  });

  it('não dorme quando o piso já passou', async () => {
    const sleep = vi.fn(async () => undefined);
    await holdUntil(1_000, 750, () => 1_900, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });
});
