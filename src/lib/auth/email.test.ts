import { describe, expect, it } from 'vitest';

import { EMAIL_RE, normalizeEmail } from './email';

describe('EMAIL_RE', () => {
  it('aceita formatos comuns', () => {
    for (const ok of ['a@b.co', 'ana.souza+crm@empresa.com.br']) {
      expect(EMAIL_RE.test(ok)).toBe(true);
    }
  });

  it('recusa o que é obviamente digitação errada', () => {
    for (const bad of [
      '',
      'sem-arroba',
      'a@b',
      'a b@c.com',
      '@c.com',
      'a@@c.com',
    ]) {
      expect(EMAIL_RE.test(bad)).toBe(false);
    }
  });
});

describe('normalizeEmail', () => {
  it('apara e põe em minúsculas', () => {
    expect(normalizeEmail('  Ana@Empresa.COM ')).toBe('ana@empresa.com');
  });
});
