// ============================================================
// Rotas PÚBLICAS `/api/forms/public/[slug]/**` (SPEC 085 §7.2, F3).
//
// O banco, o Storage e as ações pós-envio são dublês (ver
// `test-public-world.ts`): nenhum banco, nenhuma rede. O que se prova:
// `Origin` obrigatório, limite por IP, identidade (token > telefone, token
// adulterado degrada), `resume_token`, autosave só de blocos existentes,
// upload validado antes de assinar, e no envio: pontuação SÓ do servidor,
// bloco escondido descartado, arquivo de outra resposta recusado, objeto
// conferido no Storage, Turnstile fail-closed, envio duplo → 409.
// ============================================================

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvailabilityReason } from '@/lib/forms/availability';
import { signFormLink } from '@/lib/forms/link-token';
import { ACCOUNT_ID, FORM_ID, USER_ID } from '@/lib/forms/test-fixtures';
import {
  createWorld,
  defaultFields,
  defaultForm,
  EXISTING_CONTACT_ID,
  NEW_CONTACT_ID,
  SLUG,
  type World,
} from '@/lib/forms/test-public-world';
import { loadPublicFormPage } from '@/lib/forms/public-service';
import { buildUploadPath } from '@/lib/forms/uploads';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { normalizeContactPhone } from '@/lib/phone/br';

const h = vi.hoisted(() => ({
  world: null as unknown as World,
  applyMappings: vi.fn(),
  applyBandActions: vi.fn(),
  recordFormSubmitted: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => h.world.db,
}));
vi.mock('@/lib/forms/apply-mapping', () => ({
  applyMappings: (...a: unknown[]) => h.applyMappings(...a),
}));
vi.mock('@/lib/forms/apply-band', () => ({
  applyBandActions: (...a: unknown[]) => h.applyBandActions(...a),
}));
vi.mock('@/lib/forms/activity', async (orig) => ({
  ...(await orig<typeof import('@/lib/forms/activity')>()),
  recordFormSubmitted: (...a: unknown[]) => h.recordFormSubmitted(...a),
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: async () => USER_ID,
}));
vi.mock('@/lib/channels/default-channel', () => ({
  resolveDefaultChannelId: async () => 'channel-1',
}));

import { PATCH as autosave } from './[slug]/responses/[id]/route';
import { POST as start } from './[slug]/start/route';
import { POST as submit } from './[slug]/submit/route';
import { POST as uploadUrl } from './[slug]/upload-url/route';

const ORIGIN = 'https://app.example.com';
const SECRET = 'a'.repeat(48);
const PHONE = '11999998888';
const PHONE_NORMALIZED = (() => {
  const r = normalizeContactPhone(PHONE);
  if (!r.ok) throw new Error('fixture phone invalid');
  return r.phone;
})();
const params = { params: Promise.resolve({ slug: SLUG }) };

let ipSeq = 0;
const nextIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

function request(
  method: string,
  path: string,
  body: unknown,
  opts: { origin?: string | null; ip?: string } = {}
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': opts.ip ?? nextIp(),
    'user-agent': 'vitest',
  };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

const base = `/api/forms/public/${SLUG}`;
const post = (
  route: string,
  body: unknown,
  o?: Parameters<typeof request>[3]
) => request('POST', `${base}${route}`, body, o);

const sha = (token: string) => createHash('sha256').update(token).digest('hex');

function seedResponse(
  w: World,
  over: Record<string, unknown> = {},
  token = `resume-${Math.random().toString(36).slice(2)}`
) {
  const id = crypto.randomUUID();
  w.state.responses.set(id, {
    id,
    form_id: FORM_ID,
    account_id: ACCOUNT_ID,
    contact_id: EXISTING_CONTACT_ID,
    status: 'partial',
    identity_mode: 'phone',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    answers: {},
    resume_token_hash: `\\x${sha(token)}`,
    ...over,
  });
  return { id, token };
}

function addExistingContact(w: World, phone = PHONE_NORMALIZED) {
  w.state.contacts.push({
    id: EXISTING_CONTACT_ID,
    account_id: ACCOUNT_ID,
    name: null,
    phone_normalized: phone,
  });
}

const validAnswers = () => ({
  phone: PHONE,
  name: 'Ana',
  interest: 'now',
  consent: true,
});

const lastPatch = (w: World) =>
  w.state.updates[w.state.updates.length - 1].patch;

