// ============================================================
// Varredura dos formulários (SPEC 085 §4.6 / §9, F4) — fase `forms` de
// `/api/automations/cron` (sem rota nova).
//
//   1. `partial` com `updated_at` > 24 h → `abandoned` (UPDATE barato,
//      roda em TODO tick). O gatilho `set_updated_at` carimba o instante
//      da virada: é a âncora dos 7 dias do passo 2.
//   2. Objetos de `form-uploads` cujo prefixo `<response_id>` (caminho
//      `account-<uuid>/<form_id>/<response_id>/<arquivo>`, SPEC §5.1):
//        · não tem resposta (contato excluído → cascata; resposta
//          apagada; resposta que nunca saiu do `start`), ou
//        · pertence a `abandoned` há mais de 7 dias.
//      Resposta cuja linha existe mas é de OUTRA conta/formulário que a
//      pasta (fora da convenção) é preservada: na dúvida, não remove.
//      O Storage não tem consulta por prefixo recursiva: percorre
//      conta → formulário → pasta de resposta, `ACCOUNTS_PER_RUN` contas
//      por varredura com cursor em memória (best-effort: reinício do
//      processo volta ao começo) e no máximo 1 vez por hora por processo.
//   3. Objetos SEM REFERÊNCIA numa resposta `completed` (achado do roteiro
//      manual da SPEC 085, item 5): o fluxo é start → upload-url → PUT
//      direto → submit, e o submit só grava em `answers` os arquivos que o
//      visitante lista; o resto (várias URLs assinadas, só uma usada)
//      ficaria para sempre e fora da quota (`upload_bytes` soma só o
//      referenciado). Remove da pasta da resposta o objeto que:
//        · NÃO é citado em lugar nenhum de `answers` (instantâneo
//          imutável): a varredura lê TODAS as strings e chaves do JSON, em
//          qualquer profundidade e qualquer tipo de bloco, e trata como
//          referenciado o objeto cujo `<objectId>` (UUID do nome) aparece
//          em qualquer uma (sem diferenciar maiúsculas);
//        · segue a convenção do caminho (`parseUploadPath` bate com a
//          conta/formulário/resposta da pasta; `.emptyFolderPlaceholder` e
//          afins ficam);
//        · tem mais de 24 h (> validade de 2 h da URL assinada e > tempo de
//          preenchimento), medido pelo MAIOR entre `created_at` e
//          `updated_at`; ausente ou ilegível = não remove (e conta em
//          `skippedNoDate`, para a poda inerte aparecer no log).
//      Arquivo referenciado NUNCA é removido; sem conseguir ler `answers`,
//      listar a pasta COMPLETA ou a idade do objeto, nada é removido. Só
//      `completed`: `partial` vive ≤ 24 h e vira `abandoned`, cuja pasta
//      inteira some em 7 dias (mexer em objeto de resposta em andamento só
//      traria risco).
//      Custo: 1 `list` por pasta de resposta concluída, no máximo
//      `FOLDERS_PRUNED_PER_ACCOUNT` por conta e varredura, DIVIDIDO entre
//      os formulários da conta (fatia = teto restante ÷ formulários que
//      faltam, no mínimo 1: um formulário grande não deixa os seguintes sem
//      vez), com cursor por formulário (último id inspecionado, não índice:
//      a pasta esvaziada some do Storage e deslocaria um índice).
//      Os cursores só existem em memória: cada reinício/deploy volta às
//      primeiras pastas de cada formulário (sem memória de "pasta já
//      limpa", elas são relistadas). Chaves de conta/formulário que não
//      existem mais são descartadas a cada varredura.
//      `FORMS_SWEEP_PRUNE_DRY_RUN=1`: só LOGA os caminhos que seriam
//      removidos neste passo 3 (o `vn` não tem backup; use na primeira
//      semana), sem chamar `remove`.
//
// A lógica de decisão é pura (`selectResponseFoldersToRemove`,
// `selectUnreferencedObjects`); o percurso recebe o client e roda com dublê
// nos testes. Nada lança: o chamador é um `after()` que não tem quem leia a
// exceção, e cada conta/formulário/pasta/lote é isolado (o erro de um não
// aborta nem desloca o cursor dos outros).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid } from '@/lib/api/uuid';

