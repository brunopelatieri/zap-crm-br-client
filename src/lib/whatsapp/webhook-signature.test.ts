import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  verifyMetaWebhookSignature,
  verifyMetaWebhookSigner,
  resolveMetaWebhookSigner,
  isMetaSignatureHeader,
  resolveWebhookAppSecrets,
  resolveWebhookChannelSecrets,
  signerCoversPhoneNumber,
  accountIdsForSigner,
} from './webhook-signature';
import { encrypt } from '@/lib/whatsapp/encryption';

const SECRET = process.env.META_APP_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

describe('verifyMetaWebhookSignature', () => {
  it('accepts a request signed with the correct secret', () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account' });
    expect(verifyMetaWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it('rejects a signature computed with a different secret', () => {
    const body = '{}';
    expect(verifyMetaWebhookSignature(body, signedHeader(body, 'wrong'))).toBe(
      false
    );
  });

  it('rejects when the body has been tampered with after signing', () => {
    const original = '{"entry":[]}';
    const header = signedHeader(original);
    const tampered = '{"entry":[{"id":"injected"}]}';
    expect(verifyMetaWebhookSignature(tampered, header)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyMetaWebhookSignature('anything', null)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const body = '{}';
    const hex = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyMetaWebhookSignature(body, hex)).toBe(false);
    expect(verifyMetaWebhookSignature(body, `sha512=${hex}`)).toBe(false);
  });

  it('rejects a header of the wrong length without throwing', () => {
    // timingSafeEqual would throw on length mismatch — the guard inside
    // the verifier should catch this and return false instead.
    expect(verifyMetaWebhookSignature('{}', 'sha256=tooshort')).toBe(false);
  });

  describe('fail-closed when secret is missing', () => {
    const originalSecret = process.env.META_APP_SECRET;
    beforeEach(() => {
      delete process.env.META_APP_SECRET;
    });
    afterEach(() => {
      process.env.META_APP_SECRET = originalSecret;
    });

    it('rejects even a correctly-formed signature when no secret is configured', () => {
      const body = '{}';
      // Use the original secret to produce the header so we can verify
      // the rejection is solely due to missing config.
      const header = signedHeader(body, originalSecret!);
      expect(verifyMetaWebhookSignature(body, header)).toBe(false);
    });
  });

  // SPEC 064 gap (migração 073): um segundo número sob um App da Meta
  // diferente assina com um App Secret diferente. `extraSecrets` é o
  // que deixa esse evento passar sem trocar o `META_APP_SECRET` padrão.
  describe('extraSecrets (second Meta App, migração 073)', () => {
    it('accepts a request signed with a secret NOT in META_APP_SECRET, via extraSecrets', () => {
      const body = JSON.stringify({ object: 'whatsapp_business_account' });
      const otherAppSecret = 'other-app-secret';
      const header = signedHeader(body, otherAppSecret);

      // The default secret alone would reject it.
      expect(verifyMetaWebhookSignature(body, header)).toBe(false);
      expect(verifyMetaWebhookSignature(body, header, [otherAppSecret])).toBe(
        true
      );
    });

    it('still rejects when the signature matches neither the default nor any extra secret', () => {
      const body = '{}';
      const header = signedHeader(body, 'unrelated-secret');
      expect(
        verifyMetaWebhookSignature(body, header, ['some-other-app-secret'])
      ).toBe(false);
    });
  });
});

// Revisão de segurança SPEC 088, achado 1: o veredito diz QUAL segredo
// validou, para o repetidor não deixar o segredo de um canal falar pelo
// número de outra conta.
describe('verifyMetaWebhookSigner', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account' });
  const channels = [
    { secret: 'secret-app-a', phoneNumberId: 'pnid-a' },
    { secret: 'secret-app-b', phoneNumberId: 'pnid-b' },
    { secret: 'secret-app-b', phoneNumberId: 'pnid-b2' },
  ];

  it('META_APP_SECRET → default', () => {
    expect(verifyMetaWebhookSigner(body, signedHeader(body), channels)).toEqual(
      { kind: 'default' }
    );
  });

  it('segredo de um canal → só os números que guardam esse segredo', () => {
    const signer = verifyMetaWebhookSigner(
      body,
      signedHeader(body, 'secret-app-a'),
      channels
    );
    expect(signer?.kind).toBe('channels');
    expect(
      signer?.kind === 'channels' ? [...signer.phoneNumberIds] : null
    ).toEqual(['pnid-a']);
  });

  it('o mesmo segredo em dois canais vale para os dois números', () => {
    const signer = verifyMetaWebhookSigner(
      body,
      signedHeader(body, 'secret-app-b'),
      channels
    );
    expect(
      signer?.kind === 'channels' ? [...signer.phoneNumberIds].sort() : null
    ).toEqual(['pnid-b', 'pnid-b2']);
  });

  it('canal que guardou o segredo do App padrão continua default', () => {
    expect(
      verifyMetaWebhookSigner(body, signedHeader(body), [
        { secret: SECRET, phoneNumberId: 'pnid-a' },
      ])
    ).toEqual({ kind: 'default' });
  });

  it('nenhum segredo confere → null', () => {
    expect(
      verifyMetaWebhookSigner(body, signedHeader(body, 'unrelated'), channels)
    ).toBeNull();
    expect(verifyMetaWebhookSigner(body, null, channels)).toBeNull();
  });

  it('segredo vazio nunca valida (HMAC com chave vazia é forjável)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    try {
      expect(
        verifyMetaWebhookSigner(body, signedHeader(body, ''), [
          { secret: '', phoneNumberId: 'pnid-a' },
        ])
      ).toBeNull();
    } finally {
      process.env.META_APP_SECRET = original;
      spy.mockRestore();
    }
  });
});

