/**
 * Núcleo puro da exclusão de conta pelo titular (SPEC 073).
 *
 * Sem I/O de propósito — testável sem mock de Supabase. A rota
 * (`src/app/api/account/delete/route.ts`) resolve os dados reais
 * (papel, senha, e-mails, contagens) e chama estas funções antes de
 * tocar no banco, no Storage ou na VPS.
 */

import type { AccountRole } from '@/lib/auth/roles';

export type DeleteGuardReason =
  | 'not_owner' // papel abaixo de owner
  | 'platform_owner_account' // é a conta do proprietário da plataforma
  | 'name_mismatch'; // o texto digitado não bate com accounts.name

/**
 * Guardas de exclusão. `isPlatformOwnerAccount` já vem RESOLVIDO pela
 * rota (via `isPlatformOwnerEmail(ownerEmail)`) — não há um segundo
 * ator para comparar por id como em `canBlockAccount`
 * (`src/lib/platform/guards.ts`): a exclusão é sempre autoatendida (só
 * o dono pode apagar a PRÓPRIA conta), então "esta conta pertence ao
 * proprietário da plataforma" se resolve inteiramente pelo e-mail de
 * quem está chamando. Um segundo parâmetro "por id" aqui seria sempre
 * tautológico com este (achado de code review — as duas condições
 * nunca podiam divergir no único call site real).
 */
export function checkDeleteGuards(input: {
  role: AccountRole;
  accountName: string;
  typedName: string;
  isPlatformOwnerAccount: boolean;
}): { ok: true } | { ok: false; reason: DeleteGuardReason } {
  if (input.role !== 'owner') {
    return { ok: false, reason: 'not_owner' };
  }
  if (input.isPlatformOwnerAccount) {
    return { ok: false, reason: 'platform_owner_account' };
  }

  // Sensível a maiúsculas de propósito (§5.1 da SPEC) — a mesma régua
  // do modal de exclusão de instância QRCode. Afrouxar aqui seria
  // afrouxar justo onde a fricção é o recurso.
  if (input.typedName.trim() !== input.accountName.trim()) {
    return { ok: false, reason: 'name_mismatch' };
  }

  return { ok: true };
}

/** Os quatro prefixos da §3.3 (o cascade do Postgres não toca em Storage). */
export function storagePrefixesFor(
  accountId: string,
  ownerUserId: string
): { bucket: string; prefix: string }[] {
  return [
    { bucket: 'chat-media', prefix: `account-${accountId}/` },
    { bucket: 'flow-media', prefix: `account-${accountId}/` },
    { bucket: 'contact-avatars', prefix: `account-${accountId}/` },
    { bucket: 'avatars', prefix: `${ownerUserId}/` },
  ];
}

export interface DeletionTombstone {
  accountId: string;
  accountName: string;
  ownerEmail: string;
  ownerUserId: string;
  counts: Record<string, number>;
  detachedMembers: { userId: string; newAccountId: string | null }[];
  storageRemoved: Record<string, number>;
  leftovers: string[];
  deletedAt: string;
}

export function buildDeletionTombstone(input: {
  accountId: string;
  accountName: string;
  ownerEmail: string;
  ownerUserId: string;
  counts: Record<string, number>;
  detachedMembers: { userId: string; newAccountId: string | null }[];
  storageRemoved: Record<string, number>;
  leftovers: string[];
  now?: Date;
}): DeletionTombstone {
  return {
    accountId: input.accountId,
    accountName: input.accountName,
    ownerEmail: input.ownerEmail,
    ownerUserId: input.ownerUserId,
    counts: input.counts,
    detachedMembers: input.detachedMembers,
    storageRemoved: input.storageRemoved,
    leftovers: input.leftovers,
    deletedAt: (input.now ?? new Date()).toISOString(),
  };
}
