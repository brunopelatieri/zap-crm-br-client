// ============================================================
// POST /api/forms/[id]/responses/export — SPEC 085 §4.4 / §7.1 (admin+)
//
//   { format: 'csv'|'xlsx',
//     scope: { mode: 'filter', filter: { status, band, from, to, source,
//                                         block, value, q } }
//          | { mode: 'selection', ids: string[] },
//     columns?: string[] }            // chaves de bloco; omitido = todos
//
// Mesmo desenho da exportação de contatos (SPEC 051): `admin`+, client de
// SESSÃO (RLS) para ler, `supabaseAdmin()` só para a trilha em
// `contact_exports` (`source = 'form_responses'`, migração 098) depois do
// papel conferido. As respostas vêm de visitantes anônimos: toda célula
// passa por `neutralizeFormula` (injeção de fórmula no Excel/Sheets).
// ============================================================

import { NextResponse } from 'next/server';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SheetData } from 'write-excel-file/node';

import { toErrorResponse } from '@/lib/auth/account';
import { buildContactsCsv } from '@/lib/contacts/export-file';
import {
  dbErrorResponse,
  isUuidParam,
  jsonError,
  loadFields,
  loadForm,
  requireFormsRole,
} from '@/lib/forms/account-api';
import { recordFormActivity } from '@/lib/forms/activity';
import { supabaseAdmin } from '@/lib/forms/admin-client';
import {
  RESPONSE_EXPORT_FIXED_COLUMNS,
  buildResponsesExportMatrix,
  resolveBlockColumns,
  responsesExportFilename,
  type ResponseExportLabels,
  type ResponseExportRow,
} from '@/lib/forms/response-export';
import {
  RESPONSES_DELETE_MAX_IDS,
  RESPONSES_EXPORT_BATCH,
  RESPONSES_EXPORT_MAX_ROWS,
  FILTER_QUERY_KEYS,
  applyFilterOps,
  buildBlockContainment,
  needsInnerContactJoin,
  parseResponsesFilter,
  planResponsesFilter,
} from '@/lib/forms/responses-query';
import { RESPONSE_SOURCES, RESPONSE_STATUSES } from '@/lib/forms/types';

