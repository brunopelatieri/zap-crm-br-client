import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  verifyMetaWebhookSignature,
  resolveWebhookAppSecrets,
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
