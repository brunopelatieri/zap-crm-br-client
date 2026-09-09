/**
 * A regra de decisão de "apagar mensagem" (SPEC 074 §4). Função pura,
 * sem Supabase e sem `fetch` — a rota (`/api/inbox/messages/[id]/delete`)
 * é quem chama isto e traduz o resultado em HTTP.
 *
 * O fato que decide o desenho inteiro (§1): a Cloud API não tem endpoint
 * de revogação — só o canal QRCode (Evolution) revoga de verdade. Por
 * isso não existe mais um modo "apagar só no CRM" (D-1): apagar SEMPRE
 * marca a mensagem; o que varia é se há endpoint do provedor a disparar.
 */

import { can } from '@/lib/channels/capabilities';
import { hasMinRole } from '@/lib/auth/roles';
import type { AccountRole } from '@/lib/auth/roles';
import type { ChannelType } from '@/lib/channels/types';
import type { Message, MessageDeletionProviderOutcome } from '@/types';

export type DeleteRefusal =
  | 'not_outbound' // mensagem do contato — não se revoga o que não é seu
  | 'no_permission' // viewer, ou conta bloqueada
  | 'nothing_to_do'; // já marcada e o papel não pode excluir

export type DeletePlan =
  | {
      action: 'delete';
      /** Dispara o endpoint do provedor? Só quando o canal revoga E há
       *  id do provedor E o envio não ficou pendurado em sending/failed. */
      revoke: boolean;
      /** Já marcada: ao admin resta só excluir do sistema. */
      alreadyMarked: boolean;
      /** O papel permite remover a linha (admin+, D-14/D-16). */
      canPurge: boolean;
      /** Mais de 48h: o WhatsApp provavelmente não removerá do aparelho (D-5). */
      warnStaleness: boolean;
    }
  | { action: 'refuse'; reason: DeleteRefusal };

const STALENESS_HOURS = 48;

export interface PlanDeletionInput {
  channelType: ChannelType;
  senderType: Message['sender_type'];
  status: Message['status'];
  providerMessageId: string | null;
  deletedAt: string | null;
  /**
   * Desfecho ATUAL de exibição (`messages.deletion_scope`), quando
   * `deletedAt` já está preenchido. Decide se um agente comum ainda tem
   * o que fazer numa mensagem já marcada: só "Tentar de novo" sobre uma
   * revogação que falhou — qualquer outro caso é admin+ (excluir do
   * sistema, ou nada mesmo).
   */
  deletionScope?: Message['deletion_scope'];
  ageHours: number;
  role: AccountRole;
  /** Conta bloqueada (SPEC 062) — mesmo efeito de "sem permissão". */
  accountBlocked?: boolean;
}

export function planDeletion(input: PlanDeletionInput): DeletePlan {
  const {
    channelType,
    senderType,
    status,
    providerMessageId,
    deletedAt,
    deletionScope,
    ageHours,
    role,
    accountBlocked = false,
  } = input;

  // 1. Viewer, ou conta bloqueada — sem permissão de escrita nenhuma.
  if (!hasMinRole(role, 'agent') || accountBlocked) {
    return { action: 'refuse', reason: 'no_permission' };
  }

  // 2. Mensagem do contato — não há o que revogar no aparelho alheio, e
  //    "sumir com a fala do cliente" é adulteração de registro (D-4).
  if (senderType === 'customer') {
    return { action: 'refuse', reason: 'not_outbound' };
  }

  // 3. Já marcada — um agente comum ainda pode "Tentar de novo" sobre
  //    uma revogação que FALHOU (mesmo botão do §7.1: "revoke_failed +
  //    agent... botão Tentar de novo"); qualquer outro caso de mensagem
  //    já marcada (revogada com sucesso, canal sem suporte, ou excluir
  //    do sistema) é admin+.
  //
  //    Achado de code review: a versão anterior recusava TODO agente
  //    aqui, sem exceção — a UI oferecia "Tentar de novo" para qualquer
  //    agente (mesmo gate de `canSend` do botão "Apagar"), mas a rota
  //    sempre devolvia 400 `nothing_to_do` para quem não era admin,
  //    quebrando exatamente o cenário que o botão existe para cobrir.
  if (
    deletedAt &&
    !hasMinRole(role, 'admin') &&
    deletionScope !== 'revoke_failed'
  ) {
    return { action: 'refuse', reason: 'nothing_to_do' };
  }

  // 4. Apagar sempre marca. `revoke` decide só se HÁ endpoint a disparar.
  const revoke =
    can(channelType, 'deleteForEveryone') &&
    !!providerMessageId &&
    status !== 'sending' &&
    status !== 'failed';

  return {
    action: 'delete',
    revoke,
    alreadyMarked: !!deletedAt,
    canPurge: hasMinRole(role, 'admin'),
    warnStaleness: revoke && ageHours > STALENESS_HOURS,
  };
}

