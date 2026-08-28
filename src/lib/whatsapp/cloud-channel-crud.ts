/**
 * CRUD de número oficial — a parte que fala com o banco (SPEC 064 F4).
 *
 * Por que existe um módulo, e não só a rota
 *
 *   `POST /api/whatsapp/config` faz duas coisas muito diferentes: fala
 *   com a Meta (verificar, registrar, assinar o WABA) e escreve DUAS
 *   tabelas sem transação. A primeira metade já era testada de fora
 *   (mock de `fetch`); a segunda concentra tudo que esta fase precisa
 *   acertar — idempotência, readoção de canal desativado, compensação
 *   de falha parcial e o D-12 — e não dá para exercitá-la sem um banco
 *   falso. Ela mora aqui, e a rota vira a costura entre as duas.
 *
 * O bug que este módulo conserta (§1.1.E.1)
 *
 *   Até aqui, `POST /api/whatsapp/config` **nunca tocava `channels`**.
 *   Todo canal Cloud em produção veio do backfill da migração 055 — uma
 *   conta criada depois dele conectava o número, ficava com
 *   `whatsapp_config.channel_id = NULL` e sem canal nenhum, e
 *   `resolveDefaultChannelId` passava a lançar. A partir daqui a linha
 *   de `channels` nasce e é mantida junto da credencial, do mesmo jeito
 *   que `lib/evolution/instances.ts` faz para o QRCode desde a SPEC 048.
 *
 * Duas escritas, nenhuma transação (§5)
 *
 *   `supabase-js` não abre transação. Criar um número é `INSERT` em
 *   `channels` seguido de `INSERT` em `whatsapp_config`: se o segundo
 *   falhar, sobra canal órfão ocupando vaga de quota e aparecendo no
 *   filtro do inbox. `createCloudChannel` faz a compensação explícita —
 *   apaga o canal recém-criado e, se nem isso der, marca `disabled` com
 *   o motivo. É o padrão de `createEvolutionInstance`
 *   (`instances.ts:409-431`), não uma invenção local.
 *
 * O que este módulo NUNCA escreve
 *
 *   `is_default`. A coluna é escrita só pela RPC `set_default_channel`
 *   (072 §6.1) e pelas triggers `claim_default_on_insert` /
 *   `claim_default_on_reactivate`, que elegem padrão sozinhas ao criar e
 *   ao reativar. Um `update` daqui competiria com o índice único parcial
 *   e deixaria o tipo sem padrão na ordem errada.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

/** Nome-base dos canais criados pela rota, igual ao backfill da 072. */
const DEFAULT_CHANNEL_NAME = 'WhatsApp Oficial';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChannelRow = any;

/**
 * Colunas da credencial que a rota precisa para decidir o salvamento —
 * **sem `access_token` e sem `verify_token`**. O que a rota devolve ao
 * navegador sai de `listCloudChannels`; o que ela usa para decidir sai
 * daqui. Nenhum dos dois carrega segredo.
 */
export const CONFIG_DECISION_COLUMNS =
  'id, channel_id, phone_number_id, waba_id, registered_at, status';

/**
 * Onde este salvamento vai cair. Resolvido ANTES de falar com a Meta,
 * porque é ele que decide se a quota do plano sequer é consultada.
 */
export type SaveTarget =
  /** `channel_id` explícito, ou `phone_number_id` já conhecido da conta. */
  | { mode: 'update'; channel: ChannelRow; config: ConfigRow | null }
  /** Mesmo caso, com o canal `disabled` — o salvamento reativa (D-12). */
  | { mode: 'readopt'; channel: ChannelRow; config: ConfigRow | null }
  /**
   * A credencial existe mas **não tem canal** (`channel_id` nulo) — o
   * estado que o bug §1.1.E.1 deixou para trás em toda conta criada
   * depois do backfill da 055, e que sobrevive em qualquer deployment
   * onde a `072` (que põe a coluna como `NOT NULL`) ainda não rodou.
   *
   * Precisa de canal novo, mas **não** de linha nova: o
   * `phone_number_id` é `UNIQUE` global (migração 013), então um
   * `INSERT` aqui colidiria com a própria linha da conta e devolveria
   * 500 em toda tentativa — o operador ficaria sem conseguir salvar,
   * num caminho que antes desta fase funcionava.
   */
  | { mode: 'adopt'; channel: null; config: ConfigRow }
  /** Número novo para esta conta. */
  | { mode: 'create'; channel: null; config: null };

