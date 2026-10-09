import { describe, expect, it } from 'vitest';

import { canEditUserIdentity, validateFullName } from './user-identity';

describe('validateFullName', () => {
  it('apara espaços e devolve o nome limpo', () => {
    expect(validateFullName('  Ana Souza  ')).toEqual({
      ok: true,
      value: 'Ana Souza',
    });
  });

  it('só espaços (ou vazio) é recusado', () => {
    expect(validateFullName('   ')).toEqual({
      ok: false,
      code: 'name_invalid',
    });
    expect(validateFullName('')).toEqual({ ok: false, code: 'name_invalid' });
  });

  it('120 caracteres passam, 121 não', () => {
    expect(validateFullName('a'.repeat(120)).ok).toBe(true);
    expect(validateFullName('a'.repeat(121))).toEqual({
      ok: false,
      code: 'name_invalid',
    });
  });

  it('caractere de controle (NUL, quebra de linha, tab, DEL) é recusado', () => {
    for (const code of [0, 9, 10, 13, 127, 133]) {
      expect(validateFullName(`Ana${String.fromCharCode(code)}Souza`)).toEqual({
        ok: false,
        code: 'name_invalid',
      });
    }
  });

  it('acentos e emoji passam', () => {
    expect(validateFullName('José da Conceição 🙂').ok).toBe(true);
  });

  it('não-string é recusado', () => {
    for (const bad of [null, undefined, 42, {}]) {
      expect(validateFullName(bad)).toEqual({
        ok: false,
        code: 'name_invalid',
      });
    }
  });
});

describe('canEditUserIdentity', () => {
  const OWNERS = ['bruno@zapcrmbr.com', 'ana@zapcrmbr.com'];
  const check = (
    overrides: Partial<Parameters<typeof canEditUserIdentity>[0]> = {}
  ) =>
    canEditUserIdentity({
      ownerEmails: OWNERS,
      targetCurrentEmail: 'cliente@empresa.com',
      nextEmail: 'novo@empresa.com',
      ...overrides,
    });

  it('troca comum: devolve o e-mail normalizado', () => {
    expect(check({ nextEmail: '  Novo@Empresa.COM ' })).toEqual({
      ok: true,
      email: 'novo@empresa.com',
    });
  });

  it('formato inválido é email_invalid', () => {
    for (const bad of ['sem-arroba', 'a@b', 'a b@c.com', '']) {
      expect(check({ nextEmail: bad })).toEqual({
        ok: false,
        code: 'email_invalid',
      });
    }
  });

  it('mesmo e-mail com caixa/espaço diferentes é email_unchanged', () => {
    expect(
      check({
        targetCurrentEmail: 'cliente@empresa.com',
        nextEmail: '  CLIENTE@Empresa.com ',
      })
    ).toEqual({ ok: false, code: 'email_unchanged' });
  });

  it('alvo é o proprietário (caixa e espaço diferentes na lista): cannot_edit_platform_owner_email', () => {
    expect(
      check({
        ownerEmails: ['  Bruno@ZapCrmBr.com '],
        targetCurrentEmail: 'bruno@zapcrmbr.com',
        nextEmail: 'bruno.novo@zapcrmbr.com',
      })
    ).toEqual({ ok: false, code: 'cannot_edit_platform_owner_email' });
  });

  it('e-mail NOVO na lista do proprietário é email_reserved_for_platform_owner (escalonamento de privilégio)', () => {
    expect(check({ nextEmail: ' ANA@zapcrmbr.com ' })).toEqual({
      ok: false,
      code: 'email_reserved_for_platform_owner',
    });
  });

  it('casamento é por item inteiro: .com.br não casa com .com', () => {
    expect(
      check({
        ownerEmails: ['bruno@zapcrmbr.com'],
        nextEmail: 'bruno@zapcrmbr.com.br',
      })
    ).toEqual({ ok: true, email: 'bruno@zapcrmbr.com.br' });
    expect(
      check({
        ownerEmails: ['bruno@zapcrmbr.com'],
        targetCurrentEmail: 'bruno@zapcrmbr.com.br',
        nextEmail: 'outro@empresa.com',
      })
    ).toEqual({ ok: true, email: 'outro@empresa.com' });
  });

  it('proprietário reenviando o próprio e-mail é no-op (email_unchanged), não tentativa proibida', () => {
    expect(
      check({
        targetCurrentEmail: 'bruno@zapcrmbr.com',
        nextEmail: 'bruno@zapcrmbr.com',
      })
    ).toEqual({ ok: false, code: 'email_unchanged' });
  });

  it('lista de proprietários vazia não bloqueia ninguém', () => {
    expect(check({ ownerEmails: [] })).toEqual({
      ok: true,
      email: 'novo@empresa.com',
    });
  });
});
