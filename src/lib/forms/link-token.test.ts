import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FORM_LINK_DEFAULT_TTL_DAYS,
  FORM_LINK_SECRET_ENV,
  formPublicUrl,
  hashClientIp,
  isFormLinkConfigured,
  signFormLink,
  verifyFormLink,
} from './link-token';
import { CONTACT_ID, FORM_ID } from './test-fixtures';

const SECRET = 'segredo-de-teste-com-mais-de-trinta-e-dois-bytes-ok';
const NOW = new Date('2026-11-06T12:00:00Z');

describe('token do link (SPEC 085 E-7)', () => {
  const saved = process.env[FORM_LINK_SECRET_ENV];
  beforeEach(() => {
    process.env[FORM_LINK_SECRET_ENV] = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[FORM_LINK_SECRET_ENV];
    else process.env[FORM_LINK_SECRET_ENV] = saved;
  });

  it('sem FORM_LINK_SECRET (ou curto demais) não assina nem verifica — devolve null', () => {
    delete process.env[FORM_LINK_SECRET_ENV];
    expect(isFormLinkConfigured()).toBe(false);
    expect(
      signFormLink({ formId: FORM_ID, contactId: CONTACT_ID, source: 'inbox' })
    ).toBeNull();
    expect(verifyFormLink('a.b', FORM_ID)).toBeNull();

    process.env[FORM_LINK_SECRET_ENV] = 'curto';
    expect(isFormLinkConfigured()).toBe(false);
  });

  it('ida e volta: as claims voltam com a validade padrão de 30 dias', () => {
    const token = signFormLink({
      formId: FORM_ID,
      contactId: CONTACT_ID,
      source: 'broadcast',
      now: NOW,
    })!;
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const claims = verifyFormLink(token, FORM_ID, NOW);
    expect(claims).toEqual({
      formId: FORM_ID,
      contactId: CONTACT_ID,
      source: 'broadcast',
      expiresAt: new Date(
        NOW.getTime() + FORM_LINK_DEFAULT_TTL_DAYS * 86_400_000
      ),
    });
  });

  it('expirado, formulário errado, assinatura adulterada e lixo → null', () => {
    const token = signFormLink({
      formId: FORM_ID,
      contactId: CONTACT_ID,
      source: 'link',
      ttlDays: 1,
      now: NOW,
    })!;
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    expect(verifyFormLink(token, FORM_ID, later)).toBeNull();
    expect(verifyFormLink(token, CONTACT_ID, NOW)).toBeNull();

    const [body, sig] = token.split('.');
    const flipped = sig[0] === 'A' ? 'B' : 'A';
    expect(
      verifyFormLink(`${body}.${flipped}${sig.slice(1)}`, FORM_ID, NOW)
    ).toBeNull();
    expect(verifyFormLink(`${body}x.${sig}`, FORM_ID, NOW)).toBeNull();
    expect(verifyFormLink('nao-tem-ponto', FORM_ID, NOW)).toBeNull();
    expect(verifyFormLink('', FORM_ID, NOW)).toBeNull();
  });

  it('token assinado com outro segredo não vale', () => {
    const token = signFormLink({
      formId: FORM_ID,
      contactId: CONTACT_ID,
      source: 'link',
      now: NOW,
    })!;
    process.env[FORM_LINK_SECRET_ENV] = `${SECRET}-outro`;
    expect(verifyFormLink(token, FORM_ID, NOW)).toBeNull();
  });

  it('TTL é limitado a 365 dias e TTL inválido cai no padrão', () => {
    const big = verifyFormLink(
      signFormLink({
        formId: FORM_ID,
        contactId: CONTACT_ID,
        source: 'link',
        ttlDays: 9999,
        now: NOW,
      })!,
      FORM_ID,
      NOW
    )!;
    expect(big.expiresAt.getTime() - NOW.getTime()).toBe(365 * 86_400_000);
    const bad = verifyFormLink(
      signFormLink({
        formId: FORM_ID,
        contactId: CONTACT_ID,
        source: 'link',
        ttlDays: -3,
        now: NOW,
      })!,
      FORM_ID,
      NOW
    )!;
    expect(bad.expiresAt.getTime() - NOW.getTime()).toBe(
      FORM_LINK_DEFAULT_TTL_DAYS * 86_400_000
    );
  });

  it('formPublicUrl monta /f/<slug>?t=<token> sem barra dupla', () => {
    expect(formPublicUrl('meu-form', 'https://app.com/')).toBe(
      'https://app.com/f/meu-form'
    );
    expect(formPublicUrl('meu-form', 'https://app.com', 'a.b')).toBe(
      'https://app.com/f/meu-form?t=a.b'
    );
  });

  it('hashClientIp é estável, não contém o IP e é null sem IP', () => {
    const h1 = hashClientIp('203.0.113.9');
    const h2 = hashClientIp('203.0.113.9');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(32);
    expect(h1).not.toContain('203');
    expect(hashClientIp(null)).toBeNull();
    expect(hashClientIp('203.0.113.10')).not.toBe(h1);
  });
});
