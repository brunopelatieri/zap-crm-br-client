import { withSignedHeaderMedia } from '@/lib/whatsapp/header-media';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import type { MessageTemplate, TemplatePreviewPayload } from '@/types';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import {
  assertTemplateChannelCompatible,
  findTemplateRowForWaba,
} from '@/lib/whatsapp/template-waba';
import { renderTemplateText } from '@/lib/whatsapp/template-send-builder';
import { resolveOutboundContact } from '@/lib/channels/send';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send';
import {
  resolveChannelForConversation,
  sendAndPersistOutbound,
} from '@/lib/channels/send';
import { supabaseAdmin } from './admin-client';

// ------------------------------------------------------------
// Automation-side sender.
//
// Usa o cliente de service-role (o motor não tem cookies) e aceita os
// identificadores de usuário / conversa / contato que o motor já tem em
// mãos.
//
// Desde a F2 (PRD 047 / SPEC 048 §5) o esqueleto de envio vive em
// `lib/channels/send.ts` e a chamada ao provedor passa pelo adaptador do
// canal. O que continua aqui é o que é DESTE motor: carregar a linha
// local do template, assinar o header de mídia e montar o
// `template_preview` da bolha.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string;
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string;
  conversationId: string;
  contactId: string;
  text: string;
}

interface SendTemplateArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  templateName: string;
  language?: string;
  params?: string[];
}

export async function engineSendText(
  args: SendTextArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' });
}

export async function engineSendTemplate(
  args: SendTemplateArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' });
}

interface SendInteractiveArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  payload: InteractiveMessagePayload;
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args;
  // SPEC 064 §11.1 — sem isto, o log estruturado gravava TODO envio
  // interativo de automação como `origin: 'flow'` (o padrão da função
  // que este arquivo delega para), poluindo a auditoria de "qual motor
  // mandou esta mensagem".
  const common = {
    accountId,
    userId,
    conversationId,
    contactId,
    origin: 'automation' as const,
  };
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    });
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  });
}

type SendInput =
  (SendTextArgs & { kind: 'text' }) | (SendTemplateArgs & { kind: 'template' });