import { sweepPhoneProofs } from './phone-proof';
import {
  FORM_UPLOADS_BUCKET,
  parseUploadPath,
  uploadPathBelongsTo,
} from './uploads';

export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;
export const ABANDONED_FILES_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const ORPHAN_SCAN_INTERVAL_MS = 60 * 60 * 1000;
/** Objeto sem referência só sai depois disto (> validade de 2 h da URL de upload). */
export const UNREFERENCED_FILES_GRACE_MS = 24 * 60 * 60 * 1000;
export const ACCOUNTS_PER_RUN = 10;
/**
 * Teto de pastas `completed` inspecionadas (1 `list` cada) por conta e por
 * varredura, dividido entre os formulários da conta.
 */
export const FOLDERS_PRUNED_PER_ACCOUNT = 100;
const LIST_PAGE = 1000;
/**
 * Padrão documentado do `limit` do Storage: servidor que ignorasse o nosso
 * `limit` e devolvesse exatamente isto não teria acabado a listagem.
 */
const SERVER_DEFAULT_LIMIT = 100;
const MAX_LIST_PAGES = 20;
const IN_CHUNK = 150;
const REMOVE_CHUNK = 100;
/** Profundidade máxima da varredura de `answers`; acima disso, nada é removido. */
const MAX_ANSWERS_DEPTH = 32;
/** Caminhos individuais que o dry-run escreve no log por varredura. */
const DRY_RUN_LOG_PATHS = 200;
/** Teto de linhas viradas para `abandoned` por tick (o resto fica para o próximo). */
const ABANDON_BATCH = 1000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ACCOUNT_FOLDER_RE = new RegExp(`^account-${UUID}$`, 'i');

export interface SweepState {
  /** Próxima conta (índice na lista ordenada de pastas `account-…`). */
  cursor: number;
  /** Instante (ms) da última varredura de Storage deste processo. */
  lastScanAt: number;
  /**
   * Por prefixo `account-…/<form>`: último id de pasta `completed`
   * inspecionado (a próxima varredura continua DEPOIS dele; o teto por
   * formulário não pode deixar as últimas pastas sem vez).
   */
  pruneCursors?: Record<string, string>;
}

/** Estado do processo (o teste passa o seu). */
export const processSweepState: SweepState = {
  cursor: 0,
  lastScanAt: 0,
  pruneCursors: {},
};

export interface FormsSweepResult {
  abandoned: number;
  storageScanned: boolean;
  scannedFolders: number;
  removedFolders: number;
  /** Total de objetos removidos (inclui os sem referência). */
  removedObjects: number;
  /** Objetos sem referência em resposta `completed` (subconjunto de `removedObjects`). */
  removedUnreferenced: number;
  /** Pastas `completed` cujo conteúdo foi listado e avaliado para a poda. */
  prunedInspected: number;
  /** Dry-run: objetos que o passo 3 removeria (nada foi removido). */
  wouldRemoveUnreferenced: number;
  /**
   * Objetos sem referência que NÃO foram removidos por faltar `created_at`
   * ou `updated_at` legível no `list`: se crescer sem `removedUnreferenced`
   * nunca sair do zero, a poda está inerte.
   */
  skippedNoDate: number;
  /** Listagens que bateram em `MAX_LIST_PAGES` (cobertura parcial, nada removido por ela). */
  truncatedLists: number;
  /** O passo 3 rodou em dry-run. */
  dryRun: boolean;
  /** Provas de telefone (F7) apagadas. */
  phoneProofsRemoved: number;
  errors: number;
}

