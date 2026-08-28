// ============================================================
// GET/PUT /api/platform/settings — SPEC 062 §6, §7.4, F6
//
//   `platform_settings`: interruptor de quotas, plano padrão,
//   instruções de pagamento, desconto anual padrão, carência,
//   autosserviço, e-mail de suporte. `retention_defaults` FICA DE FORA
//   — aquela chave é F7 (§3.8), a virada de dono da retenção; até lá
//   ela só existe na coluna.
//
//   Esta é a rota que fecha o buraco que o guia de operação documenta:
//   ligar `quotas_enforced` hoje exige `UPDATE` por SQL direto porque
//   "não existe rota admin para isto". A UI (F6 também) pede
//   confirmação explícita antes de PUT-ar `quotasEnforced: true` — é a
//   ação de maior alcance do console, muda o comportamento de todas as
//   contas de uma vez.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readMailerConfig } from '@/lib/mailer/config';

// SPEC 063 §6 — "/admin/settings mostra os canais em modo leitura
// (host, porta, remetente, destinatário, URL do webhook mascarada)".
// Valores de `.env` NUNCA são editáveis pela tela (§6) — este bloco só
// aparece no GET, o PUT abaixo nunca aceita nenhum destes campos, e a
// senha do SMTP nunca é lida daqui nem devolvida, mascarada ou não.
function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return '(url inválida)';
  }
}

function readChannelsStatus() {
  const mailer = readMailerConfig();
  const webhookUrl =
    process.env.SYSTEM_EVENT_WEBHOOK_URL?.trim() ||
    process.env.PLAN_REQUEST_WEBHOOK_URL?.trim() ||
    null;

  return {
    email: mailer
      ? {
          configured: true,
          host: mailer.host,
          port: mailer.port,
          from: mailer.from,
          to: mailer.to,
        }
      : { configured: false, host: null, port: null, from: null, to: null },
    webhook: webhookUrl
      ? { configured: true, urlMasked: maskUrl(webhookUrl) }
      : { configured: false, urlMasked: null },
  };
}

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

const SETTINGS_COLUMNS =
  'quotas_enforced, default_plan_code, payment_instructions, billing_contact, ' +
  'default_yearly_discount_percent, support_email, grace_days, self_service_enabled, updated_at';

export async function GET() {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .select(SETTINGS_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('[GET /api/platform/settings] fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to load settings' },
      { status: 500 }
    );
  }

  return NextResponse.json({ settings: data, channels: readChannelsStatus() });
}

interface SettingsPutBody {
  quotasEnforced?: unknown;
  defaultPlanCode?: unknown;
  paymentInstructions?: unknown;
  billingContact?: unknown;
  defaultYearlyDiscountPercent?: unknown;
  supportEmail?: unknown;
  graceDays?: unknown;
  selfServiceEnabled?: unknown;
}

export async function PUT(request: Request) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }

  const body = (await request
    .json()
    .catch(() => null)) as SettingsPutBody | null;
  if (!body) {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();
  const update: Record<string, unknown> = {};

  if (body.quotasEnforced !== undefined) {
    if (typeof body.quotasEnforced !== 'boolean') {
      return NextResponse.json(
        { error: 'quotasEnforced must be a boolean' },
        { status: 400 }
      );
    }
    update.quotas_enforced = body.quotasEnforced;
  }
  if (body.defaultPlanCode !== undefined) {
    if (
      typeof body.defaultPlanCode !== 'string' ||
      body.defaultPlanCode.trim() === ''
    ) {
      return NextResponse.json(
        { error: 'defaultPlanCode must be a non-empty string' },
        { status: 400 }
      );
    }
    const trimmed = body.defaultPlanCode.trim();

    // Achado de code review: `default_plan_code` não tem FK (é lido
    // por `code`, não por id — migração 067 §11) e é consultado em
    // dois lugares que NUNCA verificam o resultado antes de seguir:
    // `handle_new_user()` (067) só faz `INSERT` `IF v_plan_id IS NOT
    // NULL` — um código inexistente faz toda conta nova nascer SEM
    // linha em `account_plans`, quebrando a invariante que a própria
    // asserção 9.2 da 069 exige; `runPlanLifecycle` (`lifecycle.ts`)
    // aborta a varredura inteira no primeiro erro se o plano padrão
    // não resolver. Confirmar aqui, antes de salvar, é a única camada
    // que existe — sem ela um typo digitado uma vez quebra silenciosamente
    // dois sistemas até alguém notar pelos logs do servidor.
    const { data: plan } = await db
      .from('plans')
      .select('code')
      .eq('code', trimmed)
      .eq('is_active', true)
      .maybeSingle();
    if (!plan) {
      return NextResponse.json(
        {
          error: `defaultPlanCode '${trimmed}' does not match any active plan`,
        },
        { status: 400 }
      );
    }
    update.default_plan_code = trimmed;
  }
  if (body.paymentInstructions !== undefined) {
    update.payment_instructions =
      typeof body.paymentInstructions === 'string'
        ? body.paymentInstructions
        : null;
  }
  if (body.billingContact !== undefined) {
    update.billing_contact =
      typeof body.billingContact === 'string' ? body.billingContact : null;
  }
  if (body.defaultYearlyDiscountPercent !== undefined) {
    const v = body.defaultYearlyDiscountPercent;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) {
      return NextResponse.json(
        {
          error:
            'defaultYearlyDiscountPercent must be an integer between 0 and 100',
        },
        { status: 400 }
      );
    }
    update.default_yearly_discount_percent = v;
  }
  if (body.supportEmail !== undefined) {
    update.support_email =
      typeof body.supportEmail === 'string' ? body.supportEmail : null;
  }
  if (body.graceDays !== undefined) {
    const v = body.graceDays;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return NextResponse.json(
        { error: 'graceDays must be a non-negative integer' },
        { status: 400 }
      );
    }
    update.grace_days = v;
  }
  if (body.selfServiceEnabled !== undefined) {
    if (typeof body.selfServiceEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'selfServiceEnabled must be a boolean' },
        { status: 400 }
      );
    }
    update.self_service_enabled = body.selfServiceEnabled;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: 'No recognized field in body' },
      { status: 400 }
    );
  }

  const { data, error } = await db
    .from('platform_settings')
    .update(update)
    .eq('id', true)
    .select(SETTINGS_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    console.error('[PUT /api/platform/settings] update error:', error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }

  // §2.5 — toda ação do console entra em platform_audit_log, com o
  // que mudou (não o valor todo: o resto não é assunto desta ação).
  await writePlatformAudit(db, {
    actor: consoleActorTag(ownerEmail),
    action: 'settings.update',
    payload: { changedKeys: Object.keys(update) },
  });

  return NextResponse.json({ settings: data });
}
