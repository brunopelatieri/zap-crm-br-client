// ============================================================
// Tool results go back to the model as DATA, not instructions (SPEC 089
// §5.3 rule 2): serialized, truncated to 4 KB and wrapped in a tag the
// system prompt tells the model to treat like a customer message. A result
// can carry text an attacker controls (a contact name, a knowledge
// document), so any copy of the tag inside it is neutralized first.
// ============================================================

/** Max UTF-8 bytes of a serialized tool result (P-6 / §5.3 rule 2). */
export const TOOL_RESULT_MAX_BYTES = 4096;

export const TOOL_RESULT_TAG = 'tool_result';

const TRUNCATED_MARK = '…[truncated]';

const encoder = new TextEncoder();

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * character (a surrogate pair or a multi-byte sequence).
 */
export function truncateUtf8(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  if (encoder.encode(text).length <= maxBytes) {
    return { text, truncated: false };
  }
  const budget = Math.max(0, maxBytes - encoder.encode(TRUNCATED_MARK).length);
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    // `for…of` walks code points, so a surrogate pair is never split.
    const size = encoder.encode(ch).length;
    if (bytes + size > budget) break;
    bytes += size;
    out += ch;
  }
  return { text: out + TRUNCATED_MARK, truncated: true };
}

/**
 * Neutralize anything that could close or open our wrapper tag, and the
 * handoff sentinel (`[[HANDOFF]]`, `defaults.ts`): a contact name or a
 * knowledge excerpt carrying it could get echoed into the final text and
 * switch the bot off on that conversation. Written out here (not imported)
 * because `defaults.ts` imports this module.
 */
function neutralizeTag(text: string): string {
  return text
    .replace(/<\s*\/?\s*tool_result\b/gi, (m) => m.replace('<', '‹'))
    .replace(/\[\[\s*HANDOFF\s*\]\]/gi, '[HANDOFF]');
}

/** JSON.stringify that never throws (cycles, BigInt) — tools return plain data. */
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string'
      ? value
      : (JSON.stringify(value) ?? 'null');
  } catch {
    return '"[unserializable result]"';
  }
}

/**
 * Serialize, neutralize, truncate and wrap one tool result. The budget
 * applies to the payload; the wrapper adds a few bytes around it.
 */
export function wrapToolResult(name: string, value: unknown): string {
  const safeName = name.replace(/[^a-z0-9_]/gi, '');
  const payload = truncateUtf8(
    neutralizeTag(safeStringify(value)),
    TOOL_RESULT_MAX_BYTES
  ).text;
  return `<${TOOL_RESULT_TAG} name="${safeName}">${payload}</${TOOL_RESULT_TAG}>`;
}
