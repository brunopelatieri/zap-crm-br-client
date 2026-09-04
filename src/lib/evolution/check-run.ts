/**
 * A execução de um lote de checagem (SPEC 069 §4.7, §7.1) — o que o
 * cron faz depois que `check-queue.ts` já decidiu QUAIS itens saem
 * agora: chama `/user/check`, grava o consumo, aplica o veredito
 * (D-2), e busca avatar quando cabe (D-13).
 *
 * Sequencial, com pausa entre itens — de propósito
 *
 *   `/user/check` aceita lote (D-14 #5, medido), mas processar o lote
 *   inteiro numa chamada só seria exatamente a rajada que a cota existe
 *   para impedir: um número descartável faz MUITAS consultas de
 *   sincronização de uma vez, e é esse padrão de volume que o antispam
 *   observa. Por isso este módulo chama `/user/check` **um número por
 *   vez**, com uma pausa de `minIntervalSeconds` entre eles — o mesmo
 *   raciocínio do envio frio (`cold-send-limit.ts`), aplicado a
 *   consulta em vez de mensagem.
 *
 * Desvio da SPEC §7.1 ponto 5: `/user/info` NÃO é chamado aqui
 *
 *   O texto original da SPEC previa `/user/check → … → /user/info +
 *   /user/avatar → bucket`. Removido depois da F3 medir contra o
 *   servidor real (D-14 #6): `/user/info` pode ficar pendurado por
 *   ~75 s (provavelmente autoconsulta, não confirmado contra
 *   terceiro), e os únicos campos que ele acrescentaria —
 *   `VerifiedName` (já vem de `/user/check`), `Status` (PRD 068 §5
 *   diz explicitamente que recado/status NÃO é exibido) e `PictureID`
 *   (sem coluna para comparar e decidir re-upload — o TTL de
 *   `shouldFetchAvatar` já evita busca redundante) — não têm onde
 *   aterrissar no schema desta SPEC. Chamar um endpoint lento por um
 *   valor que não é persistido em lugar nenhum seria gastar orçamento
 *   de tempo do lote (e uma consulta a mais de reputação) por nada.
 *   `fetchWhatsappUserInfo` continua existindo em `user.ts`, testado,
 *   para quando essa lacuna for fechada.
 *
 * Falha de avatar NUNCA desfaz o veredito de `/user/check`
 *
 *   O veredito (`applyQrCheckVerdict`) já foi aplicado e gravado antes
 *   de a busca de avatar começar. Se `/user/avatar` falhar ou vier tipo
 *   não suportado, o contato continua com o `whatsapp_status` correto
 *   — só fica sem foto até o próximo TTL.
 *
 * "Não consome tentativa" é código, não só intenção (§7.1 ponto 2)
 *
 *   `channel_unavailable` (instância caída/rede fora) reverte o claim
 *   do PRÓPRIO item para `pending` sem incrementar `attempts`, e aborta
 *   o restante do lote desta conta — os itens seguintes nem chegam a
 *   ser reivindicados. Qualquer outra falha (resposta sem casamento,
 *   erro inesperado) É uma tentativa gasta: volta a `pending` com
 *   `attempts + 1`, e é `check-queue.ts` (no próximo ciclo) quem decide
 *   se already estourou `max_attempts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { applyQrCheckVerdict } from '@/lib/contacts/whatsapp-status';
import { EvolutionApiError } from './client';
import type { EvolutionConfig } from './config';
import { fetchAndAttachAvatar, shouldFetchAvatar } from './avatar';
import { checkWhatsappUsers, matchCheckResult } from './user';

export interface CheckRunItem {
  queueItemId: string;
  contactId: string;
  phoneNormalized: string;
  avatarFetchedAt: Date | null;
}

export type CheckRunOutcome = 'done' | 'failed' | 'aborted';

export interface CheckRunItemResult {
  queueItemId: string;
  outcome: CheckRunOutcome;
  isInWhatsapp?: boolean;
  avatarFetched?: boolean;
  error?: string;
}

export interface CheckRunSummary {
  results: CheckRunItemResult[];
  checked: number;
  invalid: number;
  avatarsFetched: number;
  failed: number;
  /** O lote foi interrompido por canal indisponível — itens depois do
   *  ponto de corte nunca chegaram a ser tentados. */
  abortedChannelUnavailable: boolean;
}

export interface CheckRunParams {
  items: CheckRunItem[];
  accountId: string;
  channelId: string;
  instanceToken: string;
  minIntervalSeconds: number;
  infoAvatarTimeoutMs: number;
  avatarTtlDays: number;
  avatarMaxBytes: number;
  /** Instante absoluto após o qual nenhum item NOVO é reivindicado —
   *  a margem de segurança contra o `maxDuration` da rota é do
   *  chamador (§ cron route). Itens não alcançados continuam
   *  `pending`, intocados. */
  deadline: Date;
}

export interface CheckRunDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

const defaultDeps: CheckRunDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

async function claimItem(
  db: SupabaseClient,
  queueItemId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('contact_check_queue')
    .update({ status: 'in_progress' })
    .eq('id', queueItemId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[check-run] claim failed:', error.message);
    return false;
  }
  // `data` só existe quando o UPDATE de fato casou uma linha — outra
  // invocação do cron pode ter reivindicado o mesmo item primeiro.
  return data !== null;
}

