/**
 * SPEC 070 §6.1/§6.3 (F7) — `draftId` no corpo de `POST /api/broadcasts/send`.
 *
 * O foco destes testes é a FRONTEIRA: o que a rota aceita, o que recusa
 * e com qual código. O plano/agendamento em si é mockado — quem o testa
 * de verdade é `broadcast-dispatch.test.ts`, contra o banco falso.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRole = vi.fn();
vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    ...actual,
    requireRole: (...args: unknown[]) => requireRole(...args),
  };
});

// O fan-out roda em `after()`; num teste ele nunca deve rodar.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn(),
}));

const planDashboardBroadcast = vi.fn();
const scheduleDashboardBroadcast = vi.fn();
const planAbTestBroadcast = vi.fn();
vi.mock('@/lib/whatsapp/broadcast-dispatch', () => ({
  SEND_BATCH_SIZE: 10,
  SEND_BATCH_DELAY_MS: 0,
  MAX_DASHBOARD_RECIPIENTS: 50_000,
  planDashboardBroadcast: (...args: unknown[]) =>
    planDashboardBroadcast(...args),
  scheduleDashboardBroadcast: (...args: unknown[]) =>
    scheduleDashboardBroadcast(...args),
  planAbTestBroadcast: (...args: unknown[]) => planAbTestBroadcast(...args),
}));

vi.mock('@/lib/whatsapp/broadcast-core', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/whatsapp/broadcast-core')
  >('@/lib/whatsapp/broadcast-core');
  return { ...actual, deliverBroadcast: vi.fn() };
});

const loadAccountQuota = vi.fn();
vi.mock('@/lib/whatsapp/messaging-limit-server', () => ({
  loadAccountQuota: (...args: unknown[]) => loadAccountQuota(...args),
}));

// Sem isto, o balde real conta as requisições de TODOS os casos deste
// arquivo como se fossem do mesmo minuto e o 6º vira 429.
vi.mock('@/lib/rate-limit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/rate-limit')>(
      '@/lib/rate-limit'
    );
  return {
    ...actual,
    checkRateLimit: () => ({
      success: true,
      limit: 100,
      remaining: 99,
      reset: 0,
    }),
  };
});

vi.mock('@/lib/broadcasts/audit', () => ({ logBroadcastAudit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));

import { POST } from './route';

const ACCOUNT = 'acct-1';
const DRAFT = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

/** Linha devolvida pela leitura de pré-condição do rascunho. */
let broadcastRow: Record<string, unknown> | null = null;

const supabase = {
  from: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = () =>
      Promise.resolve({ data: broadcastRow, error: null });
    return chain;
  },
};

function body(extra: Record<string, unknown> = {}) {
  return {
    name: 'Campanha X',
    templateName: 'promo',
    templateLanguage: 'pt_BR',
    audience: { type: 'all' },
    variables: {},
    // A janela de horário (§6.3) depende do relógio real; o override
    // mantém estes testes determinísticos, sem falhar de madrugada.
    windowOverride: true,
    ...extra,
  };
}

function request(payload: Record<string, unknown>) {
  return new Request('http://localhost/api/broadcasts/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  broadcastRow = { id: DRAFT, status: 'draft', source: 'dashboard' };
  requireRole.mockResolvedValue({
    supabase,
    userId: 'user-1',
    accountId: ACCOUNT,
    role: 'admin',
  });
  loadAccountQuota.mockResolvedValue({
    configured: true,
    snapshot: { batchLimit: 1000 },
  });
  planDashboardBroadcast.mockResolvedValue({
    broadcastId: DRAFT,
    totalRecipients: 1,
    planned: [{}],
    rejected: 0,
    excludedOptedOut: 0,
    excludedInvalidWhatsapp: 0,
  });
  scheduleDashboardBroadcast.mockResolvedValue({
    broadcastId: DRAFT,
    scheduledAt: '2026-09-10T12:00:00.000Z',
  });
});

