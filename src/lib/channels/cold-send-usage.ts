/**
 * Reúne o USO que `evaluateColdSend` (cold-send-limit.ts) precisa para
 * decidir — SPEC 049 §6.2 (F6.1).
 *
 * `cold-send-limit.ts` é módulo puro de propósito: parsing, cálculo e
 * veredito, sem banco. Este arquivo é "quem chama reúne o uso" — a
 * metade que faltava.
 *
 * `instanceCreatedAt` vem de `channels.created_at`, NÃO de
 * `evolution_instances.created_at`
 *
 *   As duas linhas nascem juntas hoje, mas quem reconecta uma instância
 *   existente (logout + novo pareamento) não reinicia o aquecimento — e
 *   é `channels` que representa "este número no CRM", não a linha da
 *   instância na VPS. Ler a tabela errada faria uma reconexão de rotina
 *   reiniciar o aquecimento e travar um número já estabelecido no piso
 *   de 5 mensagens/dia.
 *
 * `kind = 'send'` não é opcional (migração 078, SPEC 069 D-1)
 *
 *   `channel_cold_sends` passou a ser o livro-caixa de DOIS eixos: o
 *   envio frio e a checagem de número (`kind = 'check'`). Sem o filtro,
 *   uma checagem apagaria do dia um envio real que o cliente pagou —
 *   exatamente o que a cota separada existe para impedir. O `DEFAULT
 *   'send'` da coluna garante que toda linha anterior à migração conta
 *   como envio, então a contagem histórica não muda.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ColdSendUsage } from './cold-send-limit';

/** O recorte deste módulo no livro-caixa compartilhado (SPEC 069 D-1). */
const COLD_SEND_KIND = 'send';

export async function loadColdSendUsage(
  db: SupabaseClient,
  channelId: string,
  now: Date = new Date()
): Promise<ColdSendUsage> {
  return loadUsageByKind(db, channelId, COLD_SEND_KIND, now);
}

/**
 * A mesma leitura, para o eixo de CHECAGEM (SPEC 069 D-1) — cota
 * separada, mesmo livro-caixa, mesma rampa de aquecimento por
 * instância (por isso reusa exatamente esta função, e não duplica a
 * consulta). Só o discriminador `kind` muda.
 */
export async function loadCheckUsage(
  db: SupabaseClient,
  channelId: string,
  now: Date = new Date()
): Promise<ColdSendUsage> {
  return loadUsageByKind(db, channelId, 'check', now);
}

async function loadUsageByKind(
  db: SupabaseClient,
  channelId: string,
  kind: string,
  now: Date
): Promise<ColdSendUsage> {
  const since24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const sinceHour = new Date(now.getTime() - 3_600_000).toISOString();

  const [last24hRes, lastHourRes, lastSentRes, channelRes] = await Promise.all([
    db
      .from('channel_cold_sends')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', channelId)
      .eq('kind', kind)
      .gte('sent_at', since24h),
    db
      .from('channel_cold_sends')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', channelId)
      .eq('kind', kind)
      .gte('sent_at', sinceHour),
    db
      .from('channel_cold_sends')
      .select('sent_at')
      .eq('channel_id', channelId)
      .eq('kind', kind)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('channels').select('created_at').eq('id', channelId).maybeSingle(),
  ]);

  return {
    last24h: last24hRes.count ?? 0,
    lastHour: lastHourRes.count ?? 0,
    lastColdSendAt: lastSentRes.data?.sent_at
      ? new Date(lastSentRes.data.sent_at)
      : null,
    // Canal apagado fora do fluxo normal: cai no piso de aquecimento
    // (a leitura mais conservadora) em vez de assumir uma instância
    // veterana que nunca existiu.
    instanceCreatedAt: channelRes.data?.created_at
      ? new Date(channelRes.data.created_at)
      : now,
  };
}
