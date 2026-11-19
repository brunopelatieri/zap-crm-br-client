// ============================================================
// GET/POST /api/forms — SPEC 085 §7.1
//
//   GET  viewer+  Lista com contadores (uma RPC agregada) + uso de quota.
//                 ÚNICA rota do grupo que responde 200 sem o item no plano
//                 (`featureInPlan: false`, lista vazia) — a página mostra o
//                 aviso "não incluído no seu plano" (PRD 084 D-11).
//   POST admin+   Cria de um modelo. `QUOTA_EXCEEDED:forms` (trigger 098)
//                 vira 409 `{ error: 'QUOTA_EXCEEDED', metric, used, limit }`.
// ============================================================

import { NextResponse } from 'next/server';

import { recordFormActivity } from '@/lib/forms/activity';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getAccountPlan } from '@/lib/plans/account-plan';
import type { PlanUsageBucket } from '@/lib/plans/types';
import {
  dbErrorResponse,
  insertFormWithSlug,
  jsonError,
  replaceFields,
  requireFormsRole,
} from '@/lib/forms/account-api';
import { parseCreateBody } from '@/lib/forms/account-input';
import { hasFormsFeature } from '@/lib/forms/plan-gate';
import { checkFormsAvailableQuota } from '@/lib/forms/quota';
import { buildFormTemplate } from '@/lib/forms/templates';
import type { Form } from '@/lib/forms/types';

const FORM_QUOTA_KEYS = ['forms', 'form_responses_month', 'form_upload_mb'];

interface StatsRow {
  form_id: string;
  started_count: number | string;
  completed_count: number | string;
  completed_month: number | string;
  last_response_at: string | null;
}

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    if (!(await hasFormsFeature(ctx.accountId))) {
      return NextResponse.json({
        featureInPlan: false,
        forms: [],
        usage: [],
        canCreate: false,
      });
    }

    const [formsRes, statsRes] = await Promise.all([
      ctx.supabase
        .from('forms')
        .select(
          'id, name, slug, status, locale, published_at, archived_at, created_at, updated_at'
        )
        .eq('account_id', ctx.accountId)
        .order('updated_at', { ascending: false }),
      ctx.supabase.rpc('forms_list_stats', { p_account_id: ctx.accountId }),
    ]);
    if (formsRes.error) return dbErrorResponse(formsRes.error, 'list');
    // Sem as estatísticas a lista ainda serve (zeros) — só registra.
    if (statsRes.error) {
      console.error('[forms] forms_list_stats failed:', statsRes.error.code);
    }

    const stats = new Map<string, StatsRow>(
      ((statsRes.data ?? []) as StatsRow[]).map((r) => [r.form_id, r])
    );
    const forms = (formsRes.data ?? []).map((f) => {
      const s = stats.get(f.id as string);
      const started = Number(s?.started_count ?? 0);
      const completed = Number(s?.completed_count ?? 0);
      return {
        ...f,
        started_count: started,
        completed_count: completed,
        completed_month: Number(s?.completed_month ?? 0),
        completion_rate: started > 0 ? completed / started : null,
        last_response_at: s?.last_response_at ?? null,
      };
    });

    let usage: PlanUsageBucket[] = [];
    let canCreate = true;
    try {
      const snapshot = await getAccountPlan(ctx.accountId, ctx.supabase);
      usage = snapshot.usage.buckets.filter((b) =>
        FORM_QUOTA_KEYS.includes(b.key)
      );
      canCreate = checkFormsAvailableQuota(snapshot.usage).available;
    } catch (err) {
      // Sem snapshot: o medidor some; a trigger continua decidindo.
      console.error('[forms] plan snapshot failed:', (err as Error).message);
    }

    return NextResponse.json({
      featureInPlan: true,
      forms,
      usage,
      canCreate,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireFormsRole('admin');
    const parsed = parseCreateBody(await request.json().catch(() => null));
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { template: templateId, locale, name } = parsed.value;

    const template = buildFormTemplate(templateId, locale);

    // Slugs da própria conta (a sessão não enxerga os das outras).
    const { data: own } = await ctx.supabase
      .from('forms')
      .select('slug')
      .eq('account_id', ctx.accountId);
    const ownSlugs = (own ?? []).map((r) => r.slug as string);

    let form: Form;
    try {
      form = await insertFormWithSlug(
        ctx.supabase,
        { accountId: ctx.accountId, userId: ctx.userId },
        {
          name: name ?? template.name,
          locale,
          description: template.description,
          theme: template.theme,
          settings: template.settings,
          scoring: template.bands.length ? { bands: template.bands } : {},
          portal_visibility: 'none',
          ai_offerable: false,
          ai_offer_hint: null,
        },
        ownSlugs
      );
    } catch (err) {
      return dbErrorResponse(err, 'create');
    }

    let fields;
    try {
      fields = await replaceFields(ctx.supabase, form.id, template.fields);
    } catch (err) {
      // Formulário sem blocos não serve: desfaz o INSERT (melhor esforço).
      await ctx.supabase.from('forms').delete().eq('id', form.id);
      return dbErrorResponse(err, 'create fields');
    }

    void recordFormActivity(ctx.supabase, {
      accountId: ctx.accountId,
      action: 'form.created',
      form: { id: form.id, name: form.name },
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
      metadata: { template: templateId },
    });

    return NextResponse.json({ form, fields }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
