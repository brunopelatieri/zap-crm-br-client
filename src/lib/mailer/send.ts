/**
 * Cola config + transporte + render num único ponto de entrada para o
 * despacho (SPEC 063 §5). Server-only.
 *
 * Nunca lança — todo erro (SMTP indisponível, autenticação, timeout)
 * vira `{ ok: false, error }`, que `dispatch.ts` transforma em recuo.
 */

import { readMailerConfig } from './config';
import { getMailTransport } from './transport';
import { renderEmailChangedNotice, renderSystemEmail } from './render';
import type { SystemEventPayload } from '@/lib/notifications/types';

export interface SendOutcome {
  ok: boolean;
  /** `true` = sem SMTP configurado — não é falha, é canal desligado. */
  skipped: boolean;
  error?: string;
}

export async function deliverSystemEmail(
  payload: SystemEventPayload
): Promise<SendOutcome> {
  const config = readMailerConfig();
  if (!config) {
    return { ok: true, skipped: true };
  }

  try {
    // `renderSystemEmail` DENTRO do `try`: achado de code review — um
    // `payload.type` que não bate mais com nenhum `SystemEventType`
    // (linha antiga na outbox, sobrevivendo a uma renomeação/remoção de
    // tipo futura) faria `RENDERERS[payload.type]` ser `undefined` e o
    // `renderer(payload)` lançar. Fora do `try`, esse lançamento nunca
    // vira `{ok:false, error}` — o chamador (`dispatch.ts`) já reivindicou
    // a linha (o lease de `next_attempt_at` já avançou) antes de chegar
    // aqui, então a linha reentraria no ciclo sem NUNCA incrementar
    // `attempts`: um retry silencioso infinito a cada lease, que nunca
    // chega a `failed`.
    const { subject, text, html } = renderSystemEmail(payload);
    const transporter = getMailTransport(config);
    await transporter.sendMail({
      from: config.from,
      to: config.to,
      subject,
      text,
      html,
    });
    return { ok: true, skipped: false };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Avisa o endereço ANTIGO de que o e-mail de acesso foi trocado pelo
 * suporte (SPEC 078 §5.5, D-11). Diferente de `deliverSystemEmail`, o
 * destinatário é explícito (o cliente, não o mantenedor); transporte e
 * `.env` são os mesmos, então sem SMTP o canal fica desligado
 * (`skipped`, com o aviso único de `readMailerConfig`) — a troca de
 * e-mail NUNCA falha por causa do aviso, e o chamador só registra o
 * desfecho.
 *
 * `replyTo` é o endereço do mantenedor (`SYSTEM_NOTIFICATION_EMAIL`): o
 * "responda a este e-mail" do corpo chega a quem pode investigar, mesmo
 * quando o remetente é um `noreply`.
 */
export async function deliverEmailChangeNotice(
  to: string,
  changedAt: Date = new Date()
): Promise<SendOutcome> {
  const config = readMailerConfig();
  if (!config) {
    return { ok: true, skipped: true };
  }

  try {
    const { subject, text, html } = renderEmailChangedNotice(changedAt);
    await getMailTransport(config).sendMail({
      from: config.from,
      to,
      replyTo: config.to,
      subject,
      text,
      html,
    });
    return { ok: true, skipped: false };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
