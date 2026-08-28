// ============================================================
// GET /api/platform/notifications — SPEC 063 §6, F7
//
//   As últimas 100 linhas da outbox (`system_notifications`), com
//   filtro opcional `?status=failed`. Também devolve o estado dos dois
//   canais (§6: "Alert no topo quando o SMTP não está configurado" —
//   sem isso o operador conclui que o sistema está quebrado quando o
//   `.env` é que está incompleto).
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readMailerConfig } from '@/lib/mailer/config';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

function webhookConfigured(): boolean {
  return Boolean(
    process.env.SYSTEM_EVENT_WEBHOOK_URL?.trim() ||
    process.env.PLAN_REQUEST_WEBHOOK_URL?.trim()
  );
}

export async function GET(request: Request) {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  let query = supabaseAdmin()
    .from('system_notifications')
    .select(
      'id, type, account_id, email_status, hook_status, attempts, last_error, created_at, delivered_at, accounts:account_id (name)'
    )
    .order('created_at', { ascending: false })
    .limit(100);

  if (status === 'failed') {
    query = query.or('email_status.eq.failed,hook_status.eq.failed');
  }

  const { data, error } = await query;
  if (error) {
    console.error('[GET /api/platform/notifications] fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to load notifications' },
      { status: 500 }
    );
  }

  const emailConfigured = readMailerConfig() !== null;

  return NextResponse.json({
    notifications: data,
    channels: { email: emailConfigured, webhook: webhookConfigured() },
  });
}