// Achado M-1 da revisão da SPEC 088 — guarda barata antes do corpo/banco.
describe('isMetaSignatureHeader', () => {
  const hex = 'a'.repeat(64);

  it('aceita o formato da Meta: sha256= + 64 hex minúsculos', () => {
    expect(isMetaSignatureHeader(`sha256=${hex}`)).toBe(true);
    expect(isMetaSignatureHeader(signedHeader('{}'))).toBe(true);
  });

  it.each([
    ['ausente', null],
    ['vazio', ''],
    ['sem prefixo', hex],
    ['outro algoritmo', `sha512=${hex}`],
    ['curto', `sha256=${hex.slice(1)}`],
    ['longo', `sha256=${hex}a`],
    ['não-hex', `sha256=${'g'.repeat(64)}`],
    ['espaço à esquerda', ` sha256=${hex}`],
    ['quebra de linha final', `sha256=${hex}\n`],
    ['cabeçalho repetido (o runtime junta com vírgula)', `sha256=${hex}, x`],
    ['hex maiúsculo', `sha256=${hex.toUpperCase()}`],
    ['prefixo maiúsculo', `SHA256=${hex}`],
  ])('recusa %s', (_label, header) => {
    expect(isMetaSignatureHeader(header)).toBe(false);
  });

  it('hex maiúsculo com o digest CERTO nunca validou, e segue sem validar', () => {
    const upper = `sha256=${signedHeader('{}').slice(7).toUpperCase()}`;
    expect(verifyMetaWebhookSigner('{}', upper)).toBeNull();
  });
});