export function emptySweepResult(): FormsSweepResult {
  return {
    abandoned: 0,
    storageScanned: false,
    scannedFolders: 0,
    removedFolders: 0,
    removedObjects: 0,
    removedUnreferenced: 0,
    prunedInspected: 0,
    wouldRemoveUnreferenced: 0,
    skippedNoDate: 0,
    truncatedLists: 0,
    dryRun: false,
    phoneProofsRemoved: 0,
    errors: 0,
  };
}

/** `partial` com `updated_at` ANTERIOR a este instante vira `abandoned`. */
export function staleCutoffIso(now: Date): string {
  return new Date(now.getTime() - ABANDON_AFTER_MS).toISOString();
}

/** `abandoned` com `updated_at` ANTERIOR a este instante perde os arquivos. */
export function expiredCutoffIso(now: Date): string {
  return new Date(now.getTime() - ABANDONED_FILES_GRACE_MS).toISOString();
}

export interface KnownResponse {
  id: string;
  status: string;
  updated_at: string;
}

/**
 * Pastas de resposta a esvaziar: sem linha em `form_responses` (órfã) ou
 * de `abandoned` há mais de 7 dias. Nome que não é UUID nunca entra
 * (a varredura só mexe no que ela mesma criou).
 */
export function selectResponseFoldersToRemove(
  folderIds: readonly string[],
  known: readonly KnownResponse[],
  now: Date
): string[] {
  const byId = new Map(known.map((r) => [r.id.toLowerCase(), r]));
  const expired = expiredCutoffIso(now);
  const out: string[] = [];
  for (const folder of folderIds) {
    if (!isUuid(folder)) continue;
    const row = byId.get(folder.toLowerCase());
    if (!row) {
      out.push(folder);
    } else if (row.status === 'abandoned' && row.updated_at < expired) {
      out.push(folder);
    }
  }
  return out;
}

/** Objeto como o `list` do Storage devolve (só o que a decisão usa). */
export interface StoredObject {
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Texto (minúsculo) com TODAS as strings e chaves de `answers`, em qualquer
 * profundidade e de qualquer tipo de bloco: o objeto é "referenciado" se o
 * seu `<objectId>` aparece nele (`isReferenced`). `null` = o instantâneo não
 * tem a forma esperada (ou é fundo demais): sem saber o que é referenciado
 * nada pode ser removido (a remoção não tem volta e o `vn` não tem backup).
 *
 * Forma esperada: objeto de entradas objeto; numa entrada `file_upload`, o
 * `value` é nulo ou uma lista de `{ path: string }`. O resto do JSON só
 * entra na varredura, não é julgado.
 */
export function answersReferenceText(answers: unknown): string | null {
  if (!isRecord(answers)) return null;
  for (const entry of Object.values(answers)) {
    if (!isRecord(entry)) return null;
    if (entry.type !== 'file_upload') continue;
    const value = entry.value;
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value)) return null;
    for (const ref of value) {
      if (!isRecord(ref) || typeof ref.path !== 'string') return null;
    }
  }

  const parts: string[] = [];
  let tooDeep = false;
  const walk = (node: unknown, depth: number) => {
    if (typeof node === 'string') {
      parts.push(node);
    } else if (Array.isArray(node)) {
      if (depth > MAX_ANSWERS_DEPTH) {
        tooDeep = true;
        return;
      }
      for (const item of node) walk(item, depth + 1);
    } else if (isRecord(node)) {
      if (depth > MAX_ANSWERS_DEPTH) {
        tooDeep = true;
        return;
      }
      for (const [key, item] of Object.entries(node)) {
        parts.push(key);
        walk(item, depth + 1);
      }
    }
  };
  walk(answers, 0);
  return tooDeep ? null : parts.join('\n').toLowerCase();
}

/** O `<objectId>` (UUID do nome) aparece em alguma string de `answers`? */
export function isReferenced(referenceText: string, objectId: string): boolean {
  return referenceText.includes(objectId.toLowerCase());
}

