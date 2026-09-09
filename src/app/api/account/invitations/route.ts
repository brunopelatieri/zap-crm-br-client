// ============================================================
// /api/account/invitations
//
//   GET  — list outstanding (un-redeemed, non-expired) invites.
//   POST — create a new invite link.
//
// Both admin+. The list endpoint is what the Members tab uses to
// populate the "Pending invitations" section; create is what the
// "Invite member" dialog calls.
//
// IMPORTANT: the plaintext token is returned exactly ONCE — in
// the POST response. We store only the SHA-256 hash on the row,
// so neither GET nor a future PATCH can ever resurface the
// link. The admin sees it in the creation modal, copies it, and
// shares it via WhatsApp/Slack/whatever they like. If they
// dismiss the modal without copying, the only recourse is to
// revoke and re-issue.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  clampExpiryDays,
  generateInviteToken,
  inviteExpiresAt,
  inviteUrl,
} from '@/lib/auth/invitations';
import { isAccountRole } from '@/lib/auth/roles';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { checkQuota } from '@/lib/plans/gate';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { recordActivity } from '@/lib/activity/record';

// Resolve the base URL we publish invite links under.
//
// Resolution order, first match wins:
//
//   1. `NEXT_PUBLIC_SITE_URL` — admin's explicit config. Trumps
//      everything; if you set this, that's where links point.
//   2. `X-Forwarded-Host` (+ `X-Forwarded-Proto`) — set by every
//      reverse proxy in front of the app: Hostinger Managed
//      Node.js, Vercel, Cloudflare, nginx. This is what makes
//      invite links Just Work in production without forcing the
//      operator to set an env var.
//   3. `Host` header + the protocol the request arrived on —
//      bare deployments without a proxy.
//   4. Last-resort marketing-site fallback. Only hit if the
//      request has no Host header at all, which is essentially
//      impossible from a real browser. Logs a warning so the
//      operator can spot the misconfig.
//
// Defense-in-depth: `ALLOWED_INVITE_HOSTS`
//
//   The request-header path (#2 and #3 above) trusts whatever
//   hostname the client (or proxy) puts in the header. On a
//   typical proxied deploy (Vercel / Hostinger / Cloudflare) the
//   proxy overwrites these so they're trustworthy. On a bare
//   deployment exposed to the public internet, an attacker could
//   POST directly with a crafted `Host: phishing.example` and
//   receive an invite URL pointing at their site.
//
//   When `ALLOWED_INVITE_HOSTS` is set (comma-separated hostnames),
//   we validate the derived host against the list. Anything not
//   on the list falls through to the wacrm.tech fallback with a
//   loud console.warn. Operators who care about this attack
//   surface should set this to their canonical hostnames; everyone
//   else gets today's permissive behavior.
//
// Previous implementation hard-defaulted to `https://wacrm.tech`
// (the docs/marketing site, a different repo). Forks that didn't
// set `NEXT_PUBLIC_SITE_URL` got invite links pointing at the
// marketing site, which 404s on `/join/<token>`. This resolution
// chain removes the foot-gun.
function parseAllowedHosts(): readonly string[] | null {
  const raw = process.env.ALLOWED_INVITE_HOSTS?.trim();
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function isHostAllowed(
  hostname: string,
  allowList: readonly string[] | null
): boolean {
  if (!allowList) return true; // No allow-list → permissive (legacy behavior).
  return allowList.includes(hostname.toLowerCase());
}

function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const allowList = parseAllowedHosts();
  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim();
  if (forwardedHost && isHostAllowed(forwardedHost, allowList)) {
    return `${forwardedProto || 'https'}://${forwardedHost}`;
  }

  const host = request.headers.get('host')?.trim();
  if (host && isHostAllowed(host, allowList)) {
    // The protocol on `request.url` is whatever the framework saw —
    // reliable for bare deployments where no proxy is rewriting it.
    const reqProto = new URL(request.url).protocol.replace(':', '');
    return `${reqProto}://${host}`;
  }

  // We fall through here when EITHER no Host header was present at
  // all (essentially impossible from a real browser) OR an
  // ALLOWED_INVITE_HOSTS list was set and neither candidate matched
  // it. The warning is the operator's signal that someone is
  // probing the API with a spoofed Host header.
  if (allowList && (forwardedHost || host)) {
    console.warn(
      '[POST /api/account/invitations] rejected non-allow-listed host:',
      { forwardedHost, host, allowList }
    );
  } else {
    console.warn(
      '[POST /api/account/invitations] could not derive base URL from request; falling back to marketing domain'
    );
  }
  return 'https://wacrm.tech';
}

