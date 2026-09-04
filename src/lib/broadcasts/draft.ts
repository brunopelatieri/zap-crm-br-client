/**
 * Retomar um rascunho de disparo (SPEC 070 F1/F2).
 *
 * "Uma campanha, uma linha" (SPEC 070 §1.3): tudo aqui existe para que
 * `broadcasts.status = 'draft'` deixe de ser um beco sem saída. Duas
 * metades:
 *
 *   - PURAS (F1) — `hydrateAudienceConfig`, `describeDraftAudience`,
 *     `persistableAudience`, `hasDraftChanges`. Sem banco, sem `db`.
 *   - ACESSO A DADOS (F2) — `loadBroadcastDraft` / `saveBroadcastDraft`.
 *     Sempre com o cliente de SESSÃO (RLS), nunca `supabaseAdmin` — o
 *     mesmo raciocínio de `resolveStagedAudience` (`audience/resolve.ts`):
 *     o `broadcastId` chega de uma URL/corpo que o usuário controla, e o
 *     filtro explícito por `account_id` é redundância deliberada por
 *     cima da RLS, não acidental.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  type AudienceConfig,
  type CustomFieldOperator,
} from '@/lib/audience/estimate';
import type { VariableMapping } from '@/lib/whatsapp/broadcast-variables';
import {
  findTemplateRowForWaba,
  wabaIdOfChannel,
} from '@/lib/whatsapp/template-waba';
import type { BroadcastStatus, MessageTemplate } from '@/types';

import {
  isRecord,
  parseAudienceConfig,
  parseVariableMap,
} from './parse-audience';

export type VariableMap = Record<string, VariableMapping>;

// ------------------------------------------------------------
// F1 — funções puras
// ------------------------------------------------------------

/**
 * Contadores de `broadcast_audience_staging` para o rascunho, na forma
 * que o passo 2 (em modo edição) e `describeDraftAudience` consomem.
 */
export interface DraftAudienceSummary {
  /** Linhas marcadas `selected = true` na triagem. */
  selected: number;
  /** Total de linhas staged para este rascunho, selecionadas ou não. */
  total: number;
  /** Subconjunto de `total` com `invalid_reason` preenchido. */
  invalid: number;
  /**
   * A origem staged veio de uma planilha importada (marcador `csv` em
   * `audience_filter`, D-4), não de "todos/etiqueta/campo" nem de um
   * rascunho anterior a esta SPEC (D-10, sem marcador nenhum). Só
   * existe para `describeDraftAudience` escolher entre "Planilha
   * importada — X de Y" e "X de Y contatos já triados": as duas frases
   * descrevem o MESMO shape de `AudienceConfig` (`{type:'staged',
   * draftId}`) depois que `hydrateAudienceConfig` colapsa as duas
   * origens (§3.2, casos 2 e 3).
   */
  imported?: boolean;
}

/**
 * Reidrata a `AudienceConfig` de um rascunho a partir do que foi
 * persistido (SPEC 070 §3.2). Decide sem banco, sem I/O — quem chama
 * (`loadBroadcastDraft`) já leu `audience_filter` e contou o staging.
 *
 * A árvore de decisão da SPEC tem 4 ramos; aqui ficam 3 porque o ramo 2
 * ("`audienceFilter.type === 'csv'` + staging cheio") é subsumido pelo
 * ramo 3: `persistableAudience` NUNCA grava `csvContacts` de volta
 * (D-4), então o marcador `{type:'csv', importedRows:N}` reprova a
 * validação de `parseAudienceConfig` (que exige `csvContacts` para o
 * tipo `csv`) e cai direto no `stagedRowCount > 0` do ramo 3 — não há
 * caminho em que o ramo 2 dispara e o 3 não dispararia também.
 */
