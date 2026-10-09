/**
 * `renderSystemEmail(payload)` — puro, sem I/O (SPEC 063 §4.2).
 *
 * Regras que os testes (`render.test.ts`) travam:
 *   - em pt-BR, sem `next-intl` (o destinatário é o mantenedor, carregar
 *     o runtime de i18n num módulo de servidor puro só para isso é peso
 *     sem ganho);
 *   - texto primeiro (é o que o operador lê no celular), HTML mínimo
 *     inline, sem CSS externo/imagem remota/fonte web;
 *   - NENHUM dado de conversa ou contato no corpo — o aviso diz "a conta
 *     X estourou a quota", nunca quem é o contato (asserção negativa
 *     explícita no teste);
 *   - todo e-mail termina com o link direto para a conta no console.
 */

import { formatPlanPrice } from '@/lib/plans/format';
import type { SystemEventPayload } from '@/lib/notifications/types';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function consoleLink(accountId: string | null): string | null {
  if (!accountId) return null;
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  return `${base}/admin/accounts/${accountId}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '(data desconhecida)';
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

interface Rendered {
  /** Some no assunto, depois do nome da conta. */
  actionSubject: string;
  /** Linhas de detalhe do corpo, uma por item. */
  lines: string[];
}

function renderPlanChanged(p: SystemEventPayload): Rendered {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  const toPlanName = String(plan.toPlanName ?? plan.toPlanCode ?? '?');
  const cycle = plan.billingCycle === 'yearly' ? 'anual' : 'mensal';
  const priceCents =
    typeof plan.priceCents === 'number' ? plan.priceCents : null;
  const price =
    priceCents !== null
      ? formatPlanPrice(priceCents, String(plan.currency ?? 'BRL'), 'pt-BR')
      : null;
  return {
    actionSubject: `plano alterado para ${toPlanName} (${cycle})`,
    lines: [
      `Plano anterior: ${plan.fromPlanCode ?? '(nenhum)'}`,
      `Novo plano: ${toPlanName} (${plan.toPlanCode ?? ''})`,
      `Ciclo: ${cycle}${price ? ` — ${price}` : ''}`,
      `Próximo vencimento: ${formatDate(plan.currentPeriodEnd as string | undefined)}`,
    ],
  };
}

function renderPlanRequested(p: SystemEventPayload): Rendered {
  return {
    actionSubject: `solicitou o plano ${p.planName ?? p.planCode ?? '?'}`,
    lines: [
      `Plano solicitado: ${p.planName ?? '?'} (${p.planCode ?? '?'})`,
      p.message ? `Mensagem: ${p.message}` : 'Sem mensagem adicional.',
    ],
  };
}

function renderPlanCanceled(p: SystemEventPayload): Rendered {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  return {
    actionSubject: 'agendou o cancelamento do plano',
    lines: [
      `Plano atual: ${plan.planCode ?? '?'}`,
      `Acesso mantido até: ${formatDate(plan.currentPeriodEnd as string | undefined)}`,
    ],
  };
}

function renderPlanCancelReverted(p: SystemEventPayload): Rendered {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  return {
    actionSubject: 'reverteu o cancelamento do plano',
    lines: [`Plano: ${plan.planCode ?? '?'}`],
  };
}

function renderPlanCanceledApplied(p: SystemEventPayload): Rendered {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  return {
    actionSubject: `voltou para o plano ${plan.toPlanCode ?? '?'} (cancelamento efetivado)`,
    lines: [
      `Plano anterior: ${plan.fromPlanCode ?? '?'}`,
      `Plano atual: ${plan.toPlanCode ?? '?'}`,
    ],
  };
}

function renderPlanRenewed(p: SystemEventPayload): Rendered {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  return {
    actionSubject: 'teve o plano renovado',
    lines: [
      `Referência do pagamento: ${plan.paymentRef ?? '?'}`,
      `Períodos renovados: ${plan.periods ?? 1}`,
      `Novo vencimento: ${formatDate(plan.currentPeriodEnd as string | undefined)}`,
    ],
  };
}

function renderPlanExpiring(p: SystemEventPayload): Rendered {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  const days = plan.daysUntil ?? '?';
  return {
    actionSubject: `plano vence em ${days} dia(s)`,
    lines: [`Vencimento: ${formatDate(plan.periodEnd as string | undefined)}`],
  };
}

function renderPlanExpired(p: SystemEventPayload): Rendered {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  return {
    actionSubject: 'plano vencido — entrou em carência',
    lines: [
      `Venceu em: ${formatDate(plan.periodEnd as string | undefined)}`,
      `Carência até: ${formatDate(plan.graceUntil as string | undefined)}`,
    ],
  };
}

function renderPlanGraceEnded(p: SystemEventPayload): Rendered {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  return {
    actionSubject: 'carência encerrada (acesso não foi revogado)',
    lines: [
      `Carência terminou em: ${formatDate(plan.graceUntil as string | undefined)}`,
    ],
  };
}

function renderAccountBlocked(p: SystemEventPayload): Rendered {
  const block = (p.block ?? {}) as Record<string, unknown>;
  return {
    actionSubject: 'foi bloqueada',
    lines: [`Motivo: ${block.reason ?? '(nenhum motivo informado)'}`],
  };
}

function renderAccountUnblocked(): Rendered {
  return { actionSubject: 'foi desbloqueada', lines: [] };
}

function renderMemberBlocked(p: SystemEventPayload): Rendered {
  const block = (p.block ?? {}) as Record<string, unknown>;
  return {
    actionSubject: 'teve um usuário bloqueado',
    lines: [
      `Usuário: ${block.memberEmail ?? '?'}`,
      `Motivo: ${block.reason ?? '(nenhum motivo informado)'}`,
    ],
  };
}

function renderMemberUnblocked(p: SystemEventPayload): Rendered {
  const block = (p.block ?? {}) as Record<string, unknown>;
  return {
    actionSubject: 'teve um usuário desbloqueado',
    lines: [`Usuário: ${block.memberEmail ?? '?'}`],
  };
}

function renderQuotaExceeded(p: SystemEventPayload): Rendered {
  const quota = (p.quota ?? {}) as Record<string, unknown>;
  return {
    actionSubject: `estourou a quota de ${quota.metric ?? '?'}`,
    lines: [`Uso: ${quota.used ?? '?'} / limite: ${quota.limit ?? '?'}`],
  };
}

function renderAccountCreated(): Rendered {
  return { actionSubject: 'fez o primeiro acesso', lines: [] };
}

function renderAccountDeleted(p: SystemEventPayload): Rendered {
  const deletion = (p.deletion ?? {}) as Record<string, unknown>;
  const counts = (deletion.counts ?? {}) as Record<string, unknown>;
  // `detachedMembers.length`, não `counts.members` — o titular NÃO é um
  // membro desligado (ele é apagado, não movido para conta pessoal), e
  // `counts.members` conta só os não-donos desde o achado de code review
  // (route.ts:loadMemberIds), mas o dado mais direto para "quantos foram
  // desligados de fato" é a lista que a etapa 3 já produziu.
  const detachedCount = Array.isArray(deletion.detachedMembers)
    ? (deletion.detachedMembers as unknown[]).length
    : (counts.members ?? 0);
  const leftovers = Array.isArray(deletion.leftovers)
    ? (deletion.leftovers as unknown[]).map(String)
    : [];
  // A rota administrativa (`/api/platform/accounts/[id]/delete`) grava
  // `actor: consoleActorTag(email)` = `console:<email>`; a self-service
  // grava `self-service:<email>`. Achado de code review: esta função
  // ignorava `p.actor` e sempre dizia "pelo titular", mesmo quando quem
  // apagou foi o proprietário da plataforma pelo console.
  const byConsole =
    typeof p.actor === 'string' && p.actor.startsWith('console:');
  return {
    actionSubject: byConsole
      ? 'foi excluída pelo console do proprietário'
      : 'foi excluída pelo titular',
    lines: [
      // Exceção documentada à regra de privacidade do arquivo (mesmo
      // espírito de member.blocked/unblocked): SPEC 073 §5.4 pede
      // explicitamente o e-mail do titular no corpo deste evento — é a
      // única forma de identificar QUAL conta foi apagada quando o nome
      // não é único, e a conta em si já não existe mais para consultar.
      `Titular: ${p.account?.ownerEmail ?? '?'}`,
      `Contatos: ${counts.contacts ?? 0}`,
      `Conversas: ${counts.conversations ?? 0}`,
      `Mensagens: ${counts.messages ?? 0}`,
      `Canais: ${counts.channels ?? 0}`,
      `Membros desligados: ${detachedCount}`,
      ...(leftovers.length > 0 ? [`Pendências: ${leftovers.join('; ')}`] : []),
    ],
  };
}

const RENDERERS: Record<
  SystemEventPayload['type'],
  (p: SystemEventPayload) => Rendered
> = {
  'account.created': renderAccountCreated,
  'plan.changed': renderPlanChanged,
  'plan.requested': renderPlanRequested,
  'plan.canceled': renderPlanCanceled,
  'plan.cancel_reverted': renderPlanCancelReverted,
  'plan.canceled_applied': renderPlanCanceledApplied,
  'plan.renewed': renderPlanRenewed,
  'plan.expiring': renderPlanExpiring,
  'plan.expired': renderPlanExpired,
  'plan.grace_ended': renderPlanGraceEnded,
  'account.blocked': renderAccountBlocked,
  'account.unblocked': renderAccountUnblocked,
  'member.blocked': renderMemberBlocked,
  'member.unblocked': renderMemberUnblocked,
  'quota.exceeded': renderQuotaExceeded,
  'account.deleted': renderAccountDeleted,
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Aviso ao endereço ANTIGO depois que o suporte troca o e-mail de acesso
 * de um usuário (SPEC 078 §5.5, D-11). Troca de e-mail é a forma clássica
 * de tomada de conta; o titular antigo precisa ter como perceber.
 *
 * Diferente dos demais renderizadores, o destinatário aqui é o CLIENTE,
 * não o mantenedor. Por isso o corpo é deliberadamente enxuto: NÃO traz o
 * endereço novo (o aviso não pode virar um canal para confirmar a quem a
 * conta foi entregue), nem o nome da conta, nem link do console. A data é
 * a de São Paulo, o mesmo calendário do restante do console.
 */
export function renderEmailChangedNotice(changedAt: Date): RenderedEmail {
  const date = changedAt.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  });
  const subject = '[ZAP CRM BR] O e-mail de acesso da sua conta foi alterado';
  const sentences = [
    `O e-mail de acesso da sua conta no ZAP CRM BR foi alterado pelo suporte em ${date}.`,
    'Se você não reconhece esta alteração, responda a este e-mail.',
  ];
  return {
    subject,
    text: sentences.join('\n\n'),
    html: sentences.map((s) => `<p>${escapeHtml(s)}</p>`).join('\n'),
  };
}

export function renderSystemEmail(payload: SystemEventPayload): RenderedEmail {
  const accountName = payload.account?.name ?? 'Conta';
  const accountId = payload.account?.id ?? null;
  const renderer = RENDERERS[payload.type];
  const { actionSubject, lines } = renderer(payload);

  const subject = `[ZAP CRM BR] ${accountName} — ${actionSubject}`;
  // `account.deleted` dispara DEPOIS de `DELETE FROM accounts` — a conta
  // já não existe quando este e-mail é montado, então o link do console
  // seria sempre morto (achado de code review). Nenhum outro tipo de
  // evento tem essa característica.
  const link =
    payload.type === 'account.deleted' ? null : consoleLink(accountId);

  const textLines = [
    `Conta: ${accountName}`,
    `Evento: ${actionSubject}`,
    '',
    ...lines,
  ];
  if (link) {
    textLines.push('', `Abrir conta no console: ${link}`);
  }
  const text = textLines.join('\n');

  const htmlLines = [
    `<p><strong>Conta:</strong> ${escapeHtml(accountName)}</p>`,
    `<p><strong>Evento:</strong> ${escapeHtml(actionSubject)}</p>`,
    lines.length > 0
      ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
      : '',
    link
      ? `<p><a href="${escapeHtml(link)}">Abrir conta no console</a></p>`
      : '',
  ].filter(Boolean);
  const html = htmlLines.join('\n');

  return { subject, text, html };
}
