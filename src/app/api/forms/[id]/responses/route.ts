// ============================================================
// GET /api/forms/[id]/responses — SPEC 085 §7.1 (viewer+)
//
// Paginação NO SERVIDOR, filtros por status, faixa, período, origem e
// "bloco X = valor" (`@>` na GIN de `answers`), busca por nome/telefone
// do contato. Client de SESSÃO: a RLS (`is_account_member`) decide o que
// a conta enxerga; nunca devolve hash, IP nem user agent.
//
// Resposta: `{ responses, total, page, pageSize, form, fields, bands }`.
// `fields` e `bands` alimentam as colunas e os filtros da tela sem uma
// segunda ida ao servidor.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  dbErrorResponse,
  isUuidParam,
  jsonError,
  loadFields,
  loadForm,
  requireFormsRole,
} from '@/lib/forms/account-api';
import {
  RESPONSE_COLUMNS,
  applyFilterOps,
  buildBlockContainment,
  needsInnerContactJoin,
  pageRange,
  parseResponsesFilter,
  planResponsesFilter,
} from '@/lib/forms/responses-query';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('viewer');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const parsed = parseResponsesFilter(new URL(request.url).searchParams);
    if (!parsed.ok) {
      return jsonError('Invalid filter', 400, { field: parsed.reason });
    }
    const filter = parsed.filter;

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);
    const fields = await loadFields(ctx.supabase, id);

    let containment: Record<string, unknown> | null = null;
    if (filter.block) {
      containment = buildBlockContainment(
        fields.find((f) => f.key === filter.block!.key),
        filter.block.value
      );
      if (!containment)
        return jsonError('Invalid filter', 400, { field: 'block' });
    }

    const contactJoin = needsInnerContactJoin(filter)
      ? 'contacts!inner(id, name, phone)'
      : 'contacts(id, name, phone)';
    const { from, to } = pageRange(filter);

    let query = ctx.supabase
      .from('form_responses')
      .select(`${RESPONSE_COLUMNS}, ${contactJoin}, deals(id, title)`, {
        count: 'exact',
      })
      .eq('form_id', id)
      .eq('account_id', ctx.accountId);
    query = applyFilterOps(query, planResponsesFilter(filter, containment));

    const { data, error, count } = await query
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
    if (error) return dbErrorResponse(error, 'responses list');

    return NextResponse.json({
      responses: data ?? [],
      total: count ?? 0,
      page: filter.page,
      pageSize: filter.pageSize,
      form: {
        id: form.id,
        name: form.name,
        slug: form.slug,
        status: form.status,
      },
      fields: fields
        .filter((f) => f.type !== 'statement')
        .map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          options: (f.options ?? []).map((o) => ({ id: o.id, label: o.label })),
        })),
      bands: (form.scoring?.bands ?? []).map((b) => ({
        key: b.key,
        label: b.label,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
