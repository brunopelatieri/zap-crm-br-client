// ============================================================
// Sessão de preenchimento do visitante (SPEC 085 §4.2, F3): `start` só
// depois da identidade, fila de autosave com reenvio, upload direto,
// envio sem campo de pontos, rascunho local à prova de falha.
// ============================================================

import { describe, expect, it, vi } from 'vitest';

import {
  FormSession,
  MIN_FILL_MS,
  type FormSessionOptions,
} from './form-session';
import type { PublicField } from './types';

const fields = [
  { key: 'phone', type: 'phone', is_identity: true },
  { key: 'name', type: 'short_text', is_identity: false },
  { key: 'cv', type: 'file_upload', is_identity: false },
  { key: 'intro', type: 'statement', is_identity: false },
] as const;
const field = (key: string) =>
  fields.find((f) => f.key === key) as unknown as PublicField;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function setup(
  responder: (call: Call) => { status?: number; json?: unknown } | Error,
  over: Partial<FormSessionOptions> = {}
) {
  const calls: Call[] = [];
  const clock = { now: 1_000_000 };
  const sleeps: number[] = [];
  const store = new Map<string, string>();
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body:
        typeof init?.body === 'string' ? JSON.parse(init.body) : ({} as never),
    };
    calls.push(call);
    const r = responder(call);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json ?? {},
    } as Response;
  });
  const session = new FormSession({
    slug: 'captacao',
    identityMode: 'phone',
    fields,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    getLinkToken: () => null,
    getUtm: () => ({ utm_source: 'ig' }),
    isEmbedded: () => false,
    ...over,
  });
  return { session, calls, clock, sleeps, store, fetchImpl };
}

const STARTED = { json: { response_id: 'r1', resume_token: 'tok' } };
const route = (c: Call) =>
  `${c.method} ${c.url.replace('/api/forms/public/captacao', '')}`;

describe('start', () => {
  it('só acontece no bloco de identidade; antes disso a sessão não fala com o servidor', async () => {
    const { session, calls } = setup(() => STARTED);
    expect(await session.blockDone(field('intro'), {})).toEqual({ ok: true });
    expect(await session.blockDone(field('name'), { name: 'Ana' })).toEqual({
      ok: true,
    });
    expect(calls).toEqual([]);
  });

  it('espera os 3 s da página aberta em vez de falhar e manda o telefone, utm e honeypot', async () => {
    const { session, calls, sleeps } = setup(() => STARTED);
    session.setHoneypot('');
    const r = await session.blockDone(field('phone'), { phone: '11999998888' });
    expect(r).toEqual({ ok: true });
    expect(sleeps[0]).toBeGreaterThanOrEqual(MIN_FILL_MS);
    expect(route(calls[0])).toBe('POST /start');
    expect(calls[0].body).toMatchObject({
      phone: '11999998888',
      utm: { utm_source: 'ig' },
      embedded: false,
      honeypot: '',
    });
    expect(calls[0].body.elapsed_ms).toBeGreaterThanOrEqual(MIN_FILL_MS);
  });

  it('o que já foi respondido vai junto no primeiro autosave', async () => {
    const { session, calls } = setup(() => STARTED);
    await session.blockDone(field('phone'), {
      phone: '11999998888',
      name: 'Ana',
    });
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(route(calls[1])).toBe('PATCH /responses/r1');
    expect(calls[1].body).toEqual({
      resume_token: 'tok',
      answers_delta: { phone: '11999998888', name: 'Ana' },
    });
  });

  it('modo token: começa no primeiro bloco concluído, com o token do endereço', async () => {
    const { session, calls } = setup(() => STARTED, {
      identityMode: 'token',
      getLinkToken: () => 'TOKEN.SIG',
    });
    await session.blockDone(field('name'), { name: 'Ana' });
    expect(route(calls[0])).toBe('POST /start');
    expect(calls[0].body.link_token).toBe('TOKEN.SIG');
    expect(calls[0].body.phone).toBeUndefined();
  });

  it('"já respondeu" e erros do servidor voltam ao componente', async () => {
    const a = setup(() => ({ json: { already_answered: true } }));
    expect(await a.session.blockDone(field('phone'), { phone: '1' })).toEqual({
      ok: true,
      alreadyAnswered: true,
    });
    const b = setup(() => ({ status: 422, json: { code: 'invalid_phone' } }));
    expect(await b.session.blockDone(field('phone'), { phone: '1' })).toEqual({
      ok: false,
      code: 'invalid_phone',
    });
    const c = setup(() => new Error('offline'));
    expect(await c.session.blockDone(field('phone'), { phone: '1' })).toEqual({
      ok: false,
      code: 'network',
    });
  });

  it('dois cliques seguidos compartilham o mesmo start', async () => {
    const { session, calls } = setup(() => STARTED);
    await Promise.all([
      session.blockDone(field('phone'), { phone: '11999998888' }),
      session.blockDone(field('phone'), { phone: '11999998888' }),
    ]);
    expect(calls.filter((c) => route(c) === 'POST /start')).toHaveLength(1);
  });
});

