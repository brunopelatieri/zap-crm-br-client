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
//      O Storage não tem consulta por prefixo recursiva: percorre
//      conta → formulário → pasta de resposta, `ACCOUNTS_PER_RUN` contas
//      por varredura com cursor em memória (best-effort: reinício do
//      processo volta ao começo) e no máximo 1 vez por hora por processo.
//   3. Objetos SEM REFERÊNCIA numa resposta `completed` (achado do roteiro
//      manual da SPEC 085, item 5): o fluxo é start → upload-url → PUT
//      direto → submit, e o submit só grava em `answers` os arquivos que o
//      visitante lista; o resto (várias URLs assinadas, só uma usada)
//      ficaria para sempre e fora da quota (`upload_bytes` soma só o
//      referenciado). Remove da pasta da resposta o objeto cujo caminho NÃO
//      está em `answers` (instantâneo imutável) e que tem mais de 24 h
//      (> validade de 2 h da URL assinada e > tempo de preenchimento).
//      Arquivo referenciado NUNCA é removido; sem conseguir ler `answers`,
//      listar a pasta ou a idade do objeto, nada é removido. Só `completed`:
//      `partial` vive ≤ 24 h e vira `abandoned`, cuja pasta inteira some em
//      7 dias (mexer em objeto de resposta em andamento só traria risco).
//      Custo: 1 `list` por pasta de resposta concluída, no máximo
//      `FOLDERS_PRUNED_PER_ACCOUNT` por conta e varredura (orçamento por
//      conta: uma conta grande não deixa as outras da fatia sem vez), com
//      cursor por formulário (último id inspecionado, não índice: a pasta
//      esvaziada some do Storage e deslocaria um índice).
//
// A lógica de decisão é pura (`selectResponseFoldersToRemove`,
// `selectUnreferencedObjects`); o
// percurso recebe o client e roda com dublê nos testes. Nada lança: o
// chamador é um `after()` que não tem quem leia a exceção.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid } from '@/lib/api/uuid';

import { sweepPhoneProofs } from './phone-proof';
import { FORM_UPLOADS_BUCKET } from './uploads';

export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;
export const ABANDONED_FILES_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const ORPHAN_SCAN_INTERVAL_MS = 60 * 60 * 1000;
/** Objeto sem referência só sai depois disto (> validade de 2 h da URL de upload). */
export const UNREFERENCED_FILES_GRACE_MS = 24 * 60 * 60 * 1000;
export const ACCOUNTS_PER_RUN = 10;
/** Teto de pastas `completed` inspecionadas (1 `list` cada) por conta e por varredura. */
export const FOLDERS_PRUNED_PER_ACCOUNT = 100;
const LIST_PAGE = 1000;
const MAX_LIST_PAGES = 20;
const IN_CHUNK = 150;
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
   * Por prefixo de formulário: último id de pasta `completed` inspecionado
   * (a próxima varredura continua DEPOIS dele; o teto por conta não pode
   * deixar as últimas pastas sem vez).
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
 * Caminhos (minúsculos) que `answers` referencia. `null` = o instantâneo
 * não tem a forma esperada: sem saber o que é referenciado nada pode ser
 * removido (a remoção não tem volta e o `vn` não tem backup).
 */
export function referencedFilePaths(answers: unknown): Set<string> | null {
  if (!isRecord(answers)) return null;
  const paths = new Set<string>();
  for (const entry of Object.values(answers)) {
    if (!isRecord(entry)) return null;
    if (entry.type !== 'file_upload') continue;
    const value = entry.value;
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value)) return null;
    for (const ref of value) {
      if (!isRecord(ref) || typeof ref.path !== 'string') return null;
      paths.add(ref.path.toLowerCase());
    }
  }
  return paths;
}

/** Instante mais recente de criação/alteração do objeto; `null` = ilegível. */
function objectTimestamp(o: StoredObject): number | null {
  const times = [o.created_at, o.updated_at]
    .filter((t): t is string => typeof t === 'string' && t !== '')
    .map((t) => Date.parse(t));
  if (times.length === 0 || times.some((t) => Number.isNaN(t))) return null;
  return Math.max(...times);
}

/**
 * Caminhos completos dos objetos da pasta de uma resposta `completed` que
 * `answers` NÃO referencia e que são mais velhos que a folga de 24 h.
 * Referenciado nunca sai; sem idade legível ou sem `answers` válido, nada.
 */