/** Modos que criam uma linha em `channels` — e portanto ocupam quota. */
export function createsChannel(mode: SaveTarget['mode']): boolean {
  return mode === 'create' || mode === 'adopt';
}

export class CloudChannelError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'CloudChannelError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Qual canal este `POST` está salvando.
 *
 * Três caminhos, nesta ordem:
 *
 *   1. `channel_id` no corpo → aquele canal, e só ele. Id de outra
 *      conta ou de outro tipo é erro, nunca "cria um novo".
 *   2. sem `channel_id`, mas o `phone_number_id` já pertence à conta →
 *      **atualiza aquele canal**. É a idempotência que o §5 pede: ela
 *      protege contra duplo clique e contra o bundle antigo em cache,
 *      que POSTa sempre sem id e criaria um segundo canal para o mesmo
 *      número a cada salvamento.
 *   3. nada disso → cria.
 *
 * `disabled` vira `readopt` em vez de `update` para que quem chama saiba
 * que precisa reativar (e que a trigger `claim_default_on_reactivate`
 * vai reeleger padrão sozinha).
 */
export async function resolveSaveTarget(
  db: SupabaseClient,
  accountId: string,
  input: { channelId?: string | null; phoneNumberId: string }
): Promise<SaveTarget> {
  const channelId = input.channelId?.trim() || null;

  if (channelId) {
    const { data: channel, error } = await db
      .from('channels')
      .select('*')
      .eq('id', channelId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      throw new CloudChannelError(
        `Failed to read channel: ${error.message}`,
        500,
        'read_failed'
      );
    }
    // Escopo de conta na própria consulta: um id de outra conta
    // simplesmente não existe aqui, e vira 404 — nunca leitura.
    if (!channel) {
      throw new CloudChannelError('Channel not found.', 404, 'not_found');
    }
    if (channel.type !== 'whatsapp_cloud') {
      throw new CloudChannelError(
        `Channel ${channelId} is a ${channel.type} channel, not an official WhatsApp number.`,
        400,
        'wrong_type'
      );
    }

    const config = await readConfigByChannel(db, accountId, channelId);
    return {
      mode: channel.status === 'disabled' ? 'readopt' : 'update',
      channel,
      config,
    };
  }

  // Idempotência por número. Casa `account_id` junto: o
  // `phone_number_id` é UNIQUE global (D-8), então uma linha de outra
  // conta existe — e o conflito dela é respondido pelo chamador com o
  // 409 explícito, não silenciosamente adotado aqui.
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select(CONFIG_DECISION_COLUMNS)
    .eq('account_id', accountId)
    .eq('phone_number_id', input.phoneNumberId)
    .maybeSingle();

  if (error) {
    throw new CloudChannelError(
      `Failed to read configuration: ${error.message}`,
      500,
      'read_failed'
    );
  }
  if (!config) return { mode: 'create', channel: null, config: null };
  // Credencial órfã: adota, nunca recria. Ver o comentário do modo.
  if (!config.channel_id) return { mode: 'adopt', channel: null, config };

  const { data: channel, error: channelError } = await db
    .from('channels')
    .select('*')
    .eq('id', config.channel_id)
    .eq('account_id', accountId)
    .maybeSingle();

  if (channelError) {
    throw new CloudChannelError(
      `Failed to read channel: ${channelError.message}`,
      500,
      'read_failed'
    );
  }
  // Config apontando para canal inexistente não deveria acontecer (o FK
  // é `ON DELETE CASCADE`), mas se acontecer o caso é o mesmo do
  // `adopt`: a LINHA existe e reserva o `phone_number_id`, então o que
  // falta é um canal para ela — não uma segunda linha.
  if (!channel) return { mode: 'adopt', channel: null, config };

  return {
    mode: channel.status === 'disabled' ? 'readopt' : 'update',
    channel,
    config,
  };
}

