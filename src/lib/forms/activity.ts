// ============================================================
// Registro de atividade dos formulários (SPEC 085 §9; SPEC 075).
//
// Fininho de propósito: só monta a entrada e chama `recordActivity`
// (que nunca lança e grava com `supabaseAdmin()`). O que estes helpers
// garantem é o que o chamador esqueceria: o recurso certo (`form` /
// `contact`), o rótulo mascarado quando é telefone, `metadata` sem
// nada sensível.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { recordActivity, type ActivityActor } from '@/lib/activity/record';
import type { ActivityActionFor } from '@/lib/activity/types';
import { maskPhoneForLog } from '@/lib/phone/mask-for-log';

export type FormActivityAction = ActivityActionFor<'form'>;

export interface RecordFormActivityInput {
  accountId: string;
  action: FormActivityAction;
  form: { id: string; name: string };
  actor: ActivityActor;
  metadata?: Record<string, unknown>;
}

/** `form.created`, `form.published`, … — ator é quem clicou. */
export async function recordFormActivity(
  db: SupabaseClient,
  input: RecordFormActivityInput
): Promise<void> {
  await recordActivity(db, {
    accountId: input.accountId,
    action: input.action,
    resourceType: 'form',
    resourceId: input.form.id,
    resourceLabel: input.form.name,
    actor: input.actor,
    source: { table: 'forms', id: input.form.id },
    metadata: input.metadata,
  });
}

export interface RecordFormSubmittedInput {
  accountId: string;
  contactId: string;
  /** Telefone do contato; vai mascarado no rótulo (LGPD, SPEC 075 regra 3). */
  contactPhone: string | null;
  contactName?: string | null;
  formId: string;
  formName: string;
  responseId: string;
  score: number | null;
  bandKey: string | null;
}

/** `contact.form_submitted` — ator é o contato (PRD 084 §6.4). */
export async function recordFormSubmitted(
  db: SupabaseClient,
  input: RecordFormSubmittedInput
): Promise<void> {
  const label =
    input.contactName?.trim() ||
    (input.contactPhone ? maskPhoneForLog(input.contactPhone) : null);
  await recordActivity(db, {
    accountId: input.accountId,
    action: 'contact.form_submitted',
    resourceType: 'contact',
    resourceId: input.contactId,
    resourceLabel: label,
    actor: { kind: 'contact', contactId: input.contactId },
    contactId: input.contactId,
    source: { table: 'form_responses', id: input.responseId },
    metadata: {
      form_id: input.formId,
      form_name: input.formName,
      response_id: input.responseId,
      score: input.score,
      band_key: input.bandKey,
    },
  });
}
