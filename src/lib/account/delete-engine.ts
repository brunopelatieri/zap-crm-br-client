/**
 * Núcleo de I/O da exclusão de conta (SPEC 073 + extensão do console do
 * proprietário). Compartilhado pelas duas rotas que apagam uma conta —
 * self-service (`src/app/api/account/delete/route.ts`) e administrativa
 * (`src/app/api/platform/accounts/[accountId]/delete/route.ts`), que só
 * divergem em QUEM autentica e QUAL RPC desliga membros. A leitura do
 * inventário, a varredura de Storage e a limpeza da VPS são idênticas
 * nas duas — moradia única para não divergirem na primeira correção
 * (achado de code review: era exatamente isso que já tinha acontecido
 * com a limpeza de instância Evolution antes desta extração).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { chunkArray } from '@/lib/array';
import { readEvolutionConfig } from '@/lib/evolution/config';
import { deleteInstanceOnVpsByRemoteId } from '@/lib/evolution/instances';
import { storagePrefixesFor } from './delete';

const STORAGE_LIST_PAGE = 100;
const STORAGE_REMOVE_BATCH = 100;
const MESSAGE_COUNT_CHUNK = 500;

export interface AccountProfileRow {
  userId: string;
  email: string;
  role: string;
}

/**
 * Todos os perfis da conta (dono incluso) numa query só — serve tanto
 * `loadMemberIds` (filtra não-donos) quanto a rota administrativa, que
 * precisa também do e-mail do titular. Antes eram duas idas separadas
 * à mesma tabela (achado de code review); agora é uma.
 */
export async function loadAccountProfiles(
  db: SupabaseClient,
  accountId: string
): Promise<AccountProfileRow[]> {
  const { data } = await db
    .from('profiles')
    .select('user_id, email, account_role')
    .eq('account_id', accountId);
  return (data ?? []).map((r) => ({
    userId: r.user_id as string,
    email: r.email as string,
    role: r.account_role as string,
  }));
}

/** `profiles.user_id` dos membros NÃO-DONOS da conta. */
export async function loadMemberIds(
  db: SupabaseClient,
  accountId: string
): Promise<string[]> {
  const profiles = await loadAccountProfiles(db, accountId);
  return profiles.filter((p) => p.role !== 'owner').map((p) => p.userId);
}

export async function loadDeletionCounts(
  db: SupabaseClient,
  accountId: string,
  memberIds: string[]
): Promise<Record<string, number>> {
  const [
    { count: contacts },
    { count: conversations },
    { count: broadcasts },
    { count: channels },
    { data: convRows },
  ] = await Promise.all([
    db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    db
      .from('broadcasts')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    db
      .from('channels')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    db.from('conversations').select('id').eq('account_id', accountId),
  ]);

  const conversationIds = (convRows ?? []).map((r) => r.id as string);
  let messages = 0;
  for (const chunk of chunkArray(conversationIds, MESSAGE_COUNT_CHUNK)) {
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', chunk);
    messages += count ?? 0;
  }

  return {
    contacts: contacts ?? 0,
    conversations: conversations ?? 0,
    messages,
    broadcasts: broadcasts ?? 0,
    channels: channels ?? 0,
    // Membros NÃO-DONOS — é o que a UI/e-mail descrevem ("perdem
    // acesso", "desligados"); o titular não é contado aqui (ele não é
    // desligado, é apagado).
    members: memberIds.length,
  };
}

async function removeStoragePrefix(
  db: SupabaseClient,
  bucket: string,
  prefix: string
): Promise<{ removed: number; error: string | null }> {
  try {
    // Lista TODAS as páginas primeiro, sem apagar no meio — apagar
    // antes de terminar de listar encolhe o bucket, e `offset` sobre
    // uma lista que está encolhendo pula itens.
    const allPaths: string[] = [];
    let offset = 0;
    for (;;) {
      const { data: entries, error: listErr } = await db.storage
        .from(bucket)
        .list(prefix, { limit: STORAGE_LIST_PAGE, offset });
      if (listErr) return { removed: 0, error: listErr.message };
      if (!entries || entries.length === 0) break;
      allPaths.push(...entries.map((e) => `${prefix}${e.name}`));
      if (entries.length < STORAGE_LIST_PAGE) break;
      offset += STORAGE_LIST_PAGE;
    }

    let removed = 0;
    for (const batch of chunkArray(allPaths, STORAGE_REMOVE_BATCH)) {
      const { error: removeErr } = await db.storage.from(bucket).remove(batch);
      if (removeErr) return { removed, error: removeErr.message };
      removed += batch.length;
    }
    return { removed, error: null };
  } catch (err) {
    return {
      removed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Varre os quatro prefixos da §3.3, melhor esforço. */
export async function removeAllStoragePrefixes(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string
): Promise<{ storageRemoved: Record<string, number>; leftovers: string[] }> {
  const storageRemoved: Record<string, number> = {};
  const leftovers: string[] = [];
  for (const { bucket, prefix } of storagePrefixesFor(accountId, ownerUserId)) {
    const result = await removeStoragePrefix(db, bucket, prefix);
    storageRemoved[bucket] = result.removed;
    if (result.error) {
      leftovers.push(`Storage ${bucket}/${prefix}: ${result.error}`);
    }
  }
  return { storageRemoved, leftovers };
}

/**
 * Apaga na VPS cada instância Evolution da conta, melhor esforço, em
 * paralelo (round-trips independentes, sem ordem a preservar).
 */
export async function cleanupEvolutionInstances(
  instances: { remote_instance_id: string | null }[]
): Promise<string[]> {
  if (instances.length === 0) return [];

  const evolutionConfig = readEvolutionConfig();
  if (!evolutionConfig) {
    return [
      `Evolution não configurada — ${instances.length} instância(s) não removida(s) da VPS`,
    ];
  }

  const remoteIds = instances
    .map((instance) => instance.remote_instance_id)
    .filter((id): id is string => id !== null);
  const results = await Promise.all(
    remoteIds.map(async (remoteId) => ({
      remoteId,
      err: await deleteInstanceOnVpsByRemoteId(evolutionConfig, remoteId),
    }))
  );

  const leftovers: string[] = [];
  for (const { remoteId, err } of results) {
    if (err) {
      leftovers.push(`instância ${remoteId} não apagada na VPS: ${err}`);
    }
  }
  return leftovers;
}
