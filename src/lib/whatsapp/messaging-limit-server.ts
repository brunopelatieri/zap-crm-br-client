/**
 * Leitura do limite de contatos por disparo no servidor (SPEC 044 §4).
 *
 * Extraído da rota `GET /api/whatsapp/messaging-limit` quando o envio
 * migrou para o servidor (§6.1). O motivo é o §4.5, item 4: os pontos
 * 1–3 de imposição do teto (pós-parse, triagem, passo 4) são UX; o
 * controle de verdade é o servidor revalidando na hora de enviar. Se
 * essa revalidação usasse uma segunda implementação, o número exibido e
 * o número aplicado poderiam divergir — e a divergência só apareceria
 * como "o botão liberou e o disparo foi recusado".
 *
 * O token cifrado nunca sai daqui: `decrypt` só roda no servidor.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  resolveCloudConfig,
  type WhatsappConfigRow,
} from '@/lib/whatsapp/cloud-channels';
import { fetchMessagingLimit } from '@/lib/whatsapp/meta-api';
import {
  FALLBACK_TIER,
  computeQuota,
  isCacheFresh,
  tierFromResponse,
  type QuotaSnapshot,
  type QuotaSource,
} from '@/lib/whatsapp/messaging-limit';

export type QuotaLoadResult =
  | { configured: false; reason: 'no_config' }
  | { configured: true; snapshot: QuotaSnapshot };

export interface LoadAccountQuotaOptions {
  /**
   * Ignora o cache de 15 min e consulta a Graph API na hora.
   *
   * É o que dá sentido ao botão "Checar limite" da tela de audiência:
   * sem isto, um clique manual logo depois de uma leitura automática
   * repetiria o valor em cache e pareceria não ter feito nada. O rate
   * limit da rota (20/min por usuário) é o que segura o abuso.
   */
  force?: boolean;
  /**
   * Qual número oficial medir (SPEC 064 D-4). Ausente = canal Cloud
   * padrão da conta.
   *
   * O tier é da Meta e vale **por número**: somar o consumo de dois
   * números contra o tier de um só faria o painel alertar cedo e o
   * operador segurar audiência que caberia.
   */
  channelId?: string | null;
}

/**
 * Resolve o retrato de limite da conta: tier (da Meta, do cache ou do
 * fallback restritivo) + quantos contatos já foram alcançados nas
 * últimas 24 h (informativo — ver `computeQuota`).
 *
 * Nunca lança por causa da Meta. Se a Graph API estiver fora, devolve o
 * último tier conhecido — ou `TIER_250` se nunca houve leitura — com
 * `source: 'fallback'`. Nunca "sem limite".
 */
