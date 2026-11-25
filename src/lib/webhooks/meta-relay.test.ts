import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
}));

// Controla a guarda SSRF por teste.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { MAX_CONSECUTIVE_FAILURES } from './deliver';
import {
  __resetMetaRelayStateForTests,
  buildRelayTestPayload,
  planMetaRelay,
  relayMetaWebhook as relayMetaWebhookWithSigner,
  sendRelayTest,
} from './meta-relay';
import type { MetaWebhookSigner } from '@/lib/whatsapp/webhook-signature';
import { verifySignatureHeader } from './sign';
import { isDeliverableUrl } from './ssrf';
import {
  accountUpdateChange,
  callsChange,
  envelope,
  envelopeOf,
  messagesChange,
  realMessagesRawBody,
  realStatusesRawBody,
  templateStatusChange,
} from './meta-relay.fixtures';

// ============================================================
// §7.1 — planMetaRelay (pura)
// ============================================================

const PNID_A = '100000000000001';
const PNID_A2 = '100000000000002';
const PNID_B = '200000000000001';
const WA_A = '5511900000001';
const WA_B = '5521900000002';

const owners = (pairs: Array<[string, string]>) => new Map(pairs);

describe('planMetaRelay', () => {
  it('1. POST só de números da conta A: A recebe raw', () => {
    const body = envelope('waba-a', [
      messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
      callsChange({ phoneNumberId: PNID_A2, waId: WA_A }),
    ]);
    const plans = planMetaRelay(
      body,
      owners([
        [PNID_A, 'acct-a'],
        [PNID_A2, 'acct-a'],
      ])
    );
    expect([...plans.keys()]).toEqual(['acct-a']);
    expect(plans.get('acct-a')).toEqual({ kind: 'raw' });
  });

  it('2. números de A e de B: cada um recebe filtered só com os seus changes, sem vazar o outro', () => {
    const body = envelopeOf([
      {
        id: 'waba-shared',
        changes: [
          messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
          messagesChange({ phoneNumberId: PNID_B, waId: WA_B }),
        ],
      },
      {
        id: 'waba-b',
        changes: [callsChange({ phoneNumberId: PNID_B, waId: WA_B })],
      },
    ]);
    const plans = planMetaRelay(
      body,
      owners([
        [PNID_A, 'acct-a'],
        [PNID_B, 'acct-b'],
      ])
    );

    const a = plans.get('acct-a');
    const b = plans.get('acct-b');
    expect(a?.kind).toBe('filtered');
    expect(b?.kind).toBe('filtered');
    if (a?.kind !== 'filtered' || b?.kind !== 'filtered') return;

    const aJson = JSON.stringify(a.body);
    const bJson = JSON.stringify(b.body);
    expect(aJson).not.toContain(PNID_B);
    expect(aJson).not.toContain(WA_B);
    expect(aJson).toContain(PNID_A);
    expect(aJson).toContain(WA_A);
    expect(bJson).not.toContain(PNID_A);
    expect(bJson).not.toContain(WA_A);
    expect(bJson).toContain(PNID_B);

    // A: a entry sem changes dele (waba-b) foi removida.
    expect((a.body.entry as unknown[]).length).toBe(1);
    // B: as duas entries sobrevivem, cada uma com seu change.
    expect((b.body.entry as unknown[]).length).toBe(2);
  });

  it('3. número fora do CRM junto com um de A: A recebe filtered; o outro não vai para ninguém', () => {
    const body = envelope('waba-a', [
      messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
      messagesChange({ phoneNumberId: '999999999999999', waId: WA_B }),
    ]);
    const plans = planMetaRelay(body, owners([[PNID_A, 'acct-a']]));

    expect([...plans.keys()]).toEqual(['acct-a']);
    const a = plans.get('acct-a');
    expect(a?.kind).toBe('filtered');
    if (a?.kind !== 'filtered') return;
    const json = JSON.stringify(a.body);
    expect(json).not.toContain('999999999999999');
    expect(json).not.toContain(WA_B);
  });

  it('4. número ausente de `owners` (canal disabled, duplicado, apagado): sem dono', () => {
    const body = envelope('waba-a', [
      messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
    ]);
    expect(planMetaRelay(body, new Map()).size).toBe(0);
  });

  it('5. change sem metadata (template, conta): sem dono, mesmo com entry.id = WABA da conta', () => {
    // O `owners` só conhece números; o WABA 'waba-a' nunca decide dono.
    const body = envelope('waba-a', [
      templateStatusChange(),
      accountUpdateChange(),
    ]);
    expect(planMetaRelay(body, owners([[PNID_A, 'acct-a']])).size).toBe(0);

    // E num POST misto, o evento de WABA sai do filtered.
    const mixed = envelope('waba-a', [
      messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
      templateStatusChange(),
    ]);
    const plan = planMetaRelay(mixed, owners([[PNID_A, 'acct-a']])).get(
      'acct-a'
    );
    expect(plan?.kind).toBe('filtered');
    if (plan?.kind !== 'filtered') return;
    expect(JSON.stringify(plan.body)).not.toContain(
      'message_template_status_update'
    );
  });

  it('6. filtered preserva chaves de topo e campos desconhecidos do change', () => {
    const own = messagesChange({ phoneNumberId: PNID_A, waId: WA_A });
    const other = messagesChange({ phoneNumberId: PNID_B, waId: WA_B });
    const body = envelope('waba-a', [own, other]);
    const plan = planMetaRelay(
      body,
      owners([
        [PNID_A, 'acct-a'],
        [PNID_B, 'acct-b'],
      ])
    ).get('acct-a');
    expect(plan?.kind).toBe('filtered');
    if (plan?.kind !== 'filtered') return;

    expect(plan.body.object).toBe('whatsapp_business_account');
    const entry = (plan.body.entry as Record<string, unknown>[])[0];
    expect(entry.id).toBe('waba-a');
    // O change da conta sai idêntico (inclui `user_id`/`from_user_id`,
    // campos que o CRM não modela).
    expect(entry.changes).toEqual([own]);
  });

  it('7. corpo sem entry, entry vazio, changes ausente ou forma inesperada: mapa vazio, sem lançar', () => {
    const o = owners([[PNID_A, 'acct-a']]);
    const bad: unknown[] = [
      null,
      undefined,
      'texto',
      42,
      [],
      {},
      { object: 'whatsapp_business_account' },
      { entry: [] },
      { entry: 'x' },
      { entry: [{ id: 'waba-a' }] },
      { entry: [{ id: 'waba-a', changes: [] }] },
      { entry: [null, 3, 'x'] },
      {
        entry: [{ id: 'waba-a', changes: [null, 'x', { field: 'messages' }] }],
      },
      {
        entry: [{ id: 'waba-a', changes: [{ field: 'messages', value: 'x' }] }],
      },
    ];
    for (const body of bad) {
      expect(() => planMetaRelay(body, o)).not.toThrow();
      expect(planMetaRelay(body, o).size).toBe(0);
    }
  });

  it('entry/change malformado ao lado de um change da conta: filtered, nunca raw', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        { id: 'waba-a', changes: [messagesChange({ phoneNumberId: PNID_A })] },
        'lixo',
      ],
    };
    const plan = planMetaRelay(body, owners([[PNID_A, 'acct-a']])).get(
      'acct-a'
    );
    expect(plan?.kind).toBe('filtered');
  });
});

