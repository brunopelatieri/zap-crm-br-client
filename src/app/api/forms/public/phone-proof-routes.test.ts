// ============================================================
// Prova de posse do telefone nas rotas PÚBLICAS (SPEC 085 F7).
//
// Fecha M-2 e M-3: com `require_phone_proof`, NADA toca `contacts` antes de o
// telefone confirmar a posse, e a resposta só passa a agir sobre o contato
// do telefone CONFIRMADO. O banco é o mundo falso de `test-public-world.ts`
// (inclui `form_phone_proofs`); o webhook é simulado chamando o mesmo gancho
// que `ingestInbound` chama (`handleInboundPhoneProof`).
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signFormLink } from '@/lib/forms/link-token';
import { handleInboundPhoneProof } from '@/lib/forms/phone-proof';
import { loadPublicFormPage } from '@/lib/forms/public-service';
import { ACCOUNT_ID, FORM_ID, USER_ID } from '@/lib/forms/test-fixtures';
import {
  createWorld,
  defaultForm,
  EXISTING_CONTACT_ID,
  NEW_CONTACT_ID,
  SLUG,
  type World,
} from '@/lib/forms/test-public-world';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const h = vi.hoisted(() => ({
  world: null as unknown as World,
  noChannel: false,
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => h.world.db,
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: async () => USER_ID,
}));
vi.mock('@/lib/channels/default-channel', () => ({
  resolveDefaultChannelId: async () => {
    if (h.noChannel) throw new Error('no channel');
    return 'channel-1';
  },
}));

import { POST as phoneProof } from './[slug]/phone-proof/route';
import { POST as proofStatus } from './[slug]/phone-proof/status/route';
import { POST as start } from './[slug]/start/route';

const ORIGIN = 'https://app.example.com';
const SECRET = 'a'.repeat(48);
const PHONE = '11999998888';
const PHONE_CANON = '5511999998888';
const VICTIM = '5511977776666';
const params = { params: Promise.resolve({ slug: SLUG }) };
const base = `/api/forms/public/${SLUG}`;

let ipSeq = 0;
const nextIp = () => `10.2.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

function post(
  route: string,
  body: unknown,
  opts: { origin?: string | null } = {}
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': nextIp(),
    'user-agent': 'vitest',
  };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin) headers.origin = origin;
  return new Request(`${ORIGIN}${base}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const withProof = () =>
  defaultForm({ settings: { require_phone_proof: true } });

const proofBody = (over: Record<string, unknown> = {}) => ({
  phone: PHONE,
  elapsed_ms: 5000,
  honeypot: '',
  ...over,
});

async function issue(phone = PHONE) {
  const res = await phoneProof(
    post('/phone-proof', proofBody({ phone })),
    params
  );
  const json = await res.json();
  expect(res.status).toBe(200);
  return json as {
    proof_id: string;
    proof_secret: string;
    code: string;
    whatsapp_number: string;
  };
}

/** O webhook entregou a mensagem do WhatsApp de `sender` com o código. */
const inbound = (code: string, sender: string) =>
  handleInboundPhoneProof({
    db: h.world.db as never,
    accountId: ACCOUNT_ID,
    senderPhone: sender,
    text: `Quero confirmar meu telefone no formulário. Código: ${code}`,
  });

const startBody = (over: Record<string, unknown> = {}) => ({
  elapsed_ms: 5000,
  honeypot: '',
  ...over,
});

const contactInserts = () =>
  h.world.state.inserts.filter((i) => i.table === 'contacts');
const responseInserts = () =>
  h.world.state.inserts.filter((i) => i.table === 'form_responses');