async function readConfigByChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string
): Promise<ConfigRow | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select(CONFIG_DECISION_COLUMNS)
    .eq('channel_id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    throw new CloudChannelError(
      `Failed to read configuration: ${error.message}`,
      500,
      'read_failed'
    );
  }
  return data ?? null;
}

/**
 * Rótulo do próximo número, no padrão do backfill da 072: "WhatsApp
 * Oficial", "WhatsApp Oficial 2", "WhatsApp Oficial 3"…
 *
 * Contador sequencial, e **não** um sufixo derivado do
 * `phone_number_id` — ele é um id opaco da Meta e nada garante que dois
 * números da mesma conta difiram nos últimos dígitos. O operador
 * renomeia na F7; aqui só precisa ser único e legível. Canais
 * `disabled` entram na contagem de propósito: eles continuam existindo
 * para reconexão, e reaproveitar o número do rótulo criaria dois
 * "WhatsApp Oficial 2".
 */
export async function nextCloudChannelName(
  db: SupabaseClient,
  accountId: string
): Promise<string> {
  const { count } = await db
    .from('channels')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('type', 'whatsapp_cloud');

  const seq = count ?? 0;
  return seq === 0
    ? DEFAULT_CHANNEL_NAME
    : `${DEFAULT_CHANNEL_NAME} ${seq + 1}`;
}

/**
 * O telefone de exibição do canal (D-9).
 *
 * `display_phone_number` chega da Meta formatado ("+55 19 99249-6598");
 * gravamos só os dígitos, o mesmo formato canônico que o resto do
 * sistema usa. Vazio vira `null` — melhor canal sem telefone do que
 * canal com string vazia que a tela tentaria formatar.
 */
export function identifierFromDisplayPhone(
  displayPhoneNumber: string | null | undefined
): string | null {
  return sanitizePhoneForMeta(displayPhoneNumber ?? '') || null;
}

export interface CreateCloudChannelInput {
  accountId: string;
  userId: string;
  name: string;
  identifier: string | null;
  status: 'connected' | 'disconnected';
  statusDetail: string | null;
  connectedAt: string | null;
  /** Tudo que vai para `whatsapp_config`, menos `channel_id`. */
  configRow: Record<string, unknown>;
  /**
   * `whatsapp_config.id` da credencial ÓRFÃ que este canal vem adotar
   * (modo `adopt`). Presente, a segunda escrita é um `UPDATE` daquela
   * linha em vez de um `INSERT` — que colidiria com o `UNIQUE` global
   * de `phone_number_id`.
   */
  adoptConfigId?: string | null;
}

/**
 * Cria canal + credencial, com a compensação do §5.
 *
 * A ordem importa: `channels` primeiro, porque é a linha que a trigger
 * `enforce_channel_quota` avalia — um plano no teto recusa aqui, antes
 * de qualquer credencial ser gravada. O erro da trigger sobe cru
 * (`QUOTA_EXCEEDED:…`); quem chama traduz.
 */
