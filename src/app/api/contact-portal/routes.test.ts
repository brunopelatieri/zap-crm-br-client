import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  /** `plan_feature_strict(account, 'contact_portal_enabled')` (SPEC 083 §8.4). */
  hasFeature: vi.fn(),
  recordActivity: vi.fn(),
  visibleContact: vi.fn(),
  visibleContactIds: vi.fn(),
  inviteContactToPortal: vi.fn(),
  service: {
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    accessStatus: vi.fn(),
    setBlocked: vi.fn(),
    endSessions: vi.fn(),
  },
}));

vi.mock('@/lib/auth/account', async (orig) => {
  const real = await orig<typeof import('@/lib/auth/account')>();
  return { ...real, requireRole: (min: string) => h.requireRole(min) };
});
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...a: unknown[]) => h.recordActivity(...a),
}));
vi.mock('@/lib/contact-portal/service', async (orig) => ({
  ...(await orig<typeof import('@/lib/contact-portal/service')>()),
  portalDb: () => ({}),
}));
vi.mock('@/lib/contact-portal/plan-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/contact-portal/plan-gate')>();
  return {
    ...real,
    hasContactPortalFeature: () => h.hasFeature(),
    requireContactPortalFeature: async () => {
      if (!(await h.hasFeature())) {
        throw new ForbiddenError(real.FEATURE_NOT_IN_PLAN);
      }
    },
  };
});
vi.mock('@/lib/contact-portal/account', async (orig) => ({
  ...(await orig<typeof import('@/lib/contact-portal/account')>()),
  createPortalAccountService: () => h.service,
  visibleContact: (...a: unknown[]) => h.visibleContact(...a),
  visibleContactIds: (...a: unknown[]) => h.visibleContactIds(...a),
  inviteContactToPortal: (...a: unknown[]) => h.inviteContactToPortal(...a),
}));

import { ForbiddenError } from '@/lib/auth/account';

import { POST as block } from './contacts/[contactId]/block/route';
import { POST as invite } from './contacts/[contactId]/invite/route';
import { DELETE as endSessions } from './contacts/[contactId]/sessions/route';
import { POST as status } from './contacts/status/route';
import { GET as getSettings, PATCH as patchSettings } from './settings/route';