describe('autosave com fila de reenvio', () => {
  it('falha de rede não trava: o lote volta à fila e é reenviado; o valor mais novo vence', async () => {
    let failing = true;
    const { session, calls } = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      return failing ? new Error('offline') : { json: { ok: true } };
    });
    await session.blockDone(field('phone'), { phone: '11999998888' });
    failing = false;
    await vi.waitFor(() => {
      const patches = calls.filter((c) => c.method === 'PATCH');
      expect(patches.length).toBeGreaterThanOrEqual(1);
    });
    // Enquanto o primeiro lote falha, o visitante muda a resposta.
    session.retryPending();
    await session.blockDone(field('name'), { name: 'Ana' });
    await vi.waitFor(() => {
      const last = calls.filter((c) => c.method === 'PATCH').at(-1)!;
      expect((last.body.answers_delta as Record<string, unknown>).name).toBe(
        'Ana'
      );
    });
  });

  it('404 (resposta concluída/fora do ar) encerra a fila; 5xx insiste com espera', async () => {
    const dead = setup((c) =>
      route(c) === 'POST /start'
        ? STARTED
        : { status: 404, json: { code: 'not_found' } }
    );
    await dead.session.blockDone(field('phone'), { phone: '11999998888' });
    await vi.waitFor(() =>
      expect(dead.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    );
    await dead.session.blockDone(field('name'), { name: 'A' });
    expect(dead.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);

    let n = 0;
    const flaky = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      return ++n < 3 ? { status: 503 } : { json: { ok: true } };
    });
    await flaky.session.blockDone(field('phone'), { phone: '11999998888' });
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(3));
    // 1 s, depois 2 s entre as tentativas.
    expect(flaky.sleeps.filter((s) => s <= 8000 && s >= 1000)).toContain(1000);
  });

  it('só chaves de blocos com valor entram (statement fica de fora)', async () => {
    const { session, calls } = setup((c) =>
      route(c) === 'POST /start' ? STARTED : { json: {} }
    );
    await session.blockDone(field('phone'), {
      phone: '11999998888',
      intro: 'x',
    } as never);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(Object.keys(calls[1].body.answers_delta as object)).toEqual([
      'phone',
    ]);
  });
});

describe('upload: MIME do .csv', () => {
  it('Chrome no Windows reporta .csv como ms-excel: sai como text/csv', async () => {
    const { session, calls } = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      return {
        json: {
          path: 'p',
          signed_url: 'https://sb.example/u',
          mime: 'text/csv',
        },
      };
    });
    await session.blockDone(field('phone'), { phone: '11999998888' });
    await session.upload(field('cv'), {
      name: 'leads.CSV',
      type: 'application/vnd.ms-excel',
      size: 10,
    });
    const body = calls.find((c) => route(c) === 'POST /upload-url')!.body;
    expect(body.mime).toBe('text/csv');
    // Um PDF de verdade não é reescrito.
    await session.upload(field('cv'), {
      name: 'a.pdf',
      type: 'application/pdf',
      size: 10,
    });
    const last = calls.filter((c) => route(c) === 'POST /upload-url').at(-1)!;
    expect(last.body.mime).toBe('application/pdf');
  });
});

