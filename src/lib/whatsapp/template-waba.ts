/**
 * Resolve a local `message_templates` row by (name, language) FOR A
 * SPECIFIC WABA (SPEC 064 D-2/F5).
 *
 * Why not `.eq('name', name).eq('language', language).maybeSingle()`
 *
 *   That was safe while `message_templates` only ever had one number
 *   per account (migration 072 didn't exist). With two WABAs on the
 *   same account, the same name+language legitimately exists TWICE —
 *   Meta scopes templates per WABA, not per account — and
 *   `.maybeSingle()` throws "multiple rows returned" the moment a
 *   second WABA gets its first same-named template.
 *
 * The adoption rule (same one `templates/sync/route.ts` already uses)
 *
 *   The row that already belongs to THIS WABA wins. Failing that, a
 *   legacy row (`waba_id IS NULL`, written before the 072 backfill)
 *   is adopted — it's the only candidate, so it must be the one this
 *   number sends. Never "the first row the query happens to return".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A regra de adoção, isolada (SPEC 064 D-2) — código de review achou a
 * mesma regra reimplementada dentro de `template-picker.tsx` (um
 * componente) só para FILTRAR uma lista, em vez de reutilizar esta.
 * "Lógica de negócio vive em `src/lib/`, não em componentes" (AGENTS.md)
 * — daqui em diante os dois caminhos (resolver UMA linha por
 * nome+idioma, ou filtrar uma LISTA por candidatos) chamam a mesma
 * função para decidir "esta linha serve para este canal?".
 */
export function templateBelongsToWaba(
  templateWabaId: string | null | undefined,
  channelWabaId: string | null
): boolean {
  const w = (templateWabaId ?? null) as string | null;
  return w === null || w === channelWabaId;
}

/**
 * As linhas locais de um mesmo nome+idioma, na conta. Extraída de
 * `findTemplateRowForWaba` para que `assertTemplateChannelCompatible`
 * (SPEC 065 D-3) faça exatamente A MESMA leitura — inclusive o escopo de
 * conta e o degrade abaixo — em vez de montar uma consulta parecida.
 *
 * Degrada, não propaga: todo chamador que `findTemplateRowForWaba`
 * substitui lia com `.maybeSingle()` sem checar `error` — uma falha
 * transitória de leitura virava "sem linha local" e o envio seguia sem
 * os componentes do template (caminho já suportado, ver `templateRow:
 * null` nos chamadores). Lançar aqui trocaria "um soluço do Supabase
 * manda a mensagem sem cabeçalho/botões" por "um soluço do Supabase
 * derruba a campanha inteira com 500".
 *
 * `null` = não deu para ler. Lista vazia = leu, e não há candidato.
 */
