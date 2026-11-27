// ============================================================
// Masking of personal data in what the audit table stores (SPEC 089 §8,
// F5). The input of a tool call can carry what the customer typed (an
// e-mail, a phone, a CPF, a free-text note). `ai_tool_calls.input` and
// `output_summary` keep the SHAPE of the call, not the personal data.
//
// Pure and deterministic. Never throws.
// ============================================================

import { ADDRESS_RE, MASK_ADDRESS, MASK_PLATE, PLATE_RE } from '../tuning/mask';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// CPF 000.000.000-00 (with or without punctuation) and CNPJ.
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ_RE = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
// A phone-like run: optional +, then digits with spaces, dots, dashes or
// parentheses between them, at least 8 digits in total.
const PHONE_RE = /\+?\(?\d[\d\s().-]{6,}\d/g;

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${host[0] ?? ''}***${tld}`;
}

// A phone, a CEP or a card number is replaced by a mark with no digit at all:
// the last two digits are still personal data (and narrow a search).
function maskPhoneRun(run: string): string {
  const digits = run.replace(/\D/g, '');
  if (digits.length < 8) return run;
  return '***';
}

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Mask e-mails, street addresses, licence plates, CPF/CNPJ and phone / CEP /
 * card numbers inside free text (a person's NAME has no format: free text
 * from the model or the customer is kept as a length, see `auditInputFor`). A UUID is an
 * identifier, not personal data: the digit runs inside it would look like a
 * phone number, so UUIDs are set aside before masking and put back after
 * (otherwise the id of a created deal is mangled in the audit).
 */
export function maskPiiText(text: string): string {
  const kept: string[] = [];
  const shielded = text.replace(UUID_RE, (m) => {
    kept.push(m);
    return `\u0001${kept.length - 1}\u0002`;
  });
  const masked = shielded
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(ADDRESS_RE, MASK_ADDRESS)
    .replace(PLATE_RE, MASK_PLATE)
    .replace(CNPJ_RE, '**.***.***/****-**')
    .replace(CPF_RE, '***.***.***-**')
    .replace(PHONE_RE, (m) => maskPhoneRun(m));
  return masked.replace(/\u0001(\d+)\u0002/g, (_, i) => kept[Number(i)] ?? '');
}

/** "Maria da Silva" → "M. d. S." (a name is personal data too). */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => `${p[0]}.`)
    .join(' ')
    .slice(0, 40);
}

/** Longest string kept in an audit payload. */
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 30;

/**
 * Keys whose string value is a person's name: reduced to initials. Every
 * other string is scanned for e-mail / CPF / phone and cut to 200 chars.
 */
const NAME_KEYS = new Set(['name']);

/**
 * Keys whose string value is free text written by the model or the customer
 * (a deal title, a summary, a note, a search string, a field name the model
 * made up). Free text can carry a name or an address, which have no format to
 * mask: only its length is kept, as `{ length }`.
 */
const FREE_TEXT_KEYS = new Set([
  'title',
  'summary',
  'note',
  'query',
  'message',
  'text',
  'body',
  'description',
  'content',
  'field',
]);

/**
 * A copy of `value` safe to store in the audit table: strings masked and
 * cut, objects and arrays limited in depth and size.
 */
export function maskForAudit(value: unknown, depth = 0, key?: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (key && NAME_KEYS.has(key)) return maskName(value);
    if (key && FREE_TEXT_KEYS.has(key)) return { length: value.length };
    const masked = maskPiiText(value);
    return masked.length > MAX_STRING
      ? `${masked.slice(0, MAX_STRING)}…`
      : masked;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((v) => maskForAudit(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) break;
      // Keys are masked too: a custom field is named by the account, and a
      // model can invent a "name" that is a phone or an e-mail.
      out[maskPiiText(k).slice(0, 80)] = maskForAudit(v, depth + 1, k);
    }
    return out;
  }
  return null;
}

/** A short masked text for `ai_tool_calls.output_summary` (≤ 500 chars). */
export function summarizeForAudit(value: unknown): string {
  let text: string;
  try {
    text =
      typeof value === 'string' ? value : JSON.stringify(maskForAudit(value));
  } catch {
    text = '[unserializable]';
  }
  const masked = maskPiiText(text ?? '');
  return masked.length > 500 ? `${masked.slice(0, 499)}…` : masked;
}

/**
 * What the audit stores of a tool's INPUT (SPEC 089 §8). The values of the
 * customer's own data (the fields a tool writes, a note's text) are not
 * stored at all: only their names and lengths; the same goes for the free
 * text the model writes (deal title, handoff reason and summary). What the
 * account itself defines (tag and funnel names) is kept, masked.
 */
export function auditInputFor(tool: string, input: unknown): unknown {
  const obj =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  if (!obj) return maskForAudit(input);

  if (tool === 'update_contact_fields') {
    const fields: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'custom_fields' && v && typeof v === 'object') {
        for (const [name, value] of Object.entries(
          v as Record<string, unknown>
        )) {
          fields[maskPiiText(name).slice(0, 80)] =
            typeof value === 'string' ? value.length : 0;
        }
      } else if (typeof v === 'string') {
        fields[k] = v.length;
      }
    }
    return { fields_value_length: fields };
  }
  if (tool === 'search_knowledge') {
    // The model's search string is built from what the customer wrote.
    const query = obj.query;
    return { query_length: typeof query === 'string' ? query.length : 0 };
  }
  if (tool === 'add_internal_note') {
    const note = obj.note;
    return { note_length: typeof note === 'string' ? note.length : 0 };
  }
  if (tool === 'handoff_to_human') {
    // Both are written from what the customer said: lengths only.
    const reason = typeof obj.reason === 'string' ? obj.reason : '';
    const summary = typeof obj.summary === 'string' ? obj.summary : '';
    return { reason_length: reason.length, summary_length: summary.length };
  }
  if (tool === 'create_deal') {
    // The title is typed from the conversation ("Pedido Joana - Av. X 500").
    const { title, ...rest } = obj;
    return {
      ...(maskForAudit(rest) as Record<string, unknown>),
      title_length: typeof title === 'string' ? title.length : 0,
    };
  }
  return maskForAudit(input);
}

/**
 * What the audit stores of the input of an account-defined HTTP tool (F6):
 * the field names and the length or type of each value, never the value (it
 * is what the customer typed, on its way to a third party).
 */
export function auditShapeOnly(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const fields: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    fields[maskPiiText(k).slice(0, 80)] =
      typeof v === 'string' ? v.length : typeof v;
  }
  return { fields_shape: fields };
}

/**
 * The SHAPE of a tool result for `output_summary` of a READ: key names,
 * counts and lengths, never the values (they are the customer's data:
 * profile fields, deals, knowledge excerpts).
 */
export function summarizeShape(value: unknown, depth = 0): string {
  const text = (() => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return `text(${value.length})`;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return typeof value;
    }
    if (Array.isArray(value)) return `list(${value.length})`;
    if (typeof value === 'object') {
      if (depth >= 2) return 'object';
      const parts = Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(
          ([k, v]) =>
            `${maskPiiText(k).slice(0, 40)}: ${summarizeShape(v, depth + 1)}`
        );
      return `{ ${parts.join(', ')} }`;
    }
    return 'unknown';
  })();
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}