const MAX_LABEL_LEN = 80;

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const { data, error } = await ctx.supabase
      .from('account_invitations')
      .select(
        'id, role, label, created_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id'
      )
      .eq('account_id', ctx.accountId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/account/invitations] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load invitations' },
        { status: 500 }
      );
    }

    return NextResponse.json({ invitations: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    // 30/min per user. The Members tab is a clicks-only UI so any
    // legitimate admin is far below this; the cap exists to keep
    // a script run in a loop or a compromised admin session from
    // flooding `account_invitations` with rows.
    const limit = checkRateLimit(
      `admin:inviteCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      role?: unknown;
      expiresInDays?: unknown;
      label?: unknown;
    } | null;

    const role = body?.role;
    if (!isAccountRole(role) || role === 'owner') {
      // The DB CHECK already rejects 'owner', but failing fast
      // here gives a clearer 400 than the eventual constraint
      // violation surfaced as a 500.
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
        { status: 400 }
      );
    }

    const expiresInDaysRaw = body?.expiresInDays;
    // `clampExpiryDays` tolerates undefined / NaN / negatives by
    // collapsing to the safe default, so we just pass the raw
    // value through after a type narrow.
    const expiresInDays =
      typeof expiresInDaysRaw === 'number' ? expiresInDaysRaw : undefined;
    const expiryDays = clampExpiryDays(expiresInDays);
    const expiresAt = inviteExpiresAt(expiryDays);

    let label: string | null = null;
    if (typeof body?.label === 'string') {
      const trimmed = body.label.trim();
      if (trimmed.length > MAX_LABEL_LEN) {
        return NextResponse.json(
          { error: `Label must be ${MAX_LABEL_LEN} characters or fewer` },
          { status: 400 }
        );
      }
      label = trimmed === '' ? null : trimmed;
    }

    // SPEC 059 §4.1: convite pendente ocupa vaga. Sem isto, um plano de
    // 5 usuários emite 20 convites (cada um passando por esta checagem
    // ANTES de qualquer um ser aceito) e recebe 20 pessoas — o
    // `redeem_invitation` final (migração 067 §12) é o backstop, não a
    // pré-checagem. Owner conta em members_total e também no bucket
    // 'admin' (D-6) — count_members_role() já resolve isso.
    const nowIso = new Date().toISOString();
    const [
      membersTotalRes,
      pendingTotalRes,
      roleMembersCountRes,
      pendingRoleRes,
      limitTotalRes,
      limitRoleRes,
    ] = await Promise.all([
      ctx.supabase
        .from('profiles')
        .select('user_id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId),
      ctx.supabase
        .from('account_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .is('accepted_at', null)
        .gt('expires_at', nowIso),
      // count_members_role/plan_limit confiam cegamente em
      // p_account_id (sem checar is_account_member) — por isso EXECUTE
      // é só de service_role (migração 067), nunca de authenticated.
      // ctx.accountId já veio de requireRole('admin') acima, não de
      // input do cliente.
      supabaseAdmin().rpc('count_members_role', {
        p_account_id: ctx.accountId,
        p_role: role,
      }),
      ctx.supabase
        .from('account_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('role', role)
        .is('accepted_at', null)
        .gt('expires_at', nowIso),
      supabaseAdmin().rpc('plan_limit', {
        p_account_id: ctx.accountId,
        p_key: 'members_total',
      }),
      supabaseAdmin().rpc('plan_limit', {
        p_account_id: ctx.accountId,
        p_key: `members_${role}`,
      }),
    ]);

    // Achado de code review: antes, só { data }/{ count } eram
    // desestruturados e o `error` de cada consulta era descartado — uma
    // falha transitória em qualquer uma virava `undefined`, que
    // checkQuota() trata como "sem limite" (falha aberta indevida,
    // diferente da falha aberta intencional de "plano sem a chave").
    const failedQuery = [
      membersTotalRes,
      pendingTotalRes,
      roleMembersCountRes,
      pendingRoleRes,
      limitTotalRes,
      limitRoleRes,
    ].find((res) => res.error);
    if (failedQuery) {
      console.error(
        '[POST /api/account/invitations] quota precheck query failed:',
        failedQuery.error
      );
      return NextResponse.json(
        { error: 'Failed to check member quota' },
        { status: 500 }
      );
    }

    const { count: membersTotal } = membersTotalRes;
    const { count: pendingTotal } = pendingTotalRes;
    const { data: roleMembersCount } = roleMembersCountRes;
    const { count: pendingRole } = pendingRoleRes;
    const { data: limitTotal } = limitTotalRes;
    const { data: limitRole } = limitRoleRes;

    const totalDecision = checkQuota({
      limit: limitTotal ?? null,
      used: (membersTotal ?? 0) + (pendingTotal ?? 0),
      requested: 1,
    });
    if (!totalDecision.allowed) {
      return NextResponse.json(
        {
          error: `Member limit reached (${totalDecision.used}/${totalDecision.limit})`,
          code: 'quota_exceeded',
        },
        { status: 403 }
      );
    }

    const roleDecision = checkQuota({
      limit: limitRole ?? null,
      used: (roleMembersCount ?? 0) + (pendingRole ?? 0),
      requested: 1,
    });
    if (!roleDecision.allowed) {
      return NextResponse.json(
        {
          error: `Member limit reached for role '${role}' (${roleDecision.used}/${roleDecision.limit})`,
          code: 'quota_exceeded',
        },
        { status: 403 }
      );
    }

    const { token, hash } = generateInviteToken();

    const { data, error } = await ctx.supabase
      .from('account_invitations')
      .insert({
        account_id: ctx.accountId,
        token_hash: hash,
        role,
        created_by_user_id: ctx.userId,
        label,
        expires_at: expiresAt.toISOString(),
      })
      .select('id, role, label, expires_at, created_at')
      .single();

    if (error || !data) {
      console.error('[POST /api/account/invitations] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create invitation' },
        { status: 500 }
      );
    }

    // SPEC 075 F4 — sem `resourceId` de pessoa (o convite ainda não tem
    // usuário associado): a linha de `account_invitations` é o
    // `source`, e o papel oferecido vai em `metadata`.
    void recordActivity(ctx.supabase, {
      accountId: ctx.accountId,
      resourceType: 'member',
      action: 'member.invited',
      resourceLabel: label ?? null,
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
      source: { table: 'account_invitations', id: data.id },
      metadata: { role },
    });

    return NextResponse.json(
      {
        invitation: data,
        // Plaintext payload — visible to the admin exactly once.
        token,
        url: inviteUrl(token, getBaseUrl(request)),
        expiresInDays: expiryDays,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
