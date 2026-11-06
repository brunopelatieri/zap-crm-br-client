// ============================================================
// Mapeamento resposta → contato (PRD 084 D-4; SPEC 085 §6 `apply-mapping.ts`).
//
// Só o que o owner MAPEOU chega ao contato: nome, e-mail, empresa, um
// campo personalizado (por ID, nunca por nome — SPEC 055 §2.2), uma
// etiqueta por opção, consentimento. Regras:
//   - `contact.*`: preenche se vazio por padrão; `overwrite` é por bloco;
//   - `custom:<id>`: `upsert` por `(contact_id, custom_field_id)`, igual
//     a `applyCustomValues` — nunca DELETE-then-INSERT; id que não é da
//     conta é pulado com aviso;
//   - `tag`: aditiva (SPEC 055 D-6), id que não é da conta é pulado;
//   - `contact.opt_in`: `set_contact_opt_in(…, 'opted_in', 'form')`, só
//     quando o bloco de consentimento foi marcado.
//
// Nunca lança: cada alvo falha sozinho e vira um aviso; a resposta já
// está gravada e o resto do envio segue.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { answerToText } from './snapshot';
import type { Answers, FormField } from './types';

export type MappingWarningCode =
  | 'custom_field_not_found'
  | 'tag_not_found'
  | 'contact_update_failed'
  | 'custom_values_failed'
  | 'tags_failed'
  | 'opt_in_failed';

export interface MappingWarning {
  code: MappingWarningCode;
  key: string;
  detail?: string;
}

export interface ApplyMappingsResult {
  /** Chaves de bloco cujo mapeamento foi aplicado. */
  applied: string[];
  warnings: MappingWarning[];
}

export interface ApplyMappingsInput {
  accountId: string;
  contactId: string;
  fields: readonly FormField[];
  /** Respostas já validadas e limpas (`validateAnswers`). */
  answers: Answers;
}

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;
type ContactPatch = Partial<Record<'name' | 'email' | 'company', string>>;

const CONTACT_COLUMNS = ['name', 'email', 'company'] as const;