// Uma exportação grande passa dos 10 s padrão do host (como a de contatos).
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return jsonError('Invalid JSON body', 400);
    }
    if (body.format !== 'csv' && body.format !== 'xlsx') {
      return jsonError('format must be "csv" or "xlsx"', 400);
    }
    const fileFormat = body.format;

    let onlyKeys: string[] | undefined;
    if (body.columns !== undefined) {
      if (
        !Array.isArray(body.columns) ||
        !body.columns.every((c) => typeof c === 'string')
      ) {
        return jsonError('columns must be an array of strings', 400);
      }
      onlyKeys = body.columns as string[];
    }

    const scope = body.scope as Record<string, unknown> | undefined;
    if (!scope || typeof scope !== 'object') {
      return jsonError('scope is required', 400);
    }
    let selectionIds: string[] | null = null;
    const filterParams = new URLSearchParams();
    if (scope.mode === 'selection') {
      if (
        !Array.isArray(scope.ids) ||
        scope.ids.length === 0 ||
        scope.ids.length > RESPONSES_DELETE_MAX_IDS ||
        !scope.ids.every(isUuidParam)
      ) {
        return jsonError('scope.ids must be 1 to 500 UUIDs', 400);
      }
      selectionIds = scope.ids as string[];
    } else if (scope.mode === 'filter') {
      const raw = (scope.filter ?? {}) as Record<string, unknown>;
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return jsonError('scope.filter must be an object', 400);
      }
      for (const [k, v] of Object.entries(raw)) {
        if (
          (FILTER_QUERY_KEYS as readonly string[]).includes(k) &&
          typeof v === 'string'
        ) {
          filterParams.set(k, v);
        }
      }
    } else {
      return jsonError('scope.mode must be "filter" or "selection"', 400);
    }

    const parsed = parseResponsesFilter(filterParams);
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
      if (!containment) {
        return jsonError('Invalid filter', 400, { field: 'block' });
      }
    }
    const ops = selectionIds ? [] : planResponsesFilter(filter, containment);
    const contactJoin =
      !selectionIds && needsInnerContactJoin(filter)
        ? 'contacts!inner(name, phone)'
        : 'contacts(name, phone)';

    // Lotes de 1.000 com ORDER BY estável: o teto silencioso do PostgREST
    // não corta a exportação (mesma lição das SPECs 051/052).
    const rows: ResponseExportRow[] = [];
    let total = 0;
    for (let from = 0; ; from += RESPONSES_EXPORT_BATCH) {
      let query = ctx.supabase
        .from('form_responses')
        .select(
          `status, source, started_at, completed_at, score, band_key, answers, ${contactJoin}`,
          { count: 'exact' }
        )
        .eq('form_id', id)
        .eq('account_id', ctx.accountId);
      if (selectionIds) query = query.in('id', selectionIds);
      query = applyFilterOps(query, ops);
      const { data, error, count } = await query
        .order('started_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + RESPONSES_EXPORT_BATCH - 1);
      if (error) return dbErrorResponse(error, 'responses export');
      if (from === 0) {
        total = count ?? 0;
        if (total > RESPONSES_EXPORT_MAX_ROWS) {
          return jsonError('export_too_large', 413, { total });
        }
      }
      const batch = (data ?? []) as unknown as ResponseExportRow[];
      rows.push(...batch);
      if (batch.length < RESPONSES_EXPORT_BATCH || rows.length >= total) break;
    }

    const blocks = resolveBlockColumns(fields, rows, onlyKeys);

    const locale = await getLocale();
    const t = await getTranslations('Forms.responses');
    const labels: ResponseExportLabels = {
      yes: t('values.yes'),
      no: t('values.no'),
      columns: Object.fromEntries(
        RESPONSE_EXPORT_FIXED_COLUMNS.map((c) => [c, t(`columns.${c}`)])
      ) as ResponseExportLabels['columns'],
      statuses: Object.fromEntries(
        RESPONSE_STATUSES.map((s) => [s, t(`status.${s}`)])
      ) as ResponseExportLabels['statuses'],
      sources: Object.fromEntries(
        RESPONSE_SOURCES.map((s) => [s, t(`source.${s}`)])
      ) as ResponseExportLabels['sources'],
      bands: Object.fromEntries(
        (form.scoring?.bands ?? []).map((b) => [b.key, b.label])
      ),
      datePattern: locale === 'pt-BR' ? 'dd/MM/yyyy HH:mm' : 'MM/dd/yyyy HH:mm',
    };

    const matrix = buildResponsesExportMatrix(rows, blocks, labels);
    const filename = responsesExportFilename(
      t('export.filenamePrefix'),
      form.slug,
      fileFormat,
      new Date()
    );

    let fileBody: BodyInit;
    let contentType: string;
    if (fileFormat === 'csv') {
      fileBody = '﻿' + buildContactsCsv(matrix);
      contentType = 'text/csv; charset=utf-8';
    } else {
      // Import dinâmico: `write-excel-file/node` é Node-only.
      const { default: writeXlsxFile } = await import('write-excel-file/node');
      // Toda célula como texto: o Excel não vira telefone em notação científica.
      const sheetData: SheetData = matrix.map((row) =>
        row.map((cell) => ({ value: cell, type: String }))
      );
      const buffer = await writeXlsxFile(sheetData).toBuffer();
      fileBody = new Uint8Array(buffer);
      contentType =
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    // Trilha de auditoria — `supabaseAdmin()` só aqui, com o papel já
    // conferido. Melhor esforço: o arquivo já está montado.
    try {
      await supabaseAdmin()
        .from('contact_exports')
        .insert({
          account_id: ctx.accountId,
          user_id: ctx.userId,
          source: 'form_responses',
          format: fileFormat,
          scope: scope.mode,
          row_count: rows.length,
          fields: [
            ...RESPONSE_EXPORT_FIXED_COLUMNS,
            ...blocks.map((b) => `block:${b.key}`),
          ],
          filter: selectionIds
            ? { form_id: id, selected: selectionIds.length }
            : {
                form_id: id,
                statuses: filter.statuses,
                band: filter.band,
                from: filter.from,
                to: filter.to,
                source: filter.source,
                block: filter.block,
                search: filter.search,
              },
        });
    } catch (err) {
      console.error('[forms/export] audit insert failed:', err);
    }

    void recordFormActivity(ctx.supabase, {
      accountId: ctx.accountId,
      action: 'form.exported',
      form: { id: form.id, name: form.name },
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
      metadata: {
        format: fileFormat,
        scope: scope.mode,
        row_count: rows.length,
        count: rows.length,
      },
    });

    return new NextResponse(fileBody, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'X-Export-Row-Count': String(rows.length),
        'X-Export-Total': String(total),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