describe('envio com resposta perdida', () => {
  it('falha de rede e reenvio que volta 404 = já concluiu: sucesso, sem dados de agradecimento', async () => {
    let submits = 0;
    const { session, store } = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      if (route(c) === 'POST /submit') {
        return ++submits === 1
          ? new Error('offline')
          : { status: 404, json: { code: 'not_found' } };
      }
      return { json: {} };
    });
    session.saveDraft({ name: 'Ana' });
    const first = await session.submit({ phone: '11999998888' }, null);
    expect(first).toEqual({ ok: false, code: 'network', errors: undefined });
    const again = await session.submit({ phone: '11999998888' }, null);
    expect(again).toEqual({
      ok: true,
      thankYou: { whatsapp_url: null, redirect_url: null },
    });
    expect(store.size).toBe(0);
  });

  it('404 SEM tentativa incerta antes continua sendo falha', async () => {
    const { session } = setup((c) =>
      route(c) === 'POST /start'
        ? STARTED
        : { status: 404, json: { code: 'not_found' } }
    );
    const r = await session.submit({ phone: '11999998888' }, null);
    expect(r.ok).toBe(false);
  });
});

describe('upload direto', () => {
  const file = { name: 'cv.pdf', type: 'application/pdf', size: 2048 };

  it('pede a URL, envia ao Storage com PUT e devolve a referência', async () => {
    const { session, calls } = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      if (route(c) === 'POST /upload-url') {
        return {
          json: {
            path: 'account-a/f/r/x.pdf',
            signed_url: 'https://sb.example/upload',
            mime: 'application/pdf',
          },
        };
      }
      return { json: {} };
    });
    await session.blockDone(field('phone'), { phone: '11999998888' });
    const r = await session.upload(field('cv'), file);
    expect(r).toEqual({
      ok: true,
      ref: {
        path: 'account-a/f/r/x.pdf',
        name: 'cv.pdf',
        mime: 'application/pdf',
        size: 2048,
      },
    });
    const put = calls.find((c) => c.url === 'https://sb.example/upload')!;
    expect(put.method).toBe('PUT');
    expect(
      calls.find((c) => route(c) === 'POST /upload-url')!.body
    ).toMatchObject({
      response_id: 'r1',
      resume_token: 'tok',
      field_key: 'cv',
      name: 'cv.pdf',
      mime: 'application/pdf',
      size: 2048,
    });
  });

  it('recusa da rota (tamanho, tipo) e falha do PUT voltam como código', async () => {
    const big = setup((c) =>
      route(c) === 'POST /start'
        ? STARTED
        : { status: 413, json: { code: 'file_too_large', max_bytes: 5242880 } }
    );
    await big.session.blockDone(field('phone'), { phone: '11999998888' });
    expect(await big.session.upload(field('cv'), file)).toEqual({
      ok: false,
      code: 'file_too_large',
      maxBytes: 5242880,
    });

    const putFails = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      if (route(c) === 'POST /upload-url') {
        return {
          json: {
            path: 'p',
            signed_url: 'https://sb.example/u',
            mime: 'application/pdf',
          },
        };
      }
      return c.url === 'https://sb.example/u' ? { status: 500 } : { json: {} };
    });
    await putFails.session.blockDone(field('phone'), { phone: '11999998888' });
    expect(await putFails.session.upload(field('cv'), file)).toEqual({
      ok: false,
      code: 'upload_failed',
    });
  });

  it('sem start (identidade ainda não respondida) não sobe nada', async () => {
    const { session, calls } = setup(() => STARTED);
    expect(await session.upload(field('cv'), file)).toEqual({
      ok: false,
      code: 'unexpected',
    });
    expect(calls).toEqual([]);
  });
});