/**
 * Instante mais recente de criação/alteração do objeto; `null` se QUALQUER
 * dos dois estiver ausente ou ilegível (o `list` real devolve ambos: faltar
 * é sinal de que não sabemos a idade).
 */
function objectTimestamp(o: StoredObject): number | null {
  const times: number[] = [];
  for (const t of [o.created_at, o.updated_at]) {
    if (typeof t !== 'string' || t === '') return null;
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) return null;
    times.push(ms);
  }
  return Math.max(...times);
}

export interface UnreferencedSelection {
  /** Caminhos completos a remover. */
  remove: string[];
  /** Sem referência, mas sem data legível: mantidos. */
  skippedNoDate: number;
}

/**
 * Objetos da pasta de uma resposta `completed` (`folderPrefix` =
 * `account-<uuid>/<form>/<resposta>`) que `answers` NÃO referencia, seguem a
 * convenção de caminho da própria pasta e são mais velhos que a folga de 24 h.
 * Referenciado nunca sai; sem idade legível ou sem `answers` válido, nada.
 */
export function selectUnreferencedObjects(
  folderPrefix: string,
  objects: readonly StoredObject[],
  answers: unknown,
  now: Date
): UnreferencedSelection {
  const none = { remove: [], skippedNoDate: 0 };
  const segments = folderPrefix.split('/');
  if (segments.length !== 3 || !segments[0].startsWith('account-')) return none;
  const [accountFolder, formId, responseId] = segments;
  const scope = {
    accountId: accountFolder.slice('account-'.length),
    formId,
    responseId,
  };

  const referenceText = answersReferenceText(answers);
  if (referenceText === null) return none;

  const cutoff = now.getTime() - UNREFERENCED_FILES_GRACE_MS;
  const remove: string[] = [];
  let skippedNoDate = 0;
  for (const o of objects) {
    const path = `${folderPrefix}/${o.name}`;
    const parsed = parseUploadPath(path);
    // Fora da convenção (ex.: `.emptyFolderPlaceholder`) ou de outra
    // conta/formulário/resposta: não é nosso para remover.
    if (!parsed || !uploadPathBelongsTo(path, scope)) continue;
    if (isReferenced(referenceText, parsed.objectId)) continue;
    const ts = objectTimestamp(o);
    if (ts === null) {
      skippedNoDate++;
    } else if (ts < cutoff) {
      remove.push(path);
    }
  }
  return { remove, skippedNoDate };
}

/**
 * Fatia de até `count` ids a partir do primeiro maior que `after` (ordem
 * alfabética, circular). Cursor por valor, não por índice: pasta que some
 * entre duas varreduras não desloca o que ainda não foi visto.
 */
export function nextFolderSlice(
  ids: readonly string[],
  after: string | undefined,
  count: number
): string[] {
  const sorted = [...ids].sort();
  if (sorted.length === 0 || count <= 0) return [];
  let start = after === undefined ? 0 : sorted.findIndex((id) => id > after);
  if (start < 0) start = 0;
  const take = Math.min(count, sorted.length);
  return Array.from(
    { length: take },
    (_, i) => sorted[(start + i) % sorted.length]
  );
}

/** Devolve só as pastas de conta (`account-<uuid>`), ordenadas (cursor estável). */
export function pickAccountFolders(names: readonly string[]): string[] {
  return names.filter((n) => ACCOUNT_FOLDER_RE.test(n)).sort();
}

/** Fatia circular de `count` contas a partir do cursor. */
export function nextAccountSlice(
  accounts: readonly string[],
  cursor: number,
  count: number
): { slice: string[]; nextCursor: number } {
  if (accounts.length === 0) return { slice: [], nextCursor: 0 };
  const start = cursor % accounts.length;
  const take = Math.min(count, accounts.length);
  const slice: string[] = [];
  for (let i = 0; i < take; i++)
    slice.push(accounts[(start + i) % accounts.length]);
  return { slice, nextCursor: (start + take) % accounts.length };
}

