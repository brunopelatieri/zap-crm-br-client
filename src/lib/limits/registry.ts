/**
 * O catálogo de limites da integração Evolution (SPEC 069 §4.1) — a
 * tabela do §3 da SPEC virando código.
 *
 * Qual problema este arquivo resolve
 *
 *   Antes dele, cada limite morava no módulo que o consumia, lido
 *   direto do `.env` ali mesmo. O resultado é o que o §3 da SPEC chama
 *   de limite escondido: para saber quais tetos existem era preciso
 *   varrer o código, e um limite novo nascia com seu próprio parser,
 *   seu próprio padrão e sua própria ideia do que fazer com um valor
 *   torto. **Um limite que não está nesta lista é um limite escondido.**
 *
 *   Aqui ele é uma linha: chave, variável de ambiente, padrão de
 *   código, em quais níveis pode ser sobrescrito e qual é o teto duro
 *   do deployment. `resolve.ts` decide; este arquivo só declara.
 *
 * Por que catálogo e resolvedor são arquivos separados
 *
 *   Porque assim o resolvedor pode ser testado com entradas
 *   sintéticas, sem depender de nenhum limite real existir. Se as duas
 *   coisas morassem juntas, todo teste de precedência viraria também
 *   um teste do catálogo, e mudar um padrão comercial quebraria testes
 *   de lógica que não têm nada a ver com ele.
 *
 * A armadilha que ele fecha: "sem limite" por omissão
 *
 *   `codeDefault` é obrigatório em toda entrada, e não há como
 *   declarar um limite sem ele. É isso que garante a regra 1 do §3.4:
 *   o nível 3 SEMPRE responde, e nenhuma configuração ausente, torta
 *   ou apagada consegue produzir "sem teto" — que é o pior desfecho
 *   possível num módulo cujo trabalho é evitar banimento de número.
 */

/** Ordem de precedência da cascata (§3.4). */
export type LimitLevel = 'instance' | 'account' | 'env' | 'code';

/**
 * O teto duro do deployment (D-7). `max` limita por cima (volume);
 * `min` limita por baixo, nos eixos em que o número MENOR é o
 * perigoso — intervalo entre envios, dias de aquecimento.
 */
export interface LimitHardCap {
  envVar: string;
  codeDefault: number;
  kind: 'max' | 'min';
}

interface LimitEntryBase {
  /** Chave da cascata. Nos limites de nível 1a é também a chave de
   *  `QUOTA_KEYS`, de `plans.limits` e de `limit_overrides`. */
  key: string;
  envVar: string;
  /** Vira chave de conta (nível 1a) — é o que a política comercial vende. */
  accountConfigurable: boolean;
  /** Aceito em `evolution_instances.limit_overrides` (nível 1b). */
  instanceConfigurable: boolean;
}

export interface IntegerLimitEntry extends LimitEntryBase {
  valueType: 'integer';
  codeDefault: number;
  /** Clampa os níveis 1a e 1b — nunca o `.env` (D-7). */
  hardCap?: LimitHardCap;
  /**
   * `0` é um valor com significado ("bloqueia este eixo") ou é lixo
   * que cai um nível?
   *
   * `true` na maioria: é como o dono do sistema desliga um eixo sem
   * mexer em código, e é a semântica que `readColdSendLimits` já tem.
   *
   * `false` onde zero nunca quis dizer nada útil e o código de hoje já
   * o rejeita: `silence_hours` (§3.4 regra 3) e os quatro valores lidos
   * por `evolution/config.ts`, cujo `positiveInt` sempre descartou
   * `<= 0`. Um timeout de 0 ms ou um teto de 0 instâncias no
   * deployment é erro de digitação, não intenção — e `config.test.ts`
   * fixa esse comportamento desde a SPEC 048.
   */
  allowZero: boolean;
}

export interface TimeZoneLimitEntry extends LimitEntryBase {
  valueType: 'timezone';
  codeDefault: string;
}

