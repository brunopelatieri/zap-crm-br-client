// ============================================================
// Ações da faixa (PRD 084 D-5; SPEC 085 §6 `apply-band.ts`).
//
// Determinísticas e isoladas: etiquetas, negócio no funil (`createDeal`),
// atribuição (`specific` entre membros atribuíveis, ou `round_robin`) e
// notificação in-app (`form_response_received`, migração 098). A falha
// de uma não impede as outras e NADA aqui lança: a resposta já está
// gravada; o que não deu certo vira `warnings` para o log da rota.
//
// `db` é service-role (rota pública): por isso cada id de etiqueta,
// funil, etapa e usuário é conferido CONTRA A CONTA antes de ser usado —
// o JSON de `scoring` foi escrito pelo admin, mas um id de outra conta
// não pode virar escrita cruzada por engano.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ASSIGNABLE_ACCOUNT_ROLES } from '@/lib/auth/roles';
import { isAssignableMember } from '@/lib/inbox/assignment';
import { createDeal } from '@/lib/pipelines/deals';

import type { Band } from './types';

export const DEFAULT_DEAL_TITLE_TEMPLATE = '{{contact.name}} — {{form.name}}';

export interface ApplyBandInput {
  band: Band;
  accountId: string;
  contactId: string;
  formId: string;
  formName: string;
  responseId: string;
  /** Nome atual do contato (para o título do negócio); `null` usa o telefone. */
  contactName: string | null;
  contactPhone: string | null;
  /** `user_id` de auditoria (dono da conta) para o negócio. */
  auditUserId: string;
  currency?: string;
  /**
   * Título e corpo da notificação, já traduzidos pela rota (a F1 não
   * cria o namespace `Notifications.formResponseReceived`).
   */
  notification?: { title: string; body?: string | null };
}

export interface ApplyBandResult {
  tagsApplied: string[];
  dealId: string | null;
  assignedTo: string | null;
  notified: string[];
  warnings: { action: 'tags' | 'deal' | 'assign' | 'notify'; detail: string }[];
}

type Db = SupabaseClient;