export function hydrateAudienceConfig(input: {
  broadcastId: string;
  /** `broadcasts.audience_filter` cru — JSONB, forma não confiável. */
  audienceFilter: unknown;
  /** `COUNT(*)` de `broadcast_audience_staging` para este rascunho. */
  stagedRowCount: number;
}): AudienceConfig {
  const { broadcastId, audienceFilter, stagedRowCount } = input;

  // Caso 1 — filtro válido é a origem verdadeira (tags, campo
  // personalizado, "todos", ou um `staged` legítimo). `contact_ids`
  // nunca passa por aqui: não está em `AUDIENCE_TYPES`
  // (`parse-audience.ts`), então `parseAudienceConfig` já devolve `null`
  // para ele — não é preciso filtrá-lo à mão. `csv` é excluído mesmo
  // quando validaria (defesa extra contra um `audience_filter` gravado
  // antes desta SPEC, ou por um bug, que tenha guardado `csvContacts`
  // de verdade: D-4 nunca deve ser confiado às cegas na leitura).
  const parsed = parseAudienceConfig(audienceFilter);
  if (parsed && parsed.type !== 'csv') {
    return parsed;
  }

  // Casos 2 e 3 — nada de origem confiável, mas o staging existe: é o
  // rascunho de importação (marcador `csv`) ou o rascunho anterior a
  // esta SPEC (D-10, sem `audience_filter` nenhum). Os dois reabrem
  // como "audiência já triada".
  if (stagedRowCount > 0) {
    return { type: 'staged', draftId: broadcastId };
  }

  // Caso 4 (D-12) — nem filtro, nem staging: o rascunho nasceu de
  // "checar antes de disparar" e a fila de checagem nunca chegou a
  // estagiar nada. `{type:'all'}` aqui NÃO significa "todos os
  // contatos foi escolhido" — é o valor neutro do formulário. Quem
  // marca a audiência como vazia para a UI é `describeDraftAudience`,
  // a partir de `DraftAudienceSummary.total === 0`, não um campo novo
  // em `AudienceConfig`.
  return { type: 'all' };
}

/**
 * O que o passo 2 mostra, em modo edição, para a audiência já
 * reidratada — como um descritor tipado (chave + parâmetros), não uma
 * string: a tradução (`messages/*.json`) e a resolução de nomes de
 * etiqueta (o componente já tem a lista carregada) ficam com quem
 * renderiza, para esta função continuar pura e testável sem i18n nem
 * banco (SPEC 070 §3.3).
 */
export type DraftAudienceDescription =
  | { key: 'tags'; tagIds: string[] }
  | {
      key: 'customField';
      fieldId: string;
      operator: CustomFieldOperator;
      value: string;
    }
  | { key: 'imported'; selected: number; total: number }
  | { key: 'staged'; selected: number; total: number }
  | { key: 'empty' };

export function describeDraftAudience(
  audience: AudienceConfig,
  summary: DraftAudienceSummary
): DraftAudienceDescription {
  if (audience.type === 'tags') {
    return { key: 'tags', tagIds: audience.tagIds ?? [] };
  }

  if (audience.type === 'custom_field' && audience.customField) {
    return {
      key: 'customField',
      fieldId: audience.customField.fieldId,
      operator: audience.customField.operator,
      value: audience.customField.value,
    };
  }

  // `staged` (as duas origens que `hydrateAudienceConfig` colapsa) e o
  // `all` neutro do caso vazio (D-12) só se distinguem pelo resumo do
  // staging — nunca pelo `type`.
  if (summary.total === 0) {
    return { key: 'empty' };
  }
  return summary.imported
    ? { key: 'imported', selected: summary.selected, total: summary.total }
    : { key: 'staged', selected: summary.selected, total: summary.total };
}

/**
 * Projeta uma `AudienceConfig` para o que `broadcasts.audience_filter`
 * pode guardar (SPEC 070 D-4). Espelha `audienceFilterOf`
 * (`broadcast-dispatch.ts`), com as duas exceções que a edição precisa:
 *
 *   - `csv` grava só o marcador `{type:'csv', importedRows:N}` — as
 *     linhas já vivem em `broadcast_audience_staging`, e duplicá-las em
 *     JSONB infla a linha de `broadcasts` em megabytes por nada;
 *   - `contact_ids` não persiste (`null`) — é construído só por código
 *     de servidor no disparo parcial (SPEC 069 R6) e nunca deveria
 *     voltar de um rascunho salvo pelo cliente.
 */
export function persistableAudience(
  audience: AudienceConfig
): Record<string, unknown> | null {
  if (audience.type === 'contact_ids') {
    return null;
  }

  if (audience.type === 'csv') {
    return {
      type: 'csv',
      importedRows: audience.csvContacts?.length ?? 0,
    };
  }

  return {
    type: audience.type,
    tagIds: audience.tagIds,
    customField: audience.customField,
    excludeTagIds: audience.excludeTagIds,
    draftId: audience.draftId,
  };
}

/** O que `hasDraftChanges` compara — o subconjunto editável do rascunho. */
export interface DraftSnapshot {
  name: string;
  templateName: string;
  templateLanguage: string;
  channelId: string | null;
  audience: AudienceConfig;
  variables: VariableMap;
  headerMediaUrl: string;
  checkBeforeSend: boolean;
}

