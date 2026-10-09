/**
 * Editar nome/e-mail de um usuário pelo console (SPEC 078 §5, §8, §8.1).
 *
 * Server-only. Junta as guardas puras (`user-identity.ts`), a escrita
 * (`user-identity-actions.ts`) e os efeitos: `platform_audit_log` com os
 * valores antigos e novos, e o registro de atividade do cliente — este
 * SEM os endereços de e-mail, só quais campos mudaram (§8.1).
 *
 * Trocou o e-mail → avisa o endereço ANTIGO (§5.5, D-11), nos dois
 * desfechos em que o login realmente mudou (sucesso e `partial_update`).
 * O aviso é melhor esforço: o desfecho (`sent`/`skipped`/`failed`) vai
 * para a auditoria e para a resposta, mas nunca falha a troca.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { recordActivity } from '@/lib/activity/record';
import { normalizeEmail } from '@/lib/auth/email';
import { deliverEmailChangeNotice } from '@/lib/mailer/send';

import { consoleActorTag, writePlatformAudit } from './audit';
import { fail, parseReason, type ConsoleResult } from './console-result';
import { parseOwnerEmails } from './owner';
import { canEditUserIdentity, validateFullName } from './user-identity';
import { updateUserIdentity } from './user-identity-actions';

export interface EditUserIdentityInput {
  userId: string;
  ownerEmail: string;
  body: { fullName?: unknown; email?: unknown; reason?: unknown } | null;
  /** `PLATFORM_OWNER_EMAILS` já separada; padrão lê o `.env`. */
  ownerEmails?: readonly string[];
}

export interface UserIdentityEdited {
  /** Campos que de fato mudaram: `'email'` e/ou `'fullName'`. */
  fields: ('email' | 'fullName')[];
  /**
   * Desfecho do aviso ao e-mail antigo: `null` quando o e-mail não
   * mudou; `skipped` = SMTP desligado (não é erro).
   */
  oldEmailNotice: OldEmailNotice;
}

export type OldEmailNotice = 'sent' | 'skipped' | 'failed' | null;

const GUARD_MESSAGES: Record<string, string> = {
  email_invalid: "'email' is not a valid e-mail address",
  email_unchanged: "'email' is the same as the current one",
  cannot_edit_platform_owner_email:
    'The platform owner e-mail cannot be changed here; update PLATFORM_OWNER_EMAILS first',
  email_reserved_for_platform_owner:
    'This e-mail is reserved for the platform owner',
};

interface TargetProfile {
  user_id: string;
  account_id: string | null;
  full_name: string;
  email: string;
}

