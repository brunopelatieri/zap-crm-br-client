// ============================================================
// Prova de posse do telefone (SPEC 085 F7; fecha M-2 e M-3 do Status).
//
// Desenho INBOUND: o visitante informa o telefone, a página mostra um
// código e um botão `wa.me` que abre o WhatsApp DELE com o código
// pré-escrito para o número da conta; ele envia. A mensagem chega pelo
// webhook (Meta ou Evolution), cujo remetente o provedor autentica, e
// `handleInboundPhoneProof` confirma a prova SE o remetente for o telefone
// informado. Só então o `start` aceita a prova (uso único) e cria/vincula
// o contato. Nada sai da conta para um número que ela não conhece: sem
// custo de template, sem teto de envio frio, sem vetor de spam.
//
// Este módulo é puro de transporte: recebe o cliente (`db`, service-role
// da rota pública ou do webhook) e conversa só com `form_phone_proofs`
// (migração 100). Estados: pending → confirmed → consumed; `expired` para
// vencida/substituída. Toda transição é um `UPDATE … WHERE status = '…'`
// que devolve a linha: duas chamadas concorrentes não vencem as duas.
//
// Nunca vai ao navegador: `phone`, `secret_hash`, `ip_hash`. O navegador só
// recebe `proof_id`, o segredo que ELE guarda, o código e o prazo.
// ============================================================

import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { phoneCandidates } from '@/lib/contact-portal/phone';
import { normalizeContactPhone } from '@/lib/phone/br';

type Db = Pick<SupabaseClient, 'from'>;

/** Sem 0, 1, I, L, O (a mesma lista do código curto da conta, migração 093). */
export const PROOF_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PROOF_CODE_LENGTH = 8;

/** Tempo para o visitante enviar a mensagem. */
export const PROOF_PENDING_TTL_MS = 10 * 60 * 1000;
/** Depois de confirmada, o `start` precisa consumi-la neste prazo. */
export const PROOF_CONFIRMED_TTL_MS = 15 * 60 * 1000;
/** Varredura apaga o que venceu há mais que isto. */
export const PROOF_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Limites por janela de 1 h (contados no banco: valem com várias instâncias). */
export const PROOF_LIMITS = {
  /** Entre dois códigos para o mesmo telefone no mesmo formulário. */
  minIntervalMs: 30_000,
  perPhoneHour: 5,
  perFormHour: 300,
  perAccountHour: 1000,
} as const;
const HOUR_MS = 60 * 60 * 1000;
const CODE_RETRIES = 4;
/** Texto maior que isto não é uma mensagem de confirmação. */
const INBOUND_TEXT_MAX = 400;
const INBOUND_CODES_MAX = 3;

// ------------------------------------------------------------
// Código e segredo
// ------------------------------------------------------------

export function generateProofCode(): string {
  let out = '';
  for (let i = 0; i < PROOF_CODE_LENGTH; i++) {
    out += PROOF_CODE_ALPHABET[randomInt(PROOF_CODE_ALPHABET.length)];
  }
  return out;
}

