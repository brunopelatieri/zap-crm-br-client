import type { ChatMessage } from './types';

/** How many of the customer's latest messages feed the query (D-13). */
export const QUERY_MAX_MESSAGES = 3;
/** Character cap of the whole query text (D-13). */
export const QUERY_MAX_CHARS = 600;

/**
 * The retrieval query (SPEC 089 D-13): the customer's last up-to-3 messages,
 * oldest first, capped at 600 characters. "E quanto custa?" alone retrieves
 * nothing; with the message before it ("Qual o plano premium?") it does.
 * When the cap bites, the NEWEST text wins (the oldest is cut), and a word
 * cut in half is dropped. Falls back to the last message of any role when
 * the customer has not written, then to the empty string. Pure.
 */
export function buildRetrievalQuery(messages: ChatMessage[]): string {
  const picked: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const text = messages[i].content.trim();
    if (!text) continue;
    picked.unshift(text);
    if (picked.length >= QUERY_MAX_MESSAGES) break;
  }
  if (picked.length === 0) {
    const last = messages.at(-1)?.content.trim() ?? '';
    return capFromEnd(last, QUERY_MAX_CHARS);
  }
  return capFromEnd(picked.join('\n'), QUERY_MAX_CHARS);
}

function capFromEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  // The cut lands inside a word when neither side of it is whitespace:
  // drop that fragment.
  const before = text[text.length - max - 1];
  const insideWord = !/\s/.test(before) && !/^\s/.test(cut);
  if (!insideWord) return cut.trimStart();
  const firstSpace = cut.search(/\s/);
  return firstSpace === -1 ? cut : cut.slice(firstSpace + 1).trimStart();
}

// ------------------------------------------------------------
// Lexical query
// ------------------------------------------------------------

// Words that carry no topic. Compared accent-stripped and lowercase. Kept
// small on purpose: Portuguese first (the product's market), plus the
// common English / Spanish function words, because the `simple` full-text
// column (no stopword removal) would otherwise match nearly every excerpt
// on "de" or "the".
const STOPWORDS = new Set(
  (
    'a o as os um uma uns umas de da do das dos em na no nas nos num numa ao aos ' +
    'por para pra pelo pela pelos pelas com sem sob sobre entre ate apos ' +
    'e ou mas se que qual quais quando onde quem como quanto quanta quantos quantas ' +
    'eu tu ele ela nos vos eles elas me te lhe meu minha meus minhas seu sua seus suas ' +
    'isso isto esse essa esses essas este esta estes estas aquele aquela aquilo ' +
    'ja ainda tambem so mais menos muito muita pouco ' +
    'ser sou eh era foi sao estou esta estao estava tem tenho ter tinha ha ' +
    'ola oi bom boa dia tarde noite obrigado obrigada favor ' +
    'gostaria queria quero preciso pode poderia podem saber ' +
    'the an and or of to in on at for with from by is are was were be been it its this that ' +
    'these those what which who when where how why can could would should do does did ' +
    'i you he she we they me him her us them my your his our their please hello hi thanks ' +
    'el la los las un una unos unas y o de del al en con sin por para es son que como cuando ' +
    'donde cual hola gracias'
  ).split(/\s+/)
);

/** Hard cap on terms sent to the full-text search. */
export const LEXICAL_MAX_TERMS = 24;

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '');
}

/**
 * The lexical half of the hybrid retrieval, in `websearch_to_tsquery` syntax
 * (SPEC 089 D-11): the topical words of the text joined by `or`. Customer
 * messages are long and conversational, and an all-words-must-match query
 * ("oi gostaria de saber quanto custa o plano premium") finds nothing; with
 * `or`, the excerpts sharing the most topical words rank first (`ts_rank`).
 *
 * Only letters and digits survive, so the text can never inject a
 * `websearch` operator (`-`, quotes) and the word "or" is a stopword by
 * length. Returns '' when no topical word is left (the search then runs on
 * vectors alone, or not at all). Pure.
 */
export function buildLexicalQuery(text: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  // NFC first: a decomposed "ç" (c + combining mark) would otherwise split
  // the word in two at the mark.
  const tokens = text
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  for (const raw of tokens ?? []) {
    const bare = stripAccents(raw);
    const isNumber = /^\p{N}+$/u.test(raw);
    // "or" must never be a term: it is the operator joining them.
    if (bare === 'or') continue;
    if (!isNumber && bare.length < 3) continue;
    if (isNumber && bare.length < 2) continue;
    if (STOPWORDS.has(bare)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= LEXICAL_MAX_TERMS) break;
  }
  return terms.join(' or ');
}