export async function applyMappings(
  db: Db,
  input: ApplyMappingsInput
): Promise<ApplyMappingsResult> {
  const applied: string[] = [];
  const warnings: MappingWarning[] = [];

  const mapped = input.fields.filter(
    (f) => f.mapping && f.key in input.answers && f.type !== 'statement'
  );
  if (mapped.length === 0) return { applied, warnings };

  // --- contact.name / email / company -------------------------
  const contactTargets = mapped.filter((f) =>
    CONTACT_COLUMNS.some((c) => f.mapping!.target === `contact.${c}`)
  );
  if (contactTargets.length > 0) {
    try {
      const { data: contact, error } = await db
        .from('contacts')
        .select('name, email, company')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle();
      if (error || !contact)
        throw new Error(error?.message ?? 'contact not found');

      const patch: ContactPatch = {};
      for (const f of contactTargets) {
        const column = f.mapping!.target.slice(
          'contact.'.length
        ) as (typeof CONTACT_COLUMNS)[number];
        const value = answerToText(f, input.answers[f.key]).trim();
        if (!value) continue;
        const current = (contact as Record<string, unknown>)[column];
        const isEmpty =
          current === null ||
          current === undefined ||
          String(current).trim() === '';
        if (isEmpty || f.mapping!.overwrite === true) {
          patch[column] = value;
          applied.push(f.key);
        }
      }
      if (Object.keys(patch).length > 0) {
        const { error: upErr } = await db
          .from('contacts')
          .update(patch)
          .eq('id', input.contactId)
          .eq('account_id', input.accountId);
        if (upErr) throw new Error(upErr.message);
      }
    } catch (err) {
      for (const f of contactTargets) {
        warnings.push({
          code: 'contact_update_failed',
          key: f.key,
          detail: messageOf(err),
        });
      }
      // Desfaz o "applied" dos que dependiam deste UPDATE.
      for (const f of contactTargets) {
        const i = applied.indexOf(f.key);
        if (i !== -1) applied.splice(i, 1);
      }
    }
  }

  // --- custom:<id> -------------------------------------------
  const customTargets = mapped.filter((f) =>
    f.mapping!.target.startsWith('custom:')
  );
  if (customTargets.length > 0) {
    try {
      const wantedIds = customTargets.map((f) =>
        f.mapping!.target.slice('custom:'.length)
      );
      const { data: defs, error } = await db
        .from('custom_fields')
        .select('id')
        .eq('account_id', input.accountId)
        .in('id', wantedIds);
      if (error) throw new Error(error.message);
      const known = new Set((defs ?? []).map((d) => d.id as string));

      const rowsByFieldId = new Map<
        string,
        { contact_id: string; custom_field_id: string; value: string }
      >();
      for (const f of customTargets) {
        const id = f.mapping!.target.slice('custom:'.length);
        if (!known.has(id)) {
          warnings.push({
            code: 'custom_field_not_found',
            key: f.key,
            detail: id,
          });
          continue;
        }
        const value = answerToText(f, input.answers[f.key]);
        rowsByFieldId.set(id, {
          contact_id: input.contactId,
          custom_field_id: id,
          value,
        });
        applied.push(f.key);
      }
      const rows = [...rowsByFieldId.values()];
      if (rows.length > 0) {
        const { error: upErr } = await db
          .from('contact_custom_values')
          .upsert(rows, { onConflict: 'contact_id,custom_field_id' });
        if (upErr) throw new Error(upErr.message);
      }
    } catch (err) {
      for (const f of customTargets) {
        warnings.push({
          code: 'custom_values_failed',
          key: f.key,
          detail: messageOf(err),
        });
      }
    }
  }

  // --- tag (por opção, aditiva) -------------------------------
  const tagTargets = mapped.filter((f) => f.mapping!.target === 'tag');
  if (tagTargets.length > 0) {
    try {
      const wanted = new Map<string, string[]>(); // tag_id → keys
      for (const f of tagTargets) {
        const byOption = f.mapping!.tag_by_option ?? {};
        for (const optionId of selectedOptionIds(f, input.answers[f.key])) {
          const tagId = byOption[optionId];
          if (!tagId) continue;
          const keys = wanted.get(tagId) ?? [];
          keys.push(f.key);
          wanted.set(tagId, keys);
        }
      }
      if (wanted.size > 0) {
        const { data: tags, error } = await db
          .from('tags')
          .select('id')
          .eq('account_id', input.accountId)
          .in('id', [...wanted.keys()]);
        if (error) throw new Error(error.message);
        const known = new Set((tags ?? []).map((t) => t.id as string));
        const rows: { contact_id: string; tag_id: string }[] = [];
        for (const [tagId, keys] of wanted) {
          if (!known.has(tagId)) {
            for (const key of keys)
              warnings.push({ code: 'tag_not_found', key, detail: tagId });
            continue;
          }
          rows.push({ contact_id: input.contactId, tag_id: tagId });
          for (const key of keys) if (!applied.includes(key)) applied.push(key);
        }
        if (rows.length > 0) {
          const { error: upErr } = await db.from('contact_tags').upsert(rows, {
            onConflict: 'contact_id,tag_id',
            ignoreDuplicates: true,
          });
          if (upErr) throw new Error(upErr.message);
        }
      }
    } catch (err) {
      for (const f of tagTargets) {
        warnings.push({
          code: 'tags_failed',
          key: f.key,
          detail: messageOf(err),
        });
      }
    }
  }

  // --- contact.opt_in ----------------------------------------
  const consentTargets = mapped.filter(
    (f) =>
      f.mapping!.target === 'contact.opt_in' && input.answers[f.key] === true
  );
  for (const f of consentTargets) {
    try {
      const { error } = await db.rpc('set_contact_opt_in', {
        p_contact_id: input.contactId,
        p_status: 'opted_in',
        p_source: 'form',
      });
      if (error) throw new Error(error.message);
      applied.push(f.key);
    } catch (err) {
      warnings.push({
        code: 'opt_in_failed',
        key: f.key,
        detail: messageOf(err),
      });
    }
  }

  return { applied, warnings };
}

/** Ids das opções escolhidas num bloco de escolha (yes_no → `yes`/`no`). */
export function selectedOptionIds(
  field: Pick<FormField, 'type'>,
  value: unknown
): string[] {
  switch (field.type) {
    case 'single_select':
    case 'dropdown':
      return typeof value === 'string' ? [value] : [];
    case 'multi_select':
      return Array.isArray(value)
        ? (value as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
    case 'yes_no':
      if (value === true || value === 'yes') return ['yes'];
      if (value === false || value === 'no') return ['no'];
      return [];
    default:
      return [];
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
