// ============================================================
// GET/PUT /api/platform/retention — padrão global de retenção
// (SPEC 062 §3.8, §5.3, §6, §7.5, F7)
//
// Substitui, junto com as duas rotas por conta, o par
// `/api/account/retention*` que a SPEC 060 entregou ao dono da conta. A
// virada de dono já aconteceu no banco (069): as duas tabelas ficaram
// com RLS ligada e zero policies. Aqui é o lado de aplicação —
// `requirePlatformOwner()` e 404 genérico em qualquer falha (§2.4).
//
// O que esta rota edita é `platform_settings.retention_defaults`: o elo
// que entra ACIMA do `.env` na cadeia de precedência (§5.3). Por isso o
// PUT funde DIMENSÃO A DIMENSÃO — editar `maxMessages` de um canal não
// pode apagar o `retentionDays` que já estava lá para o outro (§11:
// "Limite de retenção virou sem limite depois de editar um campo no
// console").
//
// `MESSAGE_RETENTION_ENABLED` continua SÓ no `.env` (D-13) e não é
// editável aqui — `enabled` viaja no GET apenas para a tela poder
// avisar que a varredura não roda.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import { readPlatformRetentionDefaults } from '@/lib/platform/retention-defaults';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CHANNEL_TYPES, type ChannelType } from '@/lib/channels/types';
import { readRetentionDefaults } from '@/lib/retention/defaults';
import { validateRetentionDefaults } from '@/lib/retention/global-defaults';
import { resolveEffectivePolicyWithSource } from '@/lib/retention/policy';
import { parseRetentionLimitInput } from '@/lib/retention/validate';
import type { RetentionPolicyRow } from '@/lib/retention/types';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