describe('envio', () => {
  it('manda só as respostas (sem pontos nem faixa) e limpa o rascunho', async () => {
    const { session, calls, store } = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      if (route(c) === 'POST /submit') {
        return {
          json: {
            ok: true,
            thank_you: { whatsapp_url: 'https://wa.me/55', redirect_url: null },
          },
        };
      }
      return { json: {} };
    });
    session.saveDraft({ name: 'Ana' });
    expect(store.size).toBe(1);

    const answers = { phone: '11999998888', name: 'Ana' };
    const r = await session.submit(answers, 'ts-token');
    expect(r).toEqual({
      ok: true,
      thankYou: { whatsapp_url: 'https://wa.me/55', redirect_url: null },
    });
    const body = calls.find((c) => route(c) === 'POST /submit')!.body;
    expect(Object.keys(body).sort()).toEqual([
      'answers',
      'honeypot',
      'response_id',
      'resume_token',
      'turnstile',
    ]);
    expect(body.answers).toEqual(answers);
    expect(body.turnstile).toBe('ts-token');
    expect(store.size).toBe(0);
  });

  it('too_fast: espera e tenta de novo uma vez; 422 devolve os erros por bloco', async () => {
    let submits = 0;
    const retry = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      if (route(c) === 'POST /submit') {
        return ++submits === 1
          ? { status: 400, json: { code: 'too_fast' } }
          : { json: { ok: true, thank_you: {} } };
      }
      return { json: {} };
    });
    const ok = await retry.session.submit({ phone: '11999998888' }, null);
    expect(ok.ok).toBe(true);
    expect(submits).toBe(2);

    const invalid = setup((c) => {
      if (route(c) === 'POST /start') return STARTED;
      if (route(c) === 'POST /submit') {
        return {
          status: 422,
          json: {
            code: 'validation_failed',
            errors: [{ key: 'name', code: 'required' }],
          },
        };
      }
      return { json: {} };
    });
    expect(
      await invalid.session.submit({ phone: '11999998888' }, null)
    ).toEqual({
      ok: false,
      code: 'validation_failed',
      errors: [{ key: 'name', code: 'required' }],
    });
  });

  it('já respondeu (start) vira o código para a tela', async () => {
    const { session } = setup(() => ({ json: { already_answered: true } }));
    expect(await session.submit({ phone: '1' }, null)).toEqual({
      ok: false,
      code: 'already_answered',
    });
  });
});

describe('rascunho local', () => {
  it('guarda e devolve só blocos conhecidos, sem arquivos; expira em 7 dias', () => {
    const { session, store, clock } = setup(() => STARTED);
    session.saveDraft({
      name: 'Ana',
      cv: [{ path: 'p', name: 'a.pdf', mime: 'application/pdf', size: 1 }],
    });
    const saved = JSON.parse([...store.values()][0]);
    expect(Object.keys(saved.answers)).toEqual(['name']);

    expect(session.loadDraft()).toEqual({ name: 'Ana' });
    clock.now += 8 * 24 * 60 * 60 * 1000;
    expect(session.loadDraft()).toEqual({});
  });

  it('o telefone (identidade) não fica no navegador e o rascunho vale 2 h', () => {
    const { session, store, clock } = setup(() => STARTED);
    session.saveDraft({ phone: '11999998888', name: 'Ana' });
    const saved = JSON.parse([...store.values()][0]);
    expect(Object.keys(saved.answers)).toEqual(['name']);

    // Mesmo um rascunho antigo com telefone não o devolve.
    store.set(
      'zapcrm-form:captacao',
      JSON.stringify({
        savedAt: clock.now,
        answers: { phone: '11999998888', name: 'Ana' },
      })
    );
    expect(session.loadDraft()).toEqual({ name: 'Ana' });
    clock.now += 3 * 60 * 60 * 1000;
    expect(session.loadDraft()).toEqual({});
  });

  it('chaves desconhecidas e JSON corrompido são ignorados', () => {
    const { session, store } = setup(() => STARTED);
    store.set(
      'zapcrm-form:captacao',
      JSON.stringify({
        savedAt: 1_000_000,
        answers: { name: 'Ana', inexistente: 'x', cv: [] },
      })
    );
    expect(session.loadDraft()).toEqual({ name: 'Ana' });
    store.set('zapcrm-form:captacao', '{quebrado');
    expect(session.loadDraft()).toEqual({});
  });

  it('armazenamento que lança (modo privado) nunca quebra o formulário', () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    const { session } = setup(() => STARTED, {
      storage: { getItem: boom, setItem: boom, removeItem: boom },
    });
    expect(() => session.saveDraft({ name: 'Ana' })).not.toThrow();
    expect(session.loadDraft()).toEqual({});
  });

  it('rascunho vazio remove a chave', () => {
    const { session, store } = setup(() => STARTED);
    session.saveDraft({ name: 'Ana' });
    session.saveDraft({});
    expect(store.size).toBe(0);
  });
});