export type LimitEntry = IntegerLimitEntry | TimeZoneLimitEntry;

export function isIntegerLimit(entry: LimitEntry): entry is IntegerLimitEntry {
  return entry.valueType === 'integer';
}

// ------------------------------------------------------------
// §3.1 — limites que já existiam antes desta SPEC
//
// Os padrões abaixo são, um a um, os valores que o código já usava.
// Mudar qualquer número aqui muda o comportamento de um deployment
// que não configurou nada — que é exatamente o que o R7 promete NÃO
// fazer.
// ------------------------------------------------------------

const EXISTING_ENTRIES: readonly LimitEntry[] = [
  {
    // Já era chave de quota desde a 067; a cascata só passa a lê-la
    // pelo mesmo caminho que as outras.
    key: 'channels_whatsapp_qr',
    envVar: 'EVOLUTION_MAX_INSTANCES_PER_ACCOUNT',
    valueType: 'integer',
    codeDefault: 3,
    accountConfigurable: true,
    instanceConfigurable: false,
    allowZero: false,
  },
  {
    // Sem nível de conta DE PROPÓSITO: protege a VPS, que é recurso
    // compartilhado. Um override por conta aqui seria uma conta
    // decidindo quantas sessões whatsmeow as outras aguentam.
    key: 'evolution_max_instances_total',
    envVar: 'EVOLUTION_MAX_INSTANCES_TOTAL',
    valueType: 'integer',
    codeDefault: 20,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: false,
  },
  {
    key: 'evolution_cold_send_silence_hours',
    envVar: 'EVOLUTION_COLD_SEND_SILENCE_HOURS',
    valueType: 'integer',
    codeDefault: 24,
    accountConfigurable: true,
    instanceConfigurable: true,
    // §3.4 regra 3: aqui `0` cairia no padrão, porque "silêncio de 0 h"
    // tornaria TODO envio frio — o oposto de desligar o eixo.
    allowZero: false,
  },
  {
    key: 'evolution_cold_send_per_hour',
    envVar: 'EVOLUTION_COLD_SEND_PER_HOUR',
    valueType: 'integer',
    codeDefault: 12,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_COLD_SEND_PER_HOUR_MAX',
      codeDefault: 40,
      kind: 'max',
    },
  },
  {
    key: 'evolution_cold_send_per_day',
    envVar: 'EVOLUTION_COLD_SEND_PER_DAY',
    valueType: 'integer',
    codeDefault: 60,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_COLD_SEND_PER_DAY_MAX',
      codeDefault: 250,
      kind: 'max',
    },
  },
  {
    key: 'evolution_cold_send_min_interval_seconds',
    envVar: 'EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS',
    valueType: 'integer',
    codeDefault: 45,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS_MIN',
      codeDefault: 10,
      kind: 'min',
    },
  },
  {
    key: 'evolution_cold_send_warmup_days',
    envVar: 'EVOLUTION_COLD_SEND_WARMUP_DAYS',
    valueType: 'integer',
    codeDefault: 14,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_COLD_SEND_WARMUP_DAYS_MIN',
      // 0 permite desligar o aquecimento, como hoje.
      codeDefault: 0,
      kind: 'min',
    },
  },
  {
    // §3.1, nota: timeout passa pela cascata mas NÃO é configurável por
    // conta. Não é política que se venda, e expor como override entrega
    // ao operador uma forma de pendurar o pool de requisições do
    // deployment inteiro sem beneficiar cliente nenhum.
    key: 'evolution_request_timeout_ms',
    envVar: 'EVOLUTION_REQUEST_TIMEOUT_MS',
    valueType: 'integer',
    codeDefault: 15_000,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: false,
  },
  {
    key: 'evolution_media_request_timeout_ms',
    envVar: 'EVOLUTION_MEDIA_REQUEST_TIMEOUT_MS',
    valueType: 'integer',
    codeDefault: 60_000,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: false,
  },
  {
    // Achado da F3 (SPEC 069), não previsto no §3.1 original: medido
    // contra o servidor real que `/user/info` e `/user/avatar` podem
    // ficar pendurados por ~75 s antes de o PRÓPRIO servidor Evolution
    // desistir com 500 "info query timed out" — provavelmente
    // autoconsulta (ver `evolution/user.ts`, achado nº 3), não
    // confirmado contra terceiro. Duas consequências:
    //
    //   1. O timeout genérico de conectividade (15 s) abortaria a
    //      requisição do CRM ANTES de o servidor Evolution sequer
    //      desistir — sempre "channel_unavailable", nunca a resposta
    //      real (sucesso ou falha).
    //   2. Usar os 75 s medidos travaria o lote inteiro do cron atrás
    //      de UM contato ruim (`check_batch_size` × 75 s estoura
    //      qualquer `maxDuration` razoável).
    //
    // 20 s é uma APOSTA deliberada no meio-termo — não uma medição — e
    // está registrada como tal na SPEC. Nível de código só: nenhuma
    // conta compra "info mais rápido", é o mesmo trade-off dos outros
    // dois timeouts acima.
    key: 'evolution_info_avatar_timeout_ms',
    envVar: 'EVOLUTION_INFO_AVATAR_TIMEOUT_MS',
    valueType: 'integer',
    codeDefault: 20_000,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: false,
  },
];

