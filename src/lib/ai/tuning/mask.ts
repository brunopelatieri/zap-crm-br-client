// ============================================================
// Masking of personal data at CAPTURE time (SPEC 089 §8, F7).
//
// A captured example or an evaluation case keeps a piece of a real
// conversation. What is stored has already lost the personal data: the
// customer's phone, e-mail, CPF/CNPJ/RG, card number, CEP, street address,
// licence plate and name. A UUID is an id and is kept whole. The
// placeholders are words in brackets (`[telefone]`, `[e-mail]`…), never a
// partial value (`***41`): a partial value is still data, and a model that
// reads examples would learn to write asterisks.
//
// Rules of the road:
//   - conservative: a number that MIGHT be personal (8+ digits in a row,
//     whatever the punctuation) is masked, even if that costs an order
//     number or a price in the millions;
//   - idempotent: masking a masked text changes nothing (placeholders have
//     no digits or `@`), so the export can mask again as a second layer;
//   - pure and deterministic, never throws.
//
// Names are the hard part: free text has no name format. We mask the names
// we KNOW (the contact's, handed in by the caller) and the usual
// introductions ("meu nome é Maria Souza"); anything else the customer
// types about a third party stays. That residual is why nothing reaches the
// prompt without an admin's approval, and why the screen says so.
//
// No `\u` escapes in this file on purpose (they are rewritten by some
// editors); control characters come from `String.fromCharCode`.
// ============================================================

export const MASK_PHONE = '[telefone]';
export const MASK_EMAIL = '[e-mail]';
export const MASK_CPF = '[cpf]';
export const MASK_CNPJ = '[cnpj]';
export const MASK_CARD = '[cartão]';
export const MASK_CEP = '[cep]';
export const MASK_NAME = '[nome]';
export const MASK_LINK_WA = '[link-whatsapp]';
export const MASK_ADDRESS = '[endereço]';
export const MASK_PLATE = '[placa]';
export const MASK_DOCUMENT = '[documento]';

