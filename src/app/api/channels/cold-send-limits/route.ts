/**
 * GET /api/channels/cold-send-limits
 *
 * Tetos de segurança para envio frio em instância não-oficial
 * (PRD 047 §10.3). Quem configura é o dono do sistema, pelo `.env` do
 * deployment; quem PRECISA ver é o cliente, que está montando a
 * automação e tem de saber com que volume pode contar.
 *
 * Por que uma rota, e não uma constante no bundle
 *
 *   `process.env` não existe no browser, e prefixar estas variáveis com
 *   NEXT_PUBLIC_ as congelaria no build — trocar um teto exigiria
 *   rebuild. Uma rota lê o valor vigente a cada chamada.
 *
 * Não há segredo aqui: a resposta são cinco números que descrevem uma
 * política de uso. O piso é a associação à conta (`viewer`), o mesmo de
 * /api/whatsapp/messaging-limit, porque a informação é de leitura e
 * aparece em telas que o viewer abre.
 *
 * `instances` — consumo por instância (SPEC 049 §6.2, F6.1)
 *
 *   Os cinco números acima descrevem a POLÍTICA da CONTA — o que vale
 *   para uma instância hipotética sem override próprio, usado onde
 *   ainda não há canal escolhido (o aviso do construtor de automações).
 *   `instances` descreve o CONSUMO por canal, já com o override daquele
 *   canal aplicado quando existir — o que a aba WhatsApp QRCode (F3)
 *   precisa para desenhar a barra e o selo de aquecimento. Só canais
 *   `whatsapp_qr`: é o único tipo onde o teto se aplica (a Meta já
 *   regula o resto).
 *
 * ✅ Correção (SPEC 069, code review): esta rota resolvia os tetos só
 * pelo `.env` (`readColdSendLimits`, níveis 2/3), enquanto o ENVIO em
 * si (`checkColdSend`, `cold-send-wiring.ts`) já percorre a cascata de
 * quatro níveis (instância → conta → `.env` → código, F2). Um override
 * de instância ou de conta feito pelo dono no painel de limites por
 * canal mudava o que era de fato aplicado no envio, mas esta tela
 * continuava mostrando o número antigo — o selo "aquecendo" e o
 * restante do dia podiam discordar do que o próximo envio realmente
 * respeitaria. Trocado para `resolveColdSendLimits`, a mesma função que
 * `checkColdSend` usa.
 */

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { evaluateColdSend } from '@/lib/channels/cold-send-limit';
import { resolveColdSendLimits } from '@/lib/channels/cold-send-resolve';
import { loadColdSendUsage } from '@/lib/channels/cold-send-usage';
import { createLimitsCache } from '@/lib/limits/load';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    const cache = createLimitsCache();

    const { limits } = await resolveColdSendLimits(
      ctx.supabase,
      { accountId: ctx.accountId },
      cache
    );

    const { data: channels } = await ctx.supabase
      .from('channels')
      .select('id, name, status')
      .eq('account_id', ctx.accountId)
      .eq('type', 'whatsapp_qr');

    const instances = await Promise.all(
      ((channels ?? []) as { id: string; name: string; status: string }[]).map(
        async (channel) => {
          const [{ limits: channelLimits }, usage] = await Promise.all([
            resolveColdSendLimits(
              ctx.supabase,
              { accountId: ctx.accountId, channelId: channel.id },
              cache
            ),
            loadColdSendUsage(ctx.supabase, channel.id),
          ]);
          const decision = evaluateColdSend(channelLimits, usage);
          return {
            channelId: channel.id,
            name: channel.name,
            status: channel.status,
            last24h: usage.last24h,
            lastHour: usage.lastHour,
            dailyLimit: decision.dailyLimit,
            hourlyLimit: decision.hourlyLimit,
            remainingToday: decision.remainingToday,
            remainingThisHour: decision.remainingThisHour,
            warmingUp: decision.warmingUp,
          };
        }
      )
    );

    return NextResponse.json({
      ...limits,
      /**
       * `false` quando o dono do sistema zerou os tetos de volume — o
       * recurso está desligado, e a interface deve dizer isso em vez de
       * mostrar "0 mensagens por dia" como se fosse uma cota.
       */
      enabled: limits.perDay > 0 && limits.perHour > 0,
      instances,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