export async function createCloudChannel(
  db: SupabaseClient,
  input: CreateCloudChannelInput
): Promise<{ channelId: string }> {
  const { data: channel, error: channelError } = await db
    .from('channels')
    .insert({
      account_id: input.accountId,
      user_id: input.userId,
      type: 'whatsapp_cloud',
      name: input.name,
      identifier: input.identifier,
      status: input.status,
      status_detail: input.statusDetail,
      connected_at: input.connectedAt,
      // `is_default` fica de fora: `claim_default_on_insert_trg` (072
      // §7.1) elege o padrão do tipo sozinha quando ainda não há um.
    })
    .select('id')
    .single();

  if (channelError || !channel) {
    throw channelError ?? new Error('Failed to create channel');
  }

  const configError = input.adoptConfigId
    ? await adoptOrphanConfig(db, input.adoptConfigId, {
        ...input.configRow,
        channel_id: channel.id,
      })
    : (
        await db
          .from('whatsapp_config')
          .insert({ ...input.configRow, channel_id: channel.id })
      ).error;

  if (configError) {
    // Canal sem credencial não envia nada, mas ocupa vaga de quota e
    // aparece no filtro do inbox. Desfaz.
    const { error: rollbackError } = await db
      .from('channels')
      .delete()
      .eq('id', channel.id);

    if (rollbackError) {
      // Nem apagar deu. `disabled` é o estado que tira o canal da
      // quota (D-5), dos seletores e do resolvedor de credencial —
      // com o motivo escrito, para o operador não achar que o número
      // sumiu sozinho.
      await db
        .from('channels')
        .update({
          status: 'disabled',
          status_detail: `Canal órfão: a credencial não pôde ser salva (${configError.message}) e o canal não pôde ser removido (${rollbackError.message}). Salve o número de novo.`,
        })
        .eq('id', channel.id);
    }
    throw configError;
  }

  return { channelId: channel.id };
}

/**
 * Liga a credencial órfã ao canal recém-criado.
 *
 * O `.select('id')` não é decoração: um `UPDATE` que não casa nenhuma
 * linha **não é erro** no PostgREST, e sem conferir a contagem a rota
 * responderia "salvo" com o canal apontando para o nada. Aqui isso
 * dispararia a compensação (canal apagado), que é o desfecho certo.
 */
async function adoptOrphanConfig(
  db: SupabaseClient,
  configId: string,
  row: Record<string, unknown>
): Promise<{ message: string } | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .update(row)
    .eq('id', configId)
    .select('id');

  if (error) return error;
  if (!data || data.length === 0) {
    return {
      message: `credential row ${configId} vanished before it could be linked to the new channel`,
    };
  }
  return null;
}

/**
 * Grava a credencial de um canal que já existe — `UPDATE`, ou `INSERT`
 * se não houver linha.
 *
 * O `INSERT` não é hipotético: `resolveSaveTarget` devolve `update` com
 * `config: null` sempre que o `channel_id` explícito aponta para um
 * canal ÓRFÃO (criado quando a compensação do §5 não conseguiu apagá-lo,
 * e listado de propósito para o operador poder consertá-lo). Sem este
 * ramo, o `UPDATE` casaria zero linhas, o PostgREST não chamaria isso de
 * erro, e a rota responderia `success: true` sobre um canal que continua
 * sem credencial nenhuma.
 */
export async function saveCloudConfigRow(
  db: SupabaseClient,
  input: {
    accountId: string;
    userId: string;
    channelId: string;
    row: Record<string, unknown>;
  }
): Promise<void> {
  const { data, error } = await db
    .from('whatsapp_config')
    .update(input.row)
    .eq('channel_id', input.channelId)
    .eq('account_id', input.accountId)
    .select('id');

  if (error) throw error;
  if (data && data.length > 0) return;

  const { error: insertError } = await db.from('whatsapp_config').insert({
    account_id: input.accountId,
    user_id: input.userId,
    channel_id: input.channelId,
    ...input.row,
  });
  if (insertError) throw insertError;
}

export interface ReconcileChannelInput {
  /** Telefone da Meta (D-9). `undefined` = não reconciliar identifier. */
  identifier?: string | null;
  status?: 'connected' | 'error';
  statusDetail?: string | null;
  connectedAt?: string | null;
  name?: string;
}

