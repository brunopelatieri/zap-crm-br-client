/**
 * O editor de três estados do nível 1a/1b (SPEC 069 §6.6, D-6/D-7/D-8,
 * F10) — a lógica de negócio compartilhada pelas DUAS portas que a
 * mexem:
 *
 *   `PUT /api/admin/accounts/[accountId]/channel-limits`   — secreto
 *      por header (`PLATFORM_ADMIN_SECRET`), para script/curl — o
 *      mesmo papel que `/api/admin/accounts/[accountId]/plan` já
 *      cumpre para o plano.
 *   `PUT /api/platform/accounts/[accountId]/channel-limits` — sessão
 *      do proprietário (`requirePlatformOwner`), a porta que o
 *      `ChannelLimitsPanel` (navegador) chama de verdade.
 *
 * Extraído para cá pelo MESMO motivo de `changeAccountPlan`
 * (`lib/platform/plan-actions.ts`): "as duas portas produzem o mesmo
 * resultado" só é verdade por construção, e não por disciplina de
 * manter duas cópias sincronizadas, quando as duas chamam a mesma
 * função. A correção de SPEC: o texto original da §6.6 só previa a
 * porta secreta — sem a de sessão, o `ChannelLimitsPanel` do F10 não
 * teria como existir (o navegador não pode carregar
 * `PLATFORM_ADMIN_SECRET`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  ACCOUNT_CONFIGURABLE_LIMIT_KEYS,
  INSTANCE_CONFIGURABLE_LIMIT_KEYS,
  getLimitEntry,
  isIntegerLimit,
} from '@/lib/limits/registry';
import { loadLimitSourcesCached } from '@/lib/limits/load';
import { resolveKey } from '@/lib/limits/resolve';

export interface LimitView {
  value: number;
  level: string;
  hardCap: number | null;
  /** O override cru desta conta — `null` quando não configurado (o
   *  valor resolvido, acima, ainda pode vir do `.env`/código). */
  override: number | null;
}

export interface InstanceLimitsView {
  channelId: string;
  label: string;
  overrides: Record<string, number>;
}

export interface ChannelLimitsSnapshot {
  account: Record<string, LimitView>;
  instances: InstanceLimitsView[];
}

export async function loadChannelLimits(
  db: SupabaseClient,
  accountId: string
): Promise<ChannelLimitsSnapshot> {
  const { data: instanceRows, error: instancesError } = await db
    .from('evolution_instances')
    .select('channel_id, limit_overrides, channels!inner(name)')
    .eq('account_id', accountId);

  if (instancesError) {
    throw new Error(instancesError.message);
  }

  const accountSources = await loadLimitSourcesCached(db, { accountId });

  const account: Record<string, LimitView> = {};
  for (const key of ACCOUNT_CONFIGURABLE_LIMIT_KEYS) {
    const resolved = resolveKey(key, accountSources);
    const raw = accountSources.account?.[key];
    account[key] = {
      value: resolved.value,
      level: resolved.level,
      hardCap: resolved.hardCap,
      override: typeof raw === 'number' ? raw : null,
    };
  }

  const instances: InstanceLimitsView[] = (instanceRows ?? []).map((row) => {
    const overridesRaw = (row.limit_overrides ?? {}) as Record<string, unknown>;
    const overrides: Record<string, number> = {};
    for (const key of INSTANCE_CONFIGURABLE_LIMIT_KEYS) {
      const v = overridesRaw[key];
      if (typeof v === 'number') overrides[key] = v;
    }
    const channelRel = row.channels as unknown as
      { name: string } | { name: string }[] | null;
    const label = Array.isArray(channelRel)
      ? (channelRel[0]?.name ?? '')
      : (channelRel?.name ?? '');
    return { channelId: row.channel_id as string, label, overrides };
  });

  return { account, instances };
}

export interface ChannelLimitsPatch {
  account?: Record<string, number | null>;
  instances?: Record<string, Record<string, number | null>>;
}

export interface ChannelLimitsValidationError {
  error: string;
}

/**
 * Valida um lote de entradas contra o registro: chave conhecida,
 * inteiro não negativo, `0` só onde `allowZero` permite, e dentro do
 * teto duro (D-7) — acima dele é `400`, nunca clamp silencioso. Puro:
 * o único acesso externo é `process.env`, o mesmo parâmetro implícito
 * que `resolveKey` já aceita.
 */