const BASE = 'https://dev.valenranch.com.br';
const CTX = {
  supabase: {},
  userId: 'u1',
  accountId: 'acc1',
  role: 'admin',
  account: { id: 'acc1', name: 'Valen Ranch' },
};
const params = (contactId: string) => ({
  params: Promise.resolve({ contactId }),
});
const json = (method: string, body?: unknown) =>
  new Request(`${BASE}/api/contact-portal/x`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** requireRole de verdade: recusa abaixo do papel pedido. */
function roleIs(role: 'viewer' | 'agent' | 'admin' | 'owner') {
  const rank = { viewer: 1, agent: 2, admin: 3, owner: 4 };
  h.requireRole.mockImplementation(async (min: keyof typeof rank) => {
    if (rank[role] < rank[min]) throw new ForbiddenError('Insufficient role');
    return { ...CTX, role };
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', BASE);
  h.hasFeature.mockResolvedValue(true);
  h.visibleContact.mockResolvedValue({ id: 'c1', name: 'Maitê' });
  h.visibleContactIds.mockImplementation(
    async (_db, _acc, ids: string[]) => ids
  );
  h.service.getSettings.mockResolvedValue({
    eligible: true,
    publicCode: 'ABCD2345',
  });
  h.service.accessStatus.mockResolvedValue([]);
  h.service.setBlocked.mockResolvedValue(true);
  h.service.endSessions.mockResolvedValue(2);
  h.inviteContactToPortal.mockResolvedValue({ ok: true, via: 'text' });
});

describe('papéis (PRD 082 §6.3)', () => {
  it('Configurações: admin+; agent recebe 403', async () => {
    roleIs('agent');
    expect((await getSettings(json('GET'))).status).toBe(403);
    expect((await patchSettings(json('PATCH', { enabled: true }))).status).toBe(
      403
    );
    expect(h.service.setSettings).not.toHaveBeenCalled();
  });

  it('Enviar acesso: agent+; viewer recebe 403', async () => {
    roleIs('viewer');
    expect((await invite(json('POST'), params('c1'))).status).toBe(403);
    roleIs('agent');
    expect((await invite(json('POST'), params('c1'))).status).toBe(200);
  });

  it('Bloquear e encerrar sessões: admin+; agent recebe 403', async () => {
    roleIs('agent');
    expect(
      (await block(json('POST', { blocked: true }), params('c1'))).status
    ).toBe(403);
    expect((await endSessions(json('DELETE'), params('c1'))).status).toBe(403);
    expect(h.service.setBlocked).not.toHaveBeenCalled();
    expect(h.service.endSessions).not.toHaveBeenCalled();
  });

  it('Estado do acesso: viewer+', async () => {
    roleIs('viewer');
    expect((await status(json('POST', { contactIds: ['c1'] }))).status).toBe(
      200
    );
  });
});

describe('plano sem o item (SPEC 083 §8.4, PRD 082 D-4)', () => {
  beforeEach(() => {
    h.hasFeature.mockResolvedValue(false);
  });

  it('GET settings é a única rota que responde 200: featureInPlan=false, sem tocar nas portal_*', async () => {
    roleIs('admin');
    const res = await getSettings(json('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      featureInPlan: false,
      settings: null,
      portalUrl: null,
    });
    expect(h.service.getSettings).not.toHaveBeenCalled();
  });

  it('PATCH settings → 403 FEATURE_NOT_IN_PLAN antes de validar o corpo', async () => {
    roleIs('owner');
    const res = await patchSettings(json('PATCH', { enabled: true }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'FEATURE_NOT_IN_PLAN' });
    expect(h.service.setSettings).not.toHaveBeenCalled();
  });

  it('status → 403 (o cartão da ficha some, sem toast)', async () => {
    roleIs('viewer');
    const res = await status(json('POST', { contactIds: ['c1'] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'FEATURE_NOT_IN_PLAN' });
    expect(h.service.accessStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['invite', () => invite(json('POST'), params('c1'))],
    ['block', () => block(json('POST', { blocked: true }), params('c1'))],
    ['sessions', () => endSessions(json('DELETE'), params('c1'))],
  ])('%s → 403 FEATURE_NOT_IN_PLAN, sem ação nem registro', async (_n, run) => {
    roleIs('owner');
    const res = await run();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('FEATURE_NOT_IN_PLAN');
    expect(h.inviteContactToPortal).not.toHaveBeenCalled();
    expect(h.service.setBlocked).not.toHaveBeenCalled();
    expect(h.service.endSessions).not.toHaveBeenCalled();
    expect(h.recordActivity).not.toHaveBeenCalled();
  });

  it('papel insuficiente vence o plano: agent no PATCH recebe 403 de papel, sem consultar o plano', async () => {
    roleIs('agent');
    const res = await patchSettings(json('PATCH', { enabled: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).not.toBe('FEATURE_NOT_IN_PLAN');
    expect(h.hasFeature).not.toHaveBeenCalled();
  });
});

describe('plano com o item', () => {
  it('GET settings devolve featureInPlan=true junto das configurações', async () => {
    roleIs('admin');
    h.service.getSettings.mockResolvedValue({
      eligible: true,
      publicCode: 'ABCD2345',
      enabled: true,
    });
    const body = await (await getSettings(json('GET'))).json();
    expect(body.featureInPlan).toBe(true);
    expect(body.portalUrl).toBe(`${BASE}/area/c/ABCD2345`);
  });
});

describe('contato fora do escopo do usuário (RLS) → 404 sem tocar no banco da área', () => {
  it.each([
    ['invite', () => invite(json('POST'), params('c9'))],
    ['block', () => block(json('POST', { blocked: true }), params('c9'))],
    ['sessions', () => endSessions(json('DELETE'), params('c9'))],
  ])('%s', async (_name, run) => {
    roleIs('owner');
    h.visibleContact.mockResolvedValue(null);
    expect((await run()).status).toBe(404);
    expect(h.inviteContactToPortal).not.toHaveBeenCalled();
    expect(h.service.setBlocked).not.toHaveBeenCalled();
    expect(h.service.endSessions).not.toHaveBeenCalled();
  });

  it('status só consulta os ids que a RLS deixa ver', async () => {
    roleIs('viewer');
    h.visibleContactIds.mockResolvedValue(['c1']);
    await status(json('POST', { contactIds: ['c1', 'c-de-outro-agente'] }));
    expect(h.service.accessStatus).toHaveBeenCalledWith('acc1', ['c1']);
  });
});

describe('convite (J1)', () => {
  it('ok registra contact.portal_invited', async () => {
    roleIs('agent');
    const res = await invite(json('POST'), params('c1'));
    expect(await res.json()).toEqual({ ok: true, via: 'text' });
    expect(h.recordActivity).toHaveBeenCalledWith(
      CTX.supabase,
      expect.objectContaining({
        action: 'contact.portal_invited',
        resourceType: 'contact',
        contactId: 'c1',
      })
    );
  });

  it('recusa volta com o motivo (opt-out → 409, limite → 429) e não registra', async () => {
    roleIs('agent');
    h.inviteContactToPortal.mockResolvedValueOnce({
      ok: false,
      reason: 'opted_out',
    });
    const r1 = await invite(json('POST'), params('c1'));
    expect(r1.status).toBe(409);
    expect((await r1.json()).code).toBe('opted_out');

    h.inviteContactToPortal.mockResolvedValueOnce({
      ok: false,
      reason: 'throttled',
    });
    expect((await invite(json('POST'), params('c1'))).status).toBe(429);
    expect(h.recordActivity).not.toHaveBeenCalled();
  });
});

describe('bloqueio', () => {
  it('bloquear e desbloquear registram a ação certa', async () => {
    roleIs('admin');
    await block(json('POST', { blocked: true }), params('c1'));
    await block(json('POST', { blocked: false }), params('c1'));
    const actions = h.recordActivity.mock.calls.map(
      (c) => (c[1] as { action: string }).action
    );
    expect(actions).toEqual([
      'contact.portal_blocked',
      'contact.portal_unblocked',
    ]);
  });

  it('corpo sem boolean → 400', async () => {
    roleIs('admin');
    expect(
      (await block(json('POST', { blocked: 'sim' }), params('c1'))).status
    ).toBe(400);
  });
});

describe('Configurações', () => {
  it('PATCH valida antes de gravar e devolve o endereço da área', async () => {
    roleIs('admin');
    expect((await patchSettings(json('PATCH', { keyword: 'x' }))).status).toBe(
      400
    );
    expect(
      (await patchSettings(json('PATCH', { channelId: 'nao-uuid' }))).status
    ).toBe(400);
    expect((await patchSettings(json('PATCH', {}))).status).toBe(400);
    expect(h.service.setSettings).not.toHaveBeenCalled();

    h.service.setSettings.mockResolvedValue({
      publicCode: 'ABCD2345',
      enabled: true,
    });
    const res = await patchSettings(
      json('PATCH', { enabled: true, keyword: ' acesso ' })
    );
    expect(res.status).toBe(200);
    expect(h.service.setSettings).toHaveBeenCalledWith(
      'acc1',
      { enabled: true, keyword: 'acesso' },
      'u1'
    );
    expect((await res.json()).portalUrl).toBe(`${BASE}/area/c/ABCD2345`);
  });
});
