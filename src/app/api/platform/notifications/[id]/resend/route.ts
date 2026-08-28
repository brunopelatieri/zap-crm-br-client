// ============================================================
// POST /api/platform/notifications/{id}/resend — SPEC 063 §6, F7
//
//   Zera `next_attempt_at` e `attempts`, e volta qualquer canal
//   `failed` para `pending` — um canal `sent`/`skipped` não é tocado
//   (reenviar não pode repetir um e-mail que já chegou). A porta 2 do
//   cron (ou a próxima chamada manual) entrega na sequência normal.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import { supabaseAdmin } from '@/lib/supabase/admin';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }

  const { id } = await params;
  const db = supabaseAdmin();

  const { data: row, error: readErr } = await db
    .from('system_notifications')
    .select('id, email_status, hook_status, account_id')
    .eq('id', id)
    .maybeSingle();

  if (readErr) {
    console.error(
      '[POST /api/platform/notifications/resend] read error:',
      readErr
    );
    return NextResponse.json(
      { error: 'Failed to load notification' },
      { status: 500 }
    );
  }
  if (!row) {
    return NextResponse.json(
      { error: 'Notification not found' },
      { status: 404 }
    );
  }

  // Achado de code review: sem esta guarda, chamar a rota numa linha
  // JÁ resolvida (nenhum canal `failed`) zerava `delivered_at` mesmo
  // sem nada para reenviar — e como a varredura só olha linhas com
  // algum canal `pending`, essa linha nunca mais ganharia `delivered_at`
  // de volta. Só a UI evitava isso (o botão só aparece com `failed`);
  // a rota precisa da mesma checagem.
  if (row.email_status !== 'failed' && row.hook_status !== 'failed') {
    return NextResponse.json(
      { error: 'Notification has no failed channel to resend' },
      { status: 400 }
    );
  }

  const revive = (status: DeliveryStatus): DeliveryStatus =>
    status === 'failed' ? 'pending' : status;

  const { data: updated, error: updateErr } = await db
    .from('system_notifications')
    .update({
      email_status: revive(row.email_status as DeliveryStatus),
      hook_status: revive(row.hook_status as DeliveryStatus),
      attempts: 0,
      last_error: null,
      next_attempt_at: new Date().toISOString(),
      delivered_at: null,
    })
    .eq('id', id)
    .select(
      'id, type, account_id, email_status, hook_status, attempts, last_error, created_at, delivered_at'
    )
    .maybeSingle();

  if (updateErr || !updated) {
    console.error(
      '[POST /api/platform/notifications/resend] update error:',
      updateErr
    );
    return NextResponse.json(
      { error: 'Failed to resend notification' },
      { status: 500 }
    );
  }

  await writePlatformAudit(db, {
    actor: consoleActorTag(ownerEmail),
    action: 'notification.resend',
    accountId: row.account_id as string | null,
    payload: { notificationId: id },
  });

  return NextResponse.json({ notification: updated });
}