/**
 * Remove de `cursors` as chaves (`account-…/<form>`) que não existem mais:
 * `accountFolders` = todas as contas listadas; `formsByAccount` = formulários
 * vistos por conta COMPLETA (conta fora do mapa não tem as suas chaves
 * mexidas além da existência da conta).
 */
export function pruneStaleCursors(
  cursors: Record<string, string>,
  accountFolders: ReadonlySet<string>,
  formsByAccount: ReadonlyMap<string, ReadonlySet<string>>
): void {
  for (const key of Object.keys(cursors)) {
    const [account, form] = key.split('/');
    if (!accountFolders.has(account)) {
      delete cursors[key];
      continue;
    }
    const forms = formsByAccount.get(account);
    if (forms && !forms.has(form)) delete cursors[key];
  }
}

type Db = SupabaseClient;

interface ListedEntry extends StoredObject {
  id?: string | null;
}

interface Listing {
  entries: ListedEntry[];
  error: boolean;
  /** Bateu em `MAX_LIST_PAGES` com a última página cheia: há mais que isto. */
  truncated: boolean;
}

async function listAll(db: Db, prefix: string): Promise<Listing> {
  const bucket = db.storage.from(FORM_UPLOADS_BUCKET);
  const entries: ListedEntry[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { data, error } = await bucket.list(prefix, {
      limit: LIST_PAGE,
      // Avança pelo que veio (não por `page * LIST_PAGE`): se o servidor
      // limitar a página abaixo do pedido, nenhuma entrada é pulada.
      offset: entries.length,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) return { entries, error: true, truncated: false };
    const batch = (data ?? []) as ListedEntry[];
    entries.push(...batch);
    // Página curta = fim, exceto a de tamanho do padrão do servidor, que
    // pode ser um teto que ignorou o nosso `limit`: nesse caso, confirma.
    const short =
      batch.length < LIST_PAGE && batch.length !== SERVER_DEFAULT_LIMIT;
    if (batch.length === 0 || short) {
      return { entries, error: false, truncated: false };
    }
  }
  return { entries, error: false, truncated: true };
}

/** Pasta = entrada sem `id` (o Storage só dá `id` a objeto). */
const isFolder = (e: ListedEntry) => e.id === null || e.id === undefined;

/**
 * Remove em lotes de `REMOVE_CHUNK`; cada lote é isolado (erro ou exceção
 * num não impede os outros). Devolve só o que um lote SEM erro pediu para
 * remover; lote com erro conta `errors` e nada em `removed` (pode ter
 * removido parte, mas não há como saber sem outra listagem — a próxima
 * varredura reavalia a pasta).
 */
async function removePaths(
  db: Db,
  paths: readonly string[],
  result: FormsSweepResult
): Promise<{ removed: number; failed: boolean }> {
  let removed = 0;
  let failed = false;
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + REMOVE_CHUNK);
    try {
      const { error } = await db.storage
        .from(FORM_UPLOADS_BUCKET)
        .remove(chunk);
      if (error) {
        result.errors++;
        failed = true;
      } else {
        removed += chunk.length;
      }
    } catch {
      result.errors++;
      failed = true;
    }
  }
  return { removed, failed };
}

async function removeFolderObjects(
  db: Db,
  prefix: string,
  result: FormsSweepResult
): Promise<void> {
  const listing = await listAll(db, prefix);
  if (listing.error) {
    result.errors++;
    return;
  }
  // Pasta de resposta já decidida como órfã/expirada: remove o que foi
  // listado (truncada, o resto sai nas próximas varreduras).
  if (listing.truncated) result.truncatedLists++;
  const paths = listing.entries
    .filter((e) => !isFolder(e))
    .map((e) => `${prefix}/${e.name}`);
  if (paths.length === 0) return;
  const { removed, failed } = await removePaths(db, paths, result);
  result.removedObjects += removed;
  // Lista truncada: sobrou conteúdo na pasta, ela ainda não foi esvaziada.
  if (!failed && !listing.truncated) result.removedFolders++;
}