const SHIELD_OPEN = String.fromCharCode(1);
const SHIELD_CLOSE = String.fromCharCode(2);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// CNPJ 00.000.000/0000-00 (punctuation optional) before CPF.
const CNPJ_RE = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
// CPF with its dots and dash, in any validity. Unpunctuated CPFs (11
// digits, ambiguous with a mobile number) go through the digit-run rule.
const CPF_PUNCT_RE = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
// A card number: 13–19 digits, optional single spaces or dashes between.
const CARD_RE = /\+?(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
// A run that may be a phone: digits with spaces, dots, dashes and
// parentheses between them (NBSP too), optional leading + or (.
const DIGIT_RUN_RE = /[+(]?\d[\d ().\xa0-]{5,}\d/g;
// A UUID is an identifier, not personal data: its digit runs would look like
// a phone number, so it is set aside before the numeric rules.
export const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// RG with its dots and check digit (12.345.678-9, 12.345.678-X).
const RG_RE = /(?<!\d)\d{1,2}\.\d{3}\.\d{3}-[\dXx](?![\dXx])/g;
// Licence plate, old (ABC-1234) and Mercosul (BRA2E19): whole word, upper
// case only (so a lower-case word with digits is left alone).
export const PLATE_RE =
  /(?<![\p{L}\d])[A-Z]{3}-?\d[A-Z0-9]\d{2}(?![\p{L}\d])/gu;
// A street address: a street type, the name (words, or "7 de Setembro"), a
// number (comma and "n." optional) and the complement that follows it (apto
// 45, bloco B, casa 2). A number glued to a CEP ("500, 01310-100") does not
// count as the street number: the CEP rule takes it.
const STREET_TYPE =
  /(?:rua|r\.|avenida|av\.?|travessa|tv\.|alameda|al\.|rodovia|rod\.|estrada|est\.|pra[cç]a|p[cç]a\.|largo)/
    .source;
// A word of the name ("das", "Flores"), "7 de Setembro", or a short
// abbreviation with its dot ("Dr.", "Gov."); a long word ending a sentence
// ("bonita.") is not part of the name.
const STREET_WORD = /(?:\d{1,2}\s+de\s+\p{L}+|\p{L}{1,4}\.|\p{L}[\p{L}'-]*)/u
  .source;
const STREET_COMPLEMENT =
  /(?:\s*,?\s*(?:apto?\.?|ap\.?|apartamento|bloco|bl\.?|casa|sala|conjunto|cj\.?|lote|lt\.?|quadra|qd\.?)\s*[\p{L}\d]{1,6}(?![\p{L}\d]))*/u
    .source;
const STREET_NUMBER = /\s*,?\s*(?:n[º°o]\.?\s*)?\d{1,6}(?!\d|-\d)/.source;
const STREET_BEHIND = /(?<![\p{L}\d])/u.source;
const STREET_GAP = /\s+/.source;
export const ADDRESS_RE = new RegExp(
  [
    STREET_BEHIND,
    STREET_TYPE,
    STREET_GAP,
    STREET_WORD,
    `(?:${STREET_GAP}${STREET_WORD}){0,5}`,
    STREET_NUMBER,
    STREET_COMPLEMENT,
  ].join(''),
  'giu'
);
// http(s) and www links.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
// "meu nome é Maria Souza", "me chamo João", "aqui é a Ana" (up to 4
// capitalised words). CASE-SENSITIVE on purpose: under the `i` flag `\p{Lu}`
// also matches lowercase letters, and "sou cliente antigo" would lose its
// words. The prefixes spell out their usual casings instead.
const INTRO_RE =
  /\b([Mm]eu nome (?:é|e|eh)|[Mm]e chamo|[Aa]qui (?:é|e|eh) (?:a|o)|[Ss]ou (?:a|o)|[Mm]y name is|[Ii] am|[Ii]'m)\s+(\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){0,3})/gu;

/** Matches a shielded slot (`SHIELD_OPEN` index `SHIELD_CLOSE`). */
function restoreRe(): RegExp {
  return new RegExp(`${SHIELD_OPEN}(\\d+)${SHIELD_CLOSE}`, 'g');
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '');
}

/** CPF check digits (11 digits, not all equal). */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

/** Luhn checksum (card numbers). */
export function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const DATE_RE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;

function maskDigitRun(run: string): string {
  const digits = run.replace(/\D/g, '');
  if (digits.length < 8) return run;
  // A date written with dots or dashes ("10.12.2026") is not personal data.
  if (DATE_RE.test(run.trim())) return run;
  // More than a phone can hold: it is some other long identifier; mask it
  // too (conservative), as a phone-like value.
  if (digits.length === 11 && isValidCpf(digits)) return MASK_CPF;
  if (/^\d{5}-\d{3}$/.test(run.trim())) return MASK_CEP;
  return MASK_PHONE;
}

function neutralizeUrl(url: string): string {
  const lower = url.toLowerCase();
  // wa.me/5511… and api.whatsapp.com/send?phone=… carry a number.
  if (lower.includes('wa.me') || lower.includes('whatsapp.com')) {
    return MASK_LINK_WA;
  }
  // Keep the page, drop the query and the fragment (tracking ids, e-mails,
  // tokens ride there).
  const cut = url.search(/[?#]/);
  const page = cut === -1 ? url : `${url.slice(0, cut)}?…`;
  // A UUID in the path is an id, not a phone: set it aside while masking.
  const ids: string[] = [];
  const shielded = page.replace(UUID_RE, (m) => {
    ids.push(m);
    return `${SHIELD_OPEN}${ids.length - 1}${SHIELD_CLOSE}`;
  });
  // The path and the user-info part can carry personal data too
  // (`/clientes/11987654321`, `/u/maria@exemplo.com`): mask it there. Short
  // numeric ids (an order number) stay, a 10+ digit run does not.
  const masked = shielded
    .replace(EMAIL_RE, MASK_EMAIL)
    .replace(CNPJ_RE, MASK_CNPJ)
    .replace(CPF_PUNCT_RE, MASK_CPF)
    .replace(/(?<!\d)\d{10,}(?!\d)/g, (m) =>
      m.length === 11 && isValidCpf(m) ? MASK_CPF : MASK_PHONE
    );
  return masked.replace(restoreRe(), (_m, i: string) => ids[Number(i)] ?? '');
}

export interface MaskOptions {
  /** Names to mask wherever they appear as whole words (the contact's name
   *  and nickname). Words shorter than 3 letters are ignored. */
  knownNames?: readonly string[];
}

function nameTokens(names: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const name of names ?? []) {
    for (const w of name.match(/\p{L}+/gu) ?? []) {
      if (w.length >= 3) out.add(stripAccents(w).toLowerCase());
    }
  }
  return out;
}

/**
 * `text` with personal data replaced by placeholders (see the header).
 * Empty or non-string input gives ''.
 */
export function maskPersonalData(text: string, opts: MaskOptions = {}): string {
  if (typeof text !== 'string' || text.length === 0) return '';

  // Links first: their digits are page ids, not phones, and their query
  // strings are cut. Shielded behind a control-character placeholder so the
  // later passes cannot touch them.
  const kept: string[] = [];
  let out = text.replace(URL_RE, (m) => {
    kept.push(neutralizeUrl(m));
    return `${SHIELD_OPEN}${kept.length - 1}${SHIELD_CLOSE}`;
  });

  // UUIDs next, for the same reason (same shield, restored at the end).
  out = out.replace(UUID_RE, (m) => {
    kept.push(m);
    return `${SHIELD_OPEN}${kept.length - 1}${SHIELD_CLOSE}`;
  });

  out = out
    .replace(EMAIL_RE, MASK_EMAIL)
    .replace(ADDRESS_RE, MASK_ADDRESS)
    .replace(PLATE_RE, MASK_PLATE)
    .replace(CNPJ_RE, MASK_CNPJ)
    .replace(CPF_PUNCT_RE, MASK_CPF)
    .replace(RG_RE, MASK_DOCUMENT)
    .replace(CARD_RE, (m) => {
      // A 13-digit run is also a Brazilian number with its country code
      // (+55 11 9xxxx-xxxx): only a number that passes the Luhn check is a
      // card here; the rest falls to the phone rule below.
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)
        ? MASK_CARD
        : m;
    })
    .replace(DIGIT_RUN_RE, maskDigitRun);

  const names = nameTokens(opts.knownNames);
  if (names.size > 0) {
    out = out.replace(/\p{L}+/gu, (w) =>
      names.has(stripAccents(w).toLowerCase()) ? MASK_NAME : w
    );
  }
  out = out.replace(INTRO_RE, (_m, intro: string) => `${intro} ${MASK_NAME}`);

  // The control characters never occur in real text, but strip any that did
  // so the restore below cannot be spoofed.
  return out.replace(restoreRe(), (_m, i: string) => kept[Number(i)] ?? '');
}

/**
 * Mask, trim and cut to `max` characters (at a word boundary when one is
 * near the end). Used for every text the tuning tables store.
 */
export function maskAndLimit(
  text: string,
  max: number,
  opts: MaskOptions = {}
): string {
  const masked = maskPersonalData(
    // Drop control characters before the shield logic sees them.
    // Every control character except newline, carriage return and tab.
    String(text ?? '').replace(/[^\P{Cc}\n\r\t]/gu, ''),
    opts
  ).trim();
  if (masked.length <= max) return masked;
  const cut = masked.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
