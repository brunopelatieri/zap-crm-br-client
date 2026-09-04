import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  buildPage,
  keysetFilter,
  parseListParams,
} from '@/lib/api/v1/pagination';

const VALID_STATUSES = ['new', 'promoted', 'ignored', 'duplicate'] as const;
type HarvestedStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(v: string | null): v is HarvestedStatus {
  return v !== null && (VALID_STATUSES as readonly string[]).includes(v);
}

/**
 * GET /api/evolution/harvested?status=new&cursor=…&channelId=… (member+)
 * SPEC 069 §6.5, §8 ponto 6 — lista paginada da triagem.
 *
 * Reusa a paginação por keyset de `lib/api/v1/pagination.ts`: mesmo
 * mecanismo do resto do repositório, não uma segunda implementação de
 * cursor. `status` filtra (padrão `new` — é o que a tela de triagem
 * abre mostrando); `channelId` filtra por instância de origem quando a
 * conta tem mais de uma.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status');
    const status: HarvestedStatus = isValidStatus(statusParam)
      ? statusParam
      : 'new';
    const channelId = url.searchParams.get('channelId');

    let query = supabase
      .from('evolution_harvested_contacts')
      .select(
        'id, channel_id, jid, phone_normalized, push_name, full_name, business_name, avatar_path, status, promoted_contact_id, promoted_by, promoted_at, created_at, updated_at'
      )
      .eq('account_id', accountId)
      .eq('status', status);

    if (channelId) query = query.eq('channel_id', channelId);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const { items, nextCursor } = buildPage(data ?? [], limit);

    return NextResponse.json({ items, next_cursor: nextCursor });
  } catch (err) {
    return toErrorResponse(err);
  }
}