beforeEach(() => {
  __resetRateLimitForTests();
  h.noChannel = false;
  h.world = createWorld({ form: withProof() });
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
describe('POST …/phone-proof', () => {
  it('gera o código e o número da conta, SEM criar contato nem resposta', async () => {
    const json = await issue();
    expect(json.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(json.whatsapp_number).toBe('5511988887777');
    expect(json.proof_secret.length).toBeGreaterThan(20);
    expect(contactInserts()).toEqual([]);
    expect(responseInserts()).toEqual([]);
    expect(h.world.state.proofs).toHaveLength(1);
    // O telefone nunca volta ao navegador.
    expect(JSON.stringify(json)).not.toContain(PHONE_CANON);
  });

  it('Origin ausente ou de fora: 403, sem tocar no banco', async () => {
    for (const origin of [null, 'https://evil.example']) {
      const res = await phoneProof(
        post('/phone-proof', proofBody(), { origin }),
        params
      );
      expect(res.status).toBe(403);
    }
    expect(h.world.state.proofs).toEqual([]);
  });

  it('honeypot e envio rápido demais: 400; telefone inválido: 422', async () => {
    const hp = await phoneProof(
      post('/phone-proof', proofBody({ honeypot: 'x' })),
      params
    );
    expect(hp.status).toBe(400);
    const fast = await phoneProof(
      post('/phone-proof', proofBody({ elapsed_ms: 500 })),
      params
    );
    expect((await fast.json()).code).toBe('too_fast');
    const bad = await phoneProof(
      post('/phone-proof', proofBody({ phone: '123' })),
      params
    );
    expect(bad.status).toBe(422);
    expect((await bad.json()).code).toBe('invalid_phone');
    expect(h.world.state.proofs).toEqual([]);
  });

  it('formulário sem a confirmação ligada: 400 phone_proof_not_required', async () => {
    h.world.state.form = defaultForm();
    const res = await phoneProof(post('/phone-proof', proofBody()), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('phone_proof_not_required');
  });

  it('conta sem canal WhatsApp: 409 proof_unavailable e nada é gravado', async () => {
    h.noChannel = true;
    const res = await phoneProof(post('/phone-proof', proofBody()), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('proof_unavailable');
    expect(h.world.state.proofs).toEqual([]);
  });

  it('indisponível (plano, quota…) é o mesmo 404 neutro', async () => {
    h.world.state.availability = 'feature_not_in_plan';
    const res = await phoneProof(post('/phone-proof', proofBody()), params);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('unavailable');
  });

  it('segundo código do mesmo telefone em seguida: 429 com Retry-After', async () => {
    await issue();
    const res = await phoneProof(post('/phone-proof', proofBody()), params);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(h.world.state.proofs).toHaveLength(1);
  });

  it('Turnstile ligado: sem token válido recusa e não grava', async () => {
    vi.stubEnv('TURNSTILE_SITE_KEY', 'site');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    h.world.state.form = defaultForm({
      settings: { require_phone_proof: true, turnstile: true },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ success: false }) }))
    );
    const res = await phoneProof(
      post('/phone-proof', proofBody({ turnstile: 'tok' })),
      params
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('turnstile_failed');
    expect(h.world.state.proofs).toEqual([]);
  });
});

// ------------------------------------------------------------
describe('POST …/phone-proof/status', () => {
  const status = async (body: unknown) => {
    const res = await proofStatus(post('/phone-proof/status', body), params);
    return { status: res.status, json: await res.json() };
  };

  it('pending → confirmed quando a mensagem chega DO telefone', async () => {
    const p = await issue();
    const body = { proof_id: p.proof_id, proof_secret: p.proof_secret };
    expect((await status(body)).json.status).toBe('pending');
    await inbound(p.code, PHONE_CANON);
    expect((await status(body)).json.status).toBe('confirmed');
  });

  it('segredo errado ou id desconhecido: not_found (nada se revela)', async () => {
    const p = await issue();
    expect(
      (await status({ proof_id: p.proof_id, proof_secret: 'x' })).json.status
    ).toBe('not_found');
    expect(
      (
        await status({
          proof_id: crypto.randomUUID(),
          proof_secret: p.proof_secret,
        })
      ).json.status
    ).toBe('not_found');
  });

  it('id que não é UUID: 404 neutro', async () => {
    const res = await status({ proof_id: 'nao-uuid', proof_secret: 'x' });
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------
describe('POST …/start com confirmação do telefone (M-2 e M-3)', () => {
  it('M-2: telefone digitado, SEM prova, não cria contato nem resposta', async () => {
    const res = await start(
      post('/start', startBody({ phone: PHONE })),
      params
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('phone_proof_required');
    expect(contactInserts()).toEqual([]);
    expect(responseInserts()).toEqual([]);
  });

  it('M-2: prova ainda pendente (mensagem não chegou) também não cria nada', async () => {
    const p = await issue();
    const res = await start(
      post(
        '/start',
        startBody({ proof_id: p.proof_id, proof_secret: p.proof_secret })
      ),
      params
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('phone_proof_required');
    expect(contactInserts()).toEqual([]);
    expect(responseInserts()).toEqual([]);
  });

  it('M-3: quem conhece o número da vítima não age sobre o contato dela', async () => {
    h.world.state.contacts.push({
      id: EXISTING_CONTACT_ID,
      account_id: ACCOUNT_ID,
      name: 'Vítima',
      phone_normalized: VICTIM,
    });
    // O atacante pede o código para o número da vítima…
    const p = await issue('11977776666');
    // …tenta o `start` com o telefone dela e com a prova pendente…
    for (const body of [
      startBody({ phone: '11977776666' }),
      startBody({
        phone: '11977776666',
        proof_id: p.proof_id,
        proof_secret: p.proof_secret,
      }),
    ]) {
      const res = await start(post('/start', body), params);
      expect(res.status).toBe(400);
    }
    // …e manda o código do PRÓPRIO WhatsApp (outro número): não confirma.
    expect(await inbound(p.code, PHONE_CANON)).toBe(true);
    const res = await start(
      post(
        '/start',
        startBody({
          phone: '11977776666',
          proof_id: p.proof_id,
          proof_secret: p.proof_secret,
        })
      ),
      params
    );
    expect(res.status).toBe(400);
    expect(responseInserts()).toEqual([]);
  });

  it('confirmada: cria o contato e a resposta com o telefone CONFIRMADO, ignorando o que o corpo disser', async () => {
    const p = await issue();
    await inbound(p.code, PHONE_CANON);
    const res = await start(
      post(
        '/start',
        startBody({
          // Outro número no corpo: ignorado.
          phone: '11977776666',
          proof_id: p.proof_id,
          proof_secret: p.proof_secret,
        })
      ),
      params
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.identity_mode).toBe('phone');
    expect(contactInserts()).toHaveLength(1);
    expect(contactInserts()[0].row.phone).toBe(PHONE_CANON);
    expect(responseInserts()[0].row.contact_id).toBe(NEW_CONTACT_ID);
    expect(h.world.state.proofs[0].status).toBe('consumed');
  });

  it('confirmada com contato que já existe (criado pelo inbound): vincula, não duplica', async () => {
    h.world.state.contacts.push({
      id: EXISTING_CONTACT_ID,
      account_id: ACCOUNT_ID,
      name: 'Ana',
      phone_normalized: PHONE_CANON,
    });
    const p = await issue();
    await inbound(p.code, PHONE_CANON);
    const res = await start(
      post(
        '/start',
        startBody({ proof_id: p.proof_id, proof_secret: p.proof_secret })
      ),
      params
    );
    expect(res.status).toBe(200);
    expect(contactInserts()).toEqual([]);
    expect(responseInserts()[0].row.contact_id).toBe(EXISTING_CONTACT_ID);
  });

  it('uso único: a mesma prova não abre uma segunda resposta', async () => {
    const p = await issue();
    await inbound(p.code, PHONE_CANON);
    const body = startBody({
      proof_id: p.proof_id,
      proof_secret: p.proof_secret,
    });
    expect((await start(post('/start', body), params)).status).toBe(200);
    const again = await start(post('/start', body), params);
    expect(again.status).toBe(400);
    expect((await again.json()).code).toBe('phone_proof_required');
    expect(responseInserts()).toHaveLength(1);
  });

  it('segredo de outro navegador não consome a prova confirmada', async () => {
    const p = await issue();
    await inbound(p.code, PHONE_CANON);
    const res = await start(
      post(
        '/start',
        startBody({ proof_id: p.proof_id, proof_secret: 'outro-navegador' })
      ),
      params
    );
    expect(res.status).toBe(400);
    expect(h.world.state.proofs[0].status).toBe('confirmed');
    expect(responseInserts()).toEqual([]);
  });

  it('o link pessoal (token) continua valendo SEM prova: já foi enviado àquele contato', async () => {
    h.world.state.contacts.push({
      id: EXISTING_CONTACT_ID,
      account_id: ACCOUNT_ID,
      name: 'Ana',
      phone_normalized: PHONE_CANON,
    });
    const token = signFormLink({
      formId: FORM_ID,
      contactId: EXISTING_CONTACT_ID,
      source: 'inbox',
    });
    const res = await start(
      post('/start', startBody({ link_token: token })),
      params
    );
    expect(res.status).toBe(200);
    expect((await res.json()).identity_mode).toBe('token');
  });

  it('token válido de contato apagado NÃO cai no telefone digitado', async () => {
    const token = signFormLink({
      formId: FORM_ID,
      contactId: EXISTING_CONTACT_ID,
      source: 'inbox',
    });
    const res = await start(
      post('/start', startBody({ link_token: token, phone: PHONE })),
      params
    );
    expect(res.status).toBe(400);
    expect(contactInserts()).toEqual([]);
  });

  it('formulário SEM a confirmação segue como antes (modo atual): telefone digitado cria o contato', async () => {
    h.world.state.form = defaultForm();
    const res = await start(
      post('/start', startBody({ phone: PHONE })),
      params
    );
    expect(res.status).toBe(200);
    expect(contactInserts()).toHaveLength(1);
  });
});

// ------------------------------------------------------------
describe('página com a confirmação do telefone', () => {
  it('modo telefone: o payload avisa o cliente; com token válido, não', async () => {
    const page = await loadPublicFormPage(SLUG);
    expect(page.kind).toBe('available');
    if (page.kind !== 'available') return;
    expect(page.payload.settings.phone_proof).toBe(true);
    expect(JSON.stringify(page.payload)).not.toContain('require_phone_proof');

    h.world.state.contacts.push({
      id: EXISTING_CONTACT_ID,
      account_id: ACCOUNT_ID,
      name: 'Ana',
      phone_normalized: PHONE_CANON,
    });
    const token = signFormLink({
      formId: FORM_ID,
      contactId: EXISTING_CONTACT_ID,
      source: 'inbox',
    });
    const personal = await loadPublicFormPage(SLUG, token);
    expect(personal.kind).toBe('available');
    if (personal.kind === 'available') {
      expect(personal.payload.settings.phone_proof).toBe(false);
    }
  });

  it('sem canal WhatsApp: a mesma página neutra (fail-closed), não o modo sem prova', async () => {
    h.noChannel = true;
    const page = await loadPublicFormPage(SLUG);
    expect(page).toEqual({ kind: 'unavailable' });
  });

  it('sem a confirmação ligada, a conta sem canal não afeta a página', async () => {
    h.noChannel = true;
    h.world.state.form = defaultForm();
    const page = await loadPublicFormPage(SLUG);
    expect(page.kind).toBe('available');
    if (page.kind === 'available') {
      expect(page.payload.settings.phone_proof).toBe(false);
    }
  });
});
