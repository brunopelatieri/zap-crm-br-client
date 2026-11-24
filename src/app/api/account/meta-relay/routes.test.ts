import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRole } from '@/lib/auth/roles';

// ---------------------------------------------------------------------------
// SPEC 088 F4 — /api/account/meta-relay (+ /secret, /test), §5 e §7.3.2/3.
//
// Roda as rotas de verdade sobre um banco em memória (a tabela não tem
// policy: o cliente é o admin, sempre filtrado pela conta da SESSÃO). A
// cifra é "visível" (`enc(...)`) para um texto claro no banco quebrar o
// teste; `fetch` é falso, mas o SSRF é o real (URLs com IP literal: sem DNS).
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  auth: null as null | {
    userId: string;
    accountId: string;
    role: AccountRole;
  },
  admin: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: vi.fn(async (min: AccountRole) => {
      if (!h.auth) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.auth.role, min)) {
        throw new actual.ForbiddenError(
          `This action requires the '${min}' role or higher`
        );
      }
      return {
        supabase: {},
        userId: h.auth.userId,
        accountId: h.auth.accountId,
        role: h.auth.role,
        account: { id: h.auth.accountId, name: 'Conta' },
      };
    }),
  };
});

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => h.admin }));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, '$1'),
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn(),
}));
vi.mock('@/lib/activity/record', () => ({
  recordActivity: recordActivityMock,
}));

import { __resetRateLimitForTests, RATE_LIMITS } from '@/lib/rate-limit';
import { verifySignatureHeader } from '@/lib/webhooks/sign';

const verify = (header: string, body: string, secret: string) =>
  verifySignatureHeader(header, body, secret, Math.floor(Date.now() / 1000));
import {
  makeRelayFakeDb,
  type RelayRow,
} from '@/lib/webhooks/meta-relay-fake-db';

import { DELETE, GET, PUT } from './route';
import { POST as secretPOST } from './secret/route';
import { POST as testPOST } from './test/route';

const A = 'acct-a';
const B = 'acct-b';
// IPs literais públicos: o SSRF real decide sem consultar DNS.
const URL_A = 'https://93.184.216.34/hooks/a-token-in-path?k=querysecret';
const URL_B = 'https://93.184.216.35/hooks/b';

let db: ReturnType<typeof makeRelayFakeDb>;
let fetchMock: ReturnType<typeof vi.fn>;

const row = (accountId: string, over: RelayRow = {}): RelayRow => ({
  account_id: accountId,
  url: accountId === A ? URL_A : URL_B,
  secret: `enc(whrelay_old_${accountId})`,
  is_enabled: true,
  failure_count: 0,
  last_delivery_at: null,
  last_failure_at: null,
  auto_disabled_at: null,
  updated_at: '2026-11-01T00:00:00.000Z',
  ...over,
});

function signIn(role: AccountRole, accountId = A) {
  h.auth = { userId: `user-${role}`, accountId, role };
}

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/account/meta-relay', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

// A rota não declara parâmetro: não lê corpo nenhum (§5.3), então o destino é
// sempre o que está salvo.
function postTest() {
  return testPOST();
}

function seed(rows: RelayRow[]) {
  db = makeRelayFakeDb(rows);
  h.admin = db.db;
}

