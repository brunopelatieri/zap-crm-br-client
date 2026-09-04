/**
 * A cascata de limites (SPEC 069 §3.4) — instância → conta → `.env` →
 * código, num resolvedor só.
 *
 * Qual problema este módulo resolve
 *
 *   Um teto de segurança tinha uma origem só: o `.env` do deployment.
 *   Duas contas na mesma VPS — uma com um número de dois anos, outra
 *   com um criado ontem — recebiam o mesmo teto, e diferenciá-las
 *   exigia editar o `.env` e reiniciar, o que mexe com todas as contas
 *   de uma vez. Este módulo troca a ORIGEM do valor sem tocar na
 *   política: quem não configurou nada continua exatamente com os
 *   números de hoje, e é isso que `resolve.test.ts` prova primeiro.
 *
 * As armadilhas que ele fecha
 *
 *   1. **"Sem limite" por acidente.** Nenhum caminho aqui devolve
 *      `undefined`, `null` ou `Infinity`. Configuração ausente, JSONB
 *      torto, string onde devia ser número, negativo — tudo isso desce
 *      um nível e acaba, no pior caso, no padrão de código. Num módulo
 *      cujo trabalho é evitar banimento de número, "não achei o teto,
 *      então não tem teto" é o desfecho mais caro possível.
 *
 *   2. **Confundir "ausente" com "presente e nulo".** É o mesmo bug
 *      que `retention/global-defaults.ts` documenta em
 *      `parseConsoleDimension`, e vale igual para o JSONB de
 *      `evolution_instances.limit_overrides`. Aqui a distinção é ainda
 *      mais direta: para chave de segurança **não existe "ilimitado"**
 *      (D-6). `NULL` num nível quer dizer "não configurado AQUI" e
 *      desce; nunca "pode tudo". Um teto que se desliga por engano
 *      deixa de ser teto.
 *
 *   3. **Override invisível.** O resultado carrega `level`, o nível que
 *      de fato venceu. Sem ele a tela só pode adivinhar, e o operador
 *      que muda o limite da conta sem ver o aviso "esta instância tem
 *      valor próprio" conclui que o produto está quebrado (D-8).
 *
 * Puro: recebe os valores já lidos e decide. Não toca banco, e o `env`
 * é parâmetro — mesma disciplina de `readColdSendLimits` e de
 * `readEvolutionConfig`, que é o que torna a precedência testável sem
 * mexer em `process.env` global.
 */

import {
  getLimitEntry,
  isIntegerLimit,
  type IntegerLimitEntry,
  type LimitLevel,
  type TimeZoneLimitEntry,
} from './registry';

export interface ResolvedLimit {
  key: string;
  value: number;
  /** Qual nível respondeu. A UI da F9 depende disto (§3.4 regra 4). */
  level: LimitLevel;
  /** O valor do nível 1a/1b foi reduzido pelo teto duro do deployment. */
  clamped: boolean;
  /** O teto (ou piso) em vigor; `null` quando a chave não tem um. */
  hardCap: number | null;
}

export interface LimitSources {
  /** `evolution_instances.limit_overrides` — JSONB cru, nunca confiável. */
  instance?: Record<string, unknown> | null;
  /** `account_effective_limits(account_id)` — JSONB cru, idem. */
  account?: Record<string, unknown> | null;
  env?: Record<string, string | undefined>;
}

// ------------------------------------------------------------
// Parsers — um por formato de origem, mesma postura nos dois
// ------------------------------------------------------------

/**
 * `undefined` = este nível não respondeu (ausente ou inválido) e a
 * cascata continua descendo. Nunca lança: um JSONB torto não pode
 * derrubar um envio.
 */
function parseJsonValue(
  raw: unknown,
  entry: IntegerLimitEntry,
  levelLabel: string
): number | undefined {
  // Chave ausente e chave com `null` colapsam AQUI, e só aqui, de
  // propósito: para limite de segurança as duas querem dizer "não
  // configurado neste nível" (D-6). É o oposto de `retention`, onde
  // `null` é o "sem limite" explícito que precisa sobreviver — lá
  // existe estado "ilimitado", aqui não existe.
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    console.warn(
      `[limits/resolve] ${levelLabel}.${entry.key}=${JSON.stringify(raw)} inválido — ignorando, descendo um nível.`
    );
    return undefined;
  }
  if (raw === 0 && !entry.allowZero) return undefined;
  return raw;
}

/**
 * Mesma semântica de `readColdSendLimits`/`readEvolutionConfig`, e é
 * preciso que continue sendo: ausente, vazio, não inteiro ou negativo
 * cai um nível. `0` vale como "bloqueia este eixo" onde `allowZero`
 * permite — a forma de o dono do sistema desligar um recurso sem
 * mexer em código.
 */
function parseEnvValue(
  raw: string | undefined,
  entry: IntegerLimitEntry
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  if (n === 0 && !entry.allowZero) return undefined;
  return n;
}

// ------------------------------------------------------------
// Teto duro do deployment (D-7)
// ------------------------------------------------------------

/**
 * Um aviso por variável por processo. Sem essa memória, um `.env` mal
 * configurado imprimiria a mesma linha a cada envio — e log que se
 * repete a cada requisição é log que ninguém lê.
 */
const warnedEnvAboveCap = new Set<string>();