describe('resolveMetaWebhookSigner', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account' });
  const channels = [
    { secret: 'secret-app-a', phoneNumberId: 'pnid-a' },
    { secret: 'secret-app-b', phoneNumberId: 'pnid-b' },
    { secret: 'secret-app-b', phoneNumberId: 'pnid-b2' },
    // Canal que guardou o segredo do App padrão: continua `default`.
    { secret: SECRET, phoneNumberId: 'pnid-c' },
  ];
  const original = process.env.META_APP_SECRET;
  afterEach(() => {
    process.env.META_APP_SECRET = original;
  });

  it('META_APP_SECRET valida → default, sem carregar os segredos dos canais', async () => {
    const load = vi.fn(async () => channels);
    await expect(
      resolveMetaWebhookSigner(body, signedHeader(body), load)
    ).resolves.toEqual({ kind: 'default' });
    expect(load).not.toHaveBeenCalled();
  });

  it('cabeçalho que não pode validar → null, sem carregar os segredos', async () => {
    const load = vi.fn(async () => channels);
    for (const header of [null, '', 'sha256=tooshort', 'x']) {
      await expect(
        resolveMetaWebhookSigner(body, header, load)
      ).resolves.toBeNull();
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('segredo de canal → carrega uma vez e devolve o escopo desse segredo', async () => {
    const load = vi.fn(async () => channels);
    const signer = await resolveMetaWebhookSigner(
      body,
      signedHeader(body, 'secret-app-b'),
      load
    );
    expect(signer).toEqual({
      kind: 'channels',
      phoneNumberIds: new Set(['pnid-b', 'pnid-b2']),
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('mesmo veredito de verifyMetaWebhookSigner com tudo carregado antes', async () => {
    for (const secret of [SECRET, 'secret-app-a', 'secret-app-b', 'nope']) {
      const header = signedHeader(body, secret);
      await expect(
        resolveMetaWebhookSigner(body, header, async () => channels)
      ).resolves.toEqual(verifyMetaWebhookSigner(body, header, channels));
    }
  });

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
  ])(
    'META_APP_SECRET %s: canal ainda valida; chave vazia nunca; sem segredo falha fechado',
    async (_label, env) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      if (env === undefined) delete process.env.META_APP_SECRET;
      else process.env.META_APP_SECRET = env;

      await expect(
        resolveMetaWebhookSigner(
          body,
          signedHeader(body, 'secret-app-a'),
          async () => channels
        )
      ).resolves.toMatchObject({ kind: 'channels' });
      expect(spy).not.toHaveBeenCalled();

      await expect(
        resolveMetaWebhookSigner(body, signedHeader(body, ''), async () => [
          { secret: '', phoneNumberId: 'pnid-a' },
        ])
      ).resolves.toBeNull();
      await expect(
        resolveMetaWebhookSigner(body, signedHeader(body), async () => [])
      ).resolves.toBeNull();
      // O operador ainda é avisado de que nada está configurado.
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('No App Secret configured')
      );
      spy.mockRestore();
    }
  );
});

describe('resolveWebhookChannelSecrets', () => {
  it('devolve cada segredo decifrado com o phone_number_id do canal', async () => {
    const { createSupabaseMock } = await import('@/lib/audience/supabase-mock');
    const db = createSupabaseMock((table) => {
      if (table !== 'whatsapp_config') return undefined;
      return {
        data: [
          { app_secret: encrypt('secret-app-b'), phone_number_id: 'pnid-b' },
          { app_secret: encrypt('secret-app-c'), phone_number_id: null },
          { app_secret: null, phone_number_id: 'pnid-x' },
        ],
      };
    }).db;

    await expect(resolveWebhookChannelSecrets(db)).resolves.toEqual([
      { secret: 'secret-app-b', phoneNumberId: 'pnid-b' },
      { secret: 'secret-app-c', phoneNumberId: null },
    ]);
  });
});

// Revisão de segurança da SPEC 088 — escopo compartilhado pelo repetidor
// e pelo ingest.
describe('signerCoversPhoneNumber', () => {
  const channels = {
    kind: 'channels' as const,
    phoneNumberIds: new Set(['pnid-a']),
  };

  it('META_APP_SECRET cobre todo número, e também change sem número (como antes)', () => {
    expect(signerCoversPhoneNumber({ kind: 'default' }, 'pnid-b')).toBe(true);
    expect(signerCoversPhoneNumber({ kind: 'default' }, undefined)).toBe(true);
  });

  it('segredo de canal cobre só os números que o guardam', () => {
    expect(signerCoversPhoneNumber(channels, 'pnid-a')).toBe(true);
    expect(signerCoversPhoneNumber(channels, 'pnid-b')).toBe(false);
  });

  it('segredo de canal nunca cobre change sem número (fail-closed)', () => {
    expect(signerCoversPhoneNumber(channels, undefined)).toBe(false);
    expect(signerCoversPhoneNumber(channels, null)).toBe(false);
    expect(signerCoversPhoneNumber(channels, '')).toBe(false);
  });
});

describe('accountIdsForSigner', () => {
  it('META_APP_SECRET → null (sem restrição), sem consultar o banco', async () => {
    const { createSupabaseMock } = await import('@/lib/audience/supabase-mock');
    const mock = createSupabaseMock(() => undefined);
    await expect(
      accountIdsForSigner(mock.db, { kind: 'default' })
    ).resolves.toBeNull();
    expect(mock.calls).toEqual([]);
  });

  it('segredo de canal → contas dos números que o guardam, sem repetir', async () => {
    const { createSupabaseMock } = await import('@/lib/audience/supabase-mock');
    const mock = createSupabaseMock((table) =>
      table === 'whatsapp_config'
        ? {
            data: [
              { account_id: 'acct-a' },
              { account_id: 'acct-a' },
              { account_id: null },
            ],
          }
        : undefined
    );
    await expect(
      accountIdsForSigner(mock.db, {
        kind: 'channels',
        phoneNumberIds: new Set(['pnid-a', 'pnid-a2']),
      })
    ).resolves.toEqual(['acct-a']);
    expect(mock.callsFor('whatsapp_config')[0]?.ops).toContainEqual({
      fn: 'in',
      args: ['phone_number_id', ['pnid-a', 'pnid-a2']],
    });
  });

  it('segredo sem número ou falha de leitura → [] (fail-closed)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createSupabaseMock } = await import('@/lib/audience/supabase-mock');
    const failing = createSupabaseMock(() => ({
      data: null,
      error: { message: 'connection reset' },
    }));
    await expect(
      accountIdsForSigner(failing.db, {
        kind: 'channels',
        phoneNumberIds: new Set(['pnid-a']),
      })
    ).resolves.toEqual([]);
    await expect(
      accountIdsForSigner(failing.db, {
        kind: 'channels',
        phoneNumberIds: new Set(),
      })
    ).resolves.toEqual([]);
    // Cliente que LANÇA: resolve [] em vez de rejeitar (o ingest memoriza
    // a promessa; uma rejeição abortaria os demais changes do POST).
    const throwing = {
      from: () => {
        throw new Error('socket hang up');
      },
    } as unknown as Parameters<typeof accountIdsForSigner>[0];
    await expect(
      accountIdsForSigner(throwing, {
        kind: 'channels',
        phoneNumberIds: new Set(['pnid-a']),
      })
    ).resolves.toEqual([]);
    spy.mockRestore();
  });
});

describe('resolveWebhookAppSecrets (migração 073)', () => {
  it('decrypts every non-null app_secret across channels', async () => {
    const { createSupabaseMock } = await import('@/lib/audience/supabase-mock');
    const db = createSupabaseMock((table) => {
      if (table !== 'whatsapp_config') return undefined;
      return {
        data: [
          { app_secret: encrypt('secret-app-b') },
          { app_secret: encrypt('secret-app-c') },
          { app_secret: null },
        ],
      };
    }).db;

    const secrets = await resolveWebhookAppSecrets(db);
    expect(secrets.sort()).toEqual(['secret-app-b', 'secret-app-c'].sort());
  });

  it('skips a malformed/undecryptable row instead of throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createSupabaseMock } = await import('@/lib/audience/supabase-mock');
    const db = createSupabaseMock((table) => {
      if (table !== 'whatsapp_config') return undefined;
      return {
        data: [
          { app_secret: 'not-actually-encrypted' },
          { app_secret: encrypt('secret-app-b') },
        ],
      };
    }).db;

    const secrets = await resolveWebhookAppSecrets(db);
    expect(secrets).toEqual(['secret-app-b']);
    spy.mockRestore();
  });

  it('degrades to an empty list (does not throw) on a read error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createSupabaseMock } = await import('@/lib/audience/supabase-mock');
    const db = createSupabaseMock((table) => {
      if (table !== 'whatsapp_config') return undefined;
      return { data: null, error: { message: 'connection reset' } };
    }).db;

    await expect(resolveWebhookAppSecrets(db)).resolves.toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