export function validateLimitEntries(
  entries: Record<string, number | null> | undefined,
  allowedKeys: readonly string[]
): ChannelLimitsValidationError | null {
  if (!entries) return null;
  for (const [key, value] of Object.entries(entries)) {
    if (!allowedKeys.includes(key)) {
      return { error: `unknown limit key: ${key}` };
    }
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return { error: `${key} must be a non-negative integer or null` };
    }
    const entry = getLimitEntry(key);
    if (!entry || !isIntegerLimit(entry)) continue;
    if (value === 0 && !entry.allowZero) {
      return { error: `${key} does not accept 0` };
    }
    if (entry.hardCap) {
      const capValue = resolveKey(key, { env: process.env }).hardCap;
      if (capValue !== null) {
        const overCeiling =
          entry.hardCap.kind === 'max' ? value > capValue : value < capValue;
        if (overCeiling) {
          return {
            error: `${key}=${value} is ${entry.hardCap.kind === 'max' ? 'above the ceiling' : 'below the floor'} of ${capValue}`,
          };
        }
      }
    }
  }
  return null;
}

export function validateChannelLimitsPatch(
  patch: ChannelLimitsPatch
): ChannelLimitsValidationError | null {
  const accountError = validateLimitEntries(
    patch.account,
    ACCOUNT_CONFIGURABLE_LIMIT_KEYS
  );
  if (accountError) return accountError;

  if (patch.instances) {
    for (const entries of Object.values(patch.instances)) {
      const err = validateLimitEntries(
        entries,
        INSTANCE_CONFIGURABLE_LIMIT_KEYS
      );
      if (err) return err;
    }
  }
  return null;
}

function mergeOverrides(
  current: Record<string, unknown>,
  patch: Record<string, number | null>
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export type ApplyChannelLimitsResult =
  { ok: true } | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * Aplica um patch JÁ VALIDADO (`validateChannelLimitsPatch`). Sempre
 * via `supabaseAdmin()` — as duas rotas chamadoras já resolveram a
 * própria autorização (segredo ou sessão do proprietário) antes de
 * chegar aqui; esta função não sabe qual das duas foi.
 */
export async function applyChannelLimits(
  accountId: string,
  patch: ChannelLimitsPatch
): Promise<ApplyChannelLimitsResult> {
  const validationError = validateChannelLimitsPatch(patch);
  if (validationError) {
    return { ok: false, status: 400, error: validationError.error };
  }

  const admin = supabaseAdmin();

  if (patch.account && Object.keys(patch.account).length > 0) {
    const { data: accountPlan, error: fetchError } = await admin
      .from('account_plans')
      .select('limit_overrides')
      .eq('account_id', accountId)
      .maybeSingle();
    if (fetchError)
      return { ok: false, status: 500, error: fetchError.message };
    if (!accountPlan) {
      return {
        ok: false,
        status: 404,
        error: 'account has no plan assigned',
      };
    }
    // MERGE, não substitui: `limit_overrides` também carrega os
    // overrides de QUOTA (contatos, membros) que a rota de plano
    // grava. Sobrescrever o objeto inteiro apagaria essas chaves toda
    // vez que o proprietário mexesse num limite de segurança.
    const merged = mergeOverrides(
      (accountPlan.limit_overrides as Record<string, unknown>) ?? {},
      patch.account
    );
    const { error: updateError } = await admin
      .from('account_plans')
      .update({ limit_overrides: merged })
      .eq('account_id', accountId);
    if (updateError) {
      return { ok: false, status: 500, error: updateError.message };
    }
  }

  if (patch.instances) {
    for (const [channelId, entries] of Object.entries(patch.instances)) {
      if (Object.keys(entries).length === 0) continue;
      const { data: instance, error: fetchError } = await admin
        .from('evolution_instances')
        .select('id, limit_overrides')
        .eq('account_id', accountId)
        .eq('channel_id', channelId)
        .maybeSingle();
      if (fetchError) {
        return { ok: false, status: 500, error: fetchError.message };
      }
      if (!instance) {
        return {
          ok: false,
          status: 404,
          error: `instance not found for channel ${channelId}`,
        };
      }
      const merged = mergeOverrides(
        (instance.limit_overrides as Record<string, unknown>) ?? {},
        entries
      );
      const { error: updateError } = await admin
        .from('evolution_instances')
        .update({ limit_overrides: merged })
        .eq('id', instance.id);
      if (updateError) {
        return { ok: false, status: 500, error: updateError.message };
      }
    }
  }

  return { ok: true };
}