// ============================================================
// §7.2 — relayMetaWebhook, sendRelayTest
// ============================================================

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string } | null;

/** POST assinado com o `META_APP_SECRET` (App padrão): vale para todo número. */
const DEFAULT_SIGNER: MetaWebhookSigner = { kind: 'default' };

/**
 * Os testes anteriores à correção do achado 1 descrevem POSTs do App
 * padrão; o escopo de segredo de canal tem testes próprios abaixo.
 */
function relayMetaWebhook(
  db: SupabaseClient,
  input: { rawBody: string; body: unknown; signer?: MetaWebhookSigner }
) {
  return relayMetaWebhookWithSigner(db, {
    ...input,
    signer: input.signer ?? DEFAULT_SIGNER,
  });
}

interface FakeState {
  relays: Row[];
  configs: Row[];
  channels: Row[];
  errors: Partial<Record<string, DbError>>;
  rpcError: DbError;
  reads: string[];
  updates: { table: string; payload: Row; filters: unknown[][] }[];
  rpcs: { name: string; args: Row }[];
}

function newState(partial: Partial<FakeState> = {}): FakeState {
  return {
    relays: [],
    configs: [],
    channels: [],
    errors: {},
    rpcError: null,
    reads: [],
    updates: [],
    rpcs: [],
    ...partial,
  };
}