beforeEach(() => {
  __resetRateLimitForTests();
  h.world = createWorld();
  h.applyMappings.mockReset().mockResolvedValue({ applied: [], warnings: [] });
  h.applyBandActions.mockReset().mockResolvedValue({});
  h.recordFormSubmitted.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', ORIGIN);
  vi.stubEnv('FORM_LINK_SECRET', SECRET);
  vi.stubEnv('TURNSTILE_SITE_KEY', '');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------
describe('Origin obrigatório e limite por IP', () => {
  it('as quatro rotas recusam Origin ausente ou de fora com 403, sem tocar no banco', async () => {
    const id = crypto.randomUUID();
    const idCtx = { params: Promise.resolve({ slug: SLUG, id }) };
    for (const origin of [null, 'https://evil.example', 'null']) {
      const o = { origin };
      const responses = [
        await start(post('/start', {}, o), params),
        await autosave(
          request('PATCH', `${base}/responses/${id}`, {}, o),
          idCtx
        ),
        await uploadUrl(post('/upload-url', {}, o), params),
        await submit(post('/submit', {}, o), params),
      ];
      for (const res of responses) {
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('forbidden_origin');
      }
    }
    expect(h.world.state.rpcCalls).toEqual([]);
  });

  it('start: o 31º pedido do mesmo IP no minuto → 429', async () => {
    const ip = '203.0.113.7';
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await start(post('/start', { honeypot: 'x' }, { ip }), params))
        .status;
    }
    expect(last).toBe(429);
  });
});

