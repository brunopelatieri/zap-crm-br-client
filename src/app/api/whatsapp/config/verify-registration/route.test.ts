import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 064 F4 — GET /api/whatsapp/config/verify-registration
//
// O diagnóstico passou a ser POR CANAL e a RECONCILIAR a linha de
// `channels` (D-9). Três coisas só ele pode errar:
//
//   1. escrever `error` num canal por uma indisponibilidade passageira
//      da Meta — agora que `channelSendBlock` barra Cloud fora de
//      `connected`, isso tira do ar um número que funciona;
//   2. reativar um canal que o operador desativou (D-12);
//   3. dizer "você nunca salvou nada" quando o que falhou foi a LEITURA
//      — a ação óbvia dali é recadastrar tudo, que é a errada.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const ACCOUNT = 'acct-1';

interface State {
  channels: Row[];
  whatsapp_config: Row[];
  profiles: Row[];
  fail: string[];
}

let state: State;

function makeClient() {
  function from(table: keyof State & string) {
    const filters: { op: 'eq' | 'neq'; col: string; val: unknown }[] = [];
    let op: 'select' | 'update' = 'select';
    let payload: Row = {};

    const rows = () =>
      (state[table] as Row[]).filter((r) =>
        filters.every((f) =>
          f.op === 'eq' ? r[f.col] === f.val : r[f.col] !== f.val
        )
      );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (): any => {
      if (state.fail.includes(table)) {
        return { data: null, error: { message: 'timeout' } };
      }
      if (op === 'update') {
        const matched = rows();
        for (const r of matched) Object.assign(r, payload);
        return { data: matched, error: null };
      }
      return { data: rows(), error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => {
      filters.push({ op: 'eq', col, val });
      return b;
    };
    b.neq = (col: string, val: unknown) => {
      filters.push({ op: 'neq', col, val });
      return b;
    };
    b.in = () => b;
    b.update = (p: Row) => {
      op = 'update';
      payload = p;
      return b;
    };
    b.maybeSingle = async () => {
      const res = run();
      if (res.error) return res;
      return { data: res.data[0] ?? null, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown) => resolve(run());
    return b;
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn(from),
  };
}

let supabaseMock = makeClient();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => supabaseMock),
}));

const verifyPhoneNumber = vi.fn(async () => ({
  id: '892352847302912',
  display_phone_number: '+55 19 99249-6598',
}));

// `importOriginal`: `MetaApiError`/`isMetaCredentialError` reais — é a
// regra deles que estes testes verificam.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/meta-api')>();
  return {
    ...actual,
    verifyPhoneNumber: () => verifyPhoneNumber(),
    getSubscribedApps: vi.fn(async () => [{ whatsapp_business_api_data: {} }]),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => String(v),
}));

import { MetaApiError } from '@/lib/whatsapp/meta-api';

import { GET } from './route';

beforeEach(() => {
  state = {
    profiles: [{ user_id: 'user-1', account_id: ACCOUNT }],
    channels: [
      {
        id: 'chan-cloud-1',
        account_id: ACCOUNT,
        type: 'whatsapp_cloud',
        name: 'WhatsApp Oficial',
        identifier: '892352847302912',
        status: 'disconnected',
        status_detail: null,
        is_default: true,
        connected_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    whatsapp_config: [
      {
        id: 'cfg-1',
        account_id: ACCOUNT,
        channel_id: 'chan-cloud-1',
        phone_number_id: '892352847302912',
        waba_id: '1596497364872182',
        access_token: 'token',
        registered_at: '2026-08-01T00:00:00.000Z',
      },
    ],
    fail: [],
  };
  supabaseMock = makeClient();
  verifyPhoneNumber.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
});

function get(query = '') {
  return GET(
    new Request(
      `http://localhost/api/whatsapp/config/verify-registration${query}`
    )
  );
}

describe('verify-registration por canal (SPEC 064 F4)', () => {
  it('reconcilia identifier e status com a resposta da Meta (D-9)', async () => {
    const body = await (await get()).json();

    expect(body.live).toBe(true);
    expect(state.channels[0].identifier).toBe('5519992496598');
    expect(state.channels[0].status).toBe('connected');
  });

  it('credencial reprovada (4xx) marca o canal `error`', async () => {
    verifyPhoneNumber.mockRejectedValueOnce(
      new MetaApiError('(#190) token expirado', 401, 190)
    );
    const body = await (await get()).json();

    expect(body.live).toBe(false);
    expect(state.channels[0].status).toBe('error');
  });

  it('Meta fora do ar (5xx) não pune o canal', async () => {
    state.channels[0].status = 'connected';
    verifyPhoneNumber.mockRejectedValueOnce(
      new MetaApiError('Meta API error: 502', 502, null)
    );
    const body = await (await get()).json();

    expect(body.errors[0]).toContain('Phone metadata check failed');
    expect(state.channels[0].status).toBe('connected');
  });

  it('não reativa um canal desativado (D-12)', async () => {
    state.channels[0].status = 'disabled';
    const body = await (await get()).json();

    expect(body.checks.config_exists).toBe(false);
    expect(state.channels[0].status).toBe('disabled');
    expect(verifyPhoneNumber).not.toHaveBeenCalled();
  });

  it('falha de LEITURA não vira "configuração não existe"', async () => {
    state.fail = ['channels'];
    const body = await (await get()).json();

    expect(body.checks.config_exists).toBeUndefined();
    expect(body.message).toContain('Could not read the configuration');
  });

  it('canal de outra conta não vaza', async () => {
    state.channels[0].account_id = 'acct-2';
    const body = await (await get('?channel_id=chan-cloud-1')).json();

    expect(body.checks.config_exists).toBe(false);
    expect(verifyPhoneNumber).not.toHaveBeenCalled();
  });
});
