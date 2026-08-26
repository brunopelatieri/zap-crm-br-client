// ============================================================
// /api/admin/plans — catálogo de planos (SPEC 059 §6, D-9)
//
//   GET  — lista todo o catálogo (inclusive planos privados/inativos —
//          é a visão do operador, não a pública de /api/account/plan).
//   POST — cria OU edita um plano por `code` (upsert). Não existe rota
//          de DELETE de propósito: um plano com conta assinada não
//          pode ser apagado (account_plans.plan_id é ON DELETE
//          RESTRICT) — "aposentar" um plano é `is_active: false`.
//
// Protegida por PLATFORM_ADMIN_SECRET (x-admin-secret), não por sessão
// — ver src/lib/auth/platform-admin.ts.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformAdminSecret } from '@/lib/auth/platform-admin';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { validateCatalog } from '@/lib/plans/catalog';

export async function GET(request: Request) {
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;

  const { data, error } = await supabaseAdmin()
    .from('plans')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('[GET /api/admin/plans] fetch error:', error);
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
}

export async function POST(request: Request) {
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;

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

  // Mesmo teste de contrato do seed comercial (catalog.test.ts) — uma
  // chave desconhecida aqui é o typo que o JSONB sem CHECK deixaria
  // passar direto para o banco.
  const validationErrors = validateCatalog([
    { code: body.code, limits, features },
  ]);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { error: 'Unknown quota/feature key', details: validationErrors },
      { status: 400 }
    );
  }

  const row = {
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

  const { data, error } = await supabaseAdmin()
    .from('plans')
    .upsert(row, { onConflict: 'code' })
    .select('*')
    .single();

  if (error || !data) {
    console.error('[POST /api/admin/plans] upsert error:', error);
    return NextResponse.json({ error: 'Failed to save plan' }, { status: 500 });
  }

  return NextResponse.json({ plan: data }, { status: 200 });
}
