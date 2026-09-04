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

const resolveCheckInstance = vi.fn();
vi.mock('@/lib/evolution/check-instance', () => ({
  resolveCheckInstance: (...args: unknown[]) => resolveCheckInstance(...args),
}));

const resolveCheckLimits = vi.fn();
vi.mock('@/lib/evolution/check-limits', () => ({
  resolveCheckLimits: (...args: unknown[]) => resolveCheckLimits(...args),
}));

const resolveAudienceContacts = vi.fn();
vi.mock('@/lib/audience/resolve', () => ({
  resolveAudienceContacts: (...args: unknown[]) =>
    resolveAudienceContacts(...args),
}));

const logBroadcastAudit = vi.fn();
vi.mock('@/lib/broadcasts/audit', () => ({
  logBroadcastAudit: (...args: unknown[]) => logBroadcastAudit(...args),
}));

/** Linha de `broadcasts` que o caminho R6 carrega, e a variante A/B. */
let broadcastRow: Record<string, unknown> | null = null;
let abVariantRow: Record<string, unknown> | null = null;
const broadcastUpdates: Array<Record<string, unknown>> = [];

let ownedContacts: Array<Record<string, unknown>> | null = [];
let alreadyQueuedRows: Array<{ contact_id: string }> = [];
const inserts: Array<Record<string, unknown>[]> = [];

const adminDb = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {};
    const filters: unknown[][] = [];
    let updatePayload: Record<string, unknown> | undefined;
    chain.select = () => chain;
    chain.eq = (...args: unknown[]) => {
      filters.push(args);
      return chain;
    };
    chain.is = () => chain;
    chain.in = () => chain;
    chain.update = (p: Record<string, unknown>) => {
      updatePayload = p;
      return chain;
    };
    chain.insert = (rows: Record<string, unknown>[]) => {
      inserts.push(rows);
      return Promise.resolve({ error: null });
    };
    chain.maybeSingle = () => {
      if (table === 'broadcasts') {
        // A consulta por `parent_broadcast_id` procura a variante B; a
        // outra carrega a própria campanha.
        const byParent = filters.some((f) => f[0] === 'parent_broadcast_id');
        return Promise.resolve({
          data: byParent ? abVariantRow : broadcastRow,
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (updatePayload !== undefined) {
        broadcastUpdates.push(updatePayload);
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      if (table === 'contact_check_queue') {
        return Promise.resolve({ data: alreadyQueuedRows, error: null }).then(
          resolve
        );
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    };
    return chain;
  },
} as unknown;

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => adminDb,
}));

const sessionDb = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.in = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'contacts') {
        return Promise.resolve({ data: ownedContacts, error: null }).then(
          resolve
        );
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    };
    return chain;
  },
};

import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/contacts/check-queue', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireRole.mockReset();
  resolveCheckInstance.mockReset();
  resolveCheckLimits.mockReset();
  resolveAudienceContacts.mockReset();
  logBroadcastAudit.mockReset();
  inserts.length = 0;
  broadcastUpdates.length = 0;
  broadcastRow = {
    id: 'b1',
    name: 'Campanha CLT',
    status: 'draft',
    audience_filter: { type: 'all' },
    parent_broadcast_id: null,
  };
  abVariantRow = null;
  resolveAudienceContacts.mockResolvedValue([
    { id: 'c1', phone: '5511900000001', phone_normalized: '5511900000001' },
    { id: 'c2', phone: '5511900000002', phone_normalized: '5511900000002' },
  ]);
  ownedContacts = [
    { id: 'c1', phone: '5511900000001', phone_normalized: '5511900000001' },
    { id: 'c2', phone: '5511900000002', phone_normalized: '5511900000002' },
  ];
  alreadyQueuedRows = [];
  requireRole.mockResolvedValue({
    supabase: sessionDb,
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Conta' },
  });
  resolveCheckInstance.mockResolvedValue({
    instanceId: 'inst-1',
    channelId: 'chan-1',
    token: 'tok',
  });
  resolveCheckLimits.mockResolvedValue({
    limits: {
      silenceHours: 0,
      perHour: 60,
      perDay: 300,
      minIntervalSeconds: 5,
      warmupDays: 14,
    },
    levels: {},
  });
});

