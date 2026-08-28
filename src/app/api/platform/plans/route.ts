// ============================================================
// GET/POST /api/platform/plans — SPEC 062 §6, §7.4, F6
//
//   GET  — catálogo inteiro (inclusive planos privados/inativos — a
//          visão do operador, não a pública de /api/account/plan).
//   POST — cria OU edita um plano por `code` (upsert), mesma regra de
//          `/api/admin/plans`: não existe DELETE de propósito (um
//          plano com conta assinada não pode ser apagado —
//          `account_plans.plan_id` é `ON DELETE RESTRICT`; "aposentar"
//          é `is_active: false`).
//
//   `yearlyDiscountPercent` (069) entra aqui — `NULL` usa o padrão da
//   plataforma (D-5), o mesmo `/admin/plans` calcula ao vivo (§7.4).
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import { validateCatalog } from '@/lib/plans/catalog';
import { supabaseAdmin } from '@/lib/supabase/admin';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function GET() {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const { data, error } = await supabaseAdmin()
    .from('plans')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('[GET /api/platform/plans] fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to load plans' },
      { status: 500 }
    );
  }

  return NextResponse.json({ plans: data ?? [] });
}

interface PlanUpsertBody {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  price_cents?: unknown;
  currency?: unknown;
  billing_period?: unknown;
  limits?: unknown;
  features?: unknown;
  is_public?: unknown;
  is_active?: unknown;
  sort_order?: unknown;
  yearly_discount_percent?: unknown;
}

export async function POST(request: Request) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }

  const body = (await request
    .json()
    .catch(() => null)) as PlanUpsertBody | null;
  if (!body || typeof body.code !== 'string' || typeof body.name !== 'string') {
    return NextResponse.json(
      { error: "'code' and 'name' are required" },
      { status: 400 }
    );
  }

  const limits =
    body.limits && typeof body.limits === 'object'
      ? (body.limits as Record<string, unknown>)
      : {};
  const features =
    body.features && typeof body.features === 'object'
      ? (body.features as Record<string, unknown>)
      : {};

  const validationErrors = validateCatalog([
    { code: body.code, limits, features },
  ]);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { error: 'Unknown quota/feature key', details: validationErrors },
      { status: 400 }
    );
  }

  const yearlyDiscount =
    body.yearly_discount_percent === null
      ? null
      : typeof body.yearly_discount_percent === 'number'
        ? body.yearly_discount_percent
        : undefined;
  if (
    yearlyDiscount !== undefined &&
    yearlyDiscount !== null &&
    (!Number.isInteger(yearlyDiscount) ||
      yearlyDiscount < 0 ||
      yearlyDiscount > 100)
  ) {
    return NextResponse.json(
      {
        error:
          'yearly_discount_percent must be an integer between 0 and 100, or null',
      },
      { status: 400 }
    );
  }

  const row: Record<string, unknown> = {
    code: body.code,
    name: body.name,
    description: typeof body.description === 'string' ? body.description : null,
    price_cents: typeof body.price_cents === 'number' ? body.price_cents : 0,
    currency: typeof body.currency === 'string' ? body.currency : 'BRL',
    billing_period:
      typeof body.billing_period === 'string' ? body.billing_period : 'monthly',
    limits,
    features,
    is_public: body.is_public === true,
    is_active: body.is_active !== false,
    sort_order: typeof body.sort_order === 'number' ? body.sort_order : 0,
    updated_at: new Date().toISOString(),
  };
  // Só toca a coluna quando o corpo a enviou — ausente não deve zerar
  // um desconto por plano já configurado.
  if (yearlyDiscount !== undefined)
    row.yearly_discount_percent = yearlyDiscount;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from('plans')
    .upsert(row, { onConflict: 'code' })
    .select('*')
    .single();

  if (error || !data) {
    console.error('[POST /api/platform/plans] upsert error:', error);
    return NextResponse.json({ error: 'Failed to save plan' }, { status: 500 });
  }

  await writePlatformAudit(db, {
    actor: consoleActorTag(ownerEmail),
    action: 'catalog.upsert',
    payload: { code: body.code },
  });

  return NextResponse.json({ plan: data }, { status: 200 });
}