beforeEach(() => {
  __resetRateLimitForTests();
  recordActivityMock.mockReset();
  h.auth = null;
  seed([]);
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    // O corpo do destino nunca pode chegar ao navegador.
    text: async () => 'TARGET-BODY-MUST-NOT-LEAK',
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('papel e autenticação (D-8)', () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    ['GET', () => GET()],
    ['PUT', () => put({ url: URL_A, is_enabled: false })],
    ['DELETE', () => DELETE()],
    ['POST /secret', () => secretPOST()],
    ['POST /test', () => postTest()],
  ];

  for (const role of ['viewer', 'agent'] as const) {
    for (const [name, call] of calls) {
      it(`${role} recebe 403 em ${name}, sem tocar no banco nem no destino`, async () => {
        seed([row(A)]);
        signIn(role);
        const res = await call();
        expect(res.status).toBe(403);
        expect(db.writes).toEqual([]);
        expect(db.rows).toEqual([row(A)]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(recordActivityMock).not.toHaveBeenCalled();
      });
    }
  }

  it('sem sessão: 401', async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('admin passa', async () => {
    signIn('admin');
    expect((await GET()).status).toBe(200);
  });
});

describe('GET', () => {
  it('sem config devolve { relay: null }', async () => {
    signIn('admin');
    const res = await GET();
    expect(await res.json()).toEqual({ relay: null });
  });

  it('nunca devolve a chave, nem em claro nem cifrada', async () => {
    seed([row(A, { failure_count: 3 })]);
    signIn('owner');
    const res = await GET();
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.secret).toBeUndefined();
    expect(Object.keys(body.relay).sort()).toEqual(
      [
        'auto_disabled_at',
        'failure_count',
        'is_enabled',
        'last_delivery_at',
        'last_failure_at',
        'updated_at',
        'url',
      ].sort()
    );
    expect(text).not.toContain('whrelay_');
    expect(text).not.toContain('enc(');
    expect(body.relay.failure_count).toBe(3);
  });
});

describe('PUT', () => {
  it('cria: 201, devolve a chave UMA vez e grava só a cifrada', async () => {
    signIn('admin');
    const res = await put({ url: URL_A, is_enabled: true });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secret).toMatch(/^whrelay_/);
    expect(body.relay.url).toBe(URL_A);
    expect(body.relay.secret).toBeUndefined();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].secret).toBe(`enc(${body.secret})`);
    expect(db.rows[0].account_id).toBe(A);
    expect(db.rows[0].updated_by).toBe('user-admin');

    // Recarregar: a chave não aparece mais.
    const again = await (await GET()).text();
    expect(again).not.toContain(body.secret);
  });

  it('atualiza: 200 e NÃO devolve chave', async () => {
    seed([row(A, { is_enabled: false })]);
    signIn('admin');
    const res = await put({ url: URL_A, is_enabled: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBeUndefined();
    expect(body.relay.is_enabled).toBe(true);
    // A chave guardada segue a mesma.
    expect(db.rows[0].secret).toBe('enc(whrelay_old_acct-a)');
  });

  const badUrls: Array<[string, unknown]> = [
    ['http:// (sem TLS)', 'http://93.184.216.34/hook'],
    ['IP privado 10.x', 'https://10.0.0.5/hook'],
    ['loopback', 'https://127.0.0.1/hook'],
    ['link-local / metadata', 'https://169.254.169.254/latest'],
    ['localhost', 'https://localhost/hook'],
    ['nome .internal', 'https://svc.internal/hook'],
    ['credenciais embutidas', 'https://user:pw@93.184.216.34/hook'],
    ['texto que não é URL', 'isto não é uma url'],
    ['vazio', ''],
    ['não é string', 42],
    ['ausente', undefined],
  ];
  for (const [name, url] of badUrls) {
    it(`URL inválida (${name}): 400 e nada é gravado`, async () => {
      signIn('admin');
      const res = await put({ url, is_enabled: true });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/url/);
      expect(db.writes).toEqual([]);
      expect(recordActivityMock).not.toHaveBeenCalled();
    });
  }

  it('is_enabled ausente ou não booleano: 400', async () => {
    signIn('admin');
    expect((await put({ url: URL_A })).status).toBe(400);
    expect((await put({ url: URL_A, is_enabled: 'true' })).status).toBe(400);
    expect((await put('not json')).status).toBe(400);
    expect(db.writes).toEqual([]);
  });

  it('religar zera os contadores e o desligamento automático', async () => {
    seed([
      row(A, {
        is_enabled: false,
        failure_count: 15,
        auto_disabled_at: '2026-11-20T10:00:00.000Z',
      }),
    ]);
    signIn('admin');
    const res = await put({ url: URL_A, is_enabled: true });
    expect(res.status).toBe(200);
    expect(db.rows[0].failure_count).toBe(0);
    expect(db.rows[0].auto_disabled_at).toBeNull();
    const body = await res.json();
    expect(body.relay.failure_count).toBe(0);
    expect(body.relay.auto_disabled_at).toBeNull();
  });

  it('salvar sem religar não zera o desligamento automático', async () => {
    seed([
      row(A, {
        is_enabled: false,
        failure_count: 15,
        auto_disabled_at: '2026-11-20T10:00:00.000Z',
      }),
    ]);
    signIn('admin');
    await put({ url: URL_A, is_enabled: false });
    expect(db.rows[0].failure_count).toBe(15);
    expect(db.rows[0].auto_disabled_at).toBe('2026-11-20T10:00:00.000Z');
  });
});

describe('DELETE', () => {
  it('remove a linha (URL e chave)', async () => {
    seed([row(A)]);
    signIn('admin');
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(db.rows).toEqual([]);
  });

  it('404 quando não há config', async () => {
    signIn('admin');
    expect((await DELETE()).status).toBe(404);
  });
});