/**
 * O botão "Reenviar" (§8) existe para os tipos que a SPEC cobre — texto,
 * mídia e template. Locação e interativo ficam de fora: a SPEC não
 * desenha reenvio para eles, e reconstruir um payload interativo a
 * partir do que sobrou na linha seria dado derivado, não reenvio.
 *
 * Mídia (D-9): o botão fica AUSENTE sem `media_path` — melhor ausente
 * do que quebrado. Não checa se o objeto ainda existe no bucket (isso
 * exigiria uma requisição); a retenção derrubando o objeto depois do
 * envio é a janela que continua sem cobertura aqui.
 */
export function canResendMessage(message: {
  content_type: Message['content_type'];
  content_text?: string | null;
  media_path?: string | null;
}): boolean {
  switch (message.content_type) {
    case 'text':
      return !!message.content_text;
    case 'template':
      return true;
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
      return !!message.media_path;
    default:
      return false;
  }
}

/**
 * O eixo de EXIBIÇÃO de `deletion_scope`/`provider_outcome` só tem os
 * três desfechos do §1.3 — não existe balão para "nunca chegou ao
 * provedor". `'not_attempted'` (mensagem sem id do provedor, ou
 * pendurada em sending/failed) colapsa para `'not_supported'`, o mesmo
 * texto de "nada a revogar" — o log (`message_deletion_log`) continua
 * com o valor preciso, sem colapsar nada.
 *
 * Compartilhado entre a rota (grava `messages.deletion_scope`) e a UI
 * (atualização otimista do balão) — achado de code review: as duas
 * reimplementavam o mesmo mapeamento de três linhas em lugares
 * diferentes, e era fácil atualizar um e esquecer o outro.
 */
export function deletionScopeFor(
  providerOutcome: MessageDeletionProviderOutcome
): 'revoked' | 'not_supported' | 'revoke_failed' {
  return providerOutcome === 'not_attempted'
    ? 'not_supported'
    : providerOutcome;
}

/** D-15: 120 caracteres, sempre — é o que faz `message_deletion_log`
 *  responder "o que foi apagado". Compartilhado entre a rota (marcar
 *  pelo agente) e `revoke-by-contact.ts` (marcar pelo contato) — achado
 *  de code review: o segundo reimplementava a mesma regra com um
 *  `slice(0, 120)` cru, sem o guard de nulo. */
export const CONTENT_PREVIEW_MAX = 120;

export function truncatePreview(
  text: string | null | undefined
): string | null {
  if (!text) return null;
  return text.length > CONTENT_PREVIEW_MAX
    ? text.slice(0, CONTENT_PREVIEW_MAX)
    : text;
}

/**
 * Nome de arquivo plausível — mesmo critério de
 * `src/lib/inbox/export/model.ts` (`DOCUMENT_FILENAME_PATTERN`): "uma
 * linha só, termina em `.extensão`". `content_text` de um documento
 * guarda o que a Meta mandou como `caption` OU `filename` — as duas
 * coisas passam pelo mesmo campo, e um documento recebido com legenda
 * ("Aqui está o contrato revisado") não tem cara de nome de arquivo
 * nenhum.
 */
const DOCUMENT_FILENAME_PATTERN = /^[^\n]{1,120}\.[a-z0-9]{1,8}$/i;

const RESEND_EXTENSION_FALLBACK: Record<
  'image' | 'video' | 'audio' | 'document',
  string
> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'ogg',
  document: 'bin',
};

/**
 * Nome de arquivo para o reenvio de mídia (§8). Achado de code review:
 * a versão anterior usava `content_text` cru como nome sempre que o
 * tipo era `document`, sem checar se aquele texto de fato parecia um
 * nome de arquivo — um documento cuja `content_text` era uma legenda em
 * prosa virava o nome literal do arquivo reenviado (e, ao mesmo tempo,
 * a legenda do rascunho de reenvio — duplicado, dos dois jeitos errado).
 */
export function deriveResendFilename(message: {
  content_type: Message['content_type'];
  content_text?: string | null;
}): string {
  const trimmed = message.content_text?.trim();
  if (
    message.content_type === 'document' &&
    trimmed &&
    DOCUMENT_FILENAME_PATTERN.test(trimmed)
  ) {
    return trimmed;
  }
  const kind = message.content_type as keyof typeof RESEND_EXTENSION_FALLBACK;
  const ext = RESEND_EXTENSION_FALLBACK[kind] ?? 'bin';
  return `${kind}.${ext}`;
}
