import { describe, it, expect } from 'vitest';

import {
  formatQuotaError,
  isContactQuotaError,
  parseQuotaError,
} from './errors';

describe('parseQuotaError', () => {
  it('reconhece o formato QUOTA_EXCEEDED vindo de error.message', () => {
    const err = { message: 'QUOTA_EXCEEDED:contacts:2001:2000' };
    expect(parseQuotaError(err)).toEqual({
      metric: 'contacts',
      used: 2001,
      limit: 2000,
    });
  });

  it('reconhece métrica de papel (members_admin)', () => {
    const err = { message: 'QUOTA_EXCEEDED:members_admin:3:2' };
    expect(parseQuotaError(err)).toEqual({
      metric: 'members_admin',
      used: 3,
      limit: 2,
    });
  });

  it('reconhece string crua', () => {
    expect(parseQuotaError('QUOTA_EXCEEDED:contacts:5:0')).toEqual({
      metric: 'contacts',
      used: 5,
      limit: 0,
    });
  });

  it('devolve null para mensagem que NÃO é de quota', () => {
    const err = { message: 'duplicate key value violates unique constraint' };
    expect(parseQuotaError(err)).toBeNull();
  });

  it('devolve null para entrada sem message', () => {
    expect(parseQuotaError({})).toBeNull();
    expect(parseQuotaError(null)).toBeNull();
    expect(parseQuotaError(undefined)).toBeNull();
  });

  it('devolve null quando a mensagem só contém o prefixo sem o resto do contrato', () => {
    expect(parseQuotaError({ message: 'QUOTA_EXCEEDED:contacts' })).toBeNull();
  });
});

describe('formatQuotaError', () => {
  it('é o inverso de parseQuotaError', () => {
    const original = 'QUOTA_EXCEEDED:contacts:2001:2000';
    const parsed = parseQuotaError(original);
    expect(parsed).not.toBeNull();
    expect(formatQuotaError(parsed!)).toBe(original);
  });
});

describe('isContactQuotaError', () => {
  it('true só para a métrica contacts', () => {
    expect(
      isContactQuotaError({ message: 'QUOTA_EXCEEDED:contacts:1:0' })
    ).toBe(true);
    expect(
      isContactQuotaError({ message: 'QUOTA_EXCEEDED:members_total:1:0' })
    ).toBe(false);
  });

  it('false para erro que não é de quota', () => {
    expect(isContactQuotaError({ message: 'boom' })).toBe(false);
  });
});
