/**
 * Carrega o canal escolhido para um recurso, escopado à conta
 * (SPEC 065 §5.4 / §6).
 *
 * Quatro rotas — `POST`/`PATCH` de automações e `POST`/`PUT` de fluxos,
 * mais a ativação de fluxo — precisam da mesma linha, com o mesmo
 * cuidado de tenancy, antes de gravar `channel_id`. Uma função só para
 * que a próxima não nasça com um `.eq()` a menos.
 *
 * Mora em `lib/channels/` (e não junto de um dos motores) porque a
 * pergunta — "este canal é desta conta?" — é da camada de canais, e os
 * dois motores são apenas os primeiros a fazê-la.
 *
 * **O `account_id` na consulta não é decoração.** As rotas escrevem com
 * o cliente `service_role`, que ignora RLS: sem ele, um `channel_id` de
 * outra conta seria gravado sem reclamação, e a automação passaria a
 * apontar para um canal alheio — exatamente a linha que a asserção
 * final da migração 075 procura ("automacao apontando para canal de
 * outra conta"). Com ele, o id de outra conta simplesmente não devolve
 * linha, e o chamador responde 400 sem confirmar que o id existe.
 *
 * "Não existe" e "é de outra conta" continuam sendo a MESMA resposta, de
 * propósito: distinguir os dois é o vazamento. O que passou a ser
 * distinguido é a TERCEIRA possibilidade — a consulta falhar (achado de
 * code review). Ver `ScopedChannelLookup`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ChannelType } from './types';

/**
 * O mínimo de `channels` que as validações precisam. Definido aqui, do
 * lado de quem lê a linha; `lib/automations/validate.ts` o reexporta
 * para não quebrar quem já importava de lá.
 */
export interface ScopedChannel {
  id: string;
  type: ChannelType;
  status: string;
}

/**
 * Resultado da busca. Três estados, e o terceiro é o motivo desta forma
 * existir.
 *
 *   `{ ok: true, channel }`        o canal é desta conta (ou nenhum
 *                                   canal foi pedido → `channel: null`);
 *   `{ ok: false, 'not_found' }`   id inexistente OU de outra conta —
 *                                   indistinguíveis de propósito;
 *   `{ ok: false, 'read_failed' }` a consulta falhou.
 *
 * Antes os dois últimos eram o mesmo `null`, e as quatro rotas
 * respondiam 400 "channel not found in this account" também para um
 * soluço do Supabase — dizendo ao operador que o número dele não existe
 * e não lhe dando motivo para tentar de novo. Continua falhando FECHADO
 * (nada é gravado sem verificação), mas agora com o motivo certo. É a
 * mesma distinção que `ChannelNotConfiguredReason` já faz em
 * `errors.ts` com `read_failed`.
 */
export type ScopedChannelLookup =
  | { ok: true; channel: ScopedChannel | null }
  | { ok: false; reason: 'not_found' | 'read_failed' };

export async function loadScopedChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string | null | undefined
): Promise<ScopedChannelLookup> {
  // Nenhum canal pedido = "vale para todos os canais", que é sucesso,
  // não ausência.
  if (!channelId) return { ok: true, channel: null };

  const { data, error } = await db
    .from('channels')
    .select('id, type, status')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.error(
      `[scoped-channel] failed to read channel ${channelId}:`,
      error
    );
    return { ok: false, reason: 'read_failed' };
  }

  const row = (data as ScopedChannel | null) ?? null;
  if (!row) return { ok: false, reason: 'not_found' };

  return { ok: true, channel: row };
}

/**
 * A resposta HTTP de cada motivo, numa forma que as rotas convertem em
 * `NextResponse.json(body, { status })`.
 *
 * Puro de propósito — sem importar `next/server` num módulo de
 * `lib/channels/`. As quatro rotas precisam do MESMO par
 * (status, código), e escrevê-lo à mão em cada uma é como o
 * `channel_not_in_account` acabaria divergindo.
 */
/**
 * O canal escolhido para um recurso (automação ou fluxo) serve para
 * ATIVAÇÃO? (SPEC 065 §5.4/§5.5, achado de code review.)
 *
 * Antes esta checagem estava reimplementada byte a byte em
 * `automations/validate.ts` (`validateChannelForActivation`) e
 * `flows/validate.ts` (`validateFlowChannel`), já divergindo de wording
 * entre as duas — exatamente a classe de bug que motivou centralizar
 * `templateBelongsToWaba`/`selectableChannels` nesta mesma SPEC (§2.E).
 * As duas continuam existindo (formas de `ValidationIssue` diferentes:
 * `{path,message}` vs `{severity,scope,field,message}`), mas chamam esta
 * função para a DECISÃO — só a mensagem final diverge, de propósito.
 *
 * `null` = tudo bem (ou nenhum canal escolhido — "vale para todos").
 * Só `disabled` bloqueia: `error`/`disconnected` não, pelo mesmo motivo
 * de `selectableChannels` (§5.1) — um número com problema continua
 * utilizável para poder ser trocado, e no `whatsapp_cloud` o status só é
 * reconciliado quando alguém passa pela rota de configuração
 * (`lib/channels/status.ts`).
 */
export function channelActivationProblem(
  channelId: string | null | undefined,
  channel: { status: string } | null | undefined
): 'not_found' | 'disabled' | null {
  if (!channelId) return null;
  if (!channel) return 'not_found';
  // SPEC 064 D-12: "remover número" preserva o canal como `disabled`. Um
  // recurso escopado nele nunca dispararia — deixá-lo ativo é a falha
  // silenciosa que o AGENTS.md nomeia.
  if (channel.status === 'disabled') return 'disabled';
  return null;
}

export function scopedChannelError(reason: 'not_found' | 'read_failed'): {
  status: number;
  body: { error: string; code: string };
} {
  if (reason === 'read_failed') {
    // 503, e não 400: não é o pedido que está errado — é a leitura que
    // não aconteceu. O operador deve tentar de novo, e um 400 diria o
    // contrário.
    return {
      status: 503,
      body: {
        error: 'could not verify the selected channel — try again',
        code: 'channel_lookup_failed',
      },
    };
  }
  return {
    status: 400,
    body: {
      error: 'channel not found in this account',
      code: 'channel_not_in_account',
    },
  };
}