interface KnownRow extends KnownResponse {
  account_id: string;
  form_id: string;
}

async function loadKnown(
  db: Db,
  ids: readonly string[]
): Promise<KnownRow[] | null> {
  const known: KnownRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data, error } = await db
      .from('form_responses')
      .select('id, status, updated_at, account_id, form_id')
      .in('id', chunk);
    if (error) return null;
    known.push(...((data ?? []) as KnownRow[]));
  }
  return known;
}

async function loadAnswers(
  db: Db,
  accountId: string,
  formId: string,
  ids: readonly string[]
): Promise<Map<string, unknown> | null> {
  const map = new Map<string, unknown>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await db
      .from('form_responses')
      .select('id, answers')
      .in('id', ids.slice(i, i + IN_CHUNK))
      .eq('account_id', accountId.toLowerCase())
      .eq('form_id', formId.toLowerCase())
      .eq('status', 'completed');
    if (error) return null;
    for (const row of (data ?? []) as { id: string; answers: unknown }[]) {
      map.set(row.id.toLowerCase(), row.answers);
    }
  }
  return map;
}

interface ScanContext {
  state: SweepState;
  dryRun: boolean;
  log: (message: string) => void;
  /** Caminhos já escritos no log do dry-run nesta varredura. */
  dryLogged: { count: number };
  /** Pastas `completed` que ainda podem ser inspecionadas nesta CONTA. */
  pruneBudget: { left: number };
}

function logDryRun(ctx: ScanContext, paths: readonly string[]): void {
  for (const path of paths) {
    if (ctx.dryLogged.count >= DRY_RUN_LOG_PATHS) {
      if (ctx.dryLogged.count === DRY_RUN_LOG_PATHS) {
        ctx.log(
          `[automations-cron] forms sweep dry-run: more than ${DRY_RUN_LOG_PATHS} paths, rest omitted (see wouldRemoveUnreferenced)`
        );
        ctx.dryLogged.count++;
      }
      return;
    }
    ctx.dryLogged.count++;
    ctx.log(`[automations-cron] forms sweep dry-run would remove: ${path}`);
  }
}

/** Avalia (e remove, ou só loga no dry-run) os objetos sem referência de UMA pasta. */
async function pruneFolder(
  db: Db,
  prefix: string,
  snapshot: unknown,
  now: Date,
  result: FormsSweepResult,
  ctx: ScanContext
): Promise<void> {
  const listing = await listAll(db, prefix);
  if (listing.error) {
    result.errors++;
    return;
  }
  // Nunca decide remoção sobre uma lista parcial da pasta.
  if (listing.truncated) {
    result.truncatedLists++;
    return;
  }
  result.prunedInspected++;
  const { remove, skippedNoDate } = selectUnreferencedObjects(
    prefix,
    listing.entries.filter((e) => !isFolder(e)),
    snapshot,
    now
  );
  result.skippedNoDate += skippedNoDate;
  if (remove.length === 0) return;
  if (ctx.dryRun) {
    result.wouldRemoveUnreferenced += remove.length;
    logDryRun(ctx, remove);
    return;
  }
  const { removed } = await removePaths(db, remove, result);
  result.removedObjects += removed;
  result.removedUnreferenced += removed;
}