// ------------------------------------------------------------
describe('POST …/start', () => {
  const startBody = (over: Record<string, unknown> = {}) => ({
    phone: PHONE,
    elapsed_ms: 5000,
    honeypot: '',
    ...over,
  });

  it('telefone: cria contato (created_via=form) e resposta partial; só o hash do token vai ao banco', async () => {
    const res = await start(post('/start', startBody()), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.identity_mode).toBe('phone');
    expect(json.resume_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const contact = h.world.state.inserts.find((i) => i.table === 'contacts')!;
    expect(contact.row).toMatchObject({
      account_id: ACCOUNT_ID,
      phone: PHONE_NORMALIZED,
      created_via: 'form',
    });
    const response = h.world.state.inserts.find(
      (i) => i.table === 'form_responses'
    )!.row;
    expect(response).toMatchObject({
      form_id: FORM_ID,
      account_id: ACCOUNT_ID,
      contact_id: NEW_CONTACT_ID,
      status: 'partial',
      identity_mode: 'phone',
      source: 'link',
      answers: {},
    });
    expect(response.resume_token_hash).toBe(`\\x${sha(json.resume_token)}`);
    expect(JSON.stringify(response)).not.toContain(json.resume_token);
  });

  it('honeypot preenchido e tempo curto demais são recusados', async () => {
    const bot = await start(
      post('/start', startBody({ honeypot: 'x' })),
      params
    );
    expect(bot.status).toBe(400);
    const fast = await start(
      post('/start', startBody({ elapsed_ms: 800 })),
      params
    );
    expect(fast.status).toBe(400);
    expect((await fast.json()).code).toBe('too_fast');
    expect(h.world.state.inserts).toEqual([]);
  });

  it('telefone inválido → 422; sem telefone nem token → 400', async () => {
    const bad = await start(
      post('/start', startBody({ phone: '123' })),
      params
    );
    expect(bad.status).toBe(422);
    expect((await bad.json()).code).toBe('invalid_phone');
    const none = await start(
      post('/start', startBody({ phone: undefined })),
      params
    );
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe('identity_required');
  });

  it('token válido pula o telefone: o contato vem do token e a origem também', async () => {
    addExistingContact(h.world, '5511000000000');
    const token = signFormLink({
      formId: FORM_ID,
      contactId: EXISTING_CONTACT_ID,
      source: 'inbox',
    })!;
    const res = await start(
      post('/start', startBody({ phone: undefined, link_token: token })),
      params
    );
    expect(res.status).toBe(200);
    expect((await res.json()).identity_mode).toBe('token');
    expect(h.world.state.inserts.some((i) => i.table === 'contacts')).toBe(
      false
    );
    expect(
      h.world.state.inserts.find((i) => i.table === 'form_responses')!.row
    ).toMatchObject({
      contact_id: EXISTING_CONTACT_ID,
      identity_mode: 'token',
      source: 'inbox',
    });
    // Com token válido a quota de contatos nem é consultada (modo não genérico).
    expect(h.world.state.rpcCalls[0].args.p_generic_link).toBe(false);
  });

  it('token adulterado degrada para o telefone (nunca para erro) e reconsulta como link genérico', async () => {
    addExistingContact(h.world, '5511000000000');
    const good = signFormLink({
      formId: FORM_ID,
      contactId: EXISTING_CONTACT_ID,
      source: 'inbox',
    })!;
    const tampered = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    const res = await start(
      post('/start', startBody({ link_token: tampered })),
      params
    );
    expect(res.status).toBe(200);
    expect((await res.json()).identity_mode).toBe('phone');
    expect(
      h.world.state.inserts.find((i) => i.table === 'form_responses')!.row
    ).toMatchObject({ identity_mode: 'phone', source: 'link' });
    const calls = h.world.state.rpcCalls.filter(
      (c) => c.name === 'form_public_availability'
    );
    expect(calls.map((c) => c.args.p_generic_link)).toEqual([false, true]);

    // Adulterado e sem telefone: pede o telefone.
    const noPhone = await start(
      post('/start', startBody({ phone: undefined, link_token: tampered })),
      params
    );
    expect(noPhone.status).toBe(400);
    expect((await noPhone.json()).code).toBe('identity_required');
  });

  it('token de OUTRO formulário não vale', async () => {
    addExistingContact(h.world, '5511000000000');
    const other = signFormLink({
      formId: '99999999-9999-4999-8999-999999999991',
      contactId: EXISTING_CONTACT_ID,
      source: 'inbox',
    })!;
    const res = await start(
      post('/start', startBody({ link_token: other })),
      params
    );
    expect((await res.json()).identity_mode).toBe('phone');
  });

  it('formulário só com link pessoal: sem token válido → 403', async () => {
    h.world.state.form = defaultForm({
      settings: { accept_generic_link: false },
    });
    const res = await start(post('/start', startBody()), params);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('token_required');
  });

  it('allow_multiple_responses=false: contato que já concluiu vê "já respondeu" e nada é criado', async () => {
    addExistingContact(h.world);
    h.world.state.completed = [{ id: 'done-1' }];
    const res = await start(post('/start', startBody()), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ already_answered: true });
    expect(
      h.world.state.inserts.some((i) => i.table === 'form_responses')
    ).toBe(false);

    // Com múltiplas respostas liberadas, segue.
    h.world.state.form = defaultForm({
      settings: { allow_multiple_responses: true },
    });
    const again = await start(post('/start', startBody()), params);
    expect((await again.json()).response_id).toBeTruthy();
  });

  it('todo motivo de indisponibilidade responde o MESMO 404', async () => {
    const reasons: AvailabilityReason[] = [
      'not_found',
      'not_published',
      'account_blocked',
      'feature_not_in_plan',
      'responses_quota',
      'contacts_quota',
    ];
    const bodies = new Set<string>();
    for (const reason of reasons) {
      h.world.state.availability = reason;
      const res = await start(post('/start', startBody()), params);
      expect(res.status).toBe(404);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect(bodies.size).toBe(1);
    expect(h.world.state.inserts).toEqual([]);
  });

  it('slug fora da forma é "indisponível" sem consultar o banco', async () => {
    const res = await start(post('/start', startBody()), {
      params: Promise.resolve({ slug: 'A_B' }),
    });
    expect(res.status).toBe(404);
    expect(h.world.state.rpcCalls).toEqual([]);
  });
});

// ------------------------------------------------------------
describe('PATCH …/responses/[id] (autosave)', () => {
  const patch = (id: string, body: unknown) =>
    autosave(request('PATCH', `${base}/responses/${id}`, body), {
      params: Promise.resolve({ slug: SLUG, id }),
    });

  it('resume_token errado, ausente ou de resposta concluída → 404 igual', async () => {
    const { id, token } = seedResponse(h.world);
    const done = seedResponse(h.world, {
      status: 'completed',
      resume_token_hash: null,
    });
    for (const res of [
      await patch(id, { resume_token: 'errado', answers_delta: { name: 'A' } }),
      await patch(id, { answers_delta: { name: 'A' } }),
      await patch(done.id, {
        resume_token: done.token,
        answers_delta: { name: 'A' },
      }),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(token).toBeTruthy();
    expect(h.world.state.updates).toEqual([]);
  });

  it('salva só blocos existentes, valida cada valor, apaga com null e não grava pontos', async () => {
    const { id, token } = seedResponse(h.world);
    const res = await patch(id, {
      resume_token: token,
      answers_delta: {
        name: 'Ana',
        interest: 'now',
        email_inexistente: 'x@y.com',
        consent: 'sim',
        phone: PHONE,
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.saved.sort()).toEqual(['interest', 'name', 'phone']);
    expect(json.rejected).toEqual(
      expect.arrayContaining([
        { key: 'email_inexistente', code: 'unknown_field' },
        { key: 'consent', code: 'consentRequired' },
      ])
    );
    const stored = lastPatch(h.world).answers as Record<
      string,
      { value: unknown; points: number }
    >;
    expect(stored.interest).toMatchObject({ value: 'now', points: 0 });
    expect(stored.phone.value).toBe(PHONE_NORMALIZED);
    expect(stored.email_inexistente).toBeUndefined();

    const clear = await patch(id, {
      resume_token: token,
      answers_delta: { name: null },
    });
    expect((await clear.json()).saved).toEqual(['name']);
    expect(
      (lastPatch(h.world).answers as Record<string, unknown>).name
    ).toBeUndefined();
  });

  it('arquivo de outra resposta no delta é recusado', async () => {
    const { id, token } = seedResponse(h.world);
    const foreign = buildUploadPath({
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      responseId: crypto.randomUUID(),
      ext: 'pdf',
    });
    const res = await patch(id, {
      resume_token: token,
      answers_delta: {
        cv: [
          { path: foreign, name: 'a.pdf', mime: 'application/pdf', size: 10 },
        ],
      },
    });
    expect((await res.json()).rejected).toEqual([
      { key: 'cv', code: 'invalidFile' },
    ]);
  });
});

// ------------------------------------------------------------
describe('POST …/upload-url', () => {
  const ask = (id: string, token: string, over: Record<string, unknown> = {}) =>
    uploadUrl(
      post('/upload-url', {
        response_id: id,
        resume_token: token,
        field_key: 'cv',
        name: 'curriculo.pdf',
        mime: 'application/pdf',
        size: 1024,
        ...over,
      }),
      params
    );

  it('assina uma URL com o caminho da conta/formulário/resposta', async () => {
    const { id, token } = seedResponse(h.world);
    const res = await ask(id, token);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.path).toMatch(
      new RegExp(`^account-${ACCOUNT_ID}/${FORM_ID}/${id}/[0-9a-f-]{36}\\.pdf$`)
    );
    expect(json.signed_url).toContain(json.path);
    expect(json.mime).toBe('application/pdf');
  });

  it('recusa antes de assinar: tipo, extensão disfarçada, tamanho, bloco errado, quota', async () => {
    const { id, token } = seedResponse(h.world);
    const cases: [Record<string, unknown>, number, string][] = [
      [
        { mime: 'application/x-msdownload', name: 'a.exe' },
        400,
        'file_type_not_allowed',
      ],
      // `.exe` renomeado: o MIME diz PDF, a extensão não.
      [{ name: 'virus.exe' }, 400, 'file_type_not_allowed'],
      [{ size: 40 * 1024 * 1024 }, 413, 'file_too_large'],
      [{ field_key: 'name' }, 400, 'invalid_field'],
      [{ field_key: 'nao_existe' }, 400, 'invalid_field'],
    ];
    for (const [over, status, code] of cases) {
      const res = await ask(id, token, over);
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
    }
    h.world.state.uploadQuota = { used_bytes: 1000, limit_bytes: 1500 };
    const full = await ask(id, token);
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe('upload_quota');
    expect(h.world.storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('token errado → 404 e nada é assinado', async () => {
    const { id } = seedResponse(h.world);
    expect((await ask(id, 'errado')).status).toBe(404);
    expect(h.world.storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('assina com upsert:false explícito (o objeto verificado não pode ser trocado)', async () => {
    const { id, token } = seedResponse(h.world);
    await ask(id, token);
    expect(h.world.storage.createSignedUploadUrl).toHaveBeenCalledWith(
      expect.stringContaining(`/${id}/`),
      { upsert: false }
    );
  });

  it('teto por resposta: o que já foi enviado e não concluído conta (nº de arquivos e bytes)', async () => {
    const { id, token } = seedResponse(h.world);
    // O bloco `cv` aceita 2 arquivos: o teto é 2 × 2 = 4 objetos assinados.
    for (let i = 0; i < 4; i++) {
      h.world.state.objects.set(
        buildUploadPath({
          accountId: ACCOUNT_ID,
          formId: FORM_ID,
          responseId: id,
          ext: 'pdf',
        }),
        10
      );
    }
    const full = await ask(id, token);
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe('upload_quota');
    expect(h.world.storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('teto por resposta: bytes pendentes entram na conta da quota da conta', async () => {
    const { id, token } = seedResponse(h.world);
    h.world.state.objects.set(
      buildUploadPath({
        accountId: ACCOUNT_ID,
        formId: FORM_ID,
        responseId: id,
        ext: 'pdf',
      }),
      900
    );
    h.world.state.uploadQuota = { used_bytes: 0, limit_bytes: 1500 };
    // 900 pendentes + 1024 pedidos > 1500, embora `used_bytes` seja 0.
    const res = await ask(id, token);
    expect(res.status).toBe(409);
    h.world.state.uploadQuota = { used_bytes: 0, limit_bytes: 2000 };
    expect((await ask(id, token)).status).toBe(200);
  });
});

describe('POST …/upload-url: teto por conta (F6, M-1)', () => {
  it('600 URLs/h por conta, de IPs diferentes; o 601º → 429 sem assinar', async () => {
    const { id, token } = seedResponse(h.world);
    const ask = () =>
      uploadUrl(
        post('/upload-url', {
          response_id: id,
          resume_token: token,
          field_key: 'cv',
          name: 'curriculo.pdf',
          mime: 'application/pdf',
          size: 1024,
        }),
        params
      );
    // Cada pedido sai de um IP novo: o limite por IP nunca dispara.
    for (let i = 0; i < 600; i++) {
      h.world.state.objects.clear();
      expect((await ask()).status).toBe(200);
    }
    const blocked = await ask();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    const json = await blocked.json();
    expect(json.code).toBe('rate_limited');
    expect(json.retry_after_seconds).toBeGreaterThan(0);
    expect(h.world.storage.createSignedUploadUrl).toHaveBeenCalledTimes(600);
  });

  it('pedido recusado pela quota não gasta o orçamento da conta', async () => {
    const { id, token } = seedResponse(h.world);
    const ask = () =>
      uploadUrl(
        post('/upload-url', {
          response_id: id,
          resume_token: token,
          field_key: 'cv',
          name: 'curriculo.pdf',
          mime: 'application/pdf',
          size: 1024,
        }),
        params
      );
    h.world.state.uploadQuota = { used_bytes: 1000, limit_bytes: 1500 };
    for (let i = 0; i < 600; i++) {
      expect((await ask()).status).toBe(409);
    }
    h.world.state.uploadQuota = { used_bytes: 0, limit_bytes: null };
    expect((await ask()).status).toBe(200);
  });
});

// ------------------------------------------------------------
describe('página pública: mídia assinada só da própria conta (F6, L-1)', () => {
  it('caminho de OUTRA conta ou com ".." no JSON do formulário não é assinado', async () => {
    const own = `account-${ACCOUNT_ID}/${FORM_ID}/${crypto.randomUUID()}.png`;
    const foreign = `account-${crypto.randomUUID()}/${FORM_ID}/${crypto.randomUUID()}.png`;
    const traversal = `account-${ACCOUNT_ID}/${FORM_ID}/../x.png`;
    h.world = createWorld({
      form: defaultForm({
        theme: {
          logo_path: foreign,
          welcome: { media: { kind: 'image', path: traversal } },
        },
      }),
      fields: defaultFields().map((f, i) =>
        i === 0 ? { ...f, media: { kind: 'image', path: own } } : f
      ),
    });
    const page = await loadPublicFormPage(SLUG);
    expect(page.kind).toBe('available');
    const signed = h.world.storage.createSignedUrls.mock.calls.flatMap(
      (c) => c[0]
    );
    expect(signed).toEqual([own]);
    if (page.kind === 'available') {
      expect(page.payload.theme.logo_url).toBeNull();
    }
  });
});

// ------------------------------------------------------------
describe('POST …/submit', () => {
  const send = (
    id: string,
    token: string,
    body: Record<string, unknown> = {}
  ) =>
    submit(
      post('/submit', {
        response_id: id,
        resume_token: token,
        answers: validAnswers(),
        ...body,
      }),
      params
    );

  beforeEach(() => addExistingContact(h.world));

  it('conclui: pontuação e faixa do servidor, resume_token descartado, efeitos pós-envio', async () => {
    const { id, token } = seedResponse(h.world);
    const res = await send(id, token);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    expect(lastPatch(h.world)).toMatchObject({
      status: 'completed',
      score: 40,
      band_key: 'hot',
      resume_token_hash: null,
      upload_bytes: 0,
    });
    const snapshot = lastPatch(h.world).answers as Record<
      string,
      { label: string; value: unknown; points: number }
    >;
    expect(snapshot.interest).toMatchObject({ value: 'now', points: 40 });
    expect(snapshot.phone.value).toBe(PHONE_NORMALIZED);

    expect(h.applyMappings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contactId: EXISTING_CONTACT_ID,
        answers: expect.objectContaining({ name: 'Ana', interest: 'now' }),
      })
    );
    expect(h.applyBandActions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        band: expect.objectContaining({ key: 'hot' }),
        accountId: ACCOUNT_ID,
        auditUserId: USER_ID,
        notification: {
          title: 'Nova resposta: Captação',
          body: expect.stringContaining('Quente'),
        },
      })
    );
    expect(h.recordFormSubmitted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ score: 40, bandKey: 'hot', responseId: id })
    );
  });

  it('a pontuação, a faixa e qualquer outro campo vindos do cliente são ignorados', async () => {
    const { id, token } = seedResponse(h.world);
    const res = await send(id, token, {
      score: 999,
      band_key: 'cold',
      band: 'cold',
      points: { interest: 0 },
      contact_id: '99999999-9999-4999-8999-999999999999',
      link_token: 'qualquer',
      answers: {
        ...validAnswers(),
        interest: 'later',
        score: 999,
        __points: 1,
      },
    });
    expect(res.status).toBe(200);
    // `later` vale 10 → faixa `cold`; o 999 do cliente não conta.
    expect(lastPatch(h.world)).toMatchObject({ score: 10, band_key: 'cold' });
    const snapshot = lastPatch(h.world).answers as Record<string, unknown>;
    expect(snapshot.score).toBeUndefined();
    expect(snapshot.__points).toBeUndefined();
    expect(h.applyMappings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactId: EXISTING_CONTACT_ID })
    );
  });

  it('bloco escondido por show_if é descartado, mesmo com valor enviado', async () => {
    const { id, token } = seedResponse(h.world);
    await send(id, token, { answers: { ...validAnswers(), extra: 'segredo' } });
    expect(
      (lastPatch(h.world).answers as Record<string, unknown>).extra
    ).toBeUndefined();

    const visible = seedResponse(h.world);
    await send(visible.id, visible.token, {
      answers: { ...validAnswers(), interest: 'later', extra: 'ok' },
    });
    expect(
      (lastPatch(h.world).answers as Record<string, { value: string }>).extra
        .value
    ).toBe('ok');
  });

  it('trocar o telefone entre o start e o envio não troca o contato', async () => {
    const { id, token } = seedResponse(h.world);
    await send(id, token, {
      answers: { ...validAnswers(), phone: '11977776666' },
    });
    expect(
      (lastPatch(h.world).answers as Record<string, { value: string }>).phone
        .value
    ).toBe(PHONE_NORMALIZED);
  });

  it('respostas inválidas → 422 com a lista por bloco, nada é gravado', async () => {
    const { id, token } = seedResponse(h.world);
    const res = await send(id, token, {
      answers: { phone: PHONE, interest: 'inexistente', consent: false },
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe('validation_failed');
    expect(json.errors).toEqual(
      expect.arrayContaining([
        { key: 'name', code: 'required' },
        { key: 'interest', code: 'invalidOption' },
        { key: 'consent', code: 'consentRequired' },
      ])
    );
    expect(h.world.state.updates).toEqual([]);
    expect(h.applyMappings).not.toHaveBeenCalled();
  });

  it('arquivo de OUTRA resposta é recusado sem nem consultar o Storage', async () => {
    const { id, token } = seedResponse(h.world);
    const foreign = buildUploadPath({
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      responseId: crypto.randomUUID(),
      ext: 'pdf',
    });
    h.world.state.objects.set(foreign, 10);
    const res = await send(id, token, {
      answers: {
        ...validAnswers(),
        cv: [
          { path: foreign, name: 'a.pdf', mime: 'application/pdf', size: 10 },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual([
      { key: 'cv', code: 'invalidFile' },
    ]);
    expect(h.world.storage.list).not.toHaveBeenCalled();
    expect(h.world.state.updates).toEqual([]);
  });

  it('arquivo próprio: confere o objeto e o tamanho REAL, soma os bytes na quota', async () => {
    const { id, token } = seedResponse(h.world);
    const path = buildUploadPath({
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      responseId: id,
      ext: 'pdf',
    });
    const file = { path, name: 'cv.pdf', mime: 'application/pdf', size: 1234 };

    // Objeto ausente e tamanho diferente do declarado: recusa.
    const missing = await send(id, token, {
      answers: { ...validAnswers(), cv: [file] },
    });
    expect(missing.status).toBe(422);
    h.world.state.objects.set(path, 9999);
    const mismatch = await send(id, token, {
      answers: { ...validAnswers(), cv: [file] },
    });
    expect(mismatch.status).toBe(422);
    expect(h.world.state.updates).toEqual([]);

    h.world.state.objects.set(path, 1234);
    const ok = await send(id, token, {
      answers: { ...validAnswers(), cv: [file] },
    });
    expect(ok.status).toBe(200);
    expect(lastPatch(h.world).upload_bytes).toBe(1234);
    expect(h.world.state.rpcCalls).toContainEqual({
      name: 'form_upload_bytes_add',
      args: { p_account_id: ACCOUNT_ID, p_delta: 1234 },
    });
  });

  it('o FileRef gravado leva só path, name, mime e size (lixo do cliente não entra)', async () => {
    const { id, token } = seedResponse(h.world);
    const path = buildUploadPath({
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      responseId: id,
      ext: 'pdf',
    });
    h.world.state.objects.set(path, 77);
    const res = await send(id, token, {
      answers: {
        ...validAnswers(),
        cv: [
          {
            path,
            name: 'cv.pdf',
            mime: 'application/pdf',
            size: 77,
            lixo: { grande: 'x'.repeat(1000) },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const snapshot = lastPatch(h.world).answers as Record<
      string,
      { value: Record<string, unknown>[] }
    >;
    expect(Object.keys(snapshot.cv.value[0]).sort()).toEqual([
      'mime',
      'name',
      'path',
      'size',
    ]);
  });

  it('extensão do caminho diferente da do nome → recusa', async () => {
    const { id, token } = seedResponse(h.world);
    const path = buildUploadPath({
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      responseId: id,
      ext: 'pdf',
    });
    h.world.state.objects.set(path, 10);
    const res = await send(id, token, {
      answers: {
        ...validAnswers(),
        cv: [{ path, name: 'x.png', mime: 'application/pdf', size: 10 }],
      },
    });
    expect(res.status).toBe(422);
  });

  it('quota de upload cheia: o bloco de arquivo obrigatório vira opcional', async () => {
    h.world.state.fields = defaultFields().map((f) =>
      f.key === 'cv' ? { ...f, required: true } : f
    );
    const { id, token } = seedResponse(h.world);
    const blocked = await send(id, token);
    expect(blocked.status).toBe(422);

    h.world.state.uploadQuota = { used_bytes: 100, limit_bytes: 100 };
    const ok = await send(id, token);
    expect(ok.status).toBe(200);
  });

  it('preenchimento rápido demais (< 3 s desde o start) → 400', async () => {
    const { id, token } = seedResponse(h.world, {
      started_at: new Date(Date.now() - 500).toISOString(),
    });
    const res = await send(id, token);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('too_fast');
    expect(h.world.state.updates).toEqual([]);
  });

  it('honeypot no envio → 400', async () => {
    const { id, token } = seedResponse(h.world);
    expect((await send(id, token, { honeypot: 'x' })).status).toBe(400);
  });

  it('envio duplo (corrida): o segundo vira 409 e não repete mapeamento nem faixa', async () => {
    const { id, token } = seedResponse(h.world);
    h.world.state.raceOnComplete = true;
    const res = await send(id, token);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already_submitted');
    expect(h.applyMappings).not.toHaveBeenCalled();
    expect(h.applyBandActions).not.toHaveBeenCalled();
    expect(h.recordFormSubmitted).not.toHaveBeenCalled();
  });

  it('depois de concluída o token não vale mais (404)', async () => {
    const { id, token } = seedResponse(h.world);
    expect((await send(id, token)).status).toBe(200);
    expect((await send(id, token)).status).toBe(404);
  });

  it('allow_multiple_responses=false com outra resposta concluída → 409', async () => {
    h.world.state.completed = [{ id: 'other' }];
    const { id, token } = seedResponse(h.world);
    const res = await send(id, token);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already_answered');
  });

  it('falha em mapeamento, faixa ou atividade não derruba o envio já gravado', async () => {
    h.applyMappings.mockRejectedValueOnce(new Error('boom'));
    h.applyBandActions.mockRejectedValueOnce(new Error('boom'));
    h.recordFormSubmitted.mockRejectedValueOnce(new Error('boom'));
    const { id, token } = seedResponse(h.world);
    const res = await send(id, token);
    expect(res.status).toBe(200);
    expect(lastPatch(h.world).status).toBe('completed');
  });

  it('agradecimento: wa.me do canal padrão e redirect só https', async () => {
    h.world.state.form = defaultForm({
      theme: {
        thank_you: {
          whatsapp_cta: true,
          whatsapp_text: 'Oi, acabei de responder',
          redirect_url: 'https://example.com/obrigado',
        },
      },
    });
    const { id, token } = seedResponse(h.world);
    const json = await (await send(id, token)).json();
    expect(json.thank_you).toEqual({
      whatsapp_url: `https://wa.me/5511988887777?text=${encodeURIComponent('Oi, acabei de responder')}`,
      redirect_url: 'https://example.com/obrigado',
    });
    // O envio nunca devolve pontuação nem faixa ao visitante.
    expect(JSON.stringify(json)).not.toMatch(/score|band|points/);
  });

  it('indisponível no momento do envio (quota/plano/despublicado) → 404 e nada é gravado', async () => {
    const { id, token } = seedResponse(h.world);
    h.world.state.availability = 'responses_quota';
    const res = await send(id, token);
    expect(res.status).toBe(404);
    expect(h.world.state.updates).toEqual([]);
  });

  describe('Turnstile', () => {
    beforeEach(() => {
      vi.stubEnv('TURNSTILE_SITE_KEY', 'site');
      vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
      h.world.state.form = defaultForm({ settings: { turnstile: true } });
    });

    it('sem token, rede caída, timeout ou success=false: RECUSA (fail-closed)', async () => {
      const outcomes: unknown[] = [
        undefined,
        new Error('rede'),
        { ok: false, json: async () => ({}) },
        { ok: true, json: async () => ({ success: false }) },
      ];
      for (const outcome of outcomes) {
        const fetchMock = vi.fn(async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome as Response;
        });
        vi.stubGlobal('fetch', fetchMock);
        const { id, token } = seedResponse(h.world);
        const res = await send(id, token, {
          turnstile: outcome === undefined ? undefined : 'tok',
        });
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('turnstile_failed');
      }
      expect(h.world.state.updates).toEqual([]);
    });

    it('token válido passa; a chamada leva timeout de 5 s', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(String(init?.body)).toContain('secret=secret');
        return { ok: true, json: async () => ({ success: true }) } as Response;
      });
      vi.stubGlobal('fetch', fetchMock);
      const { id, token } = seedResponse(h.world);
      const res = await send(id, token, { turnstile: 'tok' });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        expect.anything()
      );
    });

    it('resposta inválida (422) NÃO gasta o token do Turnstile (uso único)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { id, token } = seedResponse(h.world);
      const res = await send(id, token, {
        turnstile: 'tok',
        answers: { phone: PHONE, interest: 'inexistente' },
      });
      expect(res.status).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sem as chaves no deploy o formulário não exige Turnstile', async () => {
      vi.stubEnv('TURNSTILE_SECRET_KEY', '');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { id, token } = seedResponse(h.world);
      expect((await send(id, token)).status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

// ------------------------------------------------------------
describe('jornada completa: start → autosave → envio', () => {
  it('o token devolvido pelo start serve nas chamadas seguintes', async () => {
    const started = await (
      await start(
        post('/start', { phone: PHONE, elapsed_ms: 5000, honeypot: '' }),
        params
      )
    ).json();
    // A linha criada pelo `start` nasce com o relógio do dublê (60 s atrás).
    const saved = await autosave(
      request('PATCH', `${base}/responses/${started.response_id}`, {
        resume_token: started.resume_token,
        answers_delta: { name: 'Ana' },
      }),
      { params: Promise.resolve({ slug: SLUG, id: started.response_id }) }
    );
    expect(saved.status).toBe(200);

    const done = await submit(
      post('/submit', {
        response_id: started.response_id,
        resume_token: started.resume_token,
        answers: validAnswers(),
      }),
      params
    );
    expect(done.status).toBe(200);
    expect(lastPatch(h.world)).toMatchObject({
      status: 'completed',
      score: 40,
    });
    expect(h.applyMappings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactId: NEW_CONTACT_ID })
    );
  });
});