describe('POST /api/contacts/check-queue', () => {
  it('JSON inválido → 400', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      body: '{not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('source ausente → 400', async () => {
    const res = await POST(makeRequest({ contactIds: ['c1'] }));
    expect(res.status).toBe(400);
  });

  it('contactIds vazio → 400', async () => {
    const res = await POST(
      makeRequest({ source: 'contacts_import', contactIds: [] })
    );
    expect(res.status).toBe(400);
  });

  it('source=broadcast sem broadcastId → 400', async () => {
    const res = await POST(makeRequest({ source: 'broadcast' }));
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it('contactIds com um id de outra conta → 403, NADA enfileirado', async () => {
    // Só um dos dois ids "pertence" à conta segundo a query de sessão.
    ownedContacts = [
      { id: 'c1', phone: '5511900000001', phone_normalized: '5511900000001' },
    ];

    const res = await POST(
      makeRequest({ source: 'contacts_import', contactIds: ['c1', 'c2'] })
    );

    expect(res.status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  it('sem instância validadora habilitada → 403', async () => {
    resolveCheckInstance.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ source: 'contacts_import', contactIds: ['c1', 'c2'] })
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/no instance enabled/);
    expect(inserts).toHaveLength(0);
  });

  it('caminho feliz: enfileira, devolve queued/checkChannelId/estimatedHours', async () => {
    const res = await POST(
      makeRequest({ source: 'contacts_import', contactIds: ['c1', 'c2'] })
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.checkChannelId).toBe('chan-1');
    // 2 contatos / 300 por dia * 24h = 0.16h → arredonda para cima: 1.
    expect(body.estimatedHours).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toHaveLength(2);
    expect(inserts[0][0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'c1',
      source: 'contacts_import',
      check_channel_id: 'chan-1',
    });
  });

  it('phone_normalized nulo cai em phone (contato antigo sem a coluna gerada)', async () => {
    ownedContacts = [
      { id: 'c1', phone: '551190000çraw', phone_normalized: null },
    ];

    await POST(makeRequest({ source: 'contacts_import', contactIds: ['c1'] }));

    expect(inserts[0][0]).toMatchObject({ phone_normalized: '551190000çraw' });
  });

  it('dedupe: contato já na fila é PULADO, não reinserido', async () => {
    alreadyQueuedRows = [{ contact_id: 'c1' }];

    const res = await POST(
      makeRequest({ source: 'contacts_import', contactIds: ['c1', 'c2'] })
    );

    const body = await res.json();
    expect(body.queued).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.skippedReason).toBe('already_checked');
    expect(inserts[0]).toHaveLength(1);
    expect(inserts[0][0]).toMatchObject({ contact_id: 'c2' });
  });

  it('todos já na fila: nenhum INSERT é sequer chamado', async () => {
    alreadyQueuedRows = [{ contact_id: 'c1' }, { contact_id: 'c2' }];

    const res = await POST(
      makeRequest({ source: 'contacts_import', contactIds: ['c1', 'c2'] })
    );

    const body = await res.json();
    expect(body.queued).toBe(0);
    expect(body.skipped).toBe(2);
    expect(inserts).toHaveLength(0);
  });
});

// ============================================================
// R6 — a campanha inteira entra na fila (SPEC 069 §7.3, F8)
// ============================================================

describe('POST /api/contacts/check-queue — source=broadcast', () => {
  it('caminho feliz: resolve a audiência, enfileira e põe a campanha em awaiting_check', async () => {
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(2);
    expect(body.broadcastStatus).toBe('awaiting_check');

    expect(inserts[0]).toHaveLength(2);
    expect(inserts[0][0]).toMatchObject({
      source: 'broadcast',
      broadcast_id: 'b1',
      check_channel_id: 'chan-1',
      requested_by: 'user-1',
    });

    expect(broadcastUpdates[0]).toMatchObject({
      status: 'awaiting_check',
      check_before_send: true,
      check_channel_id: 'chan-1',
    });
  });

  it('a campanha só vira awaiting_check DEPOIS do INSERT da fila', async () => {
    // Na ordem inversa, uma falha no INSERT deixaria a campanha
    // esperando por uma fila que nunca existiu — presa para sempre.
    await POST(makeRequest({ source: 'broadcast', broadcastId: 'b1' }));
    expect(inserts.length).toBeGreaterThan(0);
    expect(broadcastUpdates.length).toBeGreaterThan(0);
  });

  it('campanha inexistente (ou de outra conta) → 404, nada enfileirado', async () => {
    broadcastRow = null;
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b-outro' })
    );
    expect(res.status).toBe(404);
    expect(inserts).toHaveLength(0);
  });

  it('campanha já enviada → 409, nada enfileirado', async () => {
    broadcastRow = { ...broadcastRow, status: 'sent' };
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );
    expect(res.status).toBe(409);
    expect(inserts).toHaveLength(0);
  });

  it('campanha já em awaiting_check → 409 (já está na fila)', async () => {
    broadcastRow = { ...broadcastRow, status: 'awaiting_check' };
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );
    expect(res.status).toBe(409);
  });

  it('agendada (scheduled) é aceita — checar antes de disparar vale para agendamento', async () => {
    broadcastRow = { ...broadcastRow, status: 'scheduled' };
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );
    expect(res.status).toBe(202);
  });

  it('teste A/B é RECUSADO — dividir cada fatia entre dois braços é decisão que a SPEC não tomou', async () => {
    abVariantRow = { id: 'b1-variant' };
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/A\/B/);
    expect(inserts).toHaveLength(0);
  });

  it('a própria variante B nunca é enfileirada sozinha', async () => {
    broadcastRow = { ...broadcastRow, parent_broadcast_id: 'b-pai' };
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it('audience_filter malformado → 400, nada enfileirado', async () => {
    broadcastRow = { ...broadcastRow, audience_filter: { type: 'inventado' } };
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it('audiência vazia → 400 (não deixa uma campanha esperando uma fila vazia)', async () => {
    resolveAudienceContacts.mockResolvedValue([]);
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
    expect(broadcastUpdates).toHaveLength(0);
  });

  it('sem instância validadora → 403 antes de resolver a audiência (trabalho caro não é jogado fora)', async () => {
    resolveCheckInstance.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ source: 'broadcast', broadcastId: 'b1' })
    );
    expect(res.status).toBe(403);
    expect(resolveAudienceContacts).not.toHaveBeenCalled();
  });

  it('não cria etiquetas ao resolver a audiência — enfileirar não é disparar', async () => {
    await POST(makeRequest({ source: 'broadcast', broadcastId: 'b1' }));
    expect(resolveAudienceContacts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ canCreateTags: false })
    );
  });

  it('registra na trilha de auditoria quem pediu e quantos entraram', async () => {
    await POST(makeRequest({ source: 'broadcast', broadcastId: 'b1' }));
    expect(logBroadcastAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        broadcastId: 'b1',
        actorUserId: 'user-1',
        details: expect.objectContaining({
          reason: 'awaiting_check',
          queued: 2,
        }),
      })
    );
  });
});
