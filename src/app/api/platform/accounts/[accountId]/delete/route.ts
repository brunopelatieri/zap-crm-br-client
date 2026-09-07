// ============================================================
// POST /api/platform/accounts/[accountId]/delete
//
// Exclusão de conta pelo CONSOLE do proprietário da plataforma —
// extensão administrativa da SPEC 073 (self-service em
// /api/account/delete). `requirePlatformOwner()` → 404 para qualquer
// chamador não autorizado (§2.4, mesmo padrão de .../block).
//
// Duas diferenças da rota self-service, pelo mesmo motivo (o operador
// não é o titular):
//   - sem reautenticação por senha — o operador não tem a senha do
//     titular. A confirmação é digitar o nome exato da conta
//     (`checkAdminDeleteGuard`).
//   - membros não-donos são desligados via `platform_remove_account_member`
//     (migração 079), não `remove_account_member` — essa RPC exige que
//     quem chama seja admin+ DA MESMA CONTA do alvo, o que o
//     proprietário da plataforma quase nunca é. A variante 079 não tem
//     essa checagem; a autorização inteira fica em TypeScript
//     (`requirePlatformOwner()`) + no GRANT do banco, restrito a
//     service_role.
//
// Resto da ordem é idêntico à self-service (§4): leitura → desligar
// membros → DELETE FROM accounts (ponto de não-retorno) → apagar login
// do titular → melhor esforço (Storage + VPS) → rastro.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import { emitSystemEvent } from '@/lib/notifications/emit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  buildDeletionTombstone,
  checkAdminDeleteGuard,
  detachMemberErrorStatus,
} from '@/lib/account/delete';
import {
  cleanupEvolutionInstances,
  loadAccountProfiles,
  loadDeletionCounts,
  removeAllStoragePrefixes,
} from '@/lib/account/delete-engine';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  let platformOwnerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    platformOwnerEmail = ctx.email;
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // A partir daqui a identidade do chamador já está resolvida — um erro
  // inesperado agora é 500, não 404 (§2.4 só cobre "esta rota não
  // existe" para quem não é o proprietário).
  try {
    const limit = checkRateLimit(
      `platform:accountDelete:${platformOwnerEmail}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { accountId } = await params;
    const db = supabaseAdmin();

    const { data: account } = await db
      .from('accounts')
      .select('name, owner_user_id')
      .eq('id', accountId)
      .maybeSingle();
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    const accountName = account.name as string;
    const ownerUserId = account.owner_user_id as string;

    const body = (await request.json().catch(() => null)) as {
      confirmName?: unknown;
    } | null;
    const confirmName =
      typeof body?.confirmName === 'string' ? body.confirmName : '';

    const guard = checkAdminDeleteGuard({
      accountName,
      typedName: confirmName,
    });
    if (!guard.ok) {
      return NextResponse.json(
        {
          error: 'Typed name does not match the account name',
          code: 'name_mismatch',
        },
        { status: 400 }
      );
    }

    // Etapa 2: leitura — uma query só de `profiles` dá o e-mail do
    // titular E a lista de membros não-donos (achado de code review —
    // antes eram duas idas separadas à mesma tabela).
    const profiles = await loadAccountProfiles(db, accountId);
    const ownerEmail =
      profiles.find((p) => p.userId === ownerUserId)?.email ?? null;
    const nonOwnerMemberIds = profiles
      .filter((p) => p.role !== 'owner')
      .map((p) => p.userId);
    const counts = await loadDeletionCounts(db, accountId, nonOwnerMemberIds);

    const { data: instanceRows } = await db
      .from('evolution_instances')
      .select('id, remote_instance_id')
      .eq('account_id', accountId);
    const instances = instanceRows ?? [];

    // Etapa 3: desliga cada membro não-dono. Falha aqui interrompe:
    // membros já desligados ficam desligados, a conta segue de pé.
    const detachedMembers: {
      userId: string;
      newAccountId: string | null;
    }[] = [];
    for (const memberId of nonOwnerMemberIds) {
      const { data, error } = await db.rpc('platform_remove_account_member', {
        p_user_id: memberId,
      });
      if (error) {
        console.error('[platform/accounts/delete] falha ao desligar membro:', {
          memberId,
          message: error.message,
        });
        const status = detachMemberErrorStatus(error.code);
        return NextResponse.json(
          {
            error:
              status === 500
                ? 'Failed to detach a team member before deletion'
                : error.message,
          },
          { status }
        );
      }
      detachedMembers.push({
        userId: memberId,
        newAccountId: (data as string | null) ?? null,
      });
    }

    // Etapa 4 — o ponto de não-retorno.
    const { error: deleteAccountErr } = await db
      .from('accounts')
      .delete()
      .eq('id', accountId);
    if (deleteAccountErr) {
      console.error(
        '[platform/accounts/delete] falha ao apagar accounts (nada foi apagado):',
        deleteAccountErr.message
      );
      return NextResponse.json(
        { error: 'Failed to delete the account' },
        { status: 500 }
      );
    }

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

    // Etapa 7: rastro. `actor` marca que foi o console, não o titular —
    // mesmo padrão de `consoleActorTag` usado no bloqueio.
    const tombstone = buildDeletionTombstone({
      accountId,
      accountName,
      ownerEmail: ownerEmail ?? '',
      ownerUserId,
      counts,
      detachedMembers,
      storageRemoved,
      leftovers,
    });

    await writePlatformAudit(db, {
      actor: consoleActorTag(platformOwnerEmail),
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
        actor: consoleActorTag(platformOwnerEmail),
        data: { deletion: { counts, detachedMembers, leftovers } },
      },
      db
    );

    return NextResponse.json({
      ok: true,
      deleted: { accountId, counts, detachedMembers, leftovers },
    });
  } catch (err) {
    console.error('[platform/accounts/delete] unexpected error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
