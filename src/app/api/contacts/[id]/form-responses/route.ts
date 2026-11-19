// ============================================================
// GET /api/contacts/[id]/form-responses — SPEC 085 §7.1 (viewer+)
//
// Respostas de formulário do contato, de TODOS os formulários, para a
// aba `forms` da ficha e o cartão "Formulários" do inbox. `requireRole`
// e depois `requireFormsFeature` (conta sem o item recebe 403
// `FEATURE_NOT_IN_PLAN`; a UI some com a aba/cartão).
//
//   ?status=completed,partial   (padrão: `completed`)
//   ?limit=1..50                 (padrão 20)
//
// `fieldOrders` (`form_id → chaves por posição`) existe porque o JSONB do
// instantâneo não guarda a ordem dos blocos.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  dbErrorResponse,
  isUuidParam,
  jsonError,
  requireFormsRole,
} from '@/lib/forms/account-api';
import { RESPONSE_COLUMNS } from '@/lib/forms/responses-query';
import type { ResponseStatus } from '@/lib/forms/types';

type Ctx = { params: Promise<{ id: string }> };

const STATUSES: readonly ResponseStatus[] = [
  'partial',
  'completed',
  'abandoned',
];

export async function GET(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('viewer');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const url = new URL(request.url);
    const rawStatus = url.searchParams.get('status') ?? 'completed';
    const statuses = rawStatus.split(',');
    if (statuses.some((s) => !(STATUSES as readonly string[]).includes(s))) {
      return jsonError('Invalid filter', 400, { field: 'status' });
    }
    const rawLimit = url.searchParams.get('limit');
    let limit = 20;
    if (rawLimit !== null) {
      if (
        !/^\d{1,3}$/.test(rawLimit) ||
        Number(rawLimit) < 1 ||
        Number(rawLimit) > 50
      ) {
        return jsonError('Invalid filter', 400, { field: 'limit' });
      }
      limit = Number(rawLimit);
    }

    const { data, error } = await ctx.supabase
      .from('form_responses')
      .select(`${RESPONSE_COLUMNS}, forms(id, name, slug), deals(id, title)`)
      .eq('contact_id', id)
      .eq('account_id', ctx.accountId)
      .in('status', statuses)
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (error) return dbErrorResponse(error, 'contact form responses');

    const responses = (data ?? []) as unknown as { form_id: string }[];
    const formIds = [...new Set(responses.map((r) => r.form_id))];
    const fieldOrders: Record<string, string[]> = {};
    if (formIds.length > 0) {
      const { data: fields, error: fieldsError } = await ctx.supabase
        .from('form_fields')
        .select('form_id, key, position')
        .in('form_id', formIds)
        .order('position', { ascending: true });
      if (fieldsError)
        return dbErrorResponse(fieldsError, 'contact form fields');
      for (const f of (fields ?? []) as { form_id: string; key: string }[]) {
        (fieldOrders[f.form_id] ??= []).push(f.key);
      }
    }

    return NextResponse.json({ responses, fieldOrders });
  } catch (err) {
    return toErrorResponse(err);
  }
}
