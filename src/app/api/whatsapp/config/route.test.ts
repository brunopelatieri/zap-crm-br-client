import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 064 F4 — GET/POST/DELETE /api/whatsapp/config
//
// Aqui o foco é a COSTURA da rota; a semântica de banco (idempotência,
// compensação, D-12) tem testes próprios em
// `lib/whatsapp/cloud-channel-crud.test.ts`, e a resolução de credencial
// em `cloud-channels.test.ts`. O que só a rota pode errar:
//
//   1. deixar um segredo escapar no payload da lista (§6.1);
//   2. criar um canal a mais quando o corpo vem sem `channel_id` — o
//      bundle antigo em cache POSTa exatamente assim;
//   3. apagar o número errado num `DELETE` sem `channel_id`;
//   4. engolir a recusa da trigger de quota como um 500 genérico.
//
// O banco falso responde por tabela e filtro, e devolve TODAS as
// colunas que a fixture tem — inclusive `access_token`. É de propósito:
// se a rota algum dia trocar as colunas nomeadas por um `select('*')`
// espalhado na resposta, o teste do item 1 quebra.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const ACCOUNT = 'acct-1';

interface State {
  channels: Row[];
  whatsapp_config: Row[];
  conversations: Row[];
  profiles: Row[];
  whatsapp_billing_status: Row[];
}

let state: State;

function makeClient() {
  function from(table: keyof State & string) {
    const filters: { op: 'eq' | 'neq'; col: string; val: unknown }[] = [];
    let inFilter: { col: string; vals: unknown[] } | null = null;
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    let wantCount = false;

    const rows = () =>
      state[table].filter(
        (r) =>
          filters.every((f) =>
            f.op === 'eq' ? r[f.col] === f.val : r[f.col] !== f.val
          ) &&
          (!inFilter || inFilter.vals.includes(r[inFilter.col]))
      );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (): any => {
      if (op === 'select') {
        const matched = rows();
        return wantCount
          ? { data: null, error: null, count: matched.length }
          : { data: matched, error: null, count: null };
      }
      if (op === 'insert') {
        const inserted = {
          id: `${table}-${state[table].length + 1}`,
          ...payload,
        };
        state[table].push(inserted);
        return { data: inserted, error: null };
      }
      if (op === 'update') {
        const matched = rows();
        for (const r of matched) Object.assign(r, payload);
        return { data: matched, error: null };
      }
      const matched = rows();
      state[table] = state[table].filter((r) => !matched.includes(r));
      return { data: matched, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    b.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count) wantCount = true;
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      filters.push({ op: 'eq', col, val });
      return b;
    };
    b.neq = (col: string, val: unknown) => {
      filters.push({ op: 'neq', col, val });
      return b;
    };
    b.in = (col: string, vals: unknown[]) => {
      inFilter = { col, vals };
      return b;
    };
    b.insert = (p: Row) => {
      op = 'insert';
      payload = p;
      return b;
    };
    b.update = (p: Row) => {
      op = 'update';
      payload = p;
      return b;
    };
    b.delete = () => {
      op = 'delete';
      return b;
    };
    b.maybeSingle = async () => {
      const res = run();
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
      return { data, error: null };
    };
    b.single = async () => {
      const res = run();
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
      return data
        ? { data, error: null }
        : { data: null, error: { message: 'no rows' } };
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
    rpc: vi.fn(async (fn: string) =>
      fn === 'plan_limit'
        ? { data: planLimit, error: null }
        : { data: null, error: null }
    ),
  };
}

let planLimit: number | null = 1;
let supabaseMock = makeClient();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}));

// O cliente de service_role é o MESMO banco falso: o que muda no
// mundo real é a RLS, que a fixture não simula. O que importa aqui é
// que a rota não use um cliente diferente para escapar do escopo de
// conta — todos os `select` continuam casando `account_id`.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => supabaseMock),
}));

