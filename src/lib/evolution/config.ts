/**
 * Configuração da integração Evolution Go (PRD 047 §12 / SPEC 048 §7).
 *
 * Nenhuma variável aqui é obrigatória. Sem `EVOLUTION_API_URL` a aba
 * "WhatsApp QRCode" aparece desabilitada com instruções — nunca 503
 * silencioso, nunca some da navegação (é a armadilha "agendamento não
 * dispara, sem erro" do AGENTS.md se repetindo, e este módulo existe
 * para fechá-la logo na leitura do `.env`).
 *
 * O que é conectividade e o que é limite (SPEC 069 §3.4, regra 5)
 *
 *   `EVOLUTION_API_URL`, `EVOLUTION_GLOBAL_API_KEY`,
 *   `EVOLUTION_INSTANCE_PREFIX` e `EVOLUTION_WEBHOOK_PUBLIC_URL`
 *   continuam sendo lidos aqui: são endereço e credencial, não teto —
 *   não fazem sentido "por conta" e ninguém os compra num plano.
 *
 *   Os quatro NÚMEROS, sim, migraram para `src/lib/limits/`. Eles são
 *   tetos, e um teto com parser próprio é um teto que um dia diverge
 *   dos outros.
 */

import { resolveKey } from '@/lib/limits/resolve';

export interface EvolutionConfig {
  apiUrl: string;
  globalApiKey: string;
  maxInstancesPerAccount: number;
  maxInstancesTotal: number;
  instancePrefix: string;
  /** Origem pública para montar a URL de webhook. */
  webhookPublicUrl: string | null;
  requestTimeoutMs: number;
  /**
   * Teto pra `/send/media`. A Evolution BAIXA o arquivo da nossa URL
   * assinada e SOBE pro WhatsApp de forma síncrona, dentro da mesma
   * requisição — ao contrário de `/send/text` (praticamente instantâneo),
   * um vídeo de alguns MB pode facilmente estourar os 15s padrão de
   * `requestTimeoutMs`, abortando o envio do lado do CRM mesmo que a
   * Evolution tivesse terminado um instante depois (visto em produção:
   * "Evolution request failed: This operation was aborted" ao mandar
   * vídeo). Bem mais folgado que o timeout genérico; envios de texto e
   * chamadas de gerência de instância continuam usando `requestTimeoutMs`.
   */
  mediaRequestTimeoutMs: number;
}

/**
 * Os quatro valores NUMÉRICOS deste módulo passam pelo registro de
 * limites (SPEC 069 §3.1, itens 1, 2, 8 e 9) em vez de terem parser
 * próprio — é a regra 5 do §3.4: não existe um segundo resolvedor.
 *
 * Aqui a cascata é curta de propósito: só os níveis 2 (`.env`) e 3
 * (código). `maxInstancesPerAccount` ganha o nível de conta no seu
 * ponto de uso, onde `checkInstanceLimit` já recebe
 * `plan_limit('channels_whatsapp_qr')`; os dois timeouts não têm nível
 * de conta nenhum, e `maxInstancesTotal` protege a VPS e não pode ter.
 *
 * O comportamento é o mesmo de sempre, inclusive na borda que mais
 * importa: `'0'` continua caindo no padrão nestes quatro (é o que o
 * `allowZero: false` do registro expressa, e o que `config.test.ts`
 * fixa desde a SPEC 048) — um timeout de 0 ms ou um teto de 0
 * instâncias no deployment é erro de digitação, nunca intenção.
 */
function limitFromEnv(
  key: string,
  env: Record<string, string | undefined>
): number {
  return resolveKey(key, { env }).value;
}

/**
 * Lê a configuração do `.env`. Devolve `null` quando `EVOLUTION_API_URL`
 * ou `EVOLUTION_GLOBAL_API_KEY` estão ausentes — as duas variáveis sem
 * as quais NENHUMA chamada à Evolution é possível. Todo o resto tem
 * padrão.
 */
export function readEvolutionConfig(
  env: Record<string, string | undefined> = process.env
): EvolutionConfig | null {
  const apiUrl = env.EVOLUTION_API_URL?.trim();
  const globalApiKey = env.EVOLUTION_GLOBAL_API_KEY?.trim();
  if (!apiUrl || !globalApiKey) return null;

  return {
    // Sem barra no final — os call sites concatenam `${apiUrl}/instance/...`.
    apiUrl: apiUrl.replace(/\/+$/, ''),
    globalApiKey,
    maxInstancesPerAccount: limitFromEnv('channels_whatsapp_qr', env),
    maxInstancesTotal: limitFromEnv('evolution_max_instances_total', env),
    instancePrefix: env.EVOLUTION_INSTANCE_PREFIX?.trim() || 'zapcrm',
    webhookPublicUrl:
      env.EVOLUTION_WEBHOOK_PUBLIC_URL?.trim() ||
      env.NEXT_PUBLIC_SITE_URL?.trim() ||
      null,
    requestTimeoutMs: limitFromEnv('evolution_request_timeout_ms', env),
    mediaRequestTimeoutMs: limitFromEnv(
      'evolution_media_request_timeout_ms',
      env
    ),
  };
}

export function isEvolutionConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return readEvolutionConfig(env) !== null;
}