export async function applyBandActions(
  db: Db,
  input: ApplyBandInput
): Promise<ApplyBandResult> {
  const result: ApplyBandResult = {
    tagsApplied: [],
    dealId: null,
    assignedTo: null,
    notified: [],
    warnings: [],
  };
  const actions = input.band.actions ?? {};

  // --- Etiquetas (aditivas) ----------------------------------
  if (actions.tag_ids?.length) {
    try {
      const { data: tags, error } = await db
        .from('tags')
        .select('id')
        .eq('account_id', input.accountId)
        .in('id', actions.tag_ids);
      if (error) throw new Error(error.message);
      const ids = (tags ?? []).map((t) => t.id as string);
      if (ids.length > 0) {
        const { error: upErr } = await db.from('contact_tags').upsert(
          ids.map((tag_id) => ({ contact_id: input.contactId, tag_id })),
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
        );
        if (upErr) throw new Error(upErr.message);
        result.tagsApplied = ids;
      }
      const missing = actions.tag_ids.filter((id) => !ids.includes(id));
      if (missing.length) {
        result.warnings.push({
          action: 'tags',
          detail: `unknown tag ids: ${missing.join(',')}`,
        });
      }
    } catch (err) {
      result.warnings.push({ action: 'tags', detail: messageOf(err) });
    }
  }

  // --- Negócio + atribuição ----------------------------------
  if (actions.deal?.pipeline_id && actions.deal.stage_id) {
    try {
      const { data: stage, error } = await db
        .from('pipeline_stages')
        .select('id, pipeline_id, pipelines!inner(account_id)')
        .eq('id', actions.deal.stage_id)
        .eq('pipeline_id', actions.deal.pipeline_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const stageAccount = (
        stage as {
          pipelines?: { account_id?: string } | { account_id?: string }[];
        } | null
      )?.pipelines;
      const stageAccountId = Array.isArray(stageAccount)
        ? stageAccount[0]?.account_id
        : stageAccount?.account_id;
      if (!stage || stageAccountId !== input.accountId) {
        throw new Error('stage not found in this account');
      }

      let assignedTo: string | null = null;
      const assign = actions.deal.assign;
      if (assign?.mode === 'specific' && assign.user_id) {
        if (await isAssignableMember(db, input.accountId, assign.user_id)) {
          assignedTo = assign.user_id;
        } else {
          result.warnings.push({
            action: 'assign',
            detail: 'user is not an assignable member',
          });
        }
      } else if (assign?.mode === 'round_robin') {
        assignedTo = await pickRoundRobin(db, input.accountId, input.formId);
        if (!assignedTo) {
          result.warnings.push({
            action: 'assign',
            detail: 'no assignable members',
          });
        }
      }

      const deal = await createDeal(db, {
        userId: input.auditUserId,
        accountId: input.accountId,
        pipelineId: actions.deal.pipeline_id,
        stageId: actions.deal.stage_id,
        contactId: input.contactId,
        title: renderDealTitle(actions.deal.title_template, {
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          formName: input.formName,
          bandLabel: input.band.label,
        }),
        currency: input.currency ?? 'BRL',
        assignedTo,
      });
      result.dealId = deal.id;
      result.assignedTo = assignedTo;
    } catch (err) {
      result.warnings.push({ action: 'deal', detail: messageOf(err) });
    }
  }

  // --- Notificação in-app ------------------------------------
  if (actions.notify_user_ids?.length && input.notification) {
    try {
      const { data: members, error } = await db
        .from('profiles')
        .select('user_id')
        .eq('account_id', input.accountId)
        .in('user_id', actions.notify_user_ids);
      if (error) throw new Error(error.message);
      const ids = (members ?? []).map((m) => m.user_id as string);
      if (ids.length > 0) {
        const { error: insErr } = await db.from('notifications').insert(
          ids.map((user_id) => ({
            account_id: input.accountId,
            user_id,
            type: 'form_response_received',
            contact_id: input.contactId,
            form_id: input.formId,
            form_response_id: input.responseId,
            actor_user_id: null,
            title: input.notification!.title.slice(0, 200),
            body: input.notification!.body ?? null,
          }))
        );
        if (insErr) throw new Error(insErr.message);
        result.notified = ids;
      }
    } catch (err) {
      result.warnings.push({ action: 'notify', detail: messageOf(err) });
    }
  }

  return result;
}

/**
 * `{{contact.name}} — {{form.name}}` (+ `{{band.label}}`, `{{contact.phone}}`).
 * Nome vazio cai no telefone; tudo vazio cai no nome do formulário.
 */
export function renderDealTitle(
  template: string | undefined,
  vars: {
    contactName: string | null;
    contactPhone: string | null;
    formName: string;
    bandLabel: string;
  }
): string {
  const tpl =
    template && template.trim() ? template : DEFAULT_DEAL_TITLE_TEMPLATE;
  const name = vars.contactName?.trim() || vars.contactPhone || '';
  const out = tpl
    .replace(/\{\{\s*contact\.name\s*\}\}/g, name)
    .replace(/\{\{\s*contact\.phone\s*\}\}/g, vars.contactPhone ?? '')
    .replace(/\{\{\s*form\.name\s*\}\}/g, vars.formName)
    .replace(/\{\{\s*band\.label\s*\}\}/g, vars.bandLabel)
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (out || vars.formName).slice(0, 200);
}

/**
 * Rodízio entre membros atribuíveis (owner/admin/agent), ordenados por
 * `user_id` para a ordem ser estável; o índice é a contagem de negócios
 * já criados pelo formulário (metadado em `deals.notes` não existe, então
 * conta-se as respostas concluídas do formulário).
 */
async function pickRoundRobin(
  db: Db,
  accountId: string,
  formId: string
): Promise<string | null> {
  const { data: members, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ASSIGNABLE_ACCOUNT_ROLES)
    .order('user_id');
  if (error || !members?.length) return null;

  const { count } = await db
    .from('form_responses')
    .select('id', { count: 'exact', head: true })
    .eq('form_id', formId)
    .eq('status', 'completed');

  const idx = Math.max(0, (count ?? 1) - 1) % members.length;
  return (members[idx].user_id as string) ?? null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