describe('confirmação do telefone pelo WhatsApp (F7)', () => {
  const PROOF = {
    json: {
      proof_id: 'p1',
      proof_secret: 'sec',
      code: 'ABCD-2345',
      whatsapp_number: '5511988887777',
      expires_in_seconds: 600,
    },
  };
  const responder =
    (status: () => string) =>
    (c: Call): { status?: number; json?: unknown } => {
      switch (route(c)) {
        case 'POST /phone-proof':
          return PROOF;
        case 'POST /phone-proof/status':
          return { json: { status: status() } };
        case 'POST /start':
          return STARTED;
        default:
          return { json: { saved: [], rejected: [] } };
      }
    };

  it('o bloco de identidade NÃO chama o `start`: pede a confirmação', async () => {
    const { session, calls } = setup(
      responder(() => 'pending'),
      {
        phoneProof: true,
      }
    );
    const r = await session.blockDone(field('phone'), { phone: '11999998888' });
    expect(r).toEqual({ ok: true, needsProof: true });
    expect(calls).toEqual([]);
  });

  it('modo token ignora a confirmação (o link já prova o contato)', async () => {
    const { session, calls } = setup(
      responder(() => 'pending'),
      {
        phoneProof: true,
        identityMode: 'token',
      }
    );
    expect(await session.blockDone(field('name'), { name: 'Ana' })).toEqual({
      ok: true,
    });
    expect(route(calls[0])).toBe('POST /start');
  });

  it('pede o código com o telefone, honeypot e tempo; guarda a prova e devolve o código', async () => {
    const { session, calls, sleeps } = setup(
      responder(() => 'pending'),
      {
        phoneProof: true,
      }
    );
    const r = await session.requestProof({ phone: '11999998888' }, 'cf-tok');
    expect(r).toEqual({
      ok: true,
      code: 'ABCD-2345',
      whatsappNumber: '5511988887777',
      expiresInSeconds: 600,
    });
    expect(sleeps[0]).toBeGreaterThanOrEqual(MIN_FILL_MS);
    expect(route(calls[0])).toBe('POST /phone-proof');
    expect(calls[0].body).toMatchObject({
      phone: '11999998888',
      honeypot: '',
      turnstile: 'cf-tok',
    });
  });

  it('só depois de `confirmed` o `start` leva proof_id/proof_secret e NÃO o telefone', async () => {
    let status = 'pending';
    const { session, calls } = setup(
      responder(() => status),
      {
        phoneProof: true,
      }
    );
    await session.requestProof({ phone: '11999998888' }, null);
    expect(await session.checkProof()).toBe('pending');
    // Ainda pendente: o bloco continua pedindo a confirmação.
    expect(
      await session.blockDone(field('phone'), { phone: '11999998888' })
    ).toEqual({ ok: true, needsProof: true });

    status = 'confirmed';
    expect(await session.checkProof()).toBe('confirmed');
    expect(
      await session.blockDone(field('phone'), { phone: '11999998888' })
    ).toEqual({ ok: true });
    const startCall = calls.find((c) => route(c) === 'POST /start');
    expect(startCall?.body).toMatchObject({
      proof_id: 'p1',
      proof_secret: 'sec',
    });
    expect(startCall?.body.phone).toBeUndefined();
  });

  it('prova vencida ou desconhecida: expired, e o `start` recusado volta a pedir confirmação', async () => {
    const { session } = setup(
      (c) =>
        route(c) === 'POST /start'
          ? { status: 400, json: { code: 'phone_proof_required' } }
          : responder(() => 'not_found')(c),
      { phoneProof: true }
    );
    await session.requestProof({ phone: '11999998888' }, null);
    expect(await session.checkProof()).toBe('expired');
  });

  it('start recusado com phone_proof_required (venceu entre a confirmação e o envio) limpa a prova', async () => {
    let status = 'confirmed';
    const { session } = setup(
      (c) =>
        route(c) === 'POST /start'
          ? { status: 400, json: { code: 'phone_proof_required' } }
          : responder(() => status)(c),
      { phoneProof: true }
    );
    await session.requestProof({ phone: '11999998888' }, null);
    await session.checkProof();
    expect(
      await session.blockDone(field('phone'), { phone: '11999998888' })
    ).toEqual({ ok: true, needsProof: true });
    // A prova foi esquecida: sem novo código, nada a consultar.
    status = 'confirmed';
    expect(await session.checkProof()).toBe('expired');
  });

  it('429 do código devolve o tempo de espera; rede caída é erro retentável', async () => {
    const a = setup(
      () => ({
        status: 429,
        json: { code: 'rate_limited', retry_after_seconds: 120 },
      }),
      { phoneProof: true }
    );
    expect(await a.session.requestProof({ phone: '1' }, null)).toEqual({
      ok: false,
      code: 'rate_limited',
      retryAfterSeconds: 120,
    });
    const b = setup(() => new Error('rede'), { phoneProof: true });
    expect(await b.session.requestProof({ phone: '1' }, null)).toMatchObject({
      ok: false,
      code: 'network',
    });
    expect(await b.session.checkProof()).toBe('expired');
  });

  it('sem a confirmação ligada, o telefone digitado segue no `start` (modo atual)', async () => {
    const { session, calls } = setup(() => STARTED);
    await session.blockDone(field('phone'), { phone: '11999998888' });
    expect(calls[0].body.phone).toBe('11999998888');
    expect(calls[0].body.proof_id).toBeUndefined();
  });
});