/** `ABCD-EFGH` para a tela e o texto do `wa.me`. */
export function formatProofCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function generateProofSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashProofSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function secretMatches(stored: unknown, secret: unknown): boolean {
  if (typeof stored !== 'string' || typeof secret !== 'string') return false;
  if (!secret || secret.length > 256) return false;
  if (!/^[0-9a-f]{64}$/.test(stored)) return false;
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(hashProofSecret(secret), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const CODE_IN_TEXT = new RegExp(
  `(?<![A-Z0-9])([${PROOF_CODE_ALPHABET}]{4})[\\s-]?([${PROOF_CODE_ALPHABET}]{4})(?![A-Z0-9])`,
  'g'
);

/**
 * Códigos candidatos dentro de uma mensagem recebida (no máximo 3, sem
 * repetir). Aceita caixa baixa e com ou sem hífen/espaço: quem digita à mão
 * erra o formato, não o código. Palavra comum de 8 letras também casa — o
 * custo é uma consulta indexada que não acha nada.
 */
export function extractProofCodes(text: string | null | undefined): string[] {
  if (!text || text.length > INBOUND_TEXT_MAX) return [];
  const found: string[] = [];
  for (const m of text.toUpperCase().matchAll(CODE_IN_TEXT)) {
    const code = `${m[1]}${m[2]}`;
    if (!found.includes(code)) found.push(code);
    if (found.length >= INBOUND_CODES_MAX) break;
  }
  return found;
}

/** O telefone que mandou a mensagem é o que o visitante informou? */
export function phonesMatch(
  a: string,
  b: string,
  opts?: { brMode?: boolean }
): boolean {
  const ca = phoneCandidates(a, opts);
  const cb = phoneCandidates(b, opts);
  if (!ca || !cb) return false;
  return ca.some((x) => cb.includes(x));
}

// ------------------------------------------------------------
// Emissão
// ------------------------------------------------------------

export type IssueProofResult =
  | {
      ok: true;
      proofId: string;
      secret: string;
      /** Sem hífen; a tela usa `formatProofCode`. */
      code: string;
      expiresAt: Date;
    }
  | {
      ok: false;
      reason: 'invalid_phone' | 'rate_limited' | 'error';
      retryAfterSeconds?: number;
    };

export interface IssueProofInput {
  accountId: string;
  formId: string;
  /** Telefone como o visitante digitou; normalizado aqui. */
  phone: string;
  ipHash: string | null;
  now?: Date;
  brMode?: boolean;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function countSince(
  db: Db,
  column: 'form_id' | 'account_id',
  value: string,
  sinceMs: number
): Promise<number | null> {
  const { count, error } = await db
    .from('form_phone_proofs')
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
    .gte('created_at', iso(sinceMs));
  if (error) return null;
  return count ?? 0;
}

/**
 * Gera uma prova `pending`. Limites no banco, nesta ordem: intervalo mínimo
 * e teto por telefone (uma consulta), teto por formulário, teto por conta.
 * Códigos pendentes anteriores do mesmo telefone/formulário são
 * substituídos (`expired`): só o mais novo vale.
 */
export async function issuePhoneProof(
  db: Db,
  input: IssueProofInput
): Promise<IssueProofResult> {
  const nowMs = (input.now ?? new Date()).getTime();
  const normalized = normalizeContactPhone(
    input.phone,
    input.brMode !== undefined ? { brMode: input.brMode } : undefined
  );
  if (!normalized.ok) return { ok: false, reason: 'invalid_phone' };
  const phone = normalized.phone;

  const since = nowMs - HOUR_MS;
  const { data: recent, error: recentError } = await db
    .from('form_phone_proofs')
    .select('created_at')
    .eq('account_id', input.accountId)
    .eq('phone', phone)
    .gte('created_at', iso(since))
    .order('created_at', { ascending: false })
    .limit(PROOF_LIMITS.perPhoneHour);
  if (recentError) return { ok: false, reason: 'error' };
  const rows = (recent ?? []) as { created_at: string }[];
  if (rows.length >= PROOF_LIMITS.perPhoneHour) {
    const oldest = new Date(rows[rows.length - 1].created_at).getTime();
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + HOUR_MS - nowMs) / 1000)
      ),
    };
  }
  if (rows.length > 0) {
    const last = new Date(rows[0].created_at).getTime();
    const wait = last + PROOF_LIMITS.minIntervalMs - nowMs;
    if (wait > 0) {
      return {
        ok: false,
        reason: 'rate_limited',
        retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)),
      };
    }
  }

  const [perForm, perAccount] = await Promise.all([
    countSince(db, 'form_id', input.formId, since),
    countSince(db, 'account_id', input.accountId, since),
  ]);
  if (perForm === null || perAccount === null) {
    return { ok: false, reason: 'error' };
  }
  if (
    perForm >= PROOF_LIMITS.perFormHour ||
    perAccount >= PROOF_LIMITS.perAccountHour
  ) {
    return { ok: false, reason: 'rate_limited', retryAfterSeconds: 300 };
  }

  const { error: supersedeError } = await db
    .from('form_phone_proofs')
    .update({ status: 'expired', expires_at: iso(nowMs) })
    .eq('account_id', input.accountId)
    .eq('form_id', input.formId)
    .eq('phone', phone)
    .eq('status', 'pending');
  if (supersedeError) return { ok: false, reason: 'error' };

  const secret = generateProofSecret();
  const expiresAt = new Date(nowMs + PROOF_PENDING_TTL_MS);
  for (let attempt = 0; attempt < CODE_RETRIES; attempt++) {
    const code = generateProofCode();
    const { data, error } = await db
      .from('form_phone_proofs')
      .insert({
        account_id: input.accountId,
        form_id: input.formId,
        phone,
        code,
        secret_hash: hashProofSecret(secret),
        ip_hash: input.ipHash,
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single();
    if (!error && data?.id) {
      return { ok: true, proofId: data.id as string, secret, code, expiresAt };
    }
    // Colisão do código pendente da conta: sorteia outro.
    if (!isUniqueViolation(error)) {
      console.error(
        '[forms/phone-proof] insert failed:',
        (error as { code?: string } | null)?.code ?? 'unknown'
      );
      return { ok: false, reason: 'error' };
    }
  }
  return { ok: false, reason: 'error' };
}

// ------------------------------------------------------------
// Estado e consumo (lado do navegador)
// ------------------------------------------------------------

export type ProofStatus = 'pending' | 'confirmed' | 'expired' | 'not_found';

interface ProofRow {
  id: string;
  phone: string;
  status: string;
  secret_hash: string;
  expires_at: string;
}

async function loadProof(
  db: Db,
  scope: { accountId: string; formId: string; proofId: string }
): Promise<ProofRow | null | 'error'> {
  const { data, error } = await db
    .from('form_phone_proofs')
    .select('id, phone, status, secret_hash, expires_at')
    .eq('id', scope.proofId)
    .eq('form_id', scope.formId)
    .eq('account_id', scope.accountId)
    .maybeSingle();
  if (error) return 'error';
  return (data as ProofRow | null) ?? null;
}

/**
 * O que a página consulta enquanto espera. Id errado, segredo errado e
 * prova já consumida são todos `not_found` (nada se revela a quem não é o
 * navegador que pediu).
 */
export async function getProofStatus(
  db: Db,
  input: {
    accountId: string;
    formId: string;
    proofId: string;
    secret: unknown;
    now?: Date;
  }
): Promise<ProofStatus | 'error'> {
  const row = await loadProof(db, input);
  if (row === 'error') return 'error';
  if (!row || !secretMatches(row.secret_hash, input.secret)) {
    return 'not_found';
  }
  const nowMs = (input.now ?? new Date()).getTime();
  if (row.status === 'consumed') return 'not_found';
  if (row.status === 'expired' || new Date(row.expires_at).getTime() <= nowMs) {
    return 'expired';
  }
  return row.status === 'confirmed' ? 'confirmed' : 'pending';
}

export type ConsumeProofResult =
  | { ok: true; phone: string; proofId: string }
  | { ok: false; reason: 'invalid' | 'not_confirmed' | 'error' };

/**
 * Uso único: `confirmed` → `consumed` em um `UPDATE` condicional. Devolve o
 * telefone CONFIRMADO (o que o `start` usa; o que o navegador mandar
 * junto é ignorado).
 */
export async function consumePhoneProof(
  db: Db,
  input: {
    accountId: string;
    formId: string;
    proofId: string;
    secret: unknown;
    now?: Date;
  }
): Promise<ConsumeProofResult> {
  const row = await loadProof(db, input);
  if (row === 'error') return { ok: false, reason: 'error' };
  if (!row || !secretMatches(row.secret_hash, input.secret)) {
    return { ok: false, reason: 'invalid' };
  }
  const now = input.now ?? new Date();
  if (row.status !== 'confirmed' || new Date(row.expires_at) <= now) {
    return { ok: false, reason: 'not_confirmed' };
  }
  const { data, error } = await db
    .from('form_phone_proofs')
    .update({ status: 'consumed', consumed_at: now.toISOString() })
    .eq('id', row.id)
    .eq('account_id', input.accountId)
    .eq('status', 'confirmed')
    .gt('expires_at', now.toISOString())
    .select('id');
  if (error) return { ok: false, reason: 'error' };
  if (!data || data.length === 0) return { ok: false, reason: 'not_confirmed' };
  return { ok: true, phone: row.phone, proofId: row.id };
}

/**
 * Devolve uma prova consumida a `confirmed` quando o `start` falhou DEPOIS
 * de consumi-la por motivo que não é do visitante (erro de banco, quota).
 * Melhor esforço: nunca lança.
 */
export async function restorePhoneProof(
  db: Db,
  input: { accountId: string; proofId: string }
): Promise<void> {
  try {
    await db
      .from('form_phone_proofs')
      .update({ status: 'confirmed', consumed_at: null })
      .eq('id', input.proofId)
      .eq('account_id', input.accountId)
      .eq('status', 'consumed');
  } catch {
    /* o visitante pede outro código */
  }
}

// ------------------------------------------------------------
// Confirmação (lado do webhook)
// ------------------------------------------------------------

export type InboundProofOutcome =
  'confirmed' | 'already' | 'mismatch' | 'no_match';

/**
 * Uma mensagem recebida na conta confirma alguma prova? `senderPhone` é o
 * telefone do contato da conversa (o remetente autenticado pelo provedor).
 *
 *   confirmed → casou o código E o remetente é o telefone informado;
 *   already   → o mesmo telefone reenviou (ou o provedor reentregou) um código
 *               de prova já confirmada/usada: não muda nada, mas a mensagem
 *               é consumida igual (a 1ª entrega já foi);
 *   mismatch  → o código é de uma prova da conta, mas de OUTRO telefone: não
 *               confirma (a mensagem é consumida igual);
 *   no_match  → nenhum código de prova ativa: siga o caminho normal.
 */
export async function confirmPhoneProofFromInbound(
  db: Db,
  input: {
    accountId: string;
    text: string | null | undefined;
    senderPhone: string | null | undefined;
    now?: Date;
    brMode?: boolean;
  }
): Promise<InboundProofOutcome> {
  const codes = extractProofCodes(input.text);
  if (codes.length === 0) return 'no_match';
  const now = input.now ?? new Date();

  const { data, error } = await db
    .from('form_phone_proofs')
    .select('id, phone, code, status')
    .eq('account_id', input.accountId)
    .in('status', ['pending', 'confirmed', 'consumed'])
    .in('code', codes)
    .gt('expires_at', now.toISOString());
  if (error || !data || data.length === 0) return 'no_match';

  const rows = data as {
    id: string;
    phone: string;
    code: string;
    status: string;
  }[];
  const sender = input.senderPhone ?? '';
  const fromSender = (r: { phone: string }) =>
    sender !== '' &&
    phonesMatch(
      r.phone,
      sender,
      input.brMode !== undefined ? { brMode: input.brMode } : undefined
    );
  const mine = rows.find((r) => r.status === 'pending' && fromSender(r));
  if (!mine) {
    return rows.some((r) => r.status !== 'pending' && fromSender(r))
      ? 'already'
      : 'mismatch';
  }

  const { data: done, error: updateError } = await db
    .from('form_phone_proofs')
    .update({
      status: 'confirmed',
      confirmed_at: now.toISOString(),
      expires_at: iso(now.getTime() + PROOF_CONFIRMED_TTL_MS),
    })
    .eq('id', mine.id)
    .eq('account_id', input.accountId)
    .eq('status', 'pending')
    .select('id');
  if (updateError || !done || done.length === 0) return 'mismatch';
  return 'confirmed';
}

/**
 * Gancho de `ingestInbound` (depois do opt-out, antes de flows/IA): `true`
 * = a mensagem era um código de confirmação de formulário e foi consumida
 * (nenhuma automação nem IA responde "ABCD-EFGH"). Nunca lança: é o caminho
 * quente de recebimento.
 */
export async function handleInboundPhoneProof(input: {
  db: Db;
  accountId: string;
  senderPhone: string | null | undefined;
  text: string | null | undefined;
}): Promise<boolean> {
  if (extractProofCodes(input.text).length === 0) return false;
  try {
    const outcome = await confirmPhoneProofFromInbound(input.db, {
      accountId: input.accountId,
      text: input.text,
      senderPhone: input.senderPhone,
    });
    return outcome !== 'no_match';
  } catch (err) {
    console.error(
      '[forms/phone-proof] inbound failed:',
      err instanceof Error ? err.name : typeof err
    );
    return false;
  }
}

/** Apaga provas vencidas há mais de um dia (fase `forms` do cron). */
export async function sweepPhoneProofs(db: Db, now: Date): Promise<number> {
  const { data, error } = await db
    .from('form_phone_proofs')
    .delete()
    .lt('expires_at', iso(now.getTime() - PROOF_RETENTION_MS))
    .select('id');
  if (error) throw error;
  return data?.length ?? 0;
}
