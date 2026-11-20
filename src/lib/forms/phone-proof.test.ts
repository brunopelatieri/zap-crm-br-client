// ============================================================
// Prova de posse do telefone (SPEC 085 F7). O banco é o `form_phone_proofs`
// em memória de `test-public-world.ts`: nenhum banco, nenhuma rede.
//
// O que se prova: o código só confirma quando a mensagem vem do TELEFONE
// informado (o remetente é a prova), uso único, vencimento, os tetos por
// telefone/formulário/conta, o segredo do navegador e que o gancho do
// webhook consome a mensagem sem nunca lançar.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  confirmPhoneProofFromInbound,
  consumePhoneProof,
  extractProofCodes,
  formatProofCode,
  generateProofCode,
  getProofStatus,
  handleInboundPhoneProof,
  hashProofSecret,
  issuePhoneProof,
  PROOF_CODE_ALPHABET,
  PROOF_CONFIRMED_TTL_MS,
  PROOF_LIMITS,
  PROOF_PENDING_TTL_MS,
  phonesMatch,
  restorePhoneProof,
  sweepPhoneProofs,
} from './phone-proof';
import { ACCOUNT_ID, FORM_ID } from './test-fixtures';
import { createWorld } from './test-public-world';

const T0 = new Date('2026-11-19T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const PHONE = '11999998888';
const PHONE_CANON = '5511999998888';
const OTHER_ACCOUNT = '99999999-9999-4999-8999-999999999999';

function setup() {
  const w = createWorld();
  w.state.clock = () => T0.getTime();
  return w;
}

async function issue(
  w: ReturnType<typeof setup>,
  over: Partial<Parameters<typeof issuePhoneProof>[1]> = {}
) {
  const r = await issuePhoneProof(w.db as never, {
    accountId: ACCOUNT_ID,
    formId: FORM_ID,
    phone: PHONE,
    ipHash: 'iphash',
    now: T0,
    brMode: true,
    ...over,
  });
  if (!r.ok) throw new Error(`issue failed: ${r.reason}`);
  return r;
}

describe('código', () => {
  it('tem 8 caracteres do alfabeto sem 0, 1, I, L, O', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateProofCode();
      expect(code).toHaveLength(8);
      for (const ch of code) expect(PROOF_CODE_ALPHABET).toContain(ch);
    }
    expect(PROOF_CODE_ALPHABET).not.toMatch(/[01ILO]/);
  });

  it('formata com hífen e o extrai de uma mensagem em qualquer caixa/formato', () => {
    expect(formatProofCode('ABCD2345')).toBe('ABCD-2345');
    const variants = [
      'Quero confirmar meu telefone no formulário. Código: ABCD-2345',
      'codigo abcd-2345 obrigado',
      'ABCD 2345',
      'ABCD2345',
      '(abcd2345)',
    ];
    for (const text of variants) {
      expect(extractProofCodes(text)).toEqual(['ABCD2345']);
    }
  });

  it('não extrai de texto sem código, comprido demais ou colado a outras letras', () => {
    expect(extractProofCodes('bom dia, tudo bem com vocês?')).toEqual([]);
    expect(extractProofCodes('')).toEqual([]);
    expect(extractProofCodes(null)).toEqual([]);
    expect(extractProofCodes('x'.repeat(500) + ' ABCD2345')).toEqual([]);
    // 9 caracteres seguidos: não é um código de 8.
    expect(extractProofCodes('ABCD23456')).toEqual([]);
    // I, L, O e 0, 1 não existem no alfabeto.
    expect(extractProofCodes('ABCD-0123')).toEqual([]);
  });

  it('devolve no máximo 3 códigos candidatos, sem repetir', () => {
    const text = 'AAAA2222 BBBB3333 AAAA2222 CCCC4444 DDDD5555';
    expect(extractProofCodes(text)).toEqual([
      'AAAA2222',
      'BBBB3333',
      'CCCC4444',
    ]);
  });
});

