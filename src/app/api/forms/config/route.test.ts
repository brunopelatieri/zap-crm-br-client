// GET /api/forms/config — estado das variáveis do servidor (SPEC 085 §10, F4).
// A regra que não pode quebrar: NUNCA devolver o valor, só booleanos.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  hasFeature: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (orig) => {
  const real = await orig<typeof import('@/lib/auth/account')>();
  return { ...real, requireRole: (min: string) => h.requireRole(min) };
});
vi.mock('@/lib/forms/plan-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/forms/plan-gate')>()),
  hasFormsFeature: (...a: unknown[]) => h.hasFeature(...a),
}));

import { ForbiddenError } from '@/lib/auth/account';

import { GET } from './route';

const SECRET = 'segredo-super-secreto-com-mais-de-32-bytes-aaaaaaaa';

beforeEach(() => {
  h.requireRole.mockReset().mockResolvedValue({ accountId: 'acc-1' });
  h.hasFeature.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/forms/config', () => {
  it('admin vê presente/ausente e o JSON não contém nenhum valor', async () => {
    vi.stubEnv('FORM_LINK_SECRET', SECRET);
    vi.stubEnv('TURNSTILE_SITE_KEY', '0x4AAAAsite-key-valor');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const res = await GET();
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.clone().json());
    expect(await res.json()).toEqual({
      featureInPlan: true,
      linkSecret: true,
      turnstile: { siteKey: true, secretKey: false },
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('0x4AAAA');
  });

  it('segredo curto demais conta como ausente', async () => {
    vi.stubEnv('FORM_LINK_SECRET', 'curto');
    vi.stubEnv('TURNSTILE_SITE_KEY', '');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    expect(await (await GET()).json()).toEqual({
      featureInPlan: true,
      linkSecret: false,
      turnstile: { siteKey: false, secretKey: false },
    });
  });

  it('conta sem o item no plano: 200 com featureInPlan false (tela de configuração)', async () => {
    h.hasFeature.mockResolvedValue(false);
    expect((await (await GET()).json()).featureInPlan).toBe(false);
  });

  it('só admin+: abaixo disso 403, sem consultar o plano', async () => {
    h.requireRole.mockImplementation(async (min: string) => {
      expect(min).toBe('admin');
      throw new ForbiddenError('Insufficient role');
    });
    expect((await GET()).status).toBe(403);
    expect(h.hasFeature).not.toHaveBeenCalled();
  });
});