function makeDb(state: FakeState): SupabaseClient {
  const tableRows = (table: string): Row[] =>
    table === 'meta_webhook_relays'
      ? state.relays
      : table === 'whatsapp_config'
        ? state.configs
        : table === 'channels'
          ? state.channels
          : [];

  const from = (table: string) => {
    const filters: unknown[][] = [];
    let mode: 'select' | 'update' = 'select';
    let payload: Row = {};

    const run = () => {
      if (mode === 'update') {
        state.updates.push({ table, payload, filters: [...filters] });
        return { data: null, error: null };
      }
      state.reads.push(table);
      const err = state.errors[table];
      if (err) return { data: null, error: err };
      const rows = tableRows(table).filter((row) =>
        filters.every(([kind, col, val]) =>
          kind === 'eq'
            ? row[col as string] === val
            : (val as unknown[]).includes(row[col as string])
        )
      );
      return { data: rows, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push(['eq', col, val]);
        return b;
      },
      in: (col: string, val: unknown[]) => {
        filters.push(['in', col, val]);
        return b;
      },
      update: (p: Row) => {
        mode = 'update';
        payload = p;
        return b;
      },
      maybeSingle: () => {
        const res = run();
        const rows = (res.data as Row[] | null) ?? [];
        return Promise.resolve({ data: rows[0] ?? null, error: res.error });
      },
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    };
    return b;
  };

  const rpc = (name: string, args: Row) => {
    state.rpcs.push({ name, args });
    return Promise.resolve({ data: null, error: state.rpcError });
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const SECRET_A = 'whrelay_secret_a';
const SECRET_B = 'whrelay_secret_b';

const relayRow = (
  accountId: string,
  url: string,
  secret: string,
  isEnabled = true
): Row => ({
  account_id: accountId,
  url,
  secret,
  is_enabled: isEnabled,
});

const cfg = (
  accountId: string,
  pnid: string,
  channelId: string | null
): Row => ({
  account_id: accountId,
  channel_id: channelId,
  phone_number_id: pnid,
});
const chan = (id: string, accountId: string, status = 'connected'): Row => ({
  id,
  account_id: accountId,
  status,
});

/** Conta A com um número ativo, relay ligado. */
function stateForA(extra: Partial<FakeState> = {}): FakeState {
  return newState({
    relays: [relayRow('acct-a', 'https://a.test/hook', SECRET_A)],
    configs: [cfg('acct-a', PNID_A, 'chan-a')],
    channels: [chan('chan-a', 'acct-a')],
    ...extra,
  });
}

type FetchCall = [string, RequestInit & { headers: Record<string, string> }];

function stubFetch(
  impl: () => Promise<Partial<Response>> = async () => ({
    ok: true,
    status: 200,
  })
) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const fetchCalls = (m: ReturnType<typeof stubFetch>) =>
  m.mock.calls as unknown as FetchCall[];

const headerKeys = (call: FetchCall) =>
  Object.keys(call[1].headers).map((k) => k.toLowerCase());

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  __resetMetaRelayStateForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function inboundBody() {
  return envelope('waba-a', [
    messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
  ]);
}

/**
 * rawBody como a Meta o envia: JSON compacto, não-ASCII escapado como
 * `\uXXXX` e `/` escapado como `\/`. Montado POR CÓDIGO (sem digitar
 * escapes no arquivo): difere de `JSON.stringify(JSON.parse(raw))`.
 */
function metaStyleRawBody(): string {
  const BACKSLASH = String.fromCharCode(92);
  const compact = JSON.stringify(
    envelope('waba-a', [
      messagesChange({
        phoneNumberId: PNID_A,
        waId: WA_A,
        text: 'ação já feita ✓ 😀 em a/b',
      }),
    ])
  );
  let out = '';
  for (let i = 0; i < compact.length; i++) {
    const unit = compact.charCodeAt(i);
    if (compact[i] === '/') out += `${BACKSLASH}/`;
    else if (unit <= 127) out += compact[i];
    // Fora do BMP já são duas unidades (par substituto), como a Meta faz.
    else out += `${BACKSLASH}u${unit.toString(16).padStart(4, '0')}`;
  }
  return out;
}

describe('relayMetaWebhook', () => {
  it('1. nenhum repetidor ligado: nenhuma leitura de whatsapp_config, nenhum fetch', async () => {
    const fetchMock = stubFetch();
    const state = stateForA({ relays: [] });

    await relayMetaWebhook(makeDb(state), {
      rawBody: JSON.stringify(inboundBody()),
      body: inboundBody(),
    });

    expect(state.reads).toEqual(['meta_webhook_relays']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2. plano raw: o body do fetch é IDÊNTICO (===) ao rawBody', async () => {
    const fetchMock = stubFetch();
    const rawBody = metaStyleRawBody();
    // Pré-condição do teste: a forma da Meta não sobrevive a um
    // parse+stringify, então qualquer re-serialização seria detectada.
    expect(rawBody).not.toBe(JSON.stringify(JSON.parse(rawBody)));
    expect(rawBody).toContain(String.fromCharCode(92) + '/');

    await relayMetaWebhook(makeDb(stateForA()), {
      rawBody,
      body: JSON.parse(rawBody),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCalls(fetchMock)[0][1].body === rawBody).toBe(true);
  });

  it('3. nenhuma entrega leva X-Hub-Signature-256; X-Wacrm-Signature confere sobre o corpo enviado', async () => {
    const fetchMock = stubFetch();
    const body = inboundBody();
    const rawBody = JSON.stringify(body);

    await relayMetaWebhook(makeDb(stateForA()), { rawBody, body });

    const [url, opts] = fetchCalls(fetchMock)[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.redirect).toBe('manual');
    expect(headerKeys(fetchCalls(fetchMock)[0])).not.toContain(
      'x-hub-signature-256'
    );
    expect(opts.headers['X-Wacrm-Event']).toBe('meta.webhook_raw');
    expect(opts.headers['X-Wacrm-Delivery-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(opts.headers['X-Wacrm-Test']).toBeUndefined();
    expect(
      verifySignatureHeader(
        opts.headers['X-Wacrm-Signature'],
        opts.body as string,
        SECRET_A,
        Math.floor(Date.now() / 1000)
      )
    ).toBe(true);
    // A chave de outra conta não confere.
    expect(
      verifySignatureHeader(
        opts.headers['X-Wacrm-Signature'],
        opts.body as string,
        SECRET_B,
        Math.floor(Date.now() / 1000)
      )
    ).toBe(false);
  });

  it('4. repetidor desligado: nada é enviado, mesmo com evento da conta', async () => {
    const fetchMock = stubFetch();
    const state = stateForA({
      relays: [relayRow('acct-a', 'https://a.test/hook', SECRET_A, false)],
    });

    await relayMetaWebhook(makeDb(state), {
      rawBody: JSON.stringify(inboundBody()),
      body: inboundBody(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.rpcs).toHaveLength(0);
  });

  it('5. destino não público: sem fetch, record_meta_relay_failure chamada', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = stubFetch();
    const state = stateForA();

    await relayMetaWebhook(makeDb(state), {
      rawBody: JSON.stringify(inboundBody()),
      body: inboundBody(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.rpcs).toEqual([
      {
        name: 'record_meta_relay_failure',
        args: {
          p_account_id: 'acct-a',
          p_max_failures: MAX_CONSECUTIVE_FAILURES,
        },
      },
    ]);
  });

  it('6. não-2xx e timeout registram falha; 2xx zera o contador', async () => {
    const run = async (fetchImpl: () => Promise<Partial<Response>>) => {
      stubFetch(fetchImpl);
      const state = stateForA();
      await relayMetaWebhook(makeDb(state), {
        rawBody: JSON.stringify(inboundBody()),
        body: inboundBody(),
      });
      return state;
    };

    const http500 = await run(async () => ({ ok: false, status: 500 }));
    expect(http500.rpcs).toHaveLength(1);
    expect(http500.updates).toHaveLength(0);

    // Redirect (manual) chega como 3xx e conta como falha.
    const http302 = await run(async () => ({ ok: false, status: 302 }));
    expect(http302.rpcs).toHaveLength(1);

    const timeout = await run(async () => {
      throw new DOMException('signal timed out', 'TimeoutError');
    });
    expect(timeout.rpcs).toHaveLength(1);
    expect(timeout.updates).toHaveLength(0);

    const ok = await run(async () => ({ ok: true, status: 200 }));
    expect(ok.rpcs).toHaveLength(0);
    expect(ok.updates).toHaveLength(1);
    expect(ok.updates[0].table).toBe('meta_webhook_relays');
    expect(ok.updates[0].payload).toMatchObject({ failure_count: 0 });
    expect(typeof ok.updates[0].payload.last_delivery_at).toBe('string');
    expect(ok.updates[0].filters).toEqual([
      ['eq', 'account_id', 'acct-a'],
      ['eq', 'is_enabled', true],
    ]);
  });

  it('7. erro de banco, tabela ausente ou exceção no fetch: resolve sem lançar', async () => {
    const body = inboundBody();
    const input = { rawBody: JSON.stringify(body), body };

    // Erro genérico ao ler os repetidores.
    stubFetch();
    await expect(
      relayMetaWebhook(
        makeDb(
          stateForA({
            errors: { meta_webhook_relays: { code: '57014', message: 'x' } },
          })
        ),
        input
      )
    ).resolves.toBeUndefined();

    // Erro ao resolver os números.
    await expect(
      relayMetaWebhook(
        makeDb(stateForA({ errors: { whatsapp_config: { message: 'boom' } } })),
        input
      )
    ).resolves.toBeUndefined();

    // fetch lança.
    stubFetch(async () => {
      throw new Error('socket hang up');
    });
    const state = stateForA();
    await expect(
      relayMetaWebhook(makeDb(state), input)
    ).resolves.toBeUndefined();
    expect(state.rpcs).toHaveLength(1);

    // O próprio cliente do banco lança.
    const throwing = {
      from: () => {
        throw new Error('client exploded');
      },
    } as unknown as SupabaseClient;
    await expect(relayMetaWebhook(throwing, input)).resolves.toBeUndefined();
  });

  it('7b. tabela ausente (migração 101 não aplicada): inerte, um aviso por processo, sem nova consulta', async () => {
    const fetchMock = stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = inboundBody();
    const input = { rawBody: JSON.stringify(body), body };
    const state = stateForA({
      errors: {
        meta_webhook_relays: { code: 'PGRST205', message: 'no table' },
      },
    });
    const db = makeDb(state);

    await relayMetaWebhook(db, input);
    await relayMetaWebhook(db, input);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(state.reads).toEqual(['meta_webhook_relays']); // 2ª chamada não consulta
    // Sem corpo, chave ou URL no aviso.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('a.test');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET_A);
  });

  describe('isolamento entre contas (R-1, D-1, D-5, D-6)', () => {
    const twoAccounts = (extra: Partial<FakeState> = {}): FakeState =>
      newState({
        relays: [
          relayRow('acct-a', 'https://a.test/hook', SECRET_A),
          relayRow('acct-b', 'https://b.test/hook', SECRET_B),
        ],
        configs: [
          cfg('acct-a', PNID_A, 'chan-a'),
          cfg('acct-b', PNID_B, 'chan-b'),
        ],
        channels: [chan('chan-a', 'acct-a'), chan('chan-b', 'acct-b')],
        ...extra,
      });

    it('POST misto: cada URL recebe só o que é da própria conta, assinado com a própria chave', async () => {
      const fetchMock = stubFetch();
      const body = envelope('waba-shared', [
        messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
        callsChange({ phoneNumberId: PNID_B, waId: WA_B }),
      ]);

      await relayMetaWebhook(makeDb(twoAccounts()), {
        rawBody: JSON.stringify(body),
        body,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const byUrl = new Map(
        fetchCalls(fetchMock).map((c) => [c[0], c] as const)
      );
      const toA = byUrl.get('https://a.test/hook')!;
      const toB = byUrl.get('https://b.test/hook')!;
      expect(toA[1].body).not.toContain(PNID_B);
      expect(toA[1].body).not.toContain(WA_B);
      expect(toB[1].body).not.toContain(PNID_A);
      expect(toB[1].body).not.toContain(WA_A);

      const now = Math.floor(Date.now() / 1000);
      expect(
        verifySignatureHeader(
          toA[1].headers['X-Wacrm-Signature'],
          toA[1].body as string,
          SECRET_A,
          now
        )
      ).toBe(true);
      expect(
        verifySignatureHeader(
          toB[1].headers['X-Wacrm-Signature'],
          toB[1].body as string,
          SECRET_B,
          now
        )
      ).toBe(true);
    });

    it('conta sem repetidor ligado não recebe, e o outro lado continua', async () => {
      const fetchMock = stubFetch();
      const body = envelope('waba-shared', [
        messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
        messagesChange({ phoneNumberId: PNID_B, waId: WA_B }),
      ]);
      const state = twoAccounts({
        relays: [relayRow('acct-a', 'https://a.test/hook', SECRET_A)],
      });

      await relayMetaWebhook(makeDb(state), {
        rawBody: JSON.stringify(body),
        body,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchCalls(fetchMock)[0][0]).toBe('https://a.test/hook');
      expect(fetchCalls(fetchMock)[0][1].body).not.toContain(WA_B);
    });

    it('a falha de uma conta não impede a entrega à outra', async () => {
      const calls: string[] = [];
      const fetchMock = vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://a.test')) return { ok: false, status: 500 };
        return { ok: true, status: 200 };
      });
      vi.stubGlobal('fetch', fetchMock);
      const body = envelope('waba-shared', [
        messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
        messagesChange({ phoneNumberId: PNID_B, waId: WA_B }),
      ]);
      const state = twoAccounts();

      await relayMetaWebhook(makeDb(state), {
        rawBody: JSON.stringify(body),
        body,
      });

      expect(calls.sort()).toEqual([
        'https://a.test/hook',
        'https://b.test/hook',
      ]);
      expect(state.rpcs.map((r) => r.args.p_account_id)).toEqual(['acct-a']);
      expect(state.updates.map((u) => u.filters)).toEqual([
        [
          ['eq', 'account_id', 'acct-b'],
          ['eq', 'is_enabled', true],
        ],
      ]);
    });

    const cases: Array<[string, Partial<FakeState>]> = [
      [
        'canal disabled',
        {
          channels: [chan('chan-a', 'acct-a', 'disabled')],
        },
      ],
      ['canal apagado', { channels: [] }],
      ['canal de outra conta', { channels: [chan('chan-a', 'acct-b')] }],
      ['config sem channel_id', { configs: [cfg('acct-a', PNID_A, null)] }],
      [
        'número duplicado em duas contas',
        {
          configs: [
            cfg('acct-a', PNID_A, 'chan-a'),
            cfg('acct-b', PNID_A, 'chan-b'),
          ],
          channels: [chan('chan-a', 'acct-a'), chan('chan-b', 'acct-b')],
        },
      ],
      ['número fora do CRM', { configs: [] }],
    ];
    it.each(cases)('%s: sem dono, nada é enviado', async (_name, override) => {
      const fetchMock = stubFetch();
      const state = stateForA(override);

      await relayMetaWebhook(makeDb(state), {
        rawBody: JSON.stringify(inboundBody()),
        body: inboundBody(),
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.rpcs).toHaveLength(0);
    });

    // Revisão de segurança SPEC 088, achado 1: o `app_secret` de um canal
    // é gravado pelo admin da conta, sem validação na Meta. Ele só pode
    // falar pelos números que o guardam.
    describe('escopo do segredo que validou a assinatura', () => {
      const signedByChannelOf = (...pnids: string[]): MetaWebhookSigner => ({
        kind: 'channels',
        phoneNumberIds: new Set(pnids),
      });

      it('segredo do canal de A com número de B: B não recebe nada', async () => {
        const fetchMock = stubFetch();
        const state = twoAccounts();
        const body = envelope('waba-b', [
          messagesChange({ phoneNumberId: PNID_B, waId: WA_B }),
        ]);

        await relayMetaWebhook(makeDb(state), {
          rawBody: JSON.stringify(body),
          body,
          signer: signedByChannelOf(PNID_A),
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(state.rpcs).toHaveLength(0);
        expect(state.updates).toHaveLength(0);
      });

      it('segredo do canal de A em POST misto: só A recebe, sem o change de B', async () => {
        const fetchMock = stubFetch();
        const body = envelope('waba-shared', [
          messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
          messagesChange({ phoneNumberId: PNID_B, waId: WA_B }),
        ]);

        await relayMetaWebhook(makeDb(twoAccounts()), {
          rawBody: JSON.stringify(body),
          body,
          signer: signedByChannelOf(PNID_A),
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchCalls(fetchMock)[0];
        expect(url).toBe('https://a.test/hook');
        expect(opts.body).not.toContain(PNID_B);
        expect(opts.body).not.toContain(WA_B);
      });

      it('segredo de canal sem número associado não fala por ninguém', async () => {
        const fetchMock = stubFetch();
        const body = envelope('waba-shared', [
          messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
          messagesChange({ phoneNumberId: PNID_B, waId: WA_B }),
        ]);

        await relayMetaWebhook(makeDb(twoAccounts()), {
          rawBody: JSON.stringify(body),
          body,
          signer: signedByChannelOf(),
        });

        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('um App, um canal: o segredo do próprio canal entrega o corpo cru', async () => {
        const fetchMock = stubFetch();
        const rawBody = JSON.stringify(inboundBody());

        await relayMetaWebhook(makeDb(stateForA()), {
          rawBody,
          body: inboundBody(),
          signer: signedByChannelOf(PNID_A),
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchCalls(fetchMock)[0][1].body === rawBody).toBe(true);
      });

      it('segredo do App padrão (META_APP_SECRET) continua valendo para todos os números', async () => {
        const fetchMock = stubFetch();
        const body = envelope('waba-shared', [
          messagesChange({ phoneNumberId: PNID_A, waId: WA_A }),
          messagesChange({ phoneNumberId: PNID_B, waId: WA_B }),
        ]);

        await relayMetaWebhook(makeDb(twoAccounts()), {
          rawBody: JSON.stringify(body),
          body,
          signer: DEFAULT_SIGNER,
        });

        expect(
          fetchCalls(fetchMock)
            .map((c) => c[0])
            .sort()
        ).toEqual(['https://a.test/hook', 'https://b.test/hook']);
      });
    });

    it('evento de template e de conta (sem metadata) não é enviado, nem com entry.id = WABA da conta', async () => {
      const fetchMock = stubFetch();
      const state = stateForA();
      const body = envelope('waba-a', [
        templateStatusChange(),
        accountUpdateChange(),
      ]);

      await relayMetaWebhook(makeDb(state), {
        rawBody: JSON.stringify(body),
        body,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      // Sem número no corpo, nem consulta ao CRM.
      expect(state.reads).toEqual(['meta_webhook_relays']);
    });
  });

  it('logs: só account_id, status e duração — nunca corpo, chave ou URL completa', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(async () => ({ ok: false, status: 500 }));
    const body = envelope('waba-a', [
      messagesChange({
        phoneNumberId: PNID_A,
        waId: WA_A,
        text: 'segredo-do-contato',
      }),
    ]);

    await relayMetaWebhook(makeDb(stateForA()), {
      rawBody: JSON.stringify(body),
      body,
    });

    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('acct-a');
    expect(logged).toContain('500');
    for (const forbidden of [
      'segredo-do-contato',
      WA_A,
      SECRET_A,
      'a.test',
      '/hook',
    ]) {
      expect(logged).not.toContain(forbidden);
    }
  });
});

describe('chave ilegível', () => {
  it('conta como falha e o log diz `secret`, não `network`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = stubFetch();
    const enc = await import('@/lib/whatsapp/encryption');
    vi.spyOn(enc, 'decrypt').mockImplementation(() => {
      throw new Error('bad key');
    });
    const state = stateForA();

    await relayMetaWebhook(makeDb(state), {
      rawBody: JSON.stringify(inboundBody()),
      body: inboundBody(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.rpcs).toHaveLength(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('reason=secret');
    expect(logged).not.toContain('reason=network');
  });
});

describe('buildRelayTestPayload', () => {
  it('é um webhook de mensagem de texto no formato da Meta, com ids evidentemente falsos', () => {
    const payload = buildRelayTestPayload(new Date(1504902988000));
    expect(payload.object).toBe('whatsapp_business_account');
    const json = JSON.stringify(payload);
    expect(json).toContain('"phone_number_id":"0"');
    expect(json).toContain('wamid.TEST');
    const value = (
      (payload.entry as Record<string, unknown>[])[0].changes as Record<
        string,
        unknown
      >[]
    )[0];
    expect(value.field).toBe('messages');
    expect(Object.keys(value.value as Record<string, unknown>).sort()).toEqual([
      'contacts',
      'messages',
      'messaging_product',
      'metadata',
    ]);
  });
});

describe('sendRelayTest', () => {
  const testState = (isEnabled = false): FakeState =>
    newState({
      relays: [
        {
          account_id: 'acct-a',
          url: 'https://a.test/hook',
          secret: SECRET_A,
          is_enabled: isEnabled,
          failure_count: 3,
        },
      ],
    });

  it('8. leva X-Wacrm-Test: true, assinado com a chave salva, mesmo com o repetidor desligado; não toca nos contadores; devolve só ok/status/duration_ms/error', async () => {
    const fetchMock = stubFetch(async () => ({
      ok: true,
      status: 200,
      // Corpo da resposta do destino: nunca pode chegar ao navegador.
      text: async () => 'resposta-secreta-do-destino',
      headers: new Headers({ 'x-segredo': 'abc' }),
    }));
    const state = testState(false);

    const result = await sendRelayTest(makeDb(state), 'acct-a');

    expect(result).toEqual({
      ok: true,
      status: 200,
      duration_ms: expect.any(Number),
      error: null,
    });
    expect(Object.keys(result!).sort()).toEqual([
      'duration_ms',
      'error',
      'ok',
      'status',
    ]);
    expect(JSON.stringify(result)).not.toContain('resposta-secreta');

    const [url, opts] = fetchCalls(fetchMock)[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Wacrm-Test']).toBe('true');
    expect(opts.headers['X-Wacrm-Event']).toBe('meta.webhook_raw');
    expect(headerKeys(fetchCalls(fetchMock)[0])).not.toContain(
      'x-hub-signature-256'
    );
    expect(
      verifySignatureHeader(
        opts.headers['X-Wacrm-Signature'],
        opts.body as string,
        SECRET_A,
        Math.floor(Date.now() / 1000)
      )
    ).toBe(true);
    expect(JSON.parse(opts.body as string)).toEqual(
      expect.objectContaining({ object: 'whatsapp_business_account' })
    );

    // Contadores intactos: nenhuma escrita, nenhuma RPC.
    expect(state.updates).toHaveLength(0);
    expect(state.rpcs).toHaveLength(0);
  });

  it('classifica as falhas em timeout | not_public | http_error | network, sem mexer nos contadores', async () => {
    const run = async (
      impl: () => Promise<Partial<Response>>,
      deliverable = true
    ) => {
      vi.mocked(isDeliverableUrl).mockResolvedValue(deliverable);
      const fetchMock = stubFetch(impl);
      const state = testState();
      const result = await sendRelayTest(makeDb(state), 'acct-a');
      expect(state.updates).toHaveLength(0);
      expect(state.rpcs).toHaveLength(0);
      return { result, fetchMock };
    };

    const http = await run(async () => ({ ok: false, status: 503 }));
    expect(http.result).toEqual({
      ok: false,
      status: 503,
      duration_ms: expect.any(Number),
      error: 'http_error',
    });

    const timeout = await run(async () => {
      throw new DOMException('signal timed out', 'TimeoutError');
    });
    expect(timeout.result).toMatchObject({
      ok: false,
      status: null,
      error: 'timeout',
    });

    const network = await run(async () => {
      throw new TypeError('fetch failed');
    });
    expect(network.result).toMatchObject({
      ok: false,
      status: null,
      error: 'network',
    });

    const notPublic = await run(async () => ({ ok: true, status: 200 }), false);
    expect(notPublic.result).toMatchObject({
      ok: false,
      status: null,
      error: 'not_public',
    });
    expect(notPublic.fetchMock).not.toHaveBeenCalled();
  });

  it('sem config salva: devolve null e não faz fetch', async () => {
    const fetchMock = stubFetch();
    const result = await sendRelayTest(makeDb(newState()), 'acct-a');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('só usa a config da conta pedida', async () => {
    const fetchMock = stubFetch();
    const state = newState({
      relays: [relayRow('acct-b', 'https://b.test/hook', SECRET_B, true)],
    });
    expect(await sendRelayTest(makeDb(state), 'acct-a')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('erro de banco: resolve sem lançar, sem fetch', async () => {
    const fetchMock = stubFetch();
    const state = testState();
    state.errors.meta_webhook_relays = { message: 'down' };
    const result = await sendRelayTest(makeDb(state), 'acct-a');
    expect(result).toEqual({
      ok: false,
      status: null,
      duration_ms: 0,
      error: 'network',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// Corpos REAIS da Meta (capturados na F6 da SPEC 088, anonimizados)
// ============================================================

describe('corpos reais da Meta (statuses e messages)', () => {
  const REAL_BODIES = [
    ['statuses', realStatusesRawBody],
    ['messages', realMessagesRawBody],
  ] as const;

  it.each(REAL_BODIES)(
    '%s: a forma real (value antes de field, compacto) chega ao destino byte a byte, assinada, sem X-Hub-Signature-256',
    async (_name, build) => {
      const fetchMock = stubFetch();
      const rawBody = build({ phoneNumberId: PNID_A });
      // Pré-condição: a ordem de chaves é a da Meta, não a da documentação.
      const change = JSON.parse(rawBody).entry[0].changes[0];
      expect(Object.keys(change)).toEqual(['value', 'field']);

      await relayMetaWebhook(makeDb(stateForA()), {
        rawBody,
        body: JSON.parse(rawBody),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, opts] = fetchCalls(fetchMock)[0];
      expect(opts.body === rawBody).toBe(true);
      expect(headerKeys(fetchCalls(fetchMock)[0])).not.toContain(
        'x-hub-signature-256'
      );
      expect(opts.headers['X-Wacrm-Event']).toBe('meta.webhook_raw');
      expect(opts.headers['X-Wacrm-Test']).toBeUndefined();
      expect(
        verifySignatureHeader(
          opts.headers['X-Wacrm-Signature'],
          opts.body as string,
          SECRET_A,
          Math.floor(Date.now() / 1000)
        )
      ).toBe(true);
    }
  );

  it('statuses real: o pricing completo (PMP, free_customer_service, free_tier) e o recipient_user_id seguem intactos', async () => {
    const fetchMock = stubFetch();
    const rawBody = realStatusesRawBody({ phoneNumberId: PNID_A });

    await relayMetaWebhook(makeDb(stateForA()), {
      rawBody,
      body: JSON.parse(rawBody),
    });

    const sent = JSON.parse(fetchCalls(fetchMock)[0][1].body as string);
    const status = sent.entry[0].changes[0].value.statuses[0];
    expect(status).toMatchObject({
      status: 'read',
      recipient_user_id: 'US.13491208655302741918',
      pricing: {
        billable: false,
        pricing_model: 'PMP',
        category: 'service',
        type: 'free_customer_service',
        subtype: 'free_tier',
      },
    });
  });

  it.each(REAL_BODIES)(
    '%s de número que não é da conta A: nada é enviado',
    async (_name, build) => {
      const fetchMock = stubFetch();
      const rawBody = build({ phoneNumberId: PNID_B });

      await relayMetaWebhook(makeDb(stateForA()), {
        rawBody,
        body: JSON.parse(rawBody),
      });

      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('POST misto com formas reais (statuses de A + messages de B): A recebe só o seu change, sem rastro do número de B', async () => {
    const fetchMock = stubFetch();
    const aChange = JSON.parse(realStatusesRawBody({ phoneNumberId: PNID_A }))
      .entry[0].changes[0];
    const bChange = JSON.parse(realMessagesRawBody({ phoneNumberId: PNID_B }))
      .entry[0].changes[0];
    const body = envelope('102290129340398', [aChange, bChange]);

    await relayMetaWebhook(makeDb(stateForA()), {
      rawBody: JSON.stringify(body),
      body,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentRaw = fetchCalls(fetchMock)[0][1].body as string;
    expect(sentRaw).not.toContain(PNID_B);
    const sent = JSON.parse(sentRaw);
    expect(sent.entry[0].changes).toHaveLength(1);
    expect(sent.entry[0].changes[0].value.statuses[0].status).toBe('read');
  });
});
