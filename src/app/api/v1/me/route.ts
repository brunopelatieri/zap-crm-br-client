// ============================================================
// GET /api/v1/me — public API identity probe.
//
// The reference endpoint for the public API: it requires nothing
// but a valid key (no scope), and returns the account the key is
// bound to plus the scopes it carries. Integrators use it to verify
// their key works and to discover what it's allowed to do before
// wiring up real calls.
//
// It also exercises the entire public-API stack end to end — bearer
// parse → hash lookup → liveness → rate limit → envelope — so a
// green response here means the plumbing every future endpoint
// depends on is sound.
//
// `channels` (SPEC 064 F9): only present when the key has
// `messages:send` or `broadcasts:send` — it lists phone numbers, and a
// key scoped only to e.g. `contacts:read` shouldn't see them. Absent
// the field entirely for other keys, not an empty array.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { hasScope } from '@/lib/api-keys/scopes';
import { getAccountName } from '@/lib/api-keys/store';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getAccountPlan } from '@/lib/plans/account-plan';
import { channelIdentifierIsPhone } from '@/lib/channels/identifier';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request);
    const name = await getAccountName(ctx.accountId);

    // SPEC 059 §8.2: bloco de plano/uso — integrações checam antes de
    // despejar 10.000 contatos em vez de descobrir pelo 403. Best-effort:
    // /api/v1/me é o endpoint de referência ("minha chave funciona?") e
    // não pode virar 500 por causa de um problema no motor de quotas.
    let plan: {
      code: string;
      name: string;
      status: string;
      billingCycle: string;
      startedAt: string;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
    } | null = null;
    let usage: { key: string; used: number; limit: number | null }[] = [];
    try {
      const snapshot = await getAccountPlan(ctx.accountId, ctx.supabase);
      plan = {
        code: snapshot.plan.code,
        name: snapshot.plan.name,
        status: snapshot.accountPlan.status,
        // SPEC 062 §9 — uma integração que provisiona recursos precisa
        // saber QUANDO o acesso vence, não só o código do plano.
        billingCycle: snapshot.accountPlan.billingCycle,
        startedAt: snapshot.accountPlan.startedAt,
        currentPeriodEnd: snapshot.accountPlan.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.accountPlan.cancelAtPeriodEnd,
      };
      usage = snapshot.quotasEnforced
        ? snapshot.usage.buckets.map((b) => ({
            key: b.key,
            used: b.used,
            limit: b.limit,
          }))
        : [];
    } catch (err) {
      console.error('[api/v1/me] failed to load account plan:', err);
    }

    // SPEC 064 F9/§7 — a lista inclui telefones, então só entra quando a
    // chave já pode fazer algo com um número (enviar mensagem ou
    // disparar campanha). Uma chave só de `contacts:read` não ganha o
    // campo — não é uma lista vazia, é AUSÊNCIA do campo, para o
    // contrato continuar idêntico ao de antes desta fase para quem não
    // pediu esse escopo.
    let channels:
      | {
          id: string;
          name: string;
          type: string;
          status: string;
          phone: string | null;
        }[]
      | undefined;
    if (
      hasScope(ctx.scopes, 'messages:send') ||
      hasScope(ctx.scopes, 'broadcasts:send')
    ) {
      const { data: rows, error } = await ctx.supabase
        .from('channels')
        .select('id, name, type, status, identifier')
        .eq('account_id', ctx.accountId)
        .neq('status', 'disabled');
      if (error) {
        console.error('[api/v1/me] failed to load channels:', error);
        channels = [];
      } else {
        channels = (rows ?? []).map((c) => ({
          id: c.id as string,
          name: c.name as string,
          type: c.type as string,
          status: c.status as string,
          // D-9: só mostra telefone do que sabidamente é um — nunca o
          // `phone_number_id` da Meta formatado como se fosse número.
          phone: channelIdentifierIsPhone({
            type: c.type,
            identifier: c.identifier,
          })
            ? (c.identifier as string | null)
            : null,
        }));
      }
    }

    return ok({
      account: { id: ctx.accountId, name },
      key: { id: ctx.keyId, scopes: ctx.scopes },
      plan,
      usage,
      ...(channels ? { channels } : {}),
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