async function loadTemplateCandidates(
  db: SupabaseClient,
  params: { accountId: string; name: string; language: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[] | null> {
  const { accountId, name, language } = params;
  const { data, error } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', name)
    .eq('language', language);

  if (error) {
    console.error(
      `[template-waba] failed to read message_templates for ${name}/${language}:`,
      error
    );
    return null;
  }
  return data ?? [];
}

export async function findTemplateRowForWaba(
  db: SupabaseClient,
  params: {
    accountId: string;
    name: string;
    language: string;
    /** WABA of the channel resolving the send/edit. `null` matches only legacy rows. */
    wabaId: string | null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const { accountId, name, language, wabaId } = params;
  const candidates = await loadTemplateCandidates(db, {
    accountId,
    name,
    language,
  });

  if (!candidates?.length) return null;

  // `?? null` normaliza `undefined` (linha de teste/fixture sem a coluna,
  // ou um SELECT que não a trouxe) para o mesmo valor que a Meta/Postgres
  // devolvem quando ela é legítima — sem isto, um candidato legado sem a
  // chave `waba_id` no objeto nunca bateria com `null`.
  return (
    candidates.find((c) => (c.waba_id ?? null) === wabaId) ??
    candidates.find((c) => (c.waba_id ?? null) === null) ??
    null
  );
}

// ------------------------------------------------------------
// SPEC 065 §5.2/§5.3 — o WABA de um canal, e a guarda de saída
// ------------------------------------------------------------

/**
 * WABA de um canal, com TRÊS estados — e a diferença importa.
 *
 *   `'waba-a'`  o canal envia por este WABA;
 *   `null`      o canal tem credencial, mas sem `waba_id` gravado
 *               (linha anterior ao backfill da 072);
 *   `undefined` **não deu para saber**: canal sem linha de credencial,
 *               id de outra conta, nenhum canal escolhido, ou erro de
 *               leitura.
 *
 * Achatar `undefined` em `null` — que é o que `resolveWabaIdForChannel`
 * (`cloud-channels.ts`) faz de propósito, para chamadores best-effort —
 * mudaria o significado de "não sei" para "sei, e é nulo", e
 * `templateBelongsToWaba(x, null)` só aceita legado. O efeito seria a
 * lista de templates encolher para "só os legados" toda vez que a
 * consulta falhasse. É o achado de code review que
 * `template-picker.tsx:170-190` registra.
 */
export type ChannelWabaId = string | null | undefined;

/**
 * O `waba_id` do canal, sem nunca lançar (SPEC 065 §5.2).
 *
 * Mora aqui, e não em `templates-for-channel.ts` (onde a SPEC a nomeia),
 * por uma razão de grafo de imports: `templates-for-channel.ts` precisa
 * de `templateBelongsToWaba`, deste arquivo, e este arquivo precisa do
 * WABA do canal para o `assertTemplateChannelCompatible` abaixo. As duas
 * pontas no mesmo lugar fechariam um ciclo ESM com uma CLASSE no meio —
 * exatamente a armadilha de TDZ que `lib/channels/errors.ts` documenta.
 * `templates-for-channel.ts` a **reexporta**, então quem importa vê a
 * função no módulo que a SPEC indica, e a implementação é uma só.
 *
 * O escopo de conta está na consulta (`account_id` junto de
 * `channel_id`), como em todo `select` de `cloud-channels.ts`: um
 * `channel_id` de outra conta não devolve linha — vira `undefined`,
 * nunca o WABA alheio.
 */
export async function wabaIdOfChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string | null | undefined
): Promise<ChannelWabaId> {
  // Sem canal escolhido não há nada a consultar — e "nenhum canal" é o
  // caso mais comum de "não sei" (automação "Todos os números",
  // rascunho antigo, chamada de API sem `channel_id`).
  if (!channelId) return undefined;

  const { data, error } = await db
    .from('whatsapp_config')
    .select('waba_id')
    .eq('account_id', accountId)
    .eq('channel_id', channelId)
    .maybeSingle();

  if (error) {
    console.error(
      `[template-waba] failed to read waba_id for channel ${channelId}:`,
      error
    );
    return undefined;
  }
  // Linha ausente (canal órfão, canal de outra conta, canal não-Cloud)
  // é "não sei", não "WABA nulo".
  if (!data) return undefined;

  return (data.waba_id as string | null | undefined) ?? null;
}

/**
 * O template escolhido não pode ser enviado por este canal (SPEC 065 D-3).
 *
 * Código estável `template_waba_mismatch`, HTTP 400 — as rotas mapeiam,
 * a UI traduz. A mensagem fica em INGLÊS (AGENTS.md: `/api/**` fala
 * inglês) e nomeia AS DUAS pontas: sem os dois WABAs, o operador não
 * sabe se o certo é trocar o template ou trocar o número.
 */
export class TemplateChannelMismatchError extends Error {
  readonly code = 'template_waba_mismatch' as const;
  readonly status = 400 as const;
  readonly templateName: string;
  readonly templateWabaId: string | null;
  readonly channelId: string;
  readonly channelWabaId: string | null;

  constructor(params: {
    templateName: string;
    templateWabaId: string | null;
    channelId: string;
    channelWabaId: string | null;
  }) {
    super(
      `Template "${params.templateName}" belongs to WhatsApp Business Account ` +
        `${params.templateWabaId ?? 'unknown'}, but channel ${params.channelId} ` +
        `sends through ${params.channelWabaId ?? 'no WABA on file'}. ` +
        `Pick a template from the same WABA, or send through another number.`
    );
    this.name = 'TemplateChannelMismatchError';
    this.templateName = params.templateName;
    this.templateWabaId = params.templateWabaId;
    this.channelId = params.channelId;
    this.channelWabaId = params.channelWabaId;
  }
}

/**
 * Recusa, ANTES da Meta, o par (template, canal) que ela rejeitaria
 * (SPEC 065 D-3).
 *
 * Filtrar a lista na tela resolve o caminho feliz. Não resolve rascunho
 * antigo, chamada de API, automação cujo canal foi trocado depois, nem
 * campanha agendada cujo template foi recriado em outro WABA — e é o
 * servidor o único ponto por onde os cinco caminhos passam. Sem isto, o
 * erro só aparece como `(#132001) Template name does not exist in the
 * translation` no log de falhas, depois de a tentativa já ter sido
 * contabilizada.
 *
 * **Só recusa o que consegue PROVAR.** Três silêncios deliberados:
 *
 *   - **nome inexistente na tabela local** — enviar template sem linha
 *     local é caminho suportado (`templateRow: null` nos chamadores,
 *     corpo simples). Não há mismatch a provar;
 *   - **WABA do canal desconhecido** (`undefined`: canal órfão, id de
 *     outra conta, sem canal escolhido) — quem recusa canal de outra
 *     conta é `resolveCloudConfig`, com `not_found`, e nada é enviado.
 *     Devolver `template_waba_mismatch` ali daria ao operador o erro
 *     ERRADO sobre o problema certo;
 *   - **erro de leitura** — mesmo raciocínio de `loadTemplateCandidates`:
 *     um soluço do Supabase não pode derrubar campanha legítima com um
 *     400 inventado.
 *
 * A decisão em si continua sendo `templateBelongsToWaba`, uma vez só.
 */
export async function assertTemplateChannelCompatible(
  db: SupabaseClient,
  params: {
    accountId: string;
    /** Canal que VAI enviar. `null`/ausente = ninguém escolheu (§5.3). */
    channelId: string | null | undefined;
    templateName: string;
    templateLanguage: string;
    /**
     * WABA do canal, quando o chamador JÁ o resolveu (achado de code
     * review). `resolveCloudConfig`/`loadWhatsappConfig`/
     * `resolveChannelForConversation` devolvem `waba_id` como parte da
     * credencial, momentos antes de todo chamador desta função — sem
     * este atalho, `wabaIdOfChannel` reconsultava `whatsapp_config` do
     * zero em cada um dos seis pontos de chamada, inclusive no caminho
     * quente de `automations/meta-send.ts` (uma vez por passo
     * `send_template` executado). Ausente = resolve aqui, como sempre;
     * `undefined` explícito tem o mesmo efeito que omitir o campo.
     */
    channelWabaId?: ChannelWabaId;
  }
): Promise<void> {
  const { accountId, channelId, templateName, templateLanguage } = params;

  const channelWabaId =
    params.channelWabaId !== undefined
      ? params.channelWabaId
      : await wabaIdOfChannel(db, accountId, channelId);
  if (channelWabaId === undefined) return;

  const candidates = await loadTemplateCandidates(db, {
    accountId,
    name: templateName,
    language: templateLanguage,
  });
  if (!candidates?.length) return;

  if (candidates.some((c) => templateBelongsToWaba(c.waba_id, channelWabaId))) {
    return;
  }

  throw new TemplateChannelMismatchError({
    templateName,
    // Todos os candidatos são incompatíveis; o primeiro basta para
    // nomear a outra ponta na mensagem.
    templateWabaId: (candidates[0].waba_id ?? null) as string | null,
    channelId: channelId as string,
    channelWabaId,
  });
}
