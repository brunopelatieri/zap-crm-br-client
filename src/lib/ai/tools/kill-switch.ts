// ============================================================
// Global kill switch for the agent's WRITE tools (SPEC 089 F8).
//
// `AI_TOOL_WRITES=off` in the server's environment turns every write tool off
// in every account at once: the built-in ones (tags, fields, deals, notes)
// and the account's HTTP tools marked `write`. Reads keep working, and so
// does `handoff_to_human` — it is the agent's way out of a conversation, and
// turning it off would leave the customer with a bot that cannot let go.
// Absent (or any other value) = the behaviour before the switch existed.
//
// Read on every call (not at import), so a restart is the only thing an
// operator needs after changing the stack.
// ============================================================

/** The tool that is never switched off (see the header). */
export const ALWAYS_ALLOWED_WRITE = 'handoff_to_human';

export function toolWritesDisabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env.AI_TOOL_WRITES ?? '').trim().toLowerCase() === 'off';
}

/** Whether a write tool with this key is switched off right now. */
export function isWriteSwitchedOff(
  key: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  return key !== ALWAYS_ALLOWED_WRITE && toolWritesDisabled(env);
}