const verifyPhoneNumber = vi.fn(async () => ({
  id: '892352847302912',
  display_phone_number: '+55 19 99249-6598',
  verified_name: 'Loja Teste',
}));
const registerPhoneNumber = vi.fn(async () => ({}));
const subscribeWabaToApp = vi.fn(async () => ({}));

// `importOriginal` de propósito: `MetaApiError` e `isMetaCredentialError`
// TÊM de ser os reais. A regra que a rota aplica — só 4xx marca o canal
// como `error` — é a coisa que estes testes verificam, e substituí-la por
// um dublê testaria o dublê.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/meta-api')>();
  return {
    ...actual,
    verifyPhoneNumber: () => verifyPhoneNumber(),
    registerPhoneNumber: () => registerPhoneNumber(),
    subscribeWabaToApp: () => subscribeWabaToApp(),
    getSubscribedApps: vi.fn(async () => [{ whatsapp_business_api_data: {} }]),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => {
    if (!String(v).startsWith('enc(')) throw new Error('bad ciphertext');
    return String(v).slice(4, -1);
  },
}));

import { MetaApiError } from '@/lib/whatsapp/meta-api';

import { DELETE, GET, POST } from './route';

const CHANNEL = {
  id: 'chan-cloud-1',
  account_id: ACCOUNT,
  user_id: 'user-1',
  type: 'whatsapp_cloud',
  name: 'WhatsApp Oficial',
  identifier: '892352847302912',
  status: 'disconnected',
  status_detail: null,
  is_default: true,
  connected_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

const CONFIG = {
  id: 'cfg-1',
  account_id: ACCOUNT,
  user_id: 'user-1',
  channel_id: 'chan-cloud-1',
  phone_number_id: '892352847302912',
  waba_id: '1596497364872182',
  access_token: 'enc(secret-token)',
  verify_token: 'enc(secret-verify)',
  status: 'connected',
  registered_at: '2026-08-01T00:00:00.000Z',
  last_registration_error: null,
  subscribed_apps_at: null,
  broadcast_cooldown_days: 21,
  messaging_limit_tier: 'TIER_2K',
  created_at: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  planLimit = 1;
  state = {
    profiles: [{ user_id: 'user-1', account_id: ACCOUNT }],
    channels: [{ ...CHANNEL }],
    whatsapp_config: [{ ...CONFIG }],
    conversations: [],
    whatsapp_billing_status: [],
  };
  supabaseMock = makeClient();
  verifyPhoneNumber.mockClear();
  registerPhoneNumber.mockClear();
  subscribeWabaToApp.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
});