describe('isolamento entre contas', () => {
  beforeEach(() => seed([row(A), row(B)]));

  it('GET devolve só a config da conta da sessão', async () => {
    signIn('admin', B);
    const body = await (await GET()).json();
    expect(body.relay.url).toBe(URL_B);

    signIn('admin', A);
    expect((await (await GET()).json()).relay.url).toBe(URL_A);
  });

  it('PUT altera só a conta da sessão, mesmo com account_id no corpo', async () => {
    signIn('admin', B);
    const res = await put({
      url: 'https://93.184.216.40/novo',
      is_enabled: false,
      account_id: A,
      accountId: A,
    });
    expect(res.status).toBe(200);
    const a = db.rows.find((r) => r.account_id === A)!;
    const b = db.rows.find((r) => r.account_id === B)!;
    expect(a).toEqual(row(A));
    expect(b.url).toBe('https://93.184.216.40/novo');
    expect(b.is_enabled).toBe(false);
  });

  it('DELETE remove só a conta da sessão', async () => {
    signIn('admin', B);
    await DELETE();
    expect(db.rows.map((r) => r.account_id)).toEqual([A]);
  });

  it('/secret troca só a chave da conta da sessão', async () => {
    signIn('admin', B);
    await secretPOST();
    expect(db.rows.find((r) => r.account_id === A)!.secret).toBe(
      'enc(whrelay_old_acct-a)'
    );
    expect(db.rows.find((r) => r.account_id === B)!.secret).not.toBe(
      'enc(whrelay_old_acct-b)'
    );
  });

  it('/test usa a URL e a chave da conta da sessão', async () => {
    signIn('admin', B);
    await postTest();
    const [calledUrl, opts] = fetchMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(calledUrl).toBe(URL_B);
    expect(
      verify(opts.headers['X-Wacrm-Signature'], opts.body, 'whrelay_old_acct-b')
    ).toBe(true);
    expect(
      verify(opts.headers['X-Wacrm-Signature'], opts.body, 'whrelay_old_acct-a')
    ).toBe(false);
  });
});

describe('POST /secret', () => {
  it('404 sem config salva', async () => {
    signIn('admin');
    const res = await secretPOST();
    expect(res.status).toBe(404);
    expect(db.rows).toEqual([]);
  });

  it('devolve a chave nova uma vez; a antiga deixa de assinar', async () => {
    signIn('admin');
    const created = await (await put({ url: URL_A, is_enabled: false })).json();
    const oldSecret = created.secret as string;

    await postTest();
    const first = fetchMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(
      verify(first[1].headers['X-Wacrm-Signature'], first[1].body, oldSecret)
    ).toBe(true);

    const res = await secretPOST();
    expect(res.status).toBe(200);
    const { secret: newSecret } = (await res.json()) as { secret: string };
    expect(newSecret).toMatch(/^whrelay_/);
    expect(newSecret).not.toBe(oldSecret);
    expect(db.rows[0].secret).toBe(`enc(${newSecret})`);

    await postTest();
    const second = fetchMock.mock.calls[1] as typeof first;
    const sig = second[1].headers['X-Wacrm-Signature'];
    expect(verify(sig, second[1].body, newSecret)).toBe(true);
    expect(verify(sig, second[1].body, oldSecret)).toBe(false);

    // Nem a chave nova nem a velha voltam por GET.
    const text = await (await GET()).text();
    expect(text).not.toContain(newSecret);
    expect(text).not.toContain(oldSecret);
  });
});

describe('POST /secret — a chave nova nunca se perde', () => {
  it('uma leitura que falha DEPOIS da troca não impede de devolver a chave', async () => {
    seed([row(A)]);
    const inner = db.db;
    let rotated = false;
    // Qualquer leitura depois da gravação da chave nova falha.
    h.admin = {
      from: (table: string) => {
        if (rotated) throw new Error('db down');
        const b = (
          inner.from as unknown as (t: string) => Record<string, unknown>
        )(table);
        const update = b.update as (p: unknown) => unknown;
        b.update = (p: unknown) => {
          rotated = true;
          return update(p);
        };
        return b;
      },
    };
    signIn('admin');
    const res = await secretPOST();
    expect(res.status).toBe(200);
    const { secret } = (await res.json()) as { secret: string };
    expect(db.rows[0].secret).toBe(`enc(${secret})`);
  });
});

