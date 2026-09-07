import { describe, expect, it } from 'vitest';

import {
  buildDeletionTombstone,
  checkAdminDeleteGuard,
  checkDeleteGuards,
  detachMemberErrorStatus,
  storagePrefixesFor,
} from './delete';

const BASE = {
  role: 'owner' as const,
  accountName: 'Minha Empresa',
  typedName: 'Minha Empresa',
  isPlatformOwnerAccount: false,
};

describe('checkDeleteGuards', () => {
  it('ok quando tudo bate', () => {
    expect(checkDeleteGuards(BASE)).toEqual({ ok: true });
  });

  it.each(['admin', 'agent', 'viewer'] as const)(
    "not_owner para o papel '%s'",
    (role) => {
      expect(checkDeleteGuards({ ...BASE, role })).toEqual({
        ok: false,
        reason: 'not_owner',
      });
    }
  );

  it('platform_owner_account quando isPlatformOwnerAccount é true', () => {
    expect(
      checkDeleteGuards({ ...BASE, isPlatformOwnerAccount: true })
    ).toEqual({ ok: false, reason: 'platform_owner_account' });
  });

  it('tolera espaço sobrando nas pontas (trim() dos dois lados, §5.1)', () => {
    expect(
      checkDeleteGuards({ ...BASE, typedName: '  Minha Empresa  ' })
    ).toEqual({ ok: true });
  });

  it('name_mismatch com espaço sobrando NO MEIO do texto (trim não corrige)', () => {
    expect(checkDeleteGuards({ ...BASE, typedName: 'Minha  Empresa' })).toEqual(
      { ok: false, reason: 'name_mismatch' }
    );
  });

  it('name_mismatch com caixa trocada (comparação sensível a maiúsculas)', () => {
    expect(checkDeleteGuards({ ...BASE, typedName: 'minha empresa' })).toEqual({
      ok: false,
      reason: 'name_mismatch',
    });
  });
});

describe('checkAdminDeleteGuard', () => {
  it('ok quando o nome bate', () => {
    expect(
      checkAdminDeleteGuard({
        accountName: 'Minha Empresa',
        typedName: 'Minha Empresa',
      })
    ).toEqual({ ok: true });
  });

  it('tolera espaço sobrando nas pontas', () => {
    expect(
      checkAdminDeleteGuard({
        accountName: 'Minha Empresa',
        typedName: '  Minha Empresa  ',
      })
    ).toEqual({ ok: true });
  });

  it('name_mismatch com caixa trocada', () => {
    expect(
      checkAdminDeleteGuard({
        accountName: 'Minha Empresa',
        typedName: 'minha empresa',
      })
    ).toEqual({ ok: false, reason: 'name_mismatch' });
  });
});

describe('detachMemberErrorStatus', () => {
  it('42501 (papel insuficiente/não-membro) → 403', () => {
    expect(detachMemberErrorStatus('42501')).toBe(403);
  });

  it('22023 (alvo não encontrado/é dono) → 400', () => {
    expect(detachMemberErrorStatus('22023')).toBe(400);
  });

  it.each([undefined, '', '23505', 'XX000'])(
    'código desconhecido (%s) → 500',
    (code) => {
      expect(detachMemberErrorStatus(code)).toBe(500);
    }
  );
});

describe('storagePrefixesFor', () => {
  it('devolve exatamente os quatro pares, na ordem da §3.3', () => {
    expect(storagePrefixesFor('acct-1', 'user-9')).toEqual([
      { bucket: 'chat-media', prefix: 'account-acct-1/' },
      { bucket: 'flow-media', prefix: 'account-acct-1/' },
      { bucket: 'contact-avatars', prefix: 'account-acct-1/' },
      { bucket: 'avatars', prefix: 'user-9/' },
    ]);
  });
});

describe('buildDeletionTombstone', () => {
  it('preserva accountId e lista as sobras mesmo quando a auditoria vai com accountId null', () => {
    const tombstone = buildDeletionTombstone({
      accountId: 'acct-1',
      accountName: 'Minha Empresa',
      ownerEmail: 'dono@example.com',
      ownerUserId: 'user-9',
      counts: { contacts: 3, conversations: 1 },
      detachedMembers: [{ userId: 'user-2', newAccountId: 'acct-personal-2' }],
      storageRemoved: { 'chat-media': 5 },
      leftovers: ['instância X não apagada na VPS'],
      now: new Date('2026-09-06T12:00:00.000Z'),
    });

    expect(tombstone.accountId).toBe('acct-1');
    expect(tombstone.leftovers).toEqual(['instância X não apagada na VPS']);
    expect(tombstone.deletedAt).toBe('2026-09-06T12:00:00.000Z');
    expect(tombstone.detachedMembers).toEqual([
      { userId: 'user-2', newAccountId: 'acct-personal-2' },
    ]);
  });
});