describe('phonesMatch', () => {
  it('é o mesmo telefone com ou sem o nono dígito e com máscara', () => {
    expect(phonesMatch(PHONE_CANON, '5511999998888', { brMode: true })).toBe(
      true
    );
    expect(phonesMatch(PHONE_CANON, '551199998888', { brMode: true })).toBe(
      true
    );
    expect(
      phonesMatch(PHONE_CANON, '+55 (11) 99999-8888', { brMode: true })
    ).toBe(true);
  });

  it('número diferente, ou que não normaliza, não casa', () => {
    expect(phonesMatch(PHONE_CANON, '5511999990000', { brMode: true })).toBe(
      false
    );
    expect(phonesMatch(PHONE_CANON, 'abc', { brMode: true })).toBe(false);
  });
});

describe('issuePhoneProof', () => {
  it('grava só o hash do segredo, o telefone canônico e o prazo de 10 min', async () => {
    const w = setup();
    const r = await issue(w);
    expect(w.state.proofs).toHaveLength(1);
    const row = w.state.proofs[0];
    expect(row).toMatchObject({
      account_id: ACCOUNT_ID,
      form_id: FORM_ID,
      phone: PHONE_CANON,
      status: 'pending',
      code: r.code,
      secret_hash: hashProofSecret(r.secret),
    });
    expect(JSON.stringify(row)).not.toContain(r.secret);
    expect(new Date(row.expires_at).getTime()).toBe(
      T0.getTime() + PROOF_PENDING_TTL_MS
    );
  });

  it('telefone inválido não grava nada', async () => {
    const w = setup();
    const r = await issuePhoneProof(w.db as never, {
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      phone: '123',
      ipHash: null,
      now: T0,
      brMode: true,
    });
    expect(r).toEqual({ ok: false, reason: 'invalid_phone' });
    expect(w.state.proofs).toHaveLength(0);
  });

  it('um código novo do mesmo telefone substitui o pendente anterior', async () => {
    const w = setup();
    const first = await issue(w);
    w.state.clock = () => T0.getTime() + 60_000;
    const second = await issue(w, { now: at(60_000) });
    const byCode = new Map(w.state.proofs.map((p) => [p.code, p.status]));
    expect(byCode.get(first.code)).toBe('expired');
    expect(byCode.get(second.code)).toBe('pending');
  });

  it('segura o intervalo mínimo entre dois códigos do mesmo telefone', async () => {
    const w = setup();
    await issue(w);
    const again = await issuePhoneProof(w.db as never, {
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      phone: PHONE,
      ipHash: null,
      now: at(5_000),
      brMode: true,
    });
    expect(again).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(
      (again as { retryAfterSeconds: number }).retryAfterSeconds
    ).toBeGreaterThan(0);
    expect(w.state.proofs).toHaveLength(1);
  });

  it('o 6º código do mesmo telefone na hora é recusado', async () => {
    const w = setup();
    for (let i = 0; i < PROOF_LIMITS.perPhoneHour; i++) {
      const t = i * (PROOF_LIMITS.minIntervalMs + 1000);
      w.state.clock = () => T0.getTime() + t;
      await issue(w, { now: at(t) });
    }
    const t = PROOF_LIMITS.perPhoneHour * (PROOF_LIMITS.minIntervalMs + 1000);
    w.state.clock = () => T0.getTime() + t;
    const sixth = await issuePhoneProof(w.db as never, {
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      phone: PHONE,
      ipHash: null,
      now: at(t),
      brMode: true,
    });
    expect(sixth).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(w.state.proofs).toHaveLength(PROOF_LIMITS.perPhoneHour);
  });

  it('teto por formulário e por conta: telefones diferentes também são contados', async () => {
    const w = setup();
    const row = (over: Record<string, unknown>) =>
      w.state.proofs.push({
        id: crypto.randomUUID(),
        account_id: ACCOUNT_ID,
        form_id: FORM_ID,
        phone: '5511900000000',
        code: generateProofCode(),
        secret_hash: 'a'.repeat(64),
        status: 'expired',
        ip_hash: null,
        expires_at: T0.toISOString(),
        confirmed_at: null,
        consumed_at: null,
        created_at: new Date(T0.getTime() - 1000).toISOString(),
        ...over,
      });
    for (let i = 0; i < PROOF_LIMITS.perFormHour; i++) row({});
    const blockedForm = await issuePhoneProof(w.db as never, {
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      phone: PHONE,
      ipHash: null,
      now: T0,
      brMode: true,
    });
    expect(blockedForm).toMatchObject({ ok: false, reason: 'rate_limited' });

    // Mil provas espalhadas em formulários da conta (nenhum no teto)…
    const w2 = setup();
    const otherForm = '88888888-8888-4888-8888-888888888888';
    for (let i = 0; i < PROOF_LIMITS.perAccountHour; i++) {
      w2.state.proofs.push({
        id: crypto.randomUUID(),
        account_id: ACCOUNT_ID,
        // 250 por formulário: nenhum chega ao teto do formulário (300).
        form_id: `00000000-0000-4000-8000-${String(Math.floor(i / 250)).padStart(12, '0')}`,
        phone: '5511900000000',
        code: generateProofCode(),
        secret_hash: 'a'.repeat(64),
        status: 'expired',
        ip_hash: null,
        expires_at: T0.toISOString(),
        confirmed_at: null,
        consumed_at: null,
        created_at: new Date(T0.getTime() - 1000).toISOString(),
      });
    }
    // …o formulário novo está vazio, mas o teto da CONTA bloqueia.
    const blockedAccount = await issuePhoneProof(w2.db as never, {
      accountId: ACCOUNT_ID,
      formId: otherForm,
      phone: PHONE,
      ipHash: null,
      now: T0,
      brMode: true,
    });
    expect(blockedAccount).toMatchObject({ ok: false, reason: 'rate_limited' });
  });
});