describe('POST /test', () => {
  it('404 sem config salva, sem chamar o destino', async () => {
    signIn('admin');
    const res = await postTest();
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('responde só { ok, status, duration_ms, error }, sem corpo do destino', async () => {
    seed([row(A, { is_enabled: false })]);
    signIn('admin');
    const res = await postTest();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('TARGET-BODY-MUST-NOT-LEAK');
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(
      ['duration_ms', 'error', 'ok', 'status'].sort()
    );
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(body.error).toBeNull();
  });

  it('marca X-Wacrm-Test, ignora URL do corpo e não mexe nos contadores', async () => {
    seed([row(A, { is_enabled: false, failure_count: 7 })]);
    signIn('admin');
    await postTest();
    const [calledUrl, opts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe(URL_A);
    expect(opts.headers['X-Wacrm-Test']).toBe('true');
    expect(db.writes).toEqual([]);
    expect(db.rows[0].failure_count).toBe(7);
    expect(db.rows[0].last_delivery_at).toBeNull();
  });

  it('destino que falha: ok=false com o motivo, sem vazar nada', async () => {
    seed([row(A)]);
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    signIn('admin');
    const body = await (await postTest()).json();
    expect(body).toEqual({
      ok: false,
      status: 500,
      duration_ms: expect.any(Number),
      error: 'http_error',
    });
  });

  it('rate limit: a 7ª chamada na janela recebe 429, por conta', async () => {
    seed([row(A), row(B)]);
    signIn('admin', A);
    for (let i = 0; i < RATE_LIMITS.metaRelayTest.limit; i++) {
      expect((await postTest()).status).toBe(200);
    }
    const blocked = await postTest();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMITS.metaRelayTest.limit);

    // Outro admin da MESMA conta divide o orçamento.
    h.auth = { userId: 'user-other', accountId: A, role: 'owner' };
    expect((await postTest()).status).toBe(429);

    // Outra conta tem o seu.
    signIn('admin', B);
    expect((await postTest()).status).toBe(200);
  });

  it('o limite é 6 por minuto', () => {
    expect(RATE_LIMITS.metaRelayTest).toEqual({ limit: 6, windowMs: 60_000 });
  });
});

describe('registro de atividade (D-10)', () => {
  const entries = () => recordActivityMock.mock.calls.map((c) => c[1]);
  const actions = () => entries().map((e) => e.action);

  it('criar ligado registra relay_enabled com só o host', async () => {
    signIn('admin');
    await put({ url: URL_A, is_enabled: true });
    expect(actions()).toEqual(['webhook.relay_enabled']);
    expect(entries()[0]).toMatchObject({
      accountId: A,
      resourceType: 'webhook',
      resourceLabel: '93.184.216.34',
      actor: { kind: 'user', userId: 'user-admin', role: 'admin' },
    });
  });

  it('criar desligado registra relay_url_changed', async () => {
    signIn('admin');
    await put({ url: URL_A, is_enabled: false });
    expect(actions()).toEqual(['webhook.relay_url_changed']);
  });

  it('desligar, ligar e trocar a URL registram cada um o seu', async () => {
    seed([row(A, { is_enabled: true })]);
    signIn('admin');
    await put({ url: URL_A, is_enabled: false });
    await put({ url: URL_A, is_enabled: true });
    await put({ url: 'https://93.184.216.50/x', is_enabled: true });
    expect(actions()).toEqual([
      'webhook.relay_disabled',
      'webhook.relay_enabled',
      'webhook.relay_url_changed',
    ]);
  });

  it('salvar sem mudar nada não registra', async () => {
    seed([row(A)]);
    signIn('admin');
    await put({ url: URL_A, is_enabled: true });
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it('gerar chave nova e remover registram', async () => {
    seed([row(A)]);
    signIn('admin');
    await secretPOST();
    await DELETE();
    expect(actions()).toEqual([
      'webhook.relay_secret_rotated',
      'webhook.relay_removed',
    ]);
    expect(entries()[1].resourceLabel).toBe('93.184.216.34');
  });

  it('nunca grava a URL completa nem a chave no registro', async () => {
    signIn('admin');
    const created = await (await put({ url: URL_A, is_enabled: true })).json();
    const rotated = await (await secretPOST()).json();
    await put({ url: 'https://93.184.216.51/y?token=zzz', is_enabled: true });
    await DELETE();

    const dump = JSON.stringify(recordActivityMock.mock.calls);
    expect(dump).not.toContain('whrelay_');
    expect(dump).not.toContain(created.secret);
    expect(dump).not.toContain(rotated.secret);
    expect(dump).not.toContain('a-token-in-path');
    expect(dump).not.toContain('querysecret');
    expect(dump).not.toContain('token=zzz');
    expect(dump).not.toContain('https://');
  });

  it('recusa de validação ou de papel não registra', async () => {
    signIn('admin');
    await put({ url: 'http://93.184.216.34/x', is_enabled: true });
    signIn('agent');
    await put({ url: URL_A, is_enabled: true });
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