/**
 * Comparação estrutural, não por referência (SPEC 070 §7): o estado do
 * assistente é reconstruído em cada render, então dois objetos
 * equivalentes com identidades diferentes não podem contar como
 * "mudou" — senão a confirmação de saída dispararia sempre, e o
 * usuário aprenderia a ignorá-la.
 */
export function hasDraftChanges(
  loaded: DraftSnapshot,
  current: DraftSnapshot
): boolean {
  return (
    loaded.name !== current.name ||
    loaded.templateName !== current.templateName ||
    loaded.templateLanguage !== current.templateLanguage ||
    loaded.channelId !== current.channelId ||
    loaded.headerMediaUrl !== current.headerMediaUrl ||
    loaded.checkBeforeSend !== current.checkBeforeSend ||
    !deepEqual(loaded.audience, current.audience) ||
    !deepEqual(loaded.variables, current.variables)
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key]
    )
  );
}

// ------------------------------------------------------------
// F2 — acesso a dados
// ------------------------------------------------------------

export type DraftLoadError =
  | 'not_found' // id inexistente, de outra conta (RLS), ou falha de leitura
  | 'not_a_draft' // scheduled / sending / sent / failed / streaming / awaiting_check
  | 'webhook_funnel' // source = 'webhook' — funil acumulado, não campanha editável
  | 'ab_variant'; // variant_label / parent_broadcast_id preenchidos (D-8)

export type DraftLoadResult =
  | { ok: true; draft: DraftHydration }
  | { ok: false; error: 'not_found' }
  /**
   * O `status` real, para a tela de aviso dizer a frase certa (§7).
   * Tipado como `Exclude<BroadcastStatus,'draft'>` (não `string`, achado
   * de code review) — é literalmente o que sobra depois do `if
   * (row.status !== 'draft')` abaixo, e é esse tipo estreito que permite
   * a quem consome este campo (a rota de edição) usar um `Record`
   * exaustivo em vez de um `switch` com `default`, que o compilador
   * nunca teria como cobrar quando `BroadcastStatus` ganhar um valor novo.
   */
  | {
      ok: false;
      error: 'not_a_draft';
      status: Exclude<BroadcastStatus, 'draft'>;
    }
  | { ok: false; error: 'webhook_funnel' }
  | { ok: false; error: 'ab_variant' };

export interface DraftHydration {
  broadcastId: string;
  name: string;
  /**
   * `null` quando `templateMissing` é `true` — o template foi apagado
   * ou saiu do WABA do canal (SPEC 070 §3.1). Recuperável: NÃO é um
   * `DraftLoadError`. O resto do rascunho (audiência, variáveis, mídia,
   * agendamento) reidrata normalmente; só o passo Template abre vazio,
   * com um aviso, em vez de jogar fora a triagem inteira.
   */
  template: MessageTemplate | null;
  templateMissing: boolean;
  channelId: string | null;
  audience: AudienceConfig;
  audienceSummary: DraftAudienceSummary;
  variables: VariableMap;
  headerMediaUrl: string;
  checkBeforeSend: boolean;
  scheduledAt: string | null;
}

/**
 * Lê e reidrata um rascunho (SPEC 070 §3.1). Roda com o cliente de
 * SESSÃO — a RLS de `broadcasts` (`is_account_member`, migração 017) já
 * garante que um id de outra conta não devolve linha, mas o
 * `.eq('account_id', accountId)` explícito fica mesmo assim: é a mesma
 * redundância deliberada de `resolveStagedAudience`, para a garantia
 * não depender só de quem chamou ter usado o cliente certo.
 */