async function revertClaim(
  db: SupabaseClient,
  queueItemId: string,
  {
    incrementAttempts,
    lastError,
  }: { incrementAttempts: boolean; lastError: string }
): Promise<void> {
  const update: Record<string, unknown> = {
    status: 'pending',
    last_error: lastError,
  };
  if (incrementAttempts) {
    // Sem RPC atômico de incremento nesta tabela: lê e escreve. Uma
    // corrida rara subcontaria em 1 — aceitável (higiene, não cobrança).
    const { data } = await db
      .from('contact_check_queue')
      .select('attempts')
      .eq('id', queueItemId)
      .maybeSingle();
    update.attempts = ((data?.attempts as number | undefined) ?? 0) + 1;
  }
  const { error } = await db
    .from('contact_check_queue')
    .update(update)
    .eq('id', queueItemId);
  if (error) {
    console.error('[check-run] revert claim failed:', error.message);
  }
}

async function markDone(
  db: SupabaseClient,
  queueItemId: string,
  now: Date
): Promise<void> {
  const { error } = await db
    .from('contact_check_queue')
    .update({ status: 'done', checked_at: now.toISOString() })
    .eq('id', queueItemId);
  if (error) {
    console.error('[check-run] mark done failed:', error.message);
  }
}

/**
 * `channel_cold_sends(kind='check')` — o mesmo livro-caixa do envio
 * frio, eixo separado (D-1). Best-effort: a checagem já aconteceu;
 * perder esta linha subconta a cota, mas fingir que a checagem falhou
 * seria pior (mesmo princípio de `recordColdSend`).
 */
async function recordCheckUsage(
  db: SupabaseClient,
  params: { channelId: string; accountId: string; contactId: string }
): Promise<void> {
  try {
    const { error } = await db.from('channel_cold_sends').insert({
      channel_id: params.channelId,
      account_id: params.accountId,
      contact_id: params.contactId,
      origin: 'engine',
      kind: 'check',
    });
    if (error) {
      console.error('[check-run] failed to record check usage:', error.message);
    }
  } catch (err) {
    console.error('[check-run] failed to record check usage:', err);
  }
}

export async function runCheckBatch(
  db: SupabaseClient,
  config: EvolutionConfig,
  params: CheckRunParams,
  deps: Partial<CheckRunDeps> = {}
): Promise<CheckRunSummary> {
  const { sleep, now } = { ...defaultDeps, ...deps };
  const results: CheckRunItemResult[] = [];
  let checked = 0;
  let invalid = 0;
  let avatarsFetched = 0;
  let failed = 0;
  let abortedChannelUnavailable = false;

  for (let i = 0; i < params.items.length; i++) {
    if (now() >= params.deadline) break;

    const item = params.items[i];
    const claimed = await claimItem(db, item.queueItemId);
    if (!claimed) continue; // outra invocação já pegou este item.

    try {
      const checkResults = await checkWhatsappUsers(
        config,
        params.instanceToken,
        [item.phoneNormalized]
      );
      const matched = matchCheckResult(checkResults, item.phoneNormalized);

      if (!matched) {
        await revertClaim(db, item.queueItemId, {
          incrementAttempts: true,
          lastError: 'Evolution response had no matching result',
        });
        results.push({
          queueItemId: item.queueItemId,
          outcome: 'failed',
          error: 'no_match',
        });
        failed++;
      } else {
        await recordCheckUsage(db, {
          channelId: params.channelId,
          accountId: params.accountId,
          contactId: item.contactId,
        });
        await applyQrCheckVerdict(db, {
          contactId: item.contactId,
          channelId: params.channelId,
          isInWhatsapp: matched.isInWhatsapp,
        });
        await markDone(db, item.queueItemId, now());

        checked++;
        if (!matched.isInWhatsapp) invalid++;

        let avatarFetched = false;
        if (
          matched.isInWhatsapp &&
          shouldFetchAvatar(item.avatarFetchedAt, params.avatarTtlDays, now())
        ) {
          avatarFetched = await fetchAndAttachAvatar(db, config, {
            accountId: params.accountId,
            contactId: item.contactId,
            phoneNormalized: item.phoneNormalized,
            instanceToken: params.instanceToken,
            timeoutMs: params.infoAvatarTimeoutMs,
            maxBytes: params.avatarMaxBytes,
          });
          if (avatarFetched) avatarsFetched++;
        }

        results.push({
          queueItemId: item.queueItemId,
          outcome: 'done',
          isInWhatsapp: matched.isInWhatsapp,
          avatarFetched,
        });
      }
    } catch (err) {
      if (
        err instanceof EvolutionApiError &&
        err.kind === 'channel_unavailable'
      ) {
        // §7.1 ponto 2: não consome tentativa, aborta o resto da conta.
        await revertClaim(db, item.queueItemId, {
          incrementAttempts: false,
          lastError: err.message,
        });
        results.push({
          queueItemId: item.queueItemId,
          outcome: 'aborted',
          error: err.message,
        });
        abortedChannelUnavailable = true;
        break;
      }

      const message = err instanceof Error ? err.message : String(err);
      await revertClaim(db, item.queueItemId, {
        incrementAttempts: true,
        lastError: message,
      });
      results.push({
        queueItemId: item.queueItemId,
        outcome: 'failed',
        error: message,
      });
      failed++;
    }

    const isLast = i === params.items.length - 1;
    if (!isLast && !abortedChannelUnavailable) {
      await sleep(params.minIntervalSeconds * 1000);
    }
  }

  return {
    results,
    checked,
    invalid,
    avatarsFetched,
    failed,
    abortedChannelUnavailable,
  };
}
