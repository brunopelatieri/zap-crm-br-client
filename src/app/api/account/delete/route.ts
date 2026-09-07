// ============================================================
// GET  /api/account/delete/preview — inventário só-leitura, owner+.
// POST /api/account/delete         — exclusão da conta pelo titular.
//
// SPEC 073. Segue a ordem canônica da §4: guardas → leitura → desligar
// membros (client de sessão) → DELETE FROM accounts (client admin,
// ponto de não-retorno) → apagar o login do titular → melhor esforço
// (Storage + VPS Evolution) → rastro (auditoria + outbox).
//
// Depois do DELETE de accounts o client de sessão está morto (o
// profiles do titular foi junto) — por isso as etapas 5-7 usam
// SEMPRE supabaseAdmin(), nunca ctx.supabase.
// ============================================================

import { NextResponse } from 'next/server';
import { createClient as createIsolatedClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isPlatformOwnerEmail } from '@/lib/platform/owner';
import { writePlatformAudit } from '@/lib/platform/audit';
import { emitSystemEvent } from '@/lib/notifications/emit';
import { chunkArray } from '@/lib/array';
import {
  buildDeletionTombstone,
  checkDeleteGuards,
  storagePrefixesFor,
} from '@/lib/account/delete';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { readEvolutionConfig } from '@/lib/evolution/config';
import { deleteInstanceOnVpsByRemoteId } from '@/lib/evolution/instances';

const STORAGE_LIST_PAGE = 100;
const STORAGE_REMOVE_BATCH = 100;
const MESSAGE_COUNT_CHUNK = 500;

// ------------------------------------------------------------
// GET preview — só as contagens, requireRole('owner').
// ------------------------------------------------------------

/**
 * `profiles.user_id` dos membros NÃO-DONOS da conta — a mesma query
 * serve dois propósitos (contagem no inventário e a lista real a
 * desligar na etapa 3 do POST), então só roda uma vez por request em
 * vez de duas.
 */
async function loadMemberIds(
  db: SupabaseClient,
  accountId: string
): Promise<string[]> {
  const { data } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .neq('account_role', 'owner');
  return (data ?? []).map((r) => r.user_id as string);
}

async function loadCounts(
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
    // Membros NÃO-DONOS — é o que a UI/e-mail descrevem ("perdem acesso",
    // "desligados"); o titular não é contado aqui (ele não é desligado,
    // é apagado).
    members: memberIds.length,
  };
}