describe('confirmação pelo webhook', () => {
  it('confirma SÓ quando o remetente é o telefone informado, e estende o prazo', async () => {
    const w = setup();
    const r = await issue(w);
    const out = await confirmPhoneProofFromInbound(w.db as never, {
      accountId: ACCOUNT_ID,
      text: `Quero confirmar. Código: ${formatProofCode(r.code)}`,
      senderPhone: '5511999998888',
      now: at(30_000),
      brMode: true,
    });
    expect(out).toBe('confirmed');
    expect(w.state.proofs[0]).toMatchObject({ status: 'confirmed' });
    expect(new Date(w.state.proofs[0].expires_at).getTime()).toBe(
      at(30_000).getTime() + PROOF_CONFIRMED_TTL_MS
    );
  });

  it('o código certo vindo de OUTRO telefone não confirma (mismatch) e a prova segue pendente', async () => {
    const w = setup();
    const r = await issue(w);
    const out = await confirmPhoneProofFromInbound(w.db as never, {
      accountId: ACCOUNT_ID,
      text: r.code,
      senderPhone: '5511999990000',
      now: at(1000),
      brMode: true,
    });
    expect(out).toBe('mismatch');
    expect(w.state.proofs[0].status).toBe('pending');
  });

  it('sem remetente, ou sem código, ou código vencido, ou de outra conta: não confirma', async () => {
    const w = setup();
    const r = await issue(w);
    const base = { text: r.code, now: at(1000), brMode: true } as const;
    expect(
      await confirmPhoneProofFromInbound(w.db as never, {
        ...base,
        accountId: ACCOUNT_ID,
        senderPhone: null,
      })
    ).toBe('mismatch');
    expect(
      await confirmPhoneProofFromInbound(w.db as never, {
        accountId: ACCOUNT_ID,
        text: 'oi, tudo bem?',
        senderPhone: PHONE_CANON,
        now: at(1000),
      })
    ).toBe('no_match');
    expect(
      await confirmPhoneProofFromInbound(w.db as never, {
        ...base,
        accountId: OTHER_ACCOUNT,
        senderPhone: PHONE_CANON,
      })
    ).toBe('no_match');
    expect(
      await confirmPhoneProofFromInbound(w.db as never, {
        ...base,
        accountId: ACCOUNT_ID,
        senderPhone: PHONE_CANON,
        now: at(PROOF_PENDING_TTL_MS + 1),
      })
    ).toBe('no_match');
    expect(w.state.proofs[0].status).toBe('pending');
  });

  it('a mesma mensagem reentregue não confirma de novo, mas continua consumida (already)', async () => {
    const w = setup();
    const r = await issue(w);
    const input = {
      accountId: ACCOUNT_ID,
      text: r.code,
      senderPhone: PHONE_CANON,
      now: at(1000),
      brMode: true,
    };
    expect(await confirmPhoneProofFromInbound(w.db as never, input)).toBe(
      'confirmed'
    );
    expect(await confirmPhoneProofFromInbound(w.db as never, input)).toBe(
      'already'
    );
  });

  it('reentrega depois de a prova ser usada pelo `start` segue consumida; de outro telefone é mismatch', async () => {
    const w = setup();
    const r = await issue(w);
    const base = {
      accountId: ACCOUNT_ID,
      text: r.code,
      now: at(1000),
      brMode: true,
    };
    await confirmPhoneProofFromInbound(w.db as never, {
      ...base,
      senderPhone: PHONE_CANON,
    });
    await consumePhoneProof(w.db as never, {
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      proofId: r.proofId,
      secret: r.secret,
      now: at(2000),
    });
    expect(
      await confirmPhoneProofFromInbound(w.db as never, {
        ...base,
        now: at(3000),
        senderPhone: PHONE_CANON,
      })
    ).toBe('already');
    expect(
      await confirmPhoneProofFromInbound(w.db as never, {
        ...base,
        now: at(3000),
        senderPhone: '5511999990000',
      })
    ).toBe('mismatch');
    expect(w.state.proofs[0].status).toBe('consumed');
  });

  it('handleInboundPhoneProof consome (true) código confirmado e código de outro telefone; texto comum segue (false)', async () => {
    const w = setup();
    const r = await issue(w, { now: new Date() });
    w.state.clock = () => Date.now();
    const call = (text: string, senderPhone: string) =>
      handleInboundPhoneProof({
        db: w.db as never,
        accountId: ACCOUNT_ID,
        senderPhone,
        text,
      });
    expect(await call('bom dia!', PHONE_CANON)).toBe(false);
    expect(await call(r.code, '5511999990000')).toBe(true);
    expect(w.state.proofs[0].status).toBe('pending');
    expect(await call(r.code, PHONE_CANON)).toBe(true);
    expect(w.state.proofs[0].status).toBe('confirmed');
  });

  it('handleInboundPhoneProof nunca lança: erro de banco devolve false', async () => {
    const broken = {
      from: () => {
        throw new Error('boom');
      },
    };
    await expect(
      handleInboundPhoneProof({
        db: broken as never,
        accountId: ACCOUNT_ID,
        senderPhone: PHONE_CANON,
        text: 'ABCD-2345',
      })
    ).resolves.toBe(false);
  });
});