/** Exportado só para os testes: `console.warn` de "uma vez" precisa
 *  poder ser rearmado entre casos. */
export function resetHardCapWarnings(): void {
  warnedEnvAboveCap.clear();
}

function resolveHardCap(
  entry: IntegerLimitEntry,
  env: Record<string, string | undefined>
): number | null {
  if (!entry.hardCap) return null;
  const raw = env[entry.hardCap.envVar];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
    console.warn(
      `[limits/resolve] ${entry.hardCap.envVar}=${raw} inválido — usando o teto padrão ${entry.hardCap.codeDefault}.`
    );
  }
  return entry.hardCap.codeDefault;
}

function applyHardCap(
  value: number,
  cap: number | null,
  entry: IntegerLimitEntry
): { value: number; clamped: boolean } {
  if (cap === null || !entry.hardCap) return { value, clamped: false };
  const capped =
    entry.hardCap.kind === 'max' ? Math.min(value, cap) : Math.max(value, cap);
  return { value: capped, clamped: capped !== value };
}

// ------------------------------------------------------------
// O resolvedor
// ------------------------------------------------------------

/**
 * Percorre os quatro níveis e devolve o primeiro que respondeu, já
 * clampado quando cabe.
 *
 * O clamp vale para os níveis de **instância e conta**, e não para o
 * `.env` (D-7): o nível 2 é a palavra do operador do deployment, que é
 * justamente quem define o teto — clampá-lo contra ele mesmo é ruído.
 * Um `.env` acima do teto é, isso sim, sinal de teto mal configurado,
 * e por isso rende um aviso.
 */
export function resolveLimitValue(
  entry: IntegerLimitEntry,
  sources: LimitSources = {}
): ResolvedLimit {
  const env = sources.env ?? {};
  const hardCap = resolveHardCap(entry, env);

  if (entry.instanceConfigurable) {
    const raw = parseJsonValue(
      sources.instance?.[entry.key],
      entry,
      'instance'
    );
    if (raw !== undefined) {
      const { value, clamped } = applyHardCap(raw, hardCap, entry);
      return { key: entry.key, value, level: 'instance', clamped, hardCap };
    }
  }

  if (entry.accountConfigurable) {
    const raw = parseJsonValue(sources.account?.[entry.key], entry, 'account');
    if (raw !== undefined) {
      const { value, clamped } = applyHardCap(raw, hardCap, entry);
      return { key: entry.key, value, level: 'account', clamped, hardCap };
    }
  }

  const fromEnv = parseEnvValue(env[entry.envVar], entry);
  if (fromEnv !== undefined) {
    if (
      hardCap !== null &&
      entry.hardCap &&
      (entry.hardCap.kind === 'max' ? fromEnv > hardCap : fromEnv < hardCap) &&
      !warnedEnvAboveCap.has(entry.hardCap.envVar)
    ) {
      warnedEnvAboveCap.add(entry.hardCap.envVar);
      console.warn(
        `[limits/resolve] ${entry.envVar}=${fromEnv} ultrapassa ${entry.hardCap.envVar}=${hardCap}. ` +
          `O valor do .env NÃO é clampado (SPEC 069 D-7), mas o teto está mal configurado: ` +
          `nenhum override de conta ou instância poderá chegar a ${fromEnv}.`
      );
    }
    return {
      key: entry.key,
      value: fromEnv,
      level: 'env',
      clamped: false,
      hardCap,
    };
  }

  // §3.4 regra 1: o nível 3 sempre responde.
  return {
    key: entry.key,
    value: entry.codeDefault,
    level: 'code',
    clamped: false,
    hardCap,
  };
}

/**
 * A irmã da entrada não numérica do catálogo. Mesma cascata reduzida
 * (`.env` → código): um fuso desconhecido pelo runtime cai no padrão
 * em vez de fazer `Intl` lançar dentro do cron — a captação parar por
 * causa de um typo em `EVOLUTION_HARVEST_TIMEZONE` seria a armadilha
 * "não dispara e não avisa" outra vez.
 */
export function resolveTimeZoneValue(
  entry: TimeZoneLimitEntry,
  sources: LimitSources = {}
): { key: string; value: string; level: LimitLevel } {
  const raw = (sources.env ?? {})[entry.envVar]?.trim();
  if (raw) {
    if (isValidTimeZone(raw)) {
      return { key: entry.key, value: raw, level: 'env' };
    }
    console.warn(
      `[limits/resolve] ${entry.envVar}=${raw} não é um fuso IANA conhecido — usando ${entry.codeDefault}.`
    );
  }
  return { key: entry.key, value: entry.codeDefault, level: 'code' };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve UMA chave pelo nome, a partir de fontes já lidas. É o atalho
 * dos call sites que só querem um eixo e não devem voltar ao banco.
 *
 * Chave fora do catálogo LANÇA, e é o único caminho deste módulo que
 * lança: é erro de programação, não estado do sistema. Devolver um
 * padrão plausível esconderia um limite que nunca foi configurado
 * atrás de um número que parece certo — que é a forma mais cara de
 * errar aqui.
 */
export function resolveKey(key: string, sources: LimitSources): ResolvedLimit {
  const entry = getLimitEntry(key);
  if (!entry || !isIntegerLimit(entry)) {
    throw new Error(`[limits] chave numérica desconhecida: ${key}`);
  }
  return resolveLimitValue(entry, sources);
}