export async function GET() {
  try {
    const ctx = await requireRole('owner');
    const db = supabaseAdmin();
    const memberIds = await loadMemberIds(db, ctx.accountId);
    const counts = await loadCounts(db, ctx.accountId, memberIds);
    return NextResponse.json({ counts });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ------------------------------------------------------------
// POST — a exclusão de verdade.
// ------------------------------------------------------------

async function reauthenticate(
  email: string,
  password: string
): Promise<boolean> {
  // Client ISOLADO — nunca o de sessão, que gravaria cookie novo por
  // cima da sessão atual (§5.2).
  const isolated = createIsolatedClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { error } = await isolated.auth.signInWithPassword({
    email,
    password,
  });
  return !error;
}

async function removeStoragePrefix(
  db: SupabaseClient,
  bucket: string,
  prefix: string
): Promise<{ removed: number; error: string | null }> {
  try {
    // Lista TODAS as páginas primeiro, sem apagar no meio — apagar antes
    // de terminar de listar encolhe o bucket, e `offset` sobre uma lista
    // que está encolhendo pula itens (achado de code review). Só depois
    // de ter o conjunto completo é que os lotes são removidos.
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

export async function POST(request: Request) {
  try {
    // Etapa 1 (parte 1): quem está chamando.
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(
      `account:delete:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const {
      data: { user },
    } = await ctx.supabase.auth.getUser();
    const ownerEmail = user?.email ?? '';

    const body = (await request.json().catch(() => null)) as {
      confirmName?: unknown;
      password?: unknown;
    } | null;
    const confirmName =
      typeof body?.confirmName === 'string' ? body.confirmName : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    // Etapa 1 (parte 2): guardas puras — papel, conta do proprietário
    // da plataforma, nome digitado. Exclusão é sempre autoatendida (o
    // chamador só pode apagar a PRÓPRIA conta), então "esta conta
    // pertence ao proprietário da plataforma" se resolve inteiramente
    // pelo e-mail de quem está chamando — não há um segundo ator para
    // comparar por id.
    const guard = checkDeleteGuards({
      role: ctx.role,
      accountName: ctx.account.name,
      typedName: confirmName,
      isPlatformOwnerAccount: isPlatformOwnerEmail(ownerEmail),
    });
    if (!guard.ok) {
      if (guard.reason === 'not_owner') {
        return NextResponse.json(
          {
            error: 'Only the account owner can delete the account',
            code: 'not_owner',
          },
          { status: 403 }
        );
      }
      if (guard.reason === 'platform_owner_account') {
        return NextResponse.json(
          {
            error: 'The platform owner account cannot be self-deleted',
            code: 'platform_owner_account',
          },
          { status: 403 }
        );
      }
      return NextResponse.json(
        {
          error: 'Typed name does not match the account name',
          code: 'name_mismatch',
        },
        { status: 400 }
      );
    }

    // Etapa 1 (parte 3): reautenticação. Client isolado — nada é
    // tocado se falhar.
    const reauthOk = await reauthenticate(ownerEmail, password);
    if (!reauthOk) {
      return NextResponse.json(
        { error: 'Incorrect password', code: 'bad_password' },
        { status: 401 }
      );
    }

    const db = supabaseAdmin();
    const accountId = ctx.accountId;
    const accountName = ctx.account.name;
    const ownerUserId = ctx.userId;

    // Etapa 2: leitura — contagens, membros não-donos, instâncias
    // Evolution. Tudo escopado por account_id (defesa em profundidade:
    // supabaseAdmin() ignora RLS). Uma query só de `profiles` — o mesmo
    // resultado serve a contagem do inventário/tombstone E a lista real
    // desligada na etapa 3.
    const nonOwnerMemberIds = await loadMemberIds(db, accountId);
    const counts = await loadCounts(db, accountId, nonOwnerMemberIds);

    const { data: instanceRows } = await db
      .from('evolution_instances')
      .select('id, remote_instance_id')
      .eq('account_id', accountId);
    const instances = instanceRows ?? [];

    // Etapa 3: desliga cada membro não-dono. Client de SESSÃO — o RPC
    // é SECURITY DEFINER e checa auth.uid(). Falha aqui interrompe:
    // membros já desligados ficam desligados, a conta segue de pé.
    const detachedMembers: { userId: string; newAccountId: string | null }[] =
      [];
    for (const memberId of nonOwnerMemberIds) {
      const { data, error } = await ctx.supabase.rpc('remove_account_member', {
        p_user_id: memberId,
      });
      if (error) {
        console.error('[account/delete] falha ao desligar membro:', {
          memberId,
          message: error.message,
        });
        return NextResponse.json(
          { error: 'Failed to detach a team member before deletion' },
          { status: 500 }
        );
      }
      detachedMembers.push({
        userId: memberId,
        newAccountId: (data as string | null) ?? null,
      });
    }

    // Etapa 4 — o ponto de não-retorno. Client ADMIN: não existe
    // policy de RLS para uma conta se auto-apagar, de propósito.
    const { error: deleteAccountErr } = await db
      .from('accounts')
      .delete()
      .eq('id', accountId);
    if (deleteAccountErr) {
      console.error(
        '[account/delete] falha ao apagar accounts (nada foi apagado):',
        deleteAccountErr.message
      );
      return NextResponse.json(
        { error: 'Failed to delete the account' },
        { status: 500 }
      );
    }

    // A partir daqui SÓ supabaseAdmin() — o client de sessão morreu
    // junto com o profiles do titular.
    const leftovers: string[] = [];

    // Etapa 5: apaga o login do titular. Falha vira sobra, não erro —
    // a conta já não existe.
    const { error: deleteUserErr } = await (
      db.auth.admin.deleteUser as (
        id: string
      ) => Promise<{ error: { message: string } | null }>
    )(ownerUserId);
    if (deleteUserErr) {
      leftovers.push(`login do titular não removido: ${deleteUserErr.message}`);
    }

    // Etapa 6a: Storage, melhor esforço, os quatro prefixos da §3.3.
    const storageRemoved: Record<string, number> = {};
    for (const { bucket, prefix } of storagePrefixesFor(
      accountId,
      ownerUserId
    )) {
      const result = await removeStoragePrefix(db, bucket, prefix);
      storageRemoved[bucket] = result.removed;
      if (result.error) {
        leftovers.push(`Storage ${bucket}/${prefix}: ${result.error}`);
      }
    }

    // Etapa 6b: instâncias Evolution na VPS, melhor esforço. Cada chamada
    // é um round-trip HTTP independente, sem ordem a preservar entre
    // instâncias — rodam em paralelo.
    const evolutionConfig = readEvolutionConfig();
    if (instances.length > 0) {
      if (!evolutionConfig) {
        leftovers.push(
          `Evolution não configurada — ${instances.length} instância(s) não removida(s) da VPS`
        );
      } else {
        const remoteIds = instances
          .map((instance) => instance.remote_instance_id as string | null)
          .filter((id): id is string => id !== null);
        const results = await Promise.all(
          remoteIds.map(async (remoteId) => ({
            remoteId,
            err: await deleteInstanceOnVpsByRemoteId(evolutionConfig, remoteId),
          }))
        );
        for (const { remoteId, err } of results) {
          if (err) {
            leftovers.push(`instância ${remoteId} não apagada na VPS: ${err}`);
          }
        }
      }
    }

    // Etapa 7: rastro. Nunca lança — uma ação sem rastro é ruim, uma
    // ação que falha por causa do rastro é pior.
    const tombstone = buildDeletionTombstone({
      accountId,
      accountName,
      ownerEmail,
      ownerUserId,
      counts,
      detachedMembers,
      storageRemoved,
      leftovers,
    });

    await writePlatformAudit(db, {
      actor: `self-service:${ownerEmail}`,
      action: 'account.delete',
      accountId: null,
      targetUserId: null,
      payload: tombstone as unknown as Record<string, unknown>,
    });

    void emitSystemEvent(
      {
        type: 'account.deleted',
        accountId: null,
        account: { id: accountId, name: accountName, ownerEmail },
        data: { deletion: { counts, detachedMembers, leftovers } },
      },
      db
    );

    return NextResponse.json({
      ok: true,
      deleted: { accountId, counts, detachedMembers, leftovers },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