export async function loadAccountQuota(
  db: SupabaseClient,
  accountId: string,
  options: LoadAccountQuotaOptions = {}
): Promise<QuotaLoadResult> {
  // SPEC 064 F3 — tier e cota passam a ser POR NÚMERO.
  //
  // Antes daqui saía um `.single()` sobre `whatsapp_config` por
  // `account_id`, que com dois números oficiais não tem resposta.
  // `resolveCloudConfig` aplica o D-7 (explícito > padrão do tipo >
  // erro) e recusa canal desativado antes do `decrypt`.
  let channelId: string;
  // Linha crua, como no resto da camada (`WhatsappConfigRow`): tipar
  // estreito aqui só criaria atrito com o `select('*')` de
  // `resolveCloudConfig` sem ganhar segurança nenhuma.
  let config: WhatsappConfigRow;
  try {
    const resolved = await resolveCloudConfig(db, accountId, options.channelId);
    channelId = resolved.channel.id;
    config = resolved.config;
  } catch (err) {
    if (!(err instanceof ChannelNotConfiguredError)) throw err;

    // `configured: false` significa UMA coisa só: a conta não tem número
    // oficial. É o que faz o medidor se esconder na tela de audiência —
    // e, nos dois chamadores de disparo, o que faz
    // `batchLimit` virar `Infinity` (`broadcasts/send/route.ts:314`,
    // `broadcasts/cron/route.ts:300`).
    //
    // Por isso qualquer OUTRO motivo (canal desativado, token zerado
    // pelo "Reset Configuration", id inválido vindo da query string,
    // leitura que falhou) não pode passar por aqui: sumir com o teto
    // por disparo em silêncio é exatamente o efeito que a SPEC quer
    // impedir. Nesses casos devolvemos o tier restritivo, com
    // `stale` e `usageUnavailable` ligados — o mesmo tratamento que a
    // Meta fora do ar já recebe logo abaixo. Nunca "sem limite".
    if (err.reason === 'no_channel') {
      return { configured: false, reason: 'no_config' };
    }

    console.error(
      `[messaging-limit] channel unusable (${err.reason}) — falling back to ${FALLBACK_TIER}:`,
      err.message
    );
    return {
      configured: true,
      snapshot: computeQuota({
        tier: FALLBACK_TIER,
        usedLast24h: 0,
        usageUnavailable: true,
        source: 'fallback',
      }),
    };
  }

  // O volume da janela sempre vem do banco — é barato e muda a cada
  // disparo, então nunca é cacheado junto com o tier. Não limita nada;
  // é o número de contexto que a tela exibe ao lado do limite.
  //
  // ⚠️ Campanhas anteriores à 072 têm `broadcasts.channel_id NULL` e não
  // entram na contagem de nenhum número (§3.9). É subcontagem conhecida
  // e some sozinha 24 h depois do deploy da F6.
  const { data: usedRaw, error: usageError } = await db.rpc(
    'broadcast_quota_usage',
    { p_account_id: accountId, p_channel_id: channelId }
  );
  if (usageError) {
    console.error(
      '[messaging-limit] quota usage error (channel',
      channelId,
      '):',
      usageError
    );
  }
  // Ausência de dado NÃO é zero (§3.9 / armadilha 7): a tela precisa
  // dizer "consumo indisponível", senão o operador monta uma audiência
  // achando que a janela está livre. `PGRST202` logo após a migração —
  // cache de schema do PostgREST — cai exatamente aqui.
  const usageUnavailable = Boolean(usageError) || usedRaw == null;
  const usedLast24h = Number(usedRaw ?? 0);

  // ── Cache quente: pula a Meta (a menos que o usuário force) ────
  if (
    !options.force &&
    config.messaging_limit_tier &&
    isCacheFresh(config.messaging_limit_checked_at)
  ) {
    return {
      configured: true,
      snapshot: computeQuota({
        tier: config.messaging_limit_tier,
        usedLast24h,
        usageUnavailable,
        source: 'cache',
        checkedAt: new Date(config.messaging_limit_checked_at),
      }),
    };
  }

  // ── Cache frio: consulta a Meta ────────────────────────────────
  // Começa pessimista: último tier salvo, ou o restritivo se nunca
  // houve leitura. Só vira 'meta' se a chamada abaixo der certo.
  let tier = config.messaging_limit_tier ?? FALLBACK_TIER;
  let source: QuotaSource = 'fallback';
  let checkedAt = config.messaging_limit_checked_at
    ? new Date(config.messaging_limit_checked_at)
    : new Date();

  try {
    const accessToken = decrypt(config.access_token);
    const response = await fetchMessagingLimit({
      phoneNumberId: config.phone_number_id,
      accessToken,
    });
    tier = tierFromResponse(response);
    source = 'meta';
    checkedAt = new Date();

    // Persistir o tier é o que faz o medidor sobreviver a um restart e o
    // que dá um valor de fallback quando a Meta cai. Uma falha de
    // escrita não invalida a leitura — logamos e seguimos.
    // ⚠️ Por `channel_id`, NUNCA por `account_id` (§9, armadilha 2): a
    // conta pode ter dois números, e `.eq('account_id')` gravaria o tier
    // do número consultado na linha do OUTRO — a leitura seguinte
    // "funcionaria", com o teto errado.
    const { error: cacheError } = await db
      .from('whatsapp_config')
      .update({
        messaging_limit_tier: tier,
        messaging_limit_checked_at: checkedAt.toISOString(),
      })
      .eq('channel_id', channelId)
      .eq('account_id', accountId);
    if (cacheError) {
      console.error('[messaging-limit] tier cache write failed:', cacheError);
    }
  } catch (err) {
    // Meta fora do ar, token inválido, timeout. Não é erro fatal: a
    // tela mostra o último tier conhecido com selo de desatualizado, e
    // o servidor continua aplicando um teto.
    console.error('[messaging-limit] Meta lookup failed:', err);
  }

  return {
    configured: true,
    snapshot: computeQuota({
      tier,
      usedLast24h,
      usageUnavailable,
      source,
      checkedAt,
    }),
  };
}
