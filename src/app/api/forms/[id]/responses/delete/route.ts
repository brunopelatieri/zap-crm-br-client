// ============================================================
// POST /api/forms/[id]/responses/delete — SPEC 085 §7.1 (admin+)
//
//   { ids: string[] }  ou  { all: true }   +   { confirm_name: string }
//
// A confirmação com o NOME do formulário é conferida aqui também (não só
// na UI): apagar é definitivo. A RPC `form_responses_delete` (INVOKER da
// sessão, SECURITY DEFINER no banco, guarda `admin` no corpo) apaga e
// devolve os caminhos dos arquivos; o servidor então remove os objetos do
// bucket `form-uploads` (melhor esforço: o que sobrar a varredura do cron
// recolhe como órfão) e devolve os bytes à quota. O contador mensal de
// respostas NÃO volta (uso do mês é histórico; a recontagem segue as
// linhas que existem).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  dbErrorResponse,
  isUuidParam,
  jsonError,
  loadForm,
  requireFormsRole,
} from '@/lib/forms/account-api';
import { recordFormActivity } from '@/lib/forms/activity';
import { supabaseAdmin } from '@/lib/forms/admin-client';
import { RESPONSES_DELETE_MAX_IDS } from '@/lib/forms/responses-query';
import { FORM_UPLOADS_BUCKET } from '@/lib/forms/uploads';

type Ctx = { params: Promise<{ id: string }> };

const REMOVE_CHUNK = 100;

interface DeleteRow {
  storage_path: string | null;
  deleted_count: number | string | null;
  freed_bytes: number | string | null;
}

export async function POST(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const body = (await request.json().catch(() => null)) as {
      ids?: unknown;
      all?: unknown;
      confirm_name?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return jsonError('Invalid JSON body', 400);
    }
    const all = body.all === true;
    let ids: string[] | null = null;
    if (!all) {
      if (
        !Array.isArray(body.ids) ||
        body.ids.length === 0 ||
        body.ids.length > RESPONSES_DELETE_MAX_IDS ||
        !body.ids.every(isUuidParam)
      ) {
        return jsonError(
          'ids must be 1 to 500 UUIDs, or all must be true',
          400
        );
      }
      ids = body.ids as string[];
    } else if (body.ids !== undefined) {
      return jsonError('Send either ids or all, not both', 400);
    }

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);
    if (
      typeof body.confirm_name !== 'string' ||
      body.confirm_name.trim() !== form.name.trim()
    ) {
      return jsonError('Confirmation does not match the form name', 400);
    }

    const { data, error } = await ctx.supabase.rpc('form_responses_delete', {
      p_form_id: id,
      p_ids: ids,
    });
    if (error) return dbErrorResponse(error, 'responses delete');

    const rows = (data ?? []) as DeleteRow[];
    const deleted = Number(rows[0]?.deleted_count ?? 0);
    const freedBytes = Number(rows[0]?.freed_bytes ?? 0);
    // Só caminhos desta conta e deste formulário: a RPC devolve o que
    // estava no instantâneo, e o instantâneo veio de um visitante.
    const prefix = `account-${ctx.accountId}/${id}/`;
    const paths = rows
      .map((r) => r.storage_path)
      .filter(
        (p): p is string =>
          typeof p === 'string' &&
          p.startsWith(prefix) &&
          !p.split('/').includes('..')
      );

    let filesRemoved = 0;
    if (paths.length > 0) {
      const admin = supabaseAdmin();
      for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
        const chunk = paths.slice(i, i + REMOVE_CHUNK);
        try {
          const { error: rmError } = await admin.storage
            .from(FORM_UPLOADS_BUCKET)
            .remove(chunk);
          if (rmError) {
            console.error('[forms] responses delete: remove failed');
          } else {
            filesRemoved += chunk.length;
          }
        } catch {
          console.error('[forms] responses delete: remove threw');
        }
      }
    }

    if (freedBytes > 0) {
      try {
        await supabaseAdmin().rpc('form_upload_bytes_add', {
          p_account_id: ctx.accountId,
          p_delta: -freedBytes,
        });
      } catch {
        console.error('[forms] responses delete: quota refund failed');
      }
    }

    void recordFormActivity(ctx.supabase, {
      accountId: ctx.accountId,
      action: 'form.responses_deleted',
      form: { id: form.id, name: form.name },
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
      metadata: { count: deleted, all },
    });

    return NextResponse.json({ deleted, filesRemoved });
  } catch (err) {
    return toErrorResponse(err);
  }
}