export async function loadBroadcastDraft(
  db: SupabaseClient,
  params: { accountId: string; broadcastId: string }
): Promise<DraftLoadResult> {
  const { accountId, broadcastId } = params;

  const { data: row, error: rowError } = await db
    .from('broadcasts')
    .select(
      'id, name, status, source, variant_label, parent_broadcast_id, template_name, template_language, template_variables, audience_filter, channel_id, header_media_url, check_before_send, scheduled_at'
    )
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (rowError) {
    console.error('[draft] failed to load broadcast row:', rowError);
    return { ok: false, error: 'not_found' };
  }
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'draft') {
    return {
      ok: false,
      error: 'not_a_draft',
      status: row.status as Exclude<BroadcastStatus, 'draft'>,
    };
  }
  if (row.source === 'webhook') return { ok: false, error: 'webhook_funnel' };
  if (row.variant_label || row.parent_broadcast_id) {
    return { ok: false, error: 'ab_variant' };
  }

  // SPEC 065 §2.A A4 — resolvido pelo WABA do canal gravado no
  // rascunho, nunca por `.eq(name).eq(language).maybeSingle()`: o mesmo
  // nome+idioma pode existir em dois WABAs (migração 072), e essa
  // consulta quebra com "multiple rows" no segundo template homônimo.
  // `templateRow` pode vir `null` — ao contrário de antes, isso NÃO
  // interrompe a reidratação (§3.1, "recuperável, não fatal"): o resto
  // do rascunho continua sendo lido abaixo.
  const wabaId = await wabaIdOfChannel(db, accountId, row.channel_id);
  const templateRow = await findTemplateRowForWaba(db, {
    accountId,
    name: row.template_name as string,
    language: (row.template_language as string) ?? 'en_US',
    wabaId: wabaId ?? null,
  });

  const rawAudienceFilter = row.audience_filter;
  const [{ count: total }, { count: selected }, { count: invalid }] =
    await Promise.all([
      db
        .from('broadcast_audience_staging')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', broadcastId)
        .eq('account_id', accountId),
      db
        .from('broadcast_audience_staging')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', broadcastId)
        .eq('account_id', accountId)
        .eq('selected', true),
      db
        .from('broadcast_audience_staging')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', broadcastId)
        .eq('account_id', accountId)
        .not('invalid_reason', 'is', null),
    ]);

  const audience = hydrateAudienceConfig({
    broadcastId,
    audienceFilter: rawAudienceFilter,
    stagedRowCount: total ?? 0,
  });

  const audienceSummary: DraftAudienceSummary = {
    selected: selected ?? 0,
    total: total ?? 0,
    invalid: invalid ?? 0,
    imported: isRecord(rawAudienceFilter) && rawAudienceFilter.type === 'csv',
  };

  return {
    ok: true,
    draft: {
      broadcastId: row.id as string,
      name: (row.name as string) ?? '',
      template: (templateRow as MessageTemplate | null) ?? null,
      templateMissing: !templateRow,
      channelId: (row.channel_id as string | null) ?? null,
      audience,
      audienceSummary,
      variables: parseVariableMap(row.template_variables) ?? {},
      headerMediaUrl: (row.header_media_url as string | null) ?? '',
      checkBeforeSend: Boolean(row.check_before_send),
      scheduledAt: (row.scheduled_at as string | null) ?? null,
    },
  };
}

/**
 * Grava as alterações de um rascunho — `UPDATE`, nunca `INSERT`
 * (SPEC 070 §4). O `.eq('status','draft')` não é detalhe: é a mesma
 * pré-condição que `materializeArm`/`scheduleDashboardBroadcast` usam
 * para adotar um rascunho — sem ela, uma segunda aba poderia salvar por
 * cima de uma campanha que já saiu.
 *
 * `.maybeSingle()` (não `.single()`) para distinguir os dois erros que
 * o retorno promete: `.single()` também rejeita quando ZERO linhas
 * casam, o que aqui é `draft_not_found`, não `db_error`.
 */
export async function saveBroadcastDraft(
  db: SupabaseClient,
  params: {
    accountId: string;
    broadcastId: string;
    name: string;
    template: MessageTemplate;
    channelId: string | null;
    audience: AudienceConfig;
    variables: VariableMap;
    headerMediaUrl: string;
    checkBeforeSend: boolean;
  }
): Promise<
  { ok: true } | { ok: false; error: 'draft_not_found' | 'db_error' }
> {
  const {
    accountId,
    broadcastId,
    name,
    template,
    channelId,
    audience,
    variables,
    headerMediaUrl,
    checkBeforeSend,
  } = params;

  // Mesma verificação de `stageAudience` (`audience/stage.ts`): a RLS de
  // `broadcasts` autoriza pela CONTA do rascunho, não pelo dono do
  // canal — um `channelId` de outra conta satisfaria a FK sem isto.
  let verifiedChannelId: string | null = null;
  if (channelId) {
    const { data: channelRow } = await db
      .from('channels')
      .select('id')
      .eq('id', channelId)
      .eq('account_id', accountId)
      .maybeSingle();
    verifiedChannelId = channelRow ? channelId : null;
  }

  const { data: updated, error } = await db
    .from('broadcasts')
    .update({
      name: name.trim() || template.name,
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: persistableAudience(audience),
      header_media_url: headerMediaUrl || null,
      channel_id: verifiedChannelId,
      channel_source: verifiedChannelId ? 'resource' : 'default',
      check_before_send: checkBeforeSend,
    })
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .eq('status', 'draft')
    .select('id')
    .maybeSingle();

  if (error) return { ok: false, error: 'db_error' };
  if (!updated) return { ok: false, error: 'draft_not_found' };
  return { ok: true };
}