/**
 * Alinha a linha de `channels` com o que a Meta acabou de responder.
 *
 * Duas coisas acontecem aqui, e as duas fecham buracos abertos:
 *
 *   - **`status`** passa a ter escritor para `whatsapp_cloud`. Até a F3
 *     a coluna era o valor congelado do backfill da 055 — daí o mapa
 *     `STATUS_IS_MAINTAINED` de `lib/channels/status.ts`, que a F4 vira
 *     para `true` justamente porque esta função existe.
 *   - **`identifier`** deixa de guardar o `phone_number_id` e passa a
 *     guardar o telefone (D-9). A migração não podia fazer isso — exige
 *     falar com a Graph API.
 *
 * ⚠️ **Nunca ressuscita um canal `disabled`.** "Desativar número"
 * (D-12) é ação deliberada do operador, e um diagnóstico de fundo não
 * pode desfazê-la — quem reativa é o `POST` de salvamento, que regrava
 * a credencial junto. O `.neq('status','disabled')` é o que garante
 * isso mesmo quando esta função roda com `service_role`.
 */
export async function reconcileCloudChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
  input: ReconcileChannelInput
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (input.identifier !== undefined) patch.identifier = input.identifier;
  if (input.status !== undefined) patch.status = input.status;
  if (input.statusDetail !== undefined)
    patch.status_detail = input.statusDetail;
  if (input.connectedAt !== undefined) patch.connected_at = input.connectedAt;
  if (input.name !== undefined) patch.name = input.name;
  if (Object.keys(patch).length === 0) return;

  const { error } = await db
    .from('channels')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', channelId)
    .eq('account_id', accountId)
    .neq('status', 'disabled');

  if (error) {
    // Reconciliação é manutenção de fundo: ela melhora o estado, não é
    // o objetivo da requisição que a disparou. Falhar o diagnóstico
    // porque a linha não pôde ser atualizada trocaria uma informação
    // desatualizada por nenhuma informação.
    console.error(
      `[whatsapp/config] falha ao reconciliar o canal ${channelId}:`,
      error.message
    );
  }
}

export interface SaveChannelInput {
  identifier: string | null;
  status: 'connected' | 'error';
  statusDetail: string | null;
  connectedAt: string | null;
  name?: string;
}

/**
 * A escrita de `channels` que acompanha um salvamento de credencial.
 *
 * Separada de `reconcileCloudChannel` por causa de UMA linha: aqui não
 * existe o `.neq('status','disabled')`. Salvar é a operação com que o
 * operador reativa um número desativado (D-12, "readota o canal
 * `disabled` em vez de criar um segundo"), e ela vem acompanhada da
 * credencial nova — diferente do diagnóstico, que roda sozinho e não
 * pode desfazer uma desativação deliberada.
 *
 * Reativar dispara `claim_default_on_reactivate_trg` e
 * `enforce_channel_quota_reactivate_trg` (072 §7): o canal volta a
 * ocupar vaga de quota e reassume o padrão do tipo se não houver outro.
 * É por isso que o erro sobe em vez de virar log — um plano no teto
 * recusa a reativação, e o operador precisa saber.
 */
export async function updateCloudChannelOnSave(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
  input: SaveChannelInput
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: input.status,
    status_detail: input.statusDetail,
    connected_at: input.connectedAt,
    updated_at: new Date().toISOString(),
  };
  // `identifier` só é sobrescrito quando a Meta devolveu um telefone:
  // apagar o valor antigo porque a resposta veio sem
  // `display_phone_number` deixaria o canal sem nada para exibir.
  if (input.identifier) patch.identifier = input.identifier;
  if (input.name) patch.name = input.name;

  const { error } = await db
    .from('channels')
    .update(patch)
    .eq('id', channelId)
    .eq('account_id', accountId);

  if (error) throw error;
}

export type RemoveOutcome = 'deleted' | 'disabled';

