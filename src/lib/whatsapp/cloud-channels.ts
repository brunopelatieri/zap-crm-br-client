/**
 * Credencial oficial POR CANAL (SPEC 064 §4.1, fase F2).
 *
 * O que este arquivo resolve
 *
 *   Até a migração 072, `whatsapp_config` era singleton por conta
 *   (`UNIQUE (account_id)`, migração 017) e vinte pontos do código
 *   perguntavam a credencial assim:
 *
 *     .from('whatsapp_config').select('*').eq('account_id', id).single()
 *
 *   Com dois números oficiais na mesma conta essa pergunta não tem
 *   resposta: o PostgREST devolve erro, e a tentação — trocar por
 *   `.limit(1)` — transforma falha alta em MENSAGEM ENVIADA PELO NÚMERO
 *   ERRADO (§9, armadilha 1). A pergunta certa é "por qual canal", e é
 *   este módulo que sabe respondê-la.
 *
 * A regra, uma vez só (D-7)
 *
 *   canal explícito > canal padrão DO TIPO `whatsapp_cloud` > erro.
 *
 *   Nunca "o primeiro que aparecer". Sem canal explícito e sem padrão,
 *   `resolveCloudConfig` lança `ChannelNotConfiguredError` — quem chama
 *   decide o que fazer, mas ninguém envia por um número sorteado.
 *
 * Escopo de conta em TODA consulta
 *
 *   Mesmo com `service_role` (que ignora RLS), todo `select` daqui casa
 *   `account_id` junto do id pedido: um `channel_id` de outra conta vira
 *   erro, nunca leitura. É o mesmo cuidado de
 *   `resolveInstanceByChannelId` (`lib/evolution/instances.ts`).
 *
 * Segredo não sai daqui em resumo
 *
 *   `listCloudChannels` seleciona colunas nomeadas de propósito:
 *   `access_token` e `verify_token` NÃO estão entre elas, porque a lista
 *   alimenta a rota que a interface consome (§5/§6.1). Só
 *   `resolveCloudConfig` — o caminho de envio — devolve a linha inteira,
 *   e o `decrypt()` continua acontecendo em `channels/send.ts`, o único
 *   lugar da camada que toca `ENCRYPTION_KEY`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveDefaultChannelId } from '@/lib/channels/default-channel';
import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import type { Channel, ChannelStatus } from '@/lib/channels/types';

/**
 * Linha de `whatsapp_config`. Tipada de forma frouxa de propósito: o
 * `select('*')` é o mesmo dos chamadores originais, e o que muda entre
 * os projetos Supabase (a coluna `channel_id` só existe onde a 055 já
 * rodou) não pode virar erro de tipo.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WhatsappConfigRow = any;

/** Um número oficial, do jeito que a interface e a rota precisam ver. */
export interface CloudChannelSummary {
  channelId: string;
  /** Rótulo do operador (`channels.name`). */
  name: string;
  /**
   * Telefone conectado (D-9). Até a reconciliação com a Meta acontecer,
   * pode ainda ser o `phone_number_id` gravado pelo backfill da 055 —
   * por isso nenhuma tela o formata como telefone.
   */
  identifier: string | null;
  status: ChannelStatus;
  isDefault: boolean;
  /**
   * `null` só no canal órfão: a criação são duas escritas sem transação
   * (§5) e a segunda pode falhar. Ele não envia nada, mas aparece na
   * lista de propósito — ocupa vaga de quota, e escondê-lo deixaria o
   * operador sem explicação para o número que "sumiu".
   */
  phoneNumberId: string | null;
  wabaId: string | null;
  /** `POST /register` da Meta já concluído neste número. */
  registeredAt: string | null;
  lastRegistrationError: string | null;
  subscribedAppsAt: string | null;
  /** Anti-fadiga por número (SPEC 044 §6.2 / D-4). */
  broadcastCooldownDays: number | null;
  /** Tier da Meta, que é por NÚMERO (D-4). */
  messagingLimitTier: string | null;
  createdAt: string;
}

/**
 * Colunas do resumo — sem segredo nenhum, ver o cabeçalho.
 *
 * A lista é o que a aba de configuração passa a ler no lugar do
 * `select('*')` que ela fazia direto do navegador (§6.1), então ela
 * carrega tudo que aquela tela mostra: registro, cooldown e tier. O que
 * não pode estar aqui é `access_token` e `verify_token` — e é por isso
 * que as colunas são nomeadas uma a uma, e não `*`.
 */
const CONFIG_SUMMARY_COLUMNS =
  'channel_id, phone_number_id, waba_id, registered_at, last_registration_error, subscribed_apps_at, broadcast_cooldown_days, messaging_limit_tier';

