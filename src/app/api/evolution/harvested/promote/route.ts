import { after, NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { parseQuotaError } from '@/lib/plans/errors';
import { emitQuotaExceeded } from '@/lib/notifications/quota';
import { readEvolutionConfig } from '@/lib/evolution/config';
import { fetchAndAttachAvatar } from '@/lib/evolution/avatar';
import { resolveKey } from '@/lib/limits/resolve';
import { decrypt } from '@/lib/whatsapp/encryption';

/**
 * POST /api/evolution/harvested/promote (admin+) — SPEC 069 §6.5, D-3.
 *
 * A promoção é o ato afirmativo que o PRD 068 §3 pede: um humano
 * decide, um por um (a rota processa a LISTA sequencialmente, não em
 * lote no banco), que aquele contato da agenda vira lead de verdade.
 * `opt_in_status: 'unknown'` sempre — ninguém consentiu com nada só
 * por estar na agenda do dono do número.
 *
 * Parcial é o resultado ESPERADO, não uma falha da rota
 *
 *   Cota de contatos estourando no meio de uma promoção em lote é
 *   exatamente o cenário que a triagem existe para tornar visível — com
 *   alguém na tela vendo o erro, ao contrário do harvest de madrugada.
 *   Por isso cada id é uma tentativa independente: uma quota estourada
 *   no id 30 de 50 não desfaz os 29 anteriores nem impede os 20
 *   seguintes de serem tentados (podem ter sido promovidos por outro
 *   admin nesse meio-tempo e já não contarem contra a quota, ou a quota
 *   pode ter sido a mesma para todos — de qualquer forma, a rota não
 *   assume).
 *
 * Contato sem telefone (Jid `@lid` puro) não pode ser promovido
 *
 *   `contacts.phone` é `NOT NULL` desde a migração 001, e um Jid
 *   `@lid` sem contraparte de telefone conhecida não tem o que colocar
 *   ali. Reportado como `no_phone_number` — não é erro do operador,
 *   é uma pessoa cuja agenda do WhatsApp nunca revelou o número dela
 *   (o LID existe justamente para isso).
 *
 * Avatar: busca em BACKGROUND depois da resposta (`after()`)
 *
 *   Harvest não busca avatar (ver a nota em
 *   `app/api/contacts/harvest/cron/route.ts`); esta rota busca, mas
 *   DEPOIS de responder — `/user/avatar` pode demorar (D-14 #6), e o
 *   admin promovendo 50 contatos não deveria esperar 50 consultas ao
 *   vivo para ver a tela confirmar.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const { ids } = body as { ids?: unknown };
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => typeof id === 'string' && id)
    ) {
      return NextResponse.json(
        { error: 'ids must be a non-empty array of strings' },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();

    const { data: harvestedRows, error: fetchError } = await admin
      .from('evolution_harvested_contacts')
      .select(
        'id, channel_id, jid, phone_normalized, push_name, full_name, business_name'
      )
      .eq('account_id', accountId)
      .eq('status', 'new')
      .in('id', ids);

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    const found = new Map(
      (harvestedRows ?? []).map((r) => [r.id as string, r])
    );
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      if (!found.has(id))
        skipped.push({ id, reason: 'not_found_or_already_processed' });
    }

    const blocked: Array<{ id: string; reason: string }> = [];
    let promoted = 0;
    const avatarTasks: Array<{
      contactId: string;
      channelId: string;
      phoneNormalized: string;
    }> = [];

    for (const row of found.values()) {
      const phone = row.phone_normalized as string | null;
      if (!phone) {
        blocked.push({ id: row.id as string, reason: 'no_phone_number' });
        continue;
      }

      const existing = await findExistingContact(admin, accountId, phone);
      if (existing) {
        // Já é contato — a triagem só estava desatualizada (contato
        // criado por outro caminho depois da captação). Vincula em vez
        // de tentar recriar.
        await admin
          .from('evolution_harvested_contacts')
          .update({
            status: 'duplicate',
            promoted_contact_id: existing.id,
            promoted_by: userId,
            promoted_at: new Date().toISOString(),
          })
          .eq('id', row.id);
        continue;
      }

      const name =
        (row.full_name as string | null) ||
        (row.push_name as string | null) ||
        (row.business_name as string | null) ||
        null;

      const { data: created, error: insertError } = await admin
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: userId,
          phone,
          name,
          opt_in_status: 'unknown',
          created_via: 'harvest',
        })
        .select('id')
        .single();

      if (insertError || !created) {
        if (isUniqueViolation(insertError)) {
          const raced = await findExistingContact(admin, accountId, phone);
          if (raced) {
            await admin
              .from('evolution_harvested_contacts')
              .update({
                status: 'duplicate',
                promoted_contact_id: raced.id,
                promoted_by: userId,
                promoted_at: new Date().toISOString(),
              })
              .eq('id', row.id);
            continue;
          }
        }
        const quotaError = parseQuotaError(insertError);
        if (quotaError && quotaError.metric === 'contacts') {
          emitQuotaExceeded(accountId, quotaError);
          blocked.push({ id: row.id as string, reason: 'quota_exceeded' });
          continue;
        }
        console.error(
          '[harvested/promote] contact insert failed:',
          insertError
        );
        blocked.push({ id: row.id as string, reason: 'insert_failed' });
        continue;
      }

      // Best-effort: mesmo vínculo que o backfill reativo grava
      // (contact-identity.ts) — aqui já sabemos o Jid, sem precisar de
      // /user/check.
      await admin.from('contact_identities').upsert(
        {
          account_id: accountId,
          contact_id: created.id,
          channel_type: 'whatsapp_qr',
          external_id: row.jid,
        },
        { onConflict: 'account_id,channel_type,external_id' }
      );

      await admin
        .from('evolution_harvested_contacts')
        .update({
          status: 'promoted',
          promoted_contact_id: created.id,
          promoted_by: userId,
          promoted_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      promoted++;
      avatarTasks.push({
        contactId: created.id as string,
        channelId: row.channel_id as string,
        phoneNormalized: phone,
      });
    }

    if (avatarTasks.length > 0) {
      after(() => fetchAvatarsInBackground(accountId, avatarTasks));
    }

    return NextResponse.json({ promoted, blocked, skipped });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Roda depois da resposta HTTP (`after()`). Uma instância por canal —
 * memoizada aqui porque vários contatos promovidos juntos costumam vir
 * do MESMO canal de origem, e resolver o token de novo por contato
 * seria round-trip repetido à toa.
 */
async function fetchAvatarsInBackground(
  accountId: string,
  tasks: Array<{
    contactId: string;
    channelId: string;
    phoneNormalized: string;
  }>
): Promise<void> {
  const config = readEvolutionConfig();
  if (!config) return;

  const admin = supabaseAdmin();
  const tokenCache = new Map<string, string | null>();

  const timeoutMs = resolveKey('evolution_info_avatar_timeout_ms', {
    env: process.env,
  }).value;
  const maxBytes = resolveKey('evolution_avatar_max_bytes', {
    env: process.env,
  }).value;

  for (const task of tasks) {
    let token = tokenCache.get(task.channelId);
    if (token === undefined) {
      token = await resolveInstanceTokenByChannel(admin, task.channelId);
      tokenCache.set(task.channelId, token);
    }
    if (!token) continue;

    await fetchAndAttachAvatar(admin, config, {
      accountId,
      contactId: task.contactId,
      phoneNormalized: task.phoneNormalized,
      instanceToken: token,
      timeoutMs,
      maxBytes,
    });
  }
}

async function resolveInstanceTokenByChannel(
  db: ReturnType<typeof supabaseAdmin>,
  channelId: string
): Promise<string | null> {
  const { data: instance } = await db
    .from('evolution_instances')
    .select('id')
    .eq('channel_id', channelId)
    .maybeSingle();
  if (!instance) return null;

  const { data: secret } = await db
    .from('evolution_instance_secrets')
    .select('instance_token_encrypted')
    .eq('instance_id', instance.id as string)
    .maybeSingle();
  if (!secret) return null;

  return decrypt(secret.instance_token_encrypted as string);
}