describe('POST /api/broadcasts/send — draftId (SPEC 070 §6.1)', () => {
  it('adota a linha: repassa adoptBroadcastId ao planejamento', async () => {
    const res = await POST(request(body({ draftId: DRAFT })));

    expect(res.status).toBe(202);
    expect(planDashboardBroadcast).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ adoptBroadcastId: DRAFT })
    );
  });

  it('achado de code review (SPEC 070) — NUNCA repassa rowAlreadyClaimed: só o cron reivindica a linha antes de chamar', async () => {
    // Esta rota só LÊ o rascunho (resolveAdoptedDraft), nunca o
    // reivindica com um UPDATE atômico. Se `rowAlreadyClaimed` viesse
    // `true` daqui, materializeArm pararia de exigir `status = 'draft'`
    // no UPDATE de adoção, e duas abas disparando o mesmo rascunho
    // editado enviariam a campanha duas vezes.
    const res = await POST(request(body({ draftId: DRAFT })));

    expect(res.status).toBe(202);
    const call = planDashboardBroadcast.mock.calls[0][1];
    expect(call.rowAlreadyClaimed).toBeUndefined();
  });

  it('agendamento também adota — é o mesmo rascunho, com hora marcada', async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await POST(request(body({ draftId: DRAFT, scheduledAt: at })));

    expect(res.status).toBe(202);
    expect(scheduleDashboardBroadcast).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ adoptBroadcastId: DRAFT })
    );
  });

  it('draftId de outra conta devolve 404 — sem tocar em cota nem em audiência', async () => {
    // A RLS já não devolveria a linha; o 404 aqui é o que transforma
    // isso numa mensagem, em vez de um erro genérico lá na frente.
    broadcastRow = null;

    const res = await POST(request(body({ draftId: OTHER })));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: 'draft_not_found',
    });
    expect(loadAccountQuota).not.toHaveBeenCalled();
    expect(planDashboardBroadcast).not.toHaveBeenCalled();
  });

  it('campanha já enviada devolve 409 draft_not_editable, com o status no corpo', async () => {
    broadcastRow = { id: DRAFT, status: 'sent', source: 'dashboard' };

    const res = await POST(request(body({ draftId: DRAFT })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: 'draft_not_editable',
      status: 'sent',
    });
    expect(planDashboardBroadcast).not.toHaveBeenCalled();
  });

  it('funil de webhook devolve 400 — não é campanha disparável', async () => {
    broadcastRow = { id: DRAFT, status: 'draft', source: 'webhook' };

    const res = await POST(request(body({ draftId: DRAFT })));

    expect(res.status).toBe(400);
    expect(planDashboardBroadcast).not.toHaveBeenCalled();
  });

  it('variante de teste A/B devolve 400 — não se dispara sozinha', async () => {
    broadcastRow = {
      id: DRAFT,
      status: 'draft',
      source: 'dashboard',
      variant_label: 'B',
      parent_broadcast_id: 'bc-parent',
    };

    const res = await POST(request(body({ draftId: DRAFT })));

    expect(res.status).toBe(400);
    expect(planDashboardBroadcast).not.toHaveBeenCalled();
  });

  it('draftId malformado devolve 400 antes de consultar o banco', async () => {
    const res = await POST(request(body({ draftId: 'not-a-uuid' })));

    expect(res.status).toBe(400);
    expect(planDashboardBroadcast).not.toHaveBeenCalled();
  });

  it('draftId divergente de audience.draftId devolve 400 (§6.3)', async () => {
    // Aceitar em silêncio faria o disparo ADOTAR uma linha e LER a
    // audiência de outra.
    const res = await POST(
      request(
        body({
          draftId: DRAFT,
          audience: { type: 'staged', draftId: OTHER },
        })
      )
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'bad_request' });
    expect(planDashboardBroadcast).not.toHaveBeenCalled();
  });

  it('draftId ausente: comportamento de hoje, intacto', async () => {
    const res = await POST(request(body()));

    expect(res.status).toBe(202);
    expect(planDashboardBroadcast).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ adoptBroadcastId: undefined })
    );
  });
});