function get(query = '') {
  return GET(new Request(`http://localhost/api/whatsapp/config${query}`));
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('GET — lista de números, sem segredo (§5/§6.1)', () => {
  it('devolve a lista e NENHUM token', async () => {
    const body = await (await get()).json();
    const raw = JSON.stringify(body);

    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({
      channel_id: 'chan-cloud-1',
      phone_number_id: '892352847302912',
      broadcast_cooldown_days: 21,
    });
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('secret-verify');
    expect(raw).not.toContain('access_token');
    expect(raw).not.toContain('verify_token');
  });

  it('reconcilia identifier e status com o que a Meta respondeu (D-9)', async () => {
    // O canal nasceu do backfill da 055: `identifier` guarda o
    // `phone_number_id` e `status` está congelado em `disconnected`.
    await get();

    expect(state.channels[0].identifier).toBe('5519992496598');
    expect(state.channels[0].status).toBe('connected');
  });

  it('a lista marca o identifier ainda não reconciliado como não-telefone', async () => {
    verifyPhoneNumber.mockRejectedValueOnce(
      new MetaApiError('token expirado', 401, 190)
    );
    const body = await (await get()).json();

    expect(body.channels[0].identifier_is_phone).toBe(false);
  });

  it('credencial REPROVADA pela Meta (4xx) deixa o canal em `error`', async () => {
    verifyPhoneNumber.mockRejectedValueOnce(
      new MetaApiError('(#190) token expirado', 401, 190)
    );
    const body = await (await get()).json();

    expect(body.reason).toBe('meta_api_error');
    expect(state.channels[0].status).toBe('error');
    expect(state.channels[0].status_detail).toBe('(#190) token expirado');
  });

  it('Meta fora do ar (5xx) NÃO marca o canal como `error`', async () => {
    // Com `STATUS_IS_MAINTAINED.whatsapp_cloud` em `true`, gravar
    // `error` aqui tiraria o número da API pública e do diálogo de
    // transferência por causa de dez segundos de indisponibilidade — e
    // ele ficaria assim até alguém reabrir esta aba, porque nenhum
    // caminho de envio re-sonda.
    state.channels[0].status = 'connected';
    verifyPhoneNumber.mockRejectedValueOnce(
      new MetaApiError('Meta API error: 503', 503, null)
    );
    const body = await (await get()).json();

    // O operador vê o problema...
    expect(body.reason).toBe('meta_api_error');
    // ...mas o canal continua utilizável.
    expect(state.channels[0].status).toBe('connected');
  });

  it('timeout de rede também não pune o canal', async () => {
    state.channels[0].status = 'connected';
    verifyPhoneNumber.mockRejectedValueOnce(new Error('fetch failed'));
    await get();

    expect(state.channels[0].status).toBe('connected');
  });

  it('429 é "tente de novo", não credencial inválida', async () => {
    state.channels[0].status = 'connected';
    verifyPhoneNumber.mockRejectedValueOnce(
      new MetaApiError('(#80007) Rate limit', 429, 80007)
    );
    await get();

    expect(state.channels[0].status).toBe('connected');
  });

  it('token indecifrável continua pedindo o reset, sem chamar a Meta', async () => {
    state.whatsapp_config[0].access_token = 'lixo';
    const body = await (await get()).json();

    expect(body.needs_reset).toBe(true);
    expect(body.reason).toBe('token_corrupted');
    expect(verifyPhoneNumber).not.toHaveBeenCalled();
  });

  it('?channel_id= vazio cai no canal padrão, não em "canal não existe"', async () => {
    const body = await (await get('?channel_id=')).json();
    expect(body.connected).toBe(true);
  });

  it('?channel_id= de outra conta não vaza nada', async () => {
    state.channels[0].account_id = 'acct-2';
    const body = await (await get('?channel_id=chan-cloud-1')).json();

    expect(body.connected).toBe(false);
    expect(body.reason).toBe('no_config');
  });
});

describe('POST — idempotência e criação (§5)', () => {
  it('sem channel_id, número já conhecido: atualiza, não cria um segundo canal', async () => {
    // É exatamente o que o bundle antigo em cache manda, e o que um
    // duplo clique repete.
    const res = await post({
      phone_number_id: '892352847302912',
      waba_id: '1596497364872182',
      access_token: 'novo-token',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.channel_id).toBe('chan-cloud-1');
    expect(state.channels).toHaveLength(1);
    expect(state.whatsapp_config).toHaveLength(1);
    expect(state.whatsapp_config[0].access_token).toBe('enc(novo-token)');
  });

  it('salvar escreve `channels`: status, telefone e connected_at (§1.1.E.1)', async () => {
    await post({
      phone_number_id: '892352847302912',
      access_token: 'novo-token',
    });

    expect(state.channels[0].status).toBe('connected');
    expect(state.channels[0].identifier).toBe('5519992496598');
    expect(state.channels[0].connected_at).not.toBeNull();
  });

  it('número novo cria canal + credencial, com rótulo sequencial', async () => {
    const res = await post({
      phone_number_id: '111111111111111',
      access_token: 'outro-token',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(state.channels).toHaveLength(2);
    expect(state.channels[1].name).toBe('WhatsApp Oficial 2');
    expect(state.whatsapp_config).toHaveLength(2);
    expect(state.whatsapp_config[1].channel_id).toBe(body.channel_id);
  });

  it('canal desativado é readotado, preservando cooldown e tier (D-12)', async () => {
    state.channels[0].status = 'disabled';
    state.whatsapp_config[0].access_token = '';

    await post({
      phone_number_id: '892352847302912',
      access_token: 'token-novo',
    });

    expect(state.channels).toHaveLength(1);
    expect(state.channels[0].status).toBe('connected');
    expect(state.whatsapp_config[0].broadcast_cooldown_days).toBe(21);
    expect(state.whatsapp_config[0].messaging_limit_tier).toBe('TIER_2K');
  });

  it('/register falhou: o canal continua `connected` — quem envia é a credencial', async () => {
    // O `/register` governa o ROTEAMENTO DE ENTRADA. Marcar o canal
    // como `error` aqui tiraria do ar um número que envia, por causa de
    // um PIN vencido — e a API pública passaria a recusá-lo.
    registerPhoneNumber.mockRejectedValueOnce(new Error('PIN inválido'));

    const body = await (
      await post({
        phone_number_id: '892352847302912',
        access_token: 'token',
        pin: '123456',
      })
    ).json();

    expect(body.registration_error).toBe('PIN inválido');
    expect(state.channels[0].status).toBe('connected');
    expect(state.channels[0].status_detail).toBe('PIN inválido');
  });

  describe('SPEC 076 §9.4 — credencial refeita zera os erros de leitura do monitor', () => {
    const SAVED_WABA = '1596497364872182';
    const failing = (waba: string): Row => ({
      account_id: ACCOUNT,
      waba_id: waba,
      health_overall: 'AVAILABLE',
      health_error_kind: 'auth',
      health_error_code: 190,
      health_error_message: 'Invalid OAuth access token',
      health_error_at: '2026-10-01T10:00:00.000Z',
      health_consecutive_failures: 3,
      health_next_retry_at: '2026-10-01T12:00:00.000Z',
      spend_error_kind: 'rate_limit',
      spend_error_code: 80008,
      spend_error_message: 'Rate limit',
      spend_error_at: '2026-10-01T10:00:00.000Z',
      spend_consecutive_failures: 2,
      spend_next_retry_at: '2026-10-01T12:00:00.000Z',
      payment_blocked_since: '2026-10-01T09:00:00.000Z',
    });

    it('zera health_error_*, spend_error_*, os contadores e os retries do WABA salvo', async () => {
      state.whatsapp_billing_status.push(failing(SAVED_WABA));

      const res = await post({
        phone_number_id: '892352847302912',
        waba_id: SAVED_WABA,
        access_token: 'novo-token',
      });
      expect(res.status).toBe(200);

      expect(state.whatsapp_billing_status[0]).toMatchObject({
        health_error_kind: null,
        health_error_code: null,
        health_error_message: null,
        health_error_at: null,
        health_consecutive_failures: 0,
        health_next_retry_at: null,
        spend_error_kind: null,
        spend_error_code: null,
        spend_error_message: null,
        spend_error_at: null,
        spend_consecutive_failures: 0,
        spend_next_retry_at: null,
        // O retrato e o episódio de pagamento não são da credencial.
        health_overall: 'AVAILABLE',
        payment_blocked_since: '2026-10-01T09:00:00.000Z',
      });
    });

    it('só o WABA salvo: outro WABA e outra conta ficam como estavam', async () => {
      state.whatsapp_billing_status.push(
        failing(SAVED_WABA),
        failing('999999999999999'),
        { ...failing(SAVED_WABA), account_id: 'acct-2' }
      );

      await post({
        phone_number_id: '892352847302912',
        waba_id: SAVED_WABA,
        access_token: 'novo-token',
      });

      expect(state.whatsapp_billing_status[0].health_error_kind).toBeNull();
      expect(state.whatsapp_billing_status[1].health_error_kind).toBe('auth');
      expect(state.whatsapp_billing_status[2].health_error_kind).toBe('auth');
    });

    it('vale também quando o /register falhou: o token novo FOI gravado', async () => {
      state.whatsapp_billing_status.push(failing(SAVED_WABA));
      registerPhoneNumber.mockRejectedValueOnce(new Error('PIN inválido'));

      const body = await (
        await post({
          phone_number_id: '892352847302912',
          waba_id: SAVED_WABA,
          access_token: 'novo-token',
          pin: '123456',
        })
      ).json();

      expect(body.registration_error).toBe('PIN inválido');
      expect(state.whatsapp_billing_status[0].health_error_kind).toBeNull();
    });

    it('falha do monitor (tabela ausente) nunca derruba o salvamento', async () => {
      // @ts-expect-error simula um projeto sem a migração 086
      delete state.whatsapp_billing_status;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await post({
        phone_number_id: '892352847302912',
        waba_id: SAVED_WABA,
        access_token: 'novo-token',
      });

      expect(res.status).toBe(200);
      expect((await res.json()).saved).toBe(true);
      errorSpy.mockRestore();
    });
  });

  it('plano sem número oficial recusa a CRIAÇÃO com 403', async () => {
    planLimit = 0;
    const res = await post({
      phone_number_id: '111111111111111',
      access_token: 'token',
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('quota_exceeded');
    expect(state.channels).toHaveLength(1);
  });

  it('plano sem número oficial NÃO bloqueia a atualização de um já conectado', async () => {
    planLimit = 0;
    const res = await post({
      phone_number_id: '892352847302912',
      access_token: 'token-rotacionado',
    });

    expect(res.status).toBe(200);
  });

  it('credencial órfã (channel_id nulo) é adotada, sem 500 no UNIQUE', async () => {
    // Estado das contas atingidas pelo §1.1.E.1 onde a 072 ainda não
    // rodou. Inserir uma segunda linha colidiria com o UNIQUE global de
    // `phone_number_id` e devolveria 500 em toda tentativa.
    state.channels = [];
    state.whatsapp_config[0].channel_id = null;

    const res = await post({
      phone_number_id: '892352847302912',
      access_token: 'token',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(state.whatsapp_config).toHaveLength(1);
    expect(state.whatsapp_config[0].channel_id).toBe(body.channel_id);
    expect(state.channels).toHaveLength(1);
    // O cooldown da linha adotada sobrevive.
    expect(state.whatsapp_config[0].broadcast_cooldown_days).toBe(21);
  });

  it('canal ÓRFÃO recebe a credencial em vez de um sucesso vazio', async () => {
    // `UPDATE` de zero linhas não é erro no PostgREST: sem o INSERT, a
    // rota responderia `success: true` sobre um canal que continua sem
    // credencial nenhuma.
    state.whatsapp_config = [];

    const res = await post({
      channel_id: 'chan-cloud-1',
      phone_number_id: '892352847302912',
      access_token: 'token',
    });

    expect(res.status).toBe(200);
    expect(state.whatsapp_config).toHaveLength(1);
    expect(state.whatsapp_config[0]).toMatchObject({
      channel_id: 'chan-cloud-1',
      account_id: ACCOUNT,
      access_token: 'enc(token)',
    });
  });

  it('WABA em branco no corpo NÃO apaga o que o D-12 preservou', async () => {
    // É o fluxo de reconexão que a própria F4 criou: depois do "Reset
    // Configuration" o canal fica `disabled` e some da lista, então o
    // formulário abre vazio. Sobrescrever com null pularia
    // `subscribeWabaToApp` e pararia a entrada de eventos.
    state.channels[0].status = 'disabled';
    state.whatsapp_config[0].access_token = '';

    await post({
      phone_number_id: '892352847302912',
      access_token: 'token-novo',
      waba_id: null,
    });

    expect(state.whatsapp_config[0].waba_id).toBe('1596497364872182');
    expect(subscribeWabaToApp).toHaveBeenCalled();
  });

  it('WABA novo no corpo continua substituindo o antigo', async () => {
    await post({
      phone_number_id: '892352847302912',
      access_token: 'token',
      waba_id: '999888777',
    });

    expect(state.whatsapp_config[0].waba_id).toBe('999888777');
  });

  // Achado de code review (migração 073): a tela NUNCA pré-preenche o
  // App Secret (mesmo tratamento do access_token/verify_token), então
  // "salvar sem mexer nele" é o caminho comum — rotacionar o token,
  // atualizar o PIN. Sem preservar, isso apagava silenciosamente o
  // App Secret do segundo número, reabrindo o próprio bug ("invalid
  // signature" no webhook) que a coluna existe para fechar.
  it('App Secret em branco no corpo NÃO apaga o que já estava salvo', async () => {
    state.whatsapp_config[0].app_secret = 'enc(secret-app-b)';

    await post({
      phone_number_id: '892352847302912',
      access_token: 'token-novo',
      // app_secret ausente — simula o formulário reenviando as outras
      // credenciais sem o operador ter tocado neste campo.
    });

    expect(state.whatsapp_config[0].app_secret).toBe('enc(secret-app-b)');
  });

  it('App Secret novo no corpo continua substituindo o antigo', async () => {
    state.whatsapp_config[0].app_secret = 'enc(secret-app-b)';

    await post({
      phone_number_id: '892352847302912',
      access_token: 'token-novo',
      app_secret: 'secret-app-c',
    });

    expect(state.whatsapp_config[0].app_secret).toBe('enc(secret-app-c)');
  });

  it('canal explícito de outra conta é 404', async () => {
    state.channels[0].account_id = 'acct-2';
    const res = await post({
      channel_id: 'chan-cloud-1',
      phone_number_id: '892352847302912',
      access_token: 'token',
    });

    expect(res.status).toBe(404);
  });

  it('número de OUTRA conta continua respondendo 409 (D-8)', async () => {
    state.whatsapp_config.push({
      ...CONFIG,
      id: 'cfg-2',
      account_id: 'acct-2',
      channel_id: 'chan-outro',
      phone_number_id: '222222222222222',
    });

    const res = await post({
      phone_number_id: '222222222222222',
      access_token: 'token',
    });

    expect(res.status).toBe(409);
  });
});

describe('DELETE — exige channel_id (D-12)', () => {
  it('sem channel_id, recusa em vez de adivinhar qual número apagar', async () => {
    const res = await DELETE(
      new Request('http://localhost/api/whatsapp/config', { method: 'DELETE' })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('channel_id_required');
    expect(state.channels).toHaveLength(1);
  });

  it('sem conversas, apaga o canal', async () => {
    const res = await DELETE(
      new Request(
        'http://localhost/api/whatsapp/config?channel_id=chan-cloud-1',
        { method: 'DELETE' }
      )
    );

    expect((await res.json()).outcome).toBe('deleted');
    expect(state.channels).toHaveLength(0);
  });

  it('com conversas, zera o segredo e desativa — o "Reset Configuration"', async () => {
    state.conversations.push({ id: 'conv-1', channel_id: 'chan-cloud-1' });

    const res = await DELETE(
      new Request(
        'http://localhost/api/whatsapp/config?channel_id=chan-cloud-1',
        { method: 'DELETE' }
      )
    );

    expect((await res.json()).outcome).toBe('disabled');
    expect(state.channels[0].status).toBe('disabled');
    expect(state.whatsapp_config[0].access_token).toBe('');
    expect(state.whatsapp_config[0].broadcast_cooldown_days).toBe(21);
  });
});