describe('estado e consumo (lado do navegador)', () => {
  const scope = { accountId: ACCOUNT_ID, formId: FORM_ID };

  it('pending → confirmed; segredo errado, id errado e outra conta são not_found', async () => {
    const w = setup();
    const r = await issue(w);
    const status = (over: Record<string, unknown> = {}, now = at(1000)) =>
      getProofStatus(w.db as never, {
        ...scope,
        proofId: r.proofId,
        secret: r.secret,
        now,
        ...over,
      });
    expect(await status()).toBe('pending');
    expect(await status({ secret: 'outro' })).toBe('not_found');
    expect(await status({ secret: undefined })).toBe('not_found');
    expect(await status({ proofId: crypto.randomUUID() })).toBe('not_found');
    expect(await status({ accountId: OTHER_ACCOUNT })).toBe('not_found');
    await confirmPhoneProofFromInbound(w.db as never, {
      accountId: ACCOUNT_ID,
      text: r.code,
      senderPhone: PHONE_CANON,
      now: at(2000),
      brMode: true,
    });
    expect(await status({}, at(3000))).toBe('confirmed');
    expect(
      await status({}, at(PROOF_PENDING_TTL_MS + PROOF_CONFIRMED_TTL_MS))
    ).toBe('expired');
  });

  it('prova pendente vencida e prova substituída aparecem como expired', async () => {
    const w = setup();
    const first = await issue(w);
    expect(
      await getProofStatus(w.db as never, {
        ...scope,
        proofId: first.proofId,
        secret: first.secret,
        now: at(PROOF_PENDING_TTL_MS + 1),
      })
    ).toBe('expired');
    w.state.clock = () => T0.getTime() + 60_000;
    await issue(w, { now: at(60_000) });
    expect(
      await getProofStatus(w.db as never, {
        ...scope,
        proofId: first.proofId,
        secret: first.secret,
        now: at(61_000),
      })
    ).toBe('expired');
  });

  async function confirmed() {
    const w = setup();
    const r = await issue(w);
    await confirmPhoneProofFromInbound(w.db as never, {
      accountId: ACCOUNT_ID,
      text: r.code,
      senderPhone: PHONE_CANON,
      now: at(1000),
      brMode: true,
    });
    return { w, r };
  }

  it('só consome prova confirmada, com o segredo do navegador, e devolve o telefone CONFIRMADO', async () => {
    const w = setup();
    const r = await issue(w);
    const consume = (secret: unknown = r.secret, now = at(2000)) =>
      consumePhoneProof(w.db as never, {
        ...scope,
        proofId: r.proofId,
        secret,
        now,
      });
    // Ainda pendente: a mensagem não chegou.
    expect(await consume()).toEqual({ ok: false, reason: 'not_confirmed' });

    await confirmPhoneProofFromInbound(w.db as never, {
      accountId: ACCOUNT_ID,
      text: r.code,
      senderPhone: PHONE_CANON,
      now: at(1000),
      brMode: true,
    });
    expect(await consume('segredo-errado')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await consume()).toEqual({
      ok: true,
      phone: PHONE_CANON,
      proofId: r.proofId,
    });
    expect(w.state.proofs[0].status).toBe('consumed');
  });

  it('uso único: o segundo consumo falha', async () => {
    const { w, r } = await confirmed();
    const input = {
      ...{ accountId: ACCOUNT_ID, formId: FORM_ID },
      proofId: r.proofId,
      secret: r.secret,
      now: at(2000),
    };
    expect((await consumePhoneProof(w.db as never, input)).ok).toBe(true);
    expect(await consumePhoneProof(w.db as never, input)).toEqual({
      ok: false,
      reason: 'not_confirmed',
    });
  });

  it('prova confirmada vence em 15 min e não é consumida depois', async () => {
    const { w, r } = await confirmed();
    expect(
      await consumePhoneProof(w.db as never, {
        accountId: ACCOUNT_ID,
        formId: FORM_ID,
        proofId: r.proofId,
        secret: r.secret,
        now: at(1000 + PROOF_CONFIRMED_TTL_MS + 1),
      })
    ).toEqual({ ok: false, reason: 'not_confirmed' });
  });

  it('prova de outro formulário não é consumida', async () => {
    const { w, r } = await confirmed();
    expect(
      await consumePhoneProof(w.db as never, {
        accountId: ACCOUNT_ID,
        formId: '88888888-8888-4888-8888-888888888888',
        proofId: r.proofId,
        secret: r.secret,
        now: at(2000),
      })
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('restorePhoneProof devolve a prova consumida para ser usada de novo', async () => {
    const { w, r } = await confirmed();
    const input = {
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      proofId: r.proofId,
      secret: r.secret,
      now: at(2000),
    };
    await consumePhoneProof(w.db as never, input);
    await restorePhoneProof(w.db as never, {
      accountId: ACCOUNT_ID,
      proofId: r.proofId,
    });
    expect((await consumePhoneProof(w.db as never, input)).ok).toBe(true);
  });
});

describe('sweepPhoneProofs', () => {
  it('apaga só o que venceu há mais de 1 dia', async () => {
    const w = setup();
    await issue(w);
    expect(await sweepPhoneProofs(w.db as never, at(60 * 60 * 1000))).toBe(0);
    expect(
      await sweepPhoneProofs(
        w.db as never,
        at(PROOF_PENDING_TTL_MS + 24 * 60 * 60 * 1000 + 1)
      )
    ).toBe(1);
    expect(w.state.proofs).toHaveLength(0);
  });
});