/**
 * Todos os números oficiais da conta, **do padrão para o mais novo**.
 *
 * Exclui `disabled`: um canal desativado não envia, não aparece em
 * seletor e não ocupa vaga de quota (D-5/D-12). Quem precisa vê-los —
 * a aba de configuração, para reconectar — consulta `channels`
 * diretamente.
 */
export async function listCloudChannels(
  db: SupabaseClient,
  accountId: string
): Promise<CloudChannelSummary[]> {
  const { data: channels, error } = await db
    .from('channels')
    .select('id, name, identifier, status, is_default, created_at')
    .eq('account_id', accountId)
    .eq('type', 'whatsapp_cloud')
    .neq('status', 'disabled');

  // Erro de leitura não vira lista vazia: "a conta não tem número" e "a
  // consulta falhou" levam o chamador a caminhos opostos.
  if (error) {
    throw new ChannelNotConfiguredError(
      `failed to list cloud channels for account ${accountId}: ${error.message}`,
      'read_failed'
    );
  }

  const rows = channels ?? [];
  if (rows.length === 0) return [];

  // Duas consultas em vez de um embed `whatsapp_config(...)`: o cache de
  // schema do PostgREST devolve `PGRST200` para relacionamento recente
  // (§9, armadilha 6 — a mesma de `resolveChannelForConversation`).
  const { data: configs, error: configError } = await db
    .from('whatsapp_config')
    .select(CONFIG_SUMMARY_COLUMNS)
    .eq('account_id', accountId)
    .in(
      'channel_id',
      rows.map((c) => c.id)
    );

  if (configError) {
    throw new ChannelNotConfiguredError(
      `failed to read cloud credentials for account ${accountId}: ${configError.message}`,
      'read_failed'
    );
  }

  const byChannel = new Map<string, WhatsappConfigRow>(
    (configs ?? []).map((c: WhatsappConfigRow) => [c.channel_id, c])
  );

  return rows
    .map((c) => {
      const config = byChannel.get(c.id);
      return {
        channelId: c.id as string,
        name: c.name as string,
        identifier: (c.identifier ?? null) as string | null,
        status: c.status as ChannelStatus,
        isDefault: Boolean(c.is_default),
        phoneNumberId: (config?.phone_number_id ?? null) as string | null,
        wabaId: (config?.waba_id ?? null) as string | null,
        registeredAt: (config?.registered_at ?? null) as string | null,
        lastRegistrationError: (config?.last_registration_error ?? null) as
          string | null,
        subscribedAppsAt: (config?.subscribed_apps_at ?? null) as string | null,
        broadcastCooldownDays: (config?.broadcast_cooldown_days ?? null) as
          number | null,
        messagingLimitTier: (config?.messaging_limit_tier ?? null) as
          string | null,
        createdAt: c.created_at as string,
      };
    })
    .sort((a, b) => {
      // Padrão primeiro, depois do mais antigo para o mais novo — a
      // mesma ordem do backfill e das três funções de triagem da 072
      // (`ORDER BY c.is_default DESC, c.created_at ASC`). Ordenar aqui e
      // não no banco porque o critério de desempate não pode depender da
      // ordem em que o PostgREST devolve as linhas.
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
}

/**
 * A config de UM número, pronta para virar `ChannelContext`.
 *
 * `channelId` ausente = canal Cloud padrão (D-11). Recusa, com motivo
 * nomeado: canal de outra conta, canal de outro tipo, canal `disabled`
 * e canal sem credencial. **Nada disso chega ao `decrypt()`** — é o que
 * impede o `access_token = ''` que "desativar número" deixa para trás
 * (D-12) de virar uma exceção opaca do decriptador.
 */
export async function resolveCloudConfig(
  db: SupabaseClient,
  accountId: string,
  channelId?: string | null
): Promise<{ channel: Channel; config: WhatsappConfigRow }> {
  // `|| null`, e não `?? null`: `''` chega aqui quando um chamador
  // repassa `searchParams.get('channel_id')` de um `?channel_id=` vazio,
  // e `''` não é nullish — sem isto, a consulta seria por `id = ''` e o
  // pedido morreria com "canal não existe" em vez de cair no padrão.
  const wantedId =
    (channelId || null) ??
    (await resolveDefaultChannelId(db, accountId, 'whatsapp_cloud'));

  const { data: channel, error } = await db
    .from('channels')
    .select('*')
    .eq('id', wantedId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    throw new ChannelNotConfiguredError(
      `failed to read channel ${wantedId}: ${error.message}`,
      'read_failed'
    );
  }
  // Inclui o caso "id de outra conta": o `account_id` acima faz a linha
  // simplesmente não existir para esta conta.
  if (!channel) {
    throw new ChannelNotConfiguredError(
      `channel ${wantedId} does not exist in account ${accountId}`,
      'not_found'
    );
  }
  if (channel.type !== 'whatsapp_cloud') {
    throw new ChannelNotConfiguredError(
      `channel ${wantedId} is of type "${channel.type}", not whatsapp_cloud`,
      'wrong_type'
    );
  }
  if (channel.status === 'disabled') {
    throw new ChannelNotConfiguredError(
      `channel ${wantedId} is disabled — reconnect the number before sending`,
      'disabled'
    );
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('channel_id', wantedId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (configError) {
    throw new ChannelNotConfiguredError(
      `failed to read credentials of channel ${wantedId}: ${configError.message}`,
      'read_failed'
    );
  }
  // Canal órfão: a criação são dois INSERT sem transação (§5).
  if (!config) {
    throw new ChannelNotConfiguredError(
      `channel ${wantedId} has no WhatsApp credentials`,
      'no_credentials'
    );
  }
  // `access_token` é NOT NULL desde a 001, então "desativar" grava
  // string vazia (D-12). Sem esta guarda o `decrypt('')` de `send.ts`
  // falharia com um erro de criptografia que não explica nada.
  if (!config.access_token) {
    throw new ChannelNotConfiguredError(
      `channel ${wantedId} has no access token — reconnect the number`,
      'no_credentials'
    );
  }

  return { channel: channel as Channel, config };
}

/**
 * A config de um número que atende um WABA específico (SPEC 064 F5/D-2).
 *
 * Templates pertencem ao WABA, não ao canal — mas falar com a Meta (editar,
 * excluir) exige um token, e o token é do canal. `wabaId` nulo (template
 * legado, anterior à 072) cai no canal Cloud padrão, a mesma regra de D-2
 * para listagem/envio. Quando dois números compartilham o WABA, usa o
 * primeiro da ordem de `listCloudChannels` (padrão antes, depois mais
 * antigo) — qualquer um deles fala pela mesma conta na Meta.
 */
export async function resolveCloudConfigForWaba(
  db: SupabaseClient,
  accountId: string,
  wabaId: string | null
): Promise<{ channel: Channel; config: WhatsappConfigRow }> {
  if (!wabaId) return resolveCloudConfig(db, accountId, null);

  const channels = await listCloudChannels(db, accountId);
  const match = channels.find((c) => c.wabaId === wabaId);
  if (!match) {
    throw new ChannelNotConfiguredError(
      `no connected channel found for WABA ${wabaId} in account ${accountId}`,
      'not_found'
    );
  }
  return resolveCloudConfig(db, accountId, match.channelId);
}

/**
 * O `waba_id` de UM canal (por `channel_id`), sem nunca lançar.
 *
 * Existe para chamadores best-effort (ex.: `hydrateBroadcastReply`) que
 * precisam saber o WABA de um canal já conhecido só para escolher a
 * linha certa de `message_templates`, mas não podem deixar uma
 * credencial ausente, canal apagado ou erro transitório virar exceção —
 * ao contrário de `resolveCloudConfig`, que EXISTE justamente para
 * lançar com motivo quando o canal não está pronto para enviar. Aqui
 * "não sei o WABA" é um resultado válido (`null`), não uma falha do
 * chamador.
 *
 * Loga a diferença entre "canal sem config" (silencioso, esperado — ver
 * o comentário de canal órfão em `resolveCloudConfig`) e "erro de
 * leitura" (logado): sem isto, uma falha transitória do Supabase fica
 * indistinguível de "este canal genuinamente não tem WABA", e o
 * chamador degradava os dois casos para o mesmo `null` sem deixar
 * rastro para diagnosticar depois (achado de code review, SPEC 064 D-2).
 */
export async function resolveWabaIdForChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('waba_id')
    .eq('channel_id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.error(
      `[cloud-channels] failed to read waba_id for channel ${channelId}: ${error.message}`
    );
    return null;
  }
  return (data?.waba_id as string | null | undefined) ?? null;
}

/**
 * Quantos números oficiais ativos a conta tem.
 *
 * A interface usa para decidir se mostra seletor de número (um número
 * só não precisa de escolha). Conta canais, não configs: canal órfão
 * também ocupa vaga de quota, e o critério tem de ser o mesmo da
 * trigger da 072 (D-5).
 */
export async function countCloudChannels(
  db: SupabaseClient,
  accountId: string
): Promise<number> {
  const { count, error } = await db
    .from('channels')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('type', 'whatsapp_cloud')
    .neq('status', 'disabled');

  if (error) {
    throw new ChannelNotConfiguredError(
      `failed to count cloud channels for account ${accountId}: ${error.message}`,
      'read_failed'
    );
  }
  return count ?? 0;
}