// ------------------------------------------------------------
// §3.2 — limites novos desta feature
//
// Declarados agora, na F2, e consumidos só a partir da F4/F5/F7.
// Estar no catálogo não liga nada: enquanto ninguém os ler, eles são
// documentação executável do que virá.
// ------------------------------------------------------------

const NEW_ENTRIES: readonly LimitEntry[] = [
  {
    key: 'evolution_check_per_hour',
    envVar: 'EVOLUTION_CHECK_PER_HOUR',
    valueType: 'integer',
    codeDefault: 60,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_CHECK_PER_HOUR_MAX',
      codeDefault: 200,
      kind: 'max',
    },
  },
  {
    key: 'evolution_check_per_day',
    envVar: 'EVOLUTION_CHECK_PER_DAY',
    valueType: 'integer',
    codeDefault: 300,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_CHECK_PER_DAY_MAX',
      codeDefault: 2000,
      kind: 'max',
    },
  },
  {
    key: 'evolution_check_min_interval_seconds',
    envVar: 'EVOLUTION_CHECK_MIN_INTERVAL_SECONDS',
    valueType: 'integer',
    codeDefault: 5,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_CHECK_MIN_INTERVAL_SECONDS_MIN',
      codeDefault: 1,
      kind: 'min',
    },
  },
  {
    key: 'evolution_check_batch_size',
    envVar: 'EVOLUTION_CHECK_BATCH_SIZE',
    valueType: 'integer',
    codeDefault: 25,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_CHECK_BATCH_SIZE_MAX',
      codeDefault: 100,
      kind: 'max',
    },
  },
  {
    // Higiene da fila, não política comercial: um cliente não compra
    // "mais tentativas por item envenenado".
    key: 'evolution_check_max_attempts',
    envVar: 'EVOLUTION_CHECK_MAX_ATTEMPTS',
    valueType: 'integer',
    codeDefault: 3,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: true,
  },
  {
    key: 'evolution_check_queue_ttl_hours',
    envVar: 'EVOLUTION_CHECK_QUEUE_TTL_HOURS',
    valueType: 'integer',
    codeDefault: 168,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: true,
  },
  {
    key: 'evolution_harvest_per_run',
    envVar: 'EVOLUTION_HARVEST_PER_RUN',
    valueType: 'integer',
    codeDefault: 50,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_HARVEST_PER_RUN_MAX',
      codeDefault: 200,
      kind: 'max',
    },
  },
  {
    // É o teto que o campo do R1(c) edita — por isso o nível de
    // instância aqui não é refinamento, é o recurso principal.
    key: 'evolution_harvest_max_per_instance',
    envVar: 'EVOLUTION_HARVEST_MAX_PER_INSTANCE',
    valueType: 'integer',
    codeDefault: 500,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    hardCap: {
      envVar: 'EVOLUTION_HARVEST_MAX_PER_INSTANCE_MAX',
      codeDefault: 2000,
      kind: 'max',
    },
  },
  {
    key: 'evolution_harvest_window_start_hour',
    envVar: 'EVOLUTION_HARVEST_WINDOW_START_HOUR',
    valueType: 'integer',
    // 0 é uma HORA válida aqui, não "desligado" — daí `allowZero`.
    codeDefault: 0,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: true,
  },
  {
    key: 'evolution_harvest_window_end_hour',
    envVar: 'EVOLUTION_HARVEST_WINDOW_END_HOUR',
    valueType: 'integer',
    codeDefault: 6,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: true,
  },
  {
    // A única entrada não numérica do catálogo. Está aqui, e não solta
    // num módulo qualquer, porque a janela "00–06" não significa nada
    // sem o fuso: separá-los deixaria metade da regra fora da lista
    // que existe para não haver limite escondido.
    key: 'evolution_harvest_timezone',
    envVar: 'EVOLUTION_HARVEST_TIMEZONE',
    valueType: 'timezone',
    codeDefault: 'America/Sao_Paulo',
    accountConfigurable: false,
    instanceConfigurable: false,
  },
  {
    key: 'evolution_avatar_ttl_days',
    envVar: 'EVOLUTION_AVATAR_TTL_DAYS',
    valueType: 'integer',
    codeDefault: 30,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: true,
  },
  {
    key: 'evolution_avatar_max_bytes',
    envVar: 'EVOLUTION_AVATAR_MAX_BYTES',
    valueType: 'integer',
    codeDefault: 1_048_576,
    accountConfigurable: false,
    instanceConfigurable: false,
    allowZero: true,
  },
];