export async function editUserIdentity(
  db: SupabaseClient,
  input: EditUserIdentityInput
): Promise<ConsoleResult<UserIdentityEdited>> {
  const { userId, ownerEmail, body } = input;
  if (!body) return fail(400, 'invalid_body', 'Invalid request body');

  const wantsName = body.fullName !== undefined && body.fullName !== null;
  const wantsEmail = body.email !== undefined && body.email !== null;
  if (!wantsName && !wantsEmail) {
    return fail(400, 'no_changes', "Provide 'fullName' and/or 'email'");
  }

  const { data, error: readErr } = await db
    .from('profiles')
    .select('user_id, account_id, full_name, email')
    .eq('user_id', userId)
    .maybeSingle();
  if (readErr) {
    console.error(
      '[platform/user-identity-console] profile read failed:',
      readErr.message
    );
    return fail(500, 'read_failed', 'Failed to load the user');
  }
  const target = data as TargetProfile | null;
  if (!target) return fail(404, 'user_not_found', 'User not found');

  // Nome: validado sempre que veio; só escreve se mudou de verdade.
  let nextName: string | null = null;
  if (wantsName) {
    const name = validateFullName(body.fullName);
    if (!name.ok) {
      return fail(
        400,
        name.code,
        "'fullName' must be 1-120 characters without control characters"
      );
    }
    if (name.value !== target.full_name) nextName = name.value;
  }

  // E-mail: as guardas rodam sempre que veio — inclusive `email_unchanged`
  // (a UI manda só o que mudou) e as do proprietário da plataforma.
  let nextEmail: string | null = null;
  if (wantsEmail) {
    const guard = canEditUserIdentity({
      ownerEmails:
        input.ownerEmails ??
        parseOwnerEmails(process.env.PLATFORM_OWNER_EMAILS),
      targetCurrentEmail: target.email,
      nextEmail: typeof body.email === 'string' ? body.email : '',
    });
    if (!guard.ok) {
      return fail(400, guard.code, GUARD_MESSAGES[guard.code]);
    }
    nextEmail = guard.email;
  }

  // Nome igual ao atual e nada mais a fazer: não grava, não audita.
  if (nextName === null && nextEmail === null) {
    return fail(400, 'no_changes', 'Nothing to change');
  }

  const actor = consoleActorTag(ownerEmail);
  const reason = parseReason(body.reason);
  const result = await updateUserIdentity(db, {
    userId,
    fullName: nextName,
    email: nextEmail,
  });

  const fields: ('email' | 'fullName')[] = [];

  if (!result.ok) {
    if (result.error === 'partial_update') {
      // O e-mail JÁ mudou: o rastro precisa dizer isso, senão a
      // auditoria afirmaria que nada aconteceu com um login que mudou.
      const notice = await noticeOldEmail(target.email);
      await auditEdit(db, actor, target, {
        fields: ['email'],
        nextEmail,
        nextName: null,
        reason,
        partial: true,
        notice,
      });
      // O login MUDOU: o cliente também precisa ver isso em /activity.
      recordProfileActivity(db, target, userId, ['email'], null);
      return fail(
        500,
        'partial_update',
        'The e-mail was updated but the name was not',
        { emailUpdated: true, oldEmailNotice: notice }
      );
    }
    switch (result.error) {
      case 'email_taken':
        return fail(409, 'email_taken', 'This e-mail is already in use');
      case 'user_not_found':
        return fail(404, 'user_not_found', 'User not found');
      case 'no_changes':
        return fail(400, 'no_changes', 'Nothing to change');
      default:
        return fail(500, 'update_failed', 'Failed to update the user');
    }
  }

  if (result.emailUpdated) fields.push('email');
  if (result.nameUpdated) fields.push('fullName');

  const notice = result.emailUpdated
    ? await noticeOldEmail(target.email)
    : null;

  await auditEdit(db, actor, target, {
    fields,
    nextEmail,
    nextName,
    reason,
    partial: false,
    notice,
  });

  recordProfileActivity(db, target, userId, fields, nextName);

  return { ok: true, data: { fields, oldEmailNotice: notice } };
}

/**
 * O que o CLIENTE vê em `/activity` (§8.1). Só quais campos mudaram —
 * nunca os endereços. Fire-and-forget, como as demais atividades.
 */
function recordProfileActivity(
  db: SupabaseClient,
  target: TargetProfile,
  userId: string,
  fields: ('email' | 'fullName')[],
  nextName: string | null
): void {
  if (!target.account_id) return;
  void recordActivity(db, {
    accountId: target.account_id,
    resourceType: 'member',
    action: 'member.profile_updated',
    actor: { kind: 'system', name: 'platform' },
    resourceId: userId,
    resourceLabel: nextName ?? target.full_name,
    metadata: { fields },
  });
}

/** Nunca lança: `deliverEmailChangeNotice` já converte falha em `ok: false`. */
async function noticeOldEmail(
  oldEmail: string
): Promise<Exclude<OldEmailNotice, null>> {
  const outcome = await deliverEmailChangeNotice(oldEmail);
  if (outcome.skipped) return 'skipped';
  if (outcome.ok) return 'sent';
  console.error(
    '[platform/user-identity-console] old-address notice failed:',
    outcome.error
  );
  return 'failed';
}

async function auditEdit(
  db: SupabaseClient,
  actor: string,
  target: TargetProfile,
  detail: {
    fields: ('email' | 'fullName')[];
    nextEmail: string | null;
    nextName: string | null;
    reason: string | null;
    partial: boolean;
    notice: OldEmailNotice;
  }
): Promise<void> {
  await writePlatformAudit(db, {
    actor,
    action: 'user.profile_update',
    accountId: target.account_id,
    targetUserId: target.user_id,
    payload: {
      fields: detail.fields,
      previousEmail: detail.nextEmail ? normalizeEmail(target.email) : null,
      newEmail: detail.nextEmail,
      previousName: detail.nextName !== null ? target.full_name : null,
      newName: detail.nextName,
      reason: detail.reason,
      ...(detail.notice !== null && { oldEmailNotice: detail.notice }),
      ...(detail.partial && { partial: true }),
    },
  });
}
