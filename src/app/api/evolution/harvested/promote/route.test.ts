import { beforeEach, describe, expect, it, vi } from 'vitest';

const afterCallbacks: Array<() => unknown> = [];
vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
      json: async () => body,
    }),
  },
}));

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

const findExistingContact = vi.fn();
vi.mock('@/lib/contacts/dedupe', async () => {
  const actual = await vi.importActual<typeof import('@/lib/contacts/dedupe')>(
    '@/lib/contacts/dedupe'
  );
  return {
    ...actual,
    findExistingContact: (...args: unknown[]) => findExistingContact(...args),
  };
});

const fetchAndAttachAvatar = vi.fn();
vi.mock('@/lib/evolution/avatar', () => ({
  fetchAndAttachAvatar: (...args: unknown[]) => fetchAndAttachAvatar(...args),
}));

const readEvolutionConfig = vi.fn();
vi.mock('@/lib/evolution/config', () => ({
  readEvolutionConfig: () => readEvolutionConfig(),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

vi.mock('@/lib/notifications/quota', () => ({
  emitQuotaExceeded: vi.fn(),
}));

interface Scenario {
  harvestedRows: Array<Record<string, unknown>>;
  contactInsertError?: { code?: string; message?: string } | null;
  contactInsertData?: { id: string } | null;
}
let scenario: Scenario;
const contactInserts: Array<Record<string, unknown>> = [];
const harvestedUpdates: Array<Record<string, unknown>> = [];
const identityUpserts: Array<Record<string, unknown>> = [];

function makeAdminDb() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      let updatePayload: unknown;
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.single = () => {
        if (table === 'contacts') {
          return Promise.resolve({
            data: scenario.contactInsertData ?? { id: 'new-contact' },
            error: scenario.contactInsertError ?? null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      };
      chain.insert = (payload: Record<string, unknown>) => {
        if (table === 'contacts') {
          contactInserts.push(payload);
        }
        return chain;
      };
      chain.upsert = (payload: Record<string, unknown>) => {
        identityUpserts.push(payload);
        return Promise.resolve({ error: null });
      };
      chain.update = (p: unknown) => {
        updatePayload = p;
        return chain;
      };
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (updatePayload !== undefined) {
          harvestedUpdates.push(updatePayload as Record<string, unknown>);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        if (table === 'evolution_harvested_contacts') {
          return Promise.resolve({
            data: scenario.harvestedRows,
            error: null,
          }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeAdminDb(),
}));

import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/evolution/harvested/promote', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function harvestedRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'h1',
    channel_id: 'chan-1',
    jid: '5511900000001@s.whatsapp.net',
    phone_normalized: '5511900000001',
    push_name: 'Fulaninho',
    full_name: null,
    business_name: null,
    ...over,
  };
}

beforeEach(() => {
  afterCallbacks.length = 0;
  contactInserts.length = 0;
  harvestedUpdates.length = 0;
  identityUpserts.length = 0;
  findExistingContact.mockReset();
  findExistingContact.mockResolvedValue(null);
  fetchAndAttachAvatar.mockReset();
  readEvolutionConfig.mockReset();
  readEvolutionConfig.mockReturnValue(null); // desliga o after() por padrão
  requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Conta' },
  });
  scenario = { harvestedRows: [harvestedRow()] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/evolution/harvested/promote', () => {
  it('exige admin+', async () => {
    await POST(makeRequest({ ids: ['h1'] }));
    expect(requireRole).toHaveBeenCalledWith('admin');
  });

  it('ids vazio → 400', async () => {
    const res = await POST(makeRequest({ ids: [] }));
    expect(res.status).toBe(400);
  });

  it('caminho feliz: cria o contato com opt_in_status unknown e created_via harvest', async () => {
    const res = await POST(makeRequest({ ids: ['h1'] }));
    const body = await res.json();

    expect(body.promoted).toBe(1);
    expect(contactInserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      phone: '5511900000001',
      name: 'Fulaninho',
      opt_in_status: 'unknown',
      created_via: 'harvest',
    });
  });

  it('grava o vínculo em contact_identities com o Jid capturado', async () => {
    await POST(makeRequest({ ids: ['h1'] }));
    expect(identityUpserts[0]).toMatchObject({
      account_id: 'acct-1',
      channel_type: 'whatsapp_qr',
      external_id: '5511900000001@s.whatsapp.net',
    });
  });

  it('marca a linha da triagem como promoted, com quem e quando', async () => {
    await POST(makeRequest({ ids: ['h1'] }));
    const promoteUpdate = harvestedUpdates.find((u) => u.status === 'promoted');
    expect(promoteUpdate).toMatchObject({
      status: 'promoted',
      promoted_contact_id: 'new-contact',
      promoted_by: 'user-1',
    });
    expect(promoteUpdate?.promoted_at).toEqual(expect.any(String));
  });

  it('sem telefone (Jid @lid puro): blocked com no_phone_number, nada criado', async () => {
    scenario.harvestedRows = [harvestedRow({ phone_normalized: null })];
    const res = await POST(makeRequest({ ids: ['h1'] }));
    const body = await res.json();

    expect(body.promoted).toBe(0);
    expect(body.blocked).toContainEqual({
      id: 'h1',
      reason: 'no_phone_number',
    });
    expect(contactInserts).toHaveLength(0);
  });

  it('id não encontrado (outra conta ou já processado): reportado em skipped', async () => {
    scenario.harvestedRows = [];
    const res = await POST(makeRequest({ ids: ['h-outro'] }));
    const body = await res.json();

    expect(body.skipped).toContainEqual({
      id: 'h-outro',
      reason: 'not_found_or_already_processed',
    });
  });

  it('já existe um contato com esse telefone: vira duplicate, vinculado ao existente, NÃO cria de novo', async () => {
    findExistingContact.mockResolvedValue({ id: 'existing-contact' });
    const res = await POST(makeRequest({ ids: ['h1'] }));
    const body = await res.json();

    expect(contactInserts).toHaveLength(0);
    expect(body.promoted).toBe(0);
    const dupUpdate = harvestedUpdates.find((u) => u.status === 'duplicate');
    expect(dupUpdate).toMatchObject({
      status: 'duplicate',
      promoted_contact_id: 'existing-contact',
    });
  });

  it('quota de contatos estourada: blocked com quota_exceeded, PARCIAL — os dois ids são tentados', async () => {
    scenario.harvestedRows = [
      harvestedRow({ id: 'h1', phone_normalized: '5511900000001' }),
      harvestedRow({ id: 'h2', phone_normalized: '5511900000002' }),
    ];
    scenario.contactInsertError = {
      message: 'QUOTA_EXCEEDED:contacts:250:250',
    };

    const res = await POST(makeRequest({ ids: ['h1', 'h2'] }));
    const body = await res.json();

    // O mock devolve o mesmo erro para as duas tentativas — o que este
    // teste prova é que a SEGUNDA foi tentada (não abortou no primeiro
    // erro): os dois ids aparecem em blocked.
    expect(body.blocked).toEqual([
      { id: 'h1', reason: 'quota_exceeded' },
      { id: 'h2', reason: 'quota_exceeded' },
    ]);
    expect(contactInserts).toHaveLength(2);
  });

  it('config da Evolution ausente: não agenda busca de avatar em background', async () => {
    readEvolutionConfig.mockReturnValue(null);
    await POST(makeRequest({ ids: ['h1'] }));
    expect(afterCallbacks).toHaveLength(1); // agendado, mas...
    await afterCallbacks[0]();
    expect(fetchAndAttachAvatar).not.toHaveBeenCalled(); // ...sai cedo sem config.
  });
});