async function sendViaMeta(
  input: SendInput
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin();

  // O escopo por `account_id` (e não por `user_id`) do contato e das
  // credenciais é aplicado dentro de `lib/channels/send.ts` — ver lá o
  // porquê: o motor usa service-role, com a RLS desligada.
  //
  // ⚠️ Diferença de ORDEM em relação ao código anterior à F2: a linha do
  //    template e a assinatura do header passaram a ser resolvidas ANTES
  //    da validação do contato (antes vinham depois). Nada observável
  //    muda — as duas primeiras são leituras —, exceto o texto do erro
  //    quando contato E header de mídia estão quebrados ao mesmo tempo.
  //
  // ⚠️ SPEC 064 D-2: para `kind: 'template'` o CANAL da conversa também
  //    passa a ser resolvido aqui (para saber o WABA e escolher a linha
  //    certa de `message_templates`) — antes só era resolvido dentro de
  //    `sendAndPersistOutbound`, mais abaixo. `resolveChannelForConversation`
  //    roda de novo lá (sem canal explícito, cai no mesmo resultado): uma
  //    segunda leitura, não uma segunda fonte de verdade.
  //
  //    Achado de code review: uma falha aqui (conta bloqueada, canal
  //    apagado) NÃO deve subir direto — faria o erro "furar a fila" na
  //    frente da validação do CONTATO, que `sendAndPersistOutbound`
  //    sempre roda primeiro (`resolveOutboundContact` antes de resolver
  //    canal, ver `channels/send.ts`). Um contato inválido E uma conta
  //    bloqueada ao mesmo tempo passaria a logar "conta bloqueada" em vez
  //    de "contato não encontrado" — motivo errado no `automation_logs`.
  //    Por isso o catch abaixo degrada para `wabaId: null` (mesmo efeito
  //    de "sem WABA conhecido" — cai na linha legada ou em nenhuma) e
  //    deixa a resolução de verdade, na ORDEM original, acontecer dentro
  //    de `sendAndPersistOutbound` mais abaixo.
  let templateRow: MessageTemplate | null = null;
  if (input.kind === 'template') {
    let wabaId: string | null = null;
    // Só vale a pena consultar `message_templates` quando o canal
    // resolvido é Cloud — nenhum outro tipo (hoje, `whatsapp_qr`)
    // suporta template (`capabilities.ts`), e `sendContentViaChannel`
    // vai recusar o envio mais abaixo de qualquer forma. `true` por
    // padrão: se a resolução falhar (branch acima), não sabemos o tipo
    // do canal — tentar a consulta best-effort com `wabaId: null` é
    // inofensivo e mantém o comportamento anterior a este ajuste.
    let mayHaveTemplate = true;
    // Guardado fora do `try` para o assert do D-3 poder rodar DEPOIS
    // dele: dentro, o catch degradaria justamente o erro que se quer
    // ver.
    let resolvedChannelId: string | null = null;
    try {
      // Escopado por WABA (SPEC 064 D-2): com dois números na mesma
      // conta, name+language pode bater em DUAS linhas (uma por WABA) —
      // resolve o canal DA CONVERSA primeiro para saber qual delas é a
      // certa. Antes desta correção a consulta ignorava por completo o
      // WABA do canal, o que arriscava adotar a linha errada (ou
      // estourar em "multiple rows" se o Supabase tivesse `.single()`).
      // Mesmo padrão de `send-message.ts`.
      const { ctx: channelCtx, configRow } =
        await resolveChannelForConversation(
          db,
          input.accountId,
          input.conversationId
        );
      resolvedChannelId = channelCtx.channel.id;
      const isCloud = channelCtx.channel.type === 'whatsapp_cloud';
      wabaId = isCloud
        ? ((configRow?.waba_id as string | null | undefined) ?? null)
        : null;
      mayHaveTemplate = isCloud;
    } catch {
      // Ver o comentário acima da função: degrada, não propaga.
    }
    // SPEC 065 D-3 — recusa aqui, com motivo legível no
    // `automation_logs`, o par (template, canal) que a Meta rejeitaria
    // com `(#132001) Template name does not exist in the translation`
    // depois de aceitar o payload. Acontece quando o canal da automação
    // foi trocado depois de o passo ser montado, ou quando o template
    // foi recriado em outro WABA.
    //
    // Fora do `try` acima de propósito: `TemplateChannelMismatchError`
    // é o erro que se QUER propagar, e o catch dali existe para degradar
    // falhas de infraestrutura. Ele só lança sobre o que consegue provar
    // (ver o cabeçalho da função), então um canal não resolvido aqui —
    // `resolvedChannelId` nulo — não vira recusa.
    if (mayHaveTemplate && resolvedChannelId) {
      // O contato é validado ANTES (achado de code review): a regra de
      // ordem documentada no topo desta função diz que nenhum erro pode
      // furar a fila na frente da validação do CONTATO, que
      // `sendAndPersistOutbound` sempre roda primeiro. Sem esta linha,
      // um passo com contato apagado E template de outro WABA passava a
      // registrar `template_waba_mismatch` no `automation_logs` em vez
      // de "contact not found" — o operador consertava o template e o
      // passo falhava de novo, agora pelo motivo verdadeiro.
      //
      // Custa um SELECT indexado a mais, repetido dentro de
      // `sendAndPersistOutbound`. É a mesma troca que o comentário do
      // canal acima já aceita: uma segunda leitura, não uma segunda
      // fonte de verdade.
      await resolveOutboundContact(db, input.accountId, input.contactId);

      await assertTemplateChannelCompatible(db, {
        accountId: input.accountId,
        channelId: resolvedChannelId,
        templateName: input.templateName,
        templateLanguage: input.language || 'en_US',
      });
    }
    if (mayHaveTemplate) {
      const data = await findTemplateRowForWaba(db, {
        accountId: input.accountId,
        name: input.templateName,
        language: input.language || 'en_US',
        wabaId,
      });
      if (data && isMessageTemplate(data)) templateRow = data;
    }
  }

  // Header de mídia: o bucket virou privado na migração 040, então a
  // URL guardada no template não é mais buscável pela Meta. Assina uma
  // vez, fora do laço de variantes, para não gerar uma assinatura nova a
  // cada telefone tentado.
  const templateSendParams = await withSignedHeaderMedia(
    db,
    templateRow ?? undefined
  );

  // Persist the sent message so it appears in the inbox with a real
  // provider message id. sender_type='bot' distinguishes automation
  // sends from manual agent sends.
  // Templates: when the local row was found, resolve header/body/footer/
  // buttons into `template_preview` (mirrors sendMessageToConversation,
  // migration 037) so the bubble renders the template in full instead of
  // an empty "Template" badge. Automations only carry positional body
  // params — a text-header {{1}} has no value source here, so it keeps
  // its placeholder (visible, not wrong).
  let templatePreview: TemplatePreviewPayload | null = null;
  let renderedBody: string | null = null;
  if (input.kind === 'template' && templateRow) {
    renderedBody = renderTemplateText(
      templateRow.body_text,
      input.params ?? []
    );
    const headerMediaType =
      templateRow.header_type === 'image' ||
      templateRow.header_type === 'video' ||
      templateRow.header_type === 'document'
        ? templateRow.header_type
        : null;
    templatePreview = {
      header:
        templateRow.header_type === 'text' && templateRow.header_content
          ? templateRow.header_content
          : undefined,
      headerMedia:
        headerMediaType && templateRow.header_media_url
          ? { type: headerMediaType, url: templateRow.header_media_url }
          : undefined,
      body: renderedBody,
      footer: templateRow.footer_text,
      buttons: templateRow.buttons,
    };
  }

  const content_type = input.kind === 'template' ? 'template' : 'text';
  const content_text = input.kind === 'text' ? input.text : renderedBody;
  const template_name = input.kind === 'template' ? input.templateName : null;

  return sendAndPersistOutbound({
    db,
    accountId: input.accountId,
    origin: 'automation',
    conversationId: input.conversationId,
    contactId: input.contactId,
    content:
      input.kind === 'template'
        ? {
            kind: 'template',
            templateName: input.templateName,
            language: input.language,
            // A linha local é o que faz header de mídia e botão de URL
            // com variável chegarem ao destinatário; sem ela o envio cai
            // no caminho legado de corpo simples (`positionalParams`).
            definition: templateRow ?? undefined,
            components: templateSendParams,
            positionalParams: input.params,
          }
        : { kind: 'text', text: input.text },
    persist: {
      senderType: 'bot',
      contentType: content_type,
      contentText: content_text,
      previewText:
        input.kind === 'template'
          ? (renderedBody ?? `[template:${input.templateName}]`)
          : input.text,
      extra: { template_name, template_preview: templatePreview },
    },
  });
}