describe('código de confirmação reaproveitado (F7)', () => {
  it('mesmo telefone com o código ainda válido: sem novo pedido; "novo código" (fresh) ou outro telefone pedem de novo', async () => {
    let n = 0;
    const { session, calls } = setup(
      () => ({
        json: {
          proof_id: `p${++n}`,
          proof_secret: 'sec',
          code: `ABCD-234${n}`,
          whatsapp_number: '5511988887777',
          expires_in_seconds: 600,
        },
      }),
      { phoneProof: true }
    );
    const first = await session.requestProof({ phone: '11999998888' }, null);
    const again = await session.requestProof({ phone: '11999998888' }, null);
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);

    const fresh = await session.requestProof({ phone: '11999998888' }, null, {
      fresh: true,
    });
    expect(fresh).toMatchObject({ ok: true, code: 'ABCD-2342' });
    const other = await session.requestProof({ phone: '11977776666' }, null);
    expect(other).toMatchObject({ ok: true, code: 'ABCD-2343' });
    expect(calls).toHaveLength(3);
  });

  it('prova vencida no servidor (expired) descarta o código guardado', async () => {
    let n = 0;
    const { session, calls } = setup(
      (c) =>
        c.url.endsWith('/phone-proof/status')
          ? { json: { status: 'expired' } }
          : {
              json: {
                proof_id: `p${++n}`,
                proof_secret: 'sec',
                code: 'ABCD-2345',
                whatsapp_number: '5511988887777',
                expires_in_seconds: 600,
              },
            },
      { phoneProof: true }
    );
    await session.requestProof({ phone: '11999998888' }, null);
    expect(await session.checkProof()).toBe('expired');
    await session.requestProof({ phone: '11999998888' }, null);
    expect(calls.filter((c) => c.url.endsWith('/phone-proof'))).toHaveLength(2);
  });
});