/** As 22 linhas do §3.1 + §3.2 da SPEC 069, em ordem. */
export const LIMIT_ENTRIES: readonly LimitEntry[] = [
  ...EXISTING_ENTRIES,
  ...NEW_ENTRIES,
];

const BY_KEY = new Map(LIMIT_ENTRIES.map((e) => [e.key, e]));

export function getLimitEntry(key: string): LimitEntry | undefined {
  return BY_KEY.get(key);
}

/**
 * As chaves que viram nível 1a — override por conta em
 * `plans.limits`/`account_plans.limit_overrides`. `QUOTA_KEYS` é
 * montada a partir daqui para que catálogo e contrato de plano não
 * possam divergir: acrescentar `accountConfigurable: true` a uma
 * entrada já a torna aceita pela rota de plano, sem uma segunda lista
 * para alguém esquecer de atualizar.
 */
export const ACCOUNT_CONFIGURABLE_LIMIT_KEYS: readonly string[] =
  LIMIT_ENTRIES.filter((e) => e.accountConfigurable).map((e) => e.key);

/** Aceitas em `evolution_instances.limit_overrides` (nível 1b). */
export const INSTANCE_CONFIGURABLE_LIMIT_KEYS: readonly string[] =
  LIMIT_ENTRIES.filter((e) => e.instanceConfigurable).map((e) => e.key);

/** As chaves do teto de envio frio, na ordem de `ColdSendLimits`. */
export const COLD_SEND_LIMIT_KEYS = {
  silenceHours: 'evolution_cold_send_silence_hours',
  perHour: 'evolution_cold_send_per_hour',
  perDay: 'evolution_cold_send_per_day',
  minIntervalSeconds: 'evolution_cold_send_min_interval_seconds',
  warmupDays: 'evolution_cold_send_warmup_days',
} as const;