/**
 * "Remover número" — desativa preservando a configuração (D-12).
 *
 * `conversations.channel_id` é `NOT NULL` **sem cascade** (059): apagar
 * um canal com conversas viola o FK, e o banco recusa. Por isso são
 * dois caminhos:
 *
 *   - **com conversas** → apaga só os segredos (`access_token = ''`,
 *     `verify_token = NULL`) e marca o canal `disabled`. Histórico,
 *     selos e filtros do inbox continuam funcionando; o canal some dos
 *     seletores e não ocupa vaga de quota.
 *   - **sem conversas** → apaga o canal de verdade. A credencial vai
 *     junto pelo `ON DELETE CASCADE` da 055, liberando o
 *     `phone_number_id` (UNIQUE global) para outra conta.
 *
 * Por que não apagar a linha nos dois casos: `broadcast_cooldown_days`,
 * `messaging_limit_tier`, `messaging_limit_checked_at` e `waba_id` moram
 * **só** ali. Reconectar depois de apagar nasceria com o `DEFAULT 7` do
 * cooldown, e a triagem de audiência voltaria a incluir contatos em
 * descanso sem aviso nenhum.
 *
 * `access_token` é `NOT NULL` desde a 001 — daí a string vazia em vez de
 * `NULL`. Quem impede o envio acidental é `resolveCloudConfig`, que
 * recusa canal `disabled` e token vazio **antes** do `decrypt()`.
 */
export async function removeCloudChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
  statusDetail: string
): Promise<RemoveOutcome> {
  const { data: channel, error: channelError } = await db
    .from('channels')
    .select('id, type')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (channelError) {
    throw new CloudChannelError(
      `Failed to read channel: ${channelError.message}`,
      500,
      'read_failed'
    );
  }
  if (!channel) {
    throw new CloudChannelError('Channel not found.', 404, 'not_found');
  }
  if (channel.type !== 'whatsapp_cloud') {
    throw new CloudChannelError(
      `Channel ${channelId} is a ${channel.type} channel, not an official WhatsApp number.`,
      400,
      'wrong_type'
    );
  }

  const { count, error: countError } = await db
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', channelId);

  if (countError) {
    throw new CloudChannelError(
      `Failed to count conversations: ${countError.message}`,
      500,
      'read_failed'
    );
  }

  // Contagem indisponível (`count` nulo sem erro) é tratada como "tem
  // conversa": desativar é reversível, apagar não é.
  const hasConversations = count === null || count > 0;

  if (!hasConversations) {
    const { error: deleteError } = await db
      .from('channels')
      .delete()
      .eq('id', channelId)
      .eq('account_id', accountId);

    if (deleteError) {
      throw new CloudChannelError(
        `Failed to delete channel: ${deleteError.message}`,
        500,
        'delete_failed'
      );
    }
    return 'deleted';
  }

  const { error: secretsError } = await db
    .from('whatsapp_config')
    .update({
      access_token: '',
      verify_token: null,
      status: 'disconnected',
      connected_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('channel_id', channelId)
    .eq('account_id', accountId);

  if (secretsError) {
    throw new CloudChannelError(
      `Failed to clear credentials: ${secretsError.message}`,
      500,
      'update_failed'
    );
  }

  // Só depois de o segredo estar zerado. Na ordem inversa, uma falha
  // no meio deixaria um canal `disabled` ainda guardando o token —
  // exatamente o que "remover" existe para evitar.
  //
  // `release_default_on_disable` / `elect_default_after_disable` (072
  // §7) cuidam do `is_default` sozinhas: nada aqui toca a coluna.
  const { error: disableError } = await db
    .from('channels')
    .update({
      status: 'disabled',
      status_detail: statusDetail,
      updated_at: new Date().toISOString(),
    })
    .eq('id', channelId)
    .eq('account_id', accountId);

  if (disableError) {
    throw new CloudChannelError(
      `Credentials were cleared but the channel could not be disabled: ${disableError.message}`,
      500,
      'update_failed'
    );
  }

  return 'disabled';
}