function isChannelType(value: unknown): value is ChannelType {
  return (
    typeof value === 'string' &&
    (CHANNEL_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Um canal de `retention_defaults` cru → a mesma forma que
 * `resolveEffectivePolicyWithSource` já consome. Só valor válido passa
 * (o resto vira "não configurado"): mesma postura tolerante de
 * `mergeGlobalDefaults` — a tela nunca quebra por causa de uma linha
 * torta, ela mostra o `.env` e deixa salvar por cima.
 */
function consoleChannelToPolicy(raw: unknown): RetentionPolicyRow | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  // Ponte entre duas convenções (achado de code review — antes disto
  // as duas colapsavam no mesmo `undefined`, apagando a escolha):
  //
  //   - `retention_defaults` (JSONB do console) usa `null` PRESENTE
  //     para "sem limite explícito" (é o que `validateRetentionDefaults`
  //     grava quando alguém digita `0`) e a CHAVE AUSENTE para "não
  //     configurado".
  //   - `RetentionPolicyRow`/`resolveDimension` usa `0` para "sem
  //     limite explícito" e `undefined`/`null` para "não configurado,
  //     herda `defaultValue`" (é a forma de uma coluna nullable —
  //     não há como o INTEGER da tabela distinguir "ausente" de
  //     "null").
  //
  // Sem esta tradução, uma chave presente com `null` (o proprietário
  // desligou o limite) vira `undefined` aqui e `resolveEffectivePolicyWithSource`
  // volta a mostrar/aplicar o valor do `.env` — a escolha "sem limite"
  // não sobrevive a um refresh da tela.
  const pick = (key: string): number | null | undefined => {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (v === null) return 0;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0
      ? v
      : undefined;
  };
  return {
    maxMessages: pick('maxMessages'),
    retentionDays: pick('retentionDays'),
    maxFavorites: pick('maxFavorites'),
  };
}

export async function GET() {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const envDefaults = readRetentionDefaults(process.env);
  const db = supabaseAdmin();

  let consoleDefaults: Record<string, unknown>;
  let lastRunAt: string | null = null;
  let lastResult: unknown = null;
  try {
    const [defaultsResult, state] = await Promise.all([
      readPlatformRetentionDefaults(db),
      db
        .from('message_retention_state')
        .select('last_run_at, last_result')
        .eq('id', true)
        .maybeSingle(),
    ]);
    if (state.error) throw state.error;
    consoleDefaults = defaultsResult;
    lastRunAt = (state.data?.last_run_at as string | null) ?? null;
    lastResult = state.data?.last_result ?? null;
  } catch (err) {
    console.error('[GET /api/platform/retention] fetch failed:', err);
    return NextResponse.json(
      { error: 'Failed to load retention defaults' },
      { status: 500 }
    );
  }

  // TODOS os tipos de canal, não só os "presentes" em alguma conta: este
  // é o padrão da plataforma inteira, e um canal que ninguém conectou
  // ainda continua precisando de padrão configurável.
  const channels = CHANNEL_TYPES.map((type) => {
    const policy = consoleChannelToPolicy(consoleDefaults[type]);
    return {
      type,
      policy,
      effective: resolveEffectivePolicyWithSource(policy, envDefaults[type]),
      // O padrão global não pertence a nenhuma conta — não existe "uso"
      // a mostrar aqui, e a prévia (`p_dry_run`) precisa de um
      // `account_id`. As duas coisas vivem na tela da conta.
      usage: null,
    };
  });

  return NextResponse.json({
    enabled: envDefaults.enabled,
    minAgeHours: envDefaults.minAgeHours,
    intervalHours: envDefaults.intervalHours,
    lastRunAt,
    lastResult,
    channels,
  });
}

export async function PUT(request: Request) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }

  const body = await request.json().catch(() => null);
  if (!body || !isChannelType(body.channelType)) {
    return NextResponse.json(
      { error: 'channelType must be one of: ' + CHANNEL_TYPES.join(', ') },
      { status: 400 }
    );
  }
  const channelType: ChannelType = body.channelType;

  const maxMessages = parseRetentionLimitInput(body.maxMessages);
  const retentionDays = parseRetentionLimitInput(body.retentionDays);
  const maxFavorites = parseRetentionLimitInput(body.maxFavorites);
  if (!maxMessages.valid || !retentionDays.valid || !maxFavorites.valid) {
    return NextResponse.json(
      { error: 'Limits must be empty or a non-negative integer' },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();

  let current: Record<string, unknown>;
  try {
    current = await readPlatformRetentionDefaults(db);
  } catch (err) {
    console.error('[PUT /api/platform/retention] read failed:', err);
    return NextResponse.json(
      { error: 'Failed to load retention defaults' },
      { status: 500 }
    );
  }

  // Fusão dimensão a dimensão (§5.3 regra 1): o formulário manda os três
  // campos DESTE canal, e só eles são reescritos — o outro canal segue
  // intacto no JSONB. Campo vazio significa "não define nada aqui, cai
  // para o `.env`", então ele SAI da chave em vez de virar `null`.
  const nextChannel: Record<string, number> = {};
  if (maxMessages.value !== null) nextChannel.maxMessages = maxMessages.value;
  if (retentionDays.value !== null) {
    nextChannel.retentionDays = retentionDays.value;
  }
  if (maxFavorites.value !== null) {
    nextChannel.maxFavorites = maxFavorites.value;
  }

  const merged: Record<string, unknown> = { ...current };
  if (Object.keys(nextChannel).length === 0) {
    // Os três campos vazios = "este canal não define nada" — a chave sai
    // do JSONB em vez de virar um objeto vazio pendurado.
    delete merged[channelType];
  } else {
    merged[channelType] = nextChannel;
  }

  // Lado ESTRITO da §5.3: rejeita o objeto INTEIRO com erro claro se algo
  // estiver malformado (inclusive lixo que já estivesse gravado) — aqui
  // existe alguém digitando que precisa do feedback antes de salvar.
  const validated = validateRetentionDefaults(merged);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const { error: updateErr } = await db
    .from('platform_settings')
    .update({ retention_defaults: validated.value })
    .eq('id', true);

  if (updateErr) {
    console.error('[PUT /api/platform/retention] update failed:', updateErr);
    return NextResponse.json(
      { error: 'Failed to save retention defaults' },
      { status: 500 }
    );
  }

  await writePlatformAudit(db, {
    actor: consoleActorTag(ownerEmail),
    action: 'retention.global.update',
    payload: { channelType, limits: nextChannel },
  });

  const envDefaults = readRetentionDefaults(process.env);
  const policy = consoleChannelToPolicy(validated.value[channelType]);
  return NextResponse.json({
    policy,
    effective: resolveEffectivePolicyWithSource(
      policy,
      envDefaults[channelType]
    ),
  });
}
