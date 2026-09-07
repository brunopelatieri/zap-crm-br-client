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
//
// A leitura de inventário, a varredura de Storage e a limpeza da VPS
// vêm de `@/lib/account/delete-engine` — compartilhadas com a
// exclusão administrativa (`/api/platform/accounts/[accountId]/delete`,
// extensão do console do proprietário). O que É específico desta rota:
// reautenticação por SENHA do titular e a RPC `remove_account_member`
// via client de SESSÃO (o console não tem a senha do titular nem é
// membro da conta-alvo — usa `platform_remove_account_member`, sem
// essa checagem, restrita a service_role).
// ============================================================

import { NextResponse } from 'next/server';
import { createClient as createIsolatedClient } from '@supabase/supabase-js';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isPlatformOwnerEmail } from '@/lib/platform/owner';
import { writePlatformAudit } from '@/lib/platform/audit';
import { emitSystemEvent } from '@/lib/notifications/emit';
import {
  buildDeletionTombstone,
  checkDeleteGuards,
} from '@/lib/account/delete';
import {
  cleanupEvolutionInstances,
  loadDeletionCounts,
  loadMemberIds,
  removeAllStoragePrefixes,
} from '@/lib/account/delete-engine';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('owner');
    const db = supabaseAdmin();
    const memberIds = await loadMemberIds(db, ctx.accountId);
    const counts = await loadDeletionCounts(db, ctx.accountId, memberIds);
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
    const counts = await loadDeletionCounts(db, accountId, nonOwnerMemberIds);

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

    // Etapa 6: melhor esforço — Storage e VPS Evolution.
    const { storageRemoved, leftovers: storageLeftovers } =
      await removeAllStoragePrefixes(db, accountId, ownerUserId);
    leftovers.push(...storageLeftovers);
    leftovers.push(...(await cleanupEvolutionInstances(instances)));

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