/** Remove os objetos sem referência das pastas `completed` (item 3 do cabeçalho). */
async function pruneUnreferenced(
  db: Db,
  accountFolder: string,
  formId: string,
  completedIds: readonly string[],
  share: number,
  now: Date,
  result: FormsSweepResult,
  ctx: ScanContext
): Promise<void> {
  const formPrefix = `${accountFolder}/${formId}`;
  const cursors = (ctx.state.pruneCursors ??= {});
  if (completedIds.length === 0) {
    delete cursors[formPrefix];
    return;
  }
  const slice = nextFolderSlice(completedIds, cursors[formPrefix], share);
  if (slice.length === 0) return;
  ctx.pruneBudget.left = Math.max(0, ctx.pruneBudget.left - slice.length);

  const answers = await loadAnswers(
    db,
    accountFolder.slice('account-'.length),
    formId,
    slice
  );
  // Sem ler `answers` NADA é removido; o cursor não anda (a fatia volta na
  // próxima varredura em vez de ser pulada).
  if (!answers) {
    result.errors++;
    return;
  }
  for (const id of slice) {
    const snapshot = answers.get(id.toLowerCase());
    if (snapshot === undefined) continue;
    try {
      await pruneFolder(db, `${formPrefix}/${id}`, snapshot, now, result, ctx);
    } catch {
      result.errors++;
    }
  }
  // Toda a fatia foi tentada (erro de uma pasta já foi contado): o cursor
  // anda para além dela; pasta que falhou é reavaliada no próximo ciclo.
  cursors[formPrefix] = slice[slice.length - 1];
}

/** Um formulário da conta: órfãs/expiradas e, depois, a poda das concluídas. */
async function scanForm(
  db: Db,
  accountFolder: string,
  formId: string,
  share: number,
  now: Date,
  result: FormsSweepResult,
  ctx: ScanContext
): Promise<void> {
  const formPrefix = `${accountFolder}/${formId}`;
  const responses = await listAll(db, formPrefix);
  if (responses.error) {
    result.errors++;
    return;
  }
  if (responses.truncated) result.truncatedLists++;
  const folderIds = responses.entries
    .filter((e) => isFolder(e) && isUuid(e.name))
    .map((e) => e.name);
  if (folderIds.length === 0) return;
  result.scannedFolders += folderIds.length;

  const loaded = await loadKnown(db, folderIds);
  // Sem saber o que existe NADA é removido (falha do banco ≠ "órfão").
  if (!loaded) {
    result.errors++;
    return;
  }
  const accountId = accountFolder.slice('account-'.length).toLowerCase();
  // Linha que existe mas pertence a OUTRA conta/formulário que a pasta
  // (fora da convenção): nem órfã, nem expirável, nem podável.
  const known: KnownResponse[] = loaded.map((r) =>
    r.account_id?.toLowerCase() === accountId &&
    r.form_id?.toLowerCase() === formId.toLowerCase()
      ? r
      : { id: r.id, status: 'foreign', updated_at: r.updated_at }
  );
  const toRemove = selectResponseFoldersToRemove(folderIds, known, now);
  for (const id of toRemove) {
    try {
      await removeFolderObjects(db, `${formPrefix}/${id}`, result);
    } catch {
      result.errors++;
    }
  }

  const gone = new Set(toRemove.map((id) => id.toLowerCase()));
  const completed = new Set(
    known.filter((r) => r.status === 'completed').map((r) => r.id.toLowerCase())
  );
  const completedIds = folderIds.filter(
    (id) => completed.has(id.toLowerCase()) && !gone.has(id.toLowerCase())
  );
  // Lista de pastas truncada: a fatia sai só do que foi listado.
  await pruneUnreferenced(
    db,
    accountFolder,
    formId,
    completedIds,
    share,
    now,
    result,
    ctx
  );
}

async function scanAccount(
  db: Db,
  accountFolder: string,
  now: Date,
  result: FormsSweepResult,
  ctx: ScanContext,
  formsSeen: Map<string, Set<string>>
): Promise<void> {
  const forms = await listAll(db, accountFolder);
  if (forms.error) {
    result.errors++;
    return;
  }
  if (forms.truncated) result.truncatedLists++;
  const formIds = forms.entries
    .filter((e) => isFolder(e) && isUuid(e.name))
    .map((e) => e.name);
  // Só uma lista COMPLETA autoriza descartar cursores de formulário sumido.
  if (!forms.truncated) formsSeen.set(accountFolder, new Set(formIds));

  for (let i = 0; i < formIds.length; i++) {
    // Fatia justa do que resta do teto da conta: o 1º formulário não come
    // tudo (mínimo 1 pasta por formulário, mesmo com o teto esgotado).
    const share = Math.max(
      1,
      Math.ceil(ctx.pruneBudget.left / (formIds.length - i))
    );
    try {
      await scanForm(db, accountFolder, formIds[i], share, now, result, ctx);
    } catch {
      result.errors++;
    }
  }
}