export function selectUnreferencedObjects(
  folderPrefix: string,
  objects: readonly StoredObject[],
  answers: unknown,
  now: Date
): string[] {
  const referenced = referencedFilePaths(answers);
  if (!referenced) return [];
  const cutoff = now.getTime() - UNREFERENCED_FILES_GRACE_MS;
  const out: string[] = [];
  for (const o of objects) {
    const path = `${folderPrefix}/${o.name}`;
    if (referenced.has(path.toLowerCase())) continue;
    const ts = objectTimestamp(o);
    if (ts !== null && ts < cutoff) out.push(path);
  }
  return out;
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

type Db = SupabaseClient;

interface ListedEntry extends StoredObject {
  id?: string | null;
}

async function listAll(
  db: Db,
  prefix: string
): Promise<{ entries: ListedEntry[]; error: boolean }> {
  const bucket = db.storage.from(FORM_UPLOADS_BUCKET);
  const entries: ListedEntry[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { data, error } = await bucket.list(prefix, {
      limit: LIST_PAGE,
      offset: page * LIST_PAGE,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) return { entries, error: true };
    const batch = (data ?? []) as ListedEntry[];
    entries.push(...batch);
    if (batch.length < LIST_PAGE) break;
  }
  return { entries, error: false };
}

/** Pasta = entrada sem `id` (o Storage só dá `id` a objeto). */
const isFolder = (e: ListedEntry) => e.id === null || e.id === undefined;

async function removeFolderObjects(
  db: Db,
  prefix: string,
  result: FormsSweepResult
): Promise<void> {
  const { entries, error } = await listAll(db, prefix);
  if (error) {
    result.errors++;
    return;
  }
  const paths = entries
    .filter((e) => !isFolder(e))
    .map((e) => `${prefix}/${e.name}`);
  if (paths.length === 0) return;
  const { error: rmError } = await db.storage
    .from(FORM_UPLOADS_BUCKET)
    .remove(paths);
  if (rmError) {
    result.errors++;
    return;
  }
  result.removedFolders++;
  result.removedObjects += paths.length;
}

async function loadKnown(
  db: Db,
  ids: readonly string[]
): Promise<KnownResponse[] | null> {
  const known: KnownResponse[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data, error } = await db
      .from('form_responses')
      .select('id, status, updated_at')
      .in('id', chunk);
    if (error) return null;
    known.push(...((data ?? []) as KnownResponse[]));
  }
  return known;
}

interface ScanContext {
  state: SweepState;
  /** Pastas `completed` que ainda podem ser inspecionadas nesta CONTA. */
  pruneBudget: { left: number };
}

async function loadAnswers(
  db: Db,
  ids: readonly string[]
): Promise<Map<string, unknown> | null> {
  const map = new Map<string, unknown>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await db
      .from('form_responses')
      .select('id, answers')
      .in('id', ids.slice(i, i + IN_CHUNK))
      .eq('status', 'completed');
    if (error) return null;
    for (const row of (data ?? []) as { id: string; answers: unknown }[]) {
      map.set(row.id.toLowerCase(), row.answers);
    }
  }
  return map;
}

/** Remove os objetos sem referência das pastas `completed` (item 3 do cabeçalho). */
async function pruneUnreferenced(
  db: Db,
  formPrefix: string,
  completedIds: readonly string[],
  now: Date,
  result: FormsSweepResult,
  ctx: ScanContext
): Promise<void> {
  const cursors = (ctx.state.pruneCursors ??= {});
  if (completedIds.length === 0) {
    delete cursors[formPrefix];
    return;
  }
  const slice = nextFolderSlice(
    completedIds,
    cursors[formPrefix],
    ctx.pruneBudget.left
  );
  if (slice.length === 0) return;
  ctx.pruneBudget.left -= slice.length;
  cursors[formPrefix] = slice[slice.length - 1];

  const answers = await loadAnswers(db, slice);
  // Sem ler `answers` NADA é removido.
  if (!answers) {
    result.errors++;
    return;
  }
  for (const id of slice) {
    const snapshot = answers.get(id.toLowerCase());
    if (snapshot === undefined) continue;
    const prefix = `${formPrefix}/${id}`;
    const listed = await listAll(db, prefix);
    if (listed.error) {
      result.errors++;
      continue;
    }
    const paths = selectUnreferencedObjects(
      prefix,
      listed.entries.filter((e) => !isFolder(e)),
      snapshot,
      now
    );
    if (paths.length === 0) continue;
    const { error } = await db.storage.from(FORM_UPLOADS_BUCKET).remove(paths);
    if (error) {
      result.errors++;
      continue;
    }
    result.removedObjects += paths.length;
    result.removedUnreferenced += paths.length;
  }
}

async function scanAccount(
  db: Db,
  accountFolder: string,
  now: Date,
  result: FormsSweepResult,
  ctx: ScanContext
): Promise<void> {
  const forms = await listAll(db, accountFolder);
  if (forms.error) {
    result.errors++;
    return;
  }
  for (const formEntry of forms.entries) {
    if (!isFolder(formEntry) || !isUuid(formEntry.name)) continue;
    const formPrefix = `${accountFolder}/${formEntry.name}`;
    const responses = await listAll(db, formPrefix);
    if (responses.error) {
      result.errors++;
      continue;
    }
    const folderIds = responses.entries
      .filter((e) => isFolder(e) && isUuid(e.name))
      .map((e) => e.name);
    if (folderIds.length === 0) continue;
    result.scannedFolders += folderIds.length;

    const known = await loadKnown(db, folderIds);
    // Sem saber o que existe NADA é removido (falha do banco ≠ "órfão").
    if (!known) {
      result.errors++;
      continue;
    }
    const toRemove = selectResponseFoldersToRemove(folderIds, known, now);
    for (const id of toRemove) {
      await removeFolderObjects(db, `${formPrefix}/${id}`, result);
    }

    const gone = new Set(toRemove.map((id) => id.toLowerCase()));
    const completed = new Set(
      known
        .filter((r) => r.status === 'completed')
        .map((r) => r.id.toLowerCase())
    );
    const completedIds = folderIds.filter(
      (id) => completed.has(id.toLowerCase()) && !gone.has(id.toLowerCase())
    );
    await pruneUnreferenced(db, formPrefix, completedIds, now, result, ctx);
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

export async function runFormsSweep(
  db: Db,
  now: Date,
  state: SweepState = processSweepState
): Promise<FormsSweepResult> {
  const result = emptySweepResult();

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
    const accounts = pickAccountFolders(
      root.entries.filter(isFolder).map((e) => e.name)
    );
    const { slice, nextCursor } = nextAccountSlice(
      accounts,
      state.cursor,
      ACCOUNTS_PER_RUN
    );
    state.cursor = nextCursor;
    for (const account of slice) {
      const ctx: ScanContext = {
        state,
        pruneBudget: { left: FOLDERS_PRUNED_PER_ACCOUNT },
      };
      await scanAccount(db, account, now, result, ctx);
    }
  } catch {
    result.errors++;
  }
  return result;
}