/** Fase 1 — marca as paradas há mais de 24 h. */
export async function abandonStalePartials(
  db: Db,
  now: Date
): Promise<{ count: number; error: boolean }> {
  const { data: stale, error } = await db
    .from('form_responses')
    .select('id')
    .eq('status', 'partial')
    .lt('updated_at', staleCutoffIso(now))
    .limit(ABANDON_BATCH);
  if (error) return { count: 0, error: true };
  const ids = (stale ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return { count: 0, error: false };
  // `status = 'partial'` repetido: uma resposta concluída no meio do
  // caminho não volta para `abandoned`.
  const { data, error: updError } = await db
    .from('form_responses')
    .update({ status: 'abandoned' })
    .in('id', ids)
    .eq('status', 'partial')
    .select('id');
  if (updError) return { count: 0, error: true };
  return { count: data?.length ?? 0, error: false };
}

export interface SweepOptions {
  /** Só loga o que o passo 3 removeria. Padrão: `FORMS_SWEEP_PRUNE_DRY_RUN=1`. */
  pruneDryRun?: boolean;
  /** Destino do log do dry-run (padrão `console.log`). */
  log?: (message: string) => void;
}

/** `FORMS_SWEEP_PRUNE_DRY_RUN` ligada (`1` ou `true`). */
export function pruneDryRunFromEnv(
  env: Record<string, string | undefined> = process.env
): boolean {
  const v = env.FORMS_SWEEP_PRUNE_DRY_RUN?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

export async function runFormsSweep(
  db: Db,
  now: Date,
  state: SweepState = processSweepState,
  options: SweepOptions = {}
): Promise<FormsSweepResult> {
  const result = emptySweepResult();
  const dryRun = options.pruneDryRun ?? pruneDryRunFromEnv();
  result.dryRun = dryRun;

  try {
    const abandoned = await abandonStalePartials(db, now);
    result.abandoned = abandoned.count;
    if (abandoned.error) result.errors++;
  } catch {
    result.errors++;
  }

  // F7: provas de telefone vencidas há mais de um dia (barato, todo tick).
  try {
    result.phoneProofsRemoved = await sweepPhoneProofs(db, now);
  } catch {
    result.errors++;
  }

  if (now.getTime() - state.lastScanAt < ORPHAN_SCAN_INTERVAL_MS) {
    return result;
  }
  state.lastScanAt = now.getTime();
  result.storageScanned = true;

  try {
    const root = await listAll(db, '');
    if (root.error) {
      result.errors++;
      return result;
    }
    if (root.truncated) result.truncatedLists++;
    const accounts = pickAccountFolders(
      root.entries.filter(isFolder).map((e) => e.name)
    );
    const { slice, nextCursor } = nextAccountSlice(
      accounts,
      state.cursor,
      ACCOUNTS_PER_RUN
    );
    state.cursor = nextCursor;

    const formsSeen = new Map<string, Set<string>>();
    const dryLogged = { count: 0 };
    for (const account of slice) {
      const ctx: ScanContext = {
        state,
        dryRun,
        log: options.log ?? ((m) => console.log(m)),
        dryLogged,
        pruneBudget: { left: FOLDERS_PRUNED_PER_ACCOUNT },
      };
      try {
        await scanAccount(db, account, now, result, ctx, formsSeen);
      } catch {
        result.errors++;
      }
    }

    // Cursores de conta/formulário que sumiram não ficam para sempre no
    // mapa. Lista de contas truncada: não descarta nada.
    if (!root.truncated && state.pruneCursors) {
      pruneStaleCursors(state.pruneCursors, new Set(accounts), formsSeen);
    }
  } catch {
    result.errors++;
  }
  return result;
}
