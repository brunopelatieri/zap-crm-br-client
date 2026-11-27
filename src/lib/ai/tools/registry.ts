import type { ToolSpec } from '../types';
import { isToolEnabled } from './config';
import { getContactProfileTool } from './contact';
import {
  addContactTagsTool,
  removeContactTagsTool,
  updateContactFieldsTool,
} from './contact-writes';
import { createDealTool, moveDealStageTool } from './deal-writes';
import { listContactDealsTool } from './deals';
import { searchKnowledgeTool } from './knowledge';
import { isWriteSwitchedOff } from './kill-switch';
import { addInternalNoteTool, handoffToHumanTool } from './note-handoff';
import type { AgentTool, ToolKey, ToolMode, ToolsConfig } from './types';

// ============================================================
// The tool catalog (SPEC 089 §5.3) and which tools a turn is offered.
// No destructive tool exists here: nothing deletes data, messages another
// contact or starts a campaign (§2 non-goals).
// ============================================================

// AgentTool<I> is contravariant in I through `handler`; the catalog only
// hands parsed input back to the same tool, so the cast is sound.
const CATALOG: readonly AgentTool[] = [
  searchKnowledgeTool,
  getContactProfileTool,
  listContactDealsTool,
  updateContactFieldsTool,
  addContactTagsTool,
  removeContactTagsTool,
  createDealTool,
  moveDealStageTool,
  addInternalNoteTool,
  handoffToHumanTool,
] as unknown as readonly AgentTool[];

const BY_KEY = new Map<string, AgentTool>(CATALOG.map((t) => [t.key, t]));

export function allTools(): readonly AgentTool[] {
  return CATALOG;
}

export function getTool(key: string): AgentTool | undefined {
  return BY_KEY.get(key);
}

/**
 * Tools offered in one turn: the account's enabled tools, narrowed by mode
 * (D-18).
 *   - `draft`: reads only (a human is in the loop, nothing is written).
 *   - `playground` / `eval`: reads, plus writes in simulation (`dryRun`).
 *   - `auto_reply`: reads and REAL writes — with the slot claimed before the
 *     loop (D-17), every call audited and the write cap / plan quota decided
 *     by the database (F5). Each write handler re-checks the mode itself.
 */
export function toolsForTurn(
  config: ToolsConfig | undefined,
  mode: ToolMode
): AgentTool[] {
  const allowWrite = mode !== 'draft';
  return CATALOG.filter(
    (t) =>
      isToolEnabled(config, t.key as ToolKey) &&
      (t.risk === 'read' ||
        (allowWrite && !(mode === 'auto_reply' && isWriteSwitchedOff(t.key))))
  );
}

/** Write tools only describe what they would do outside a live auto-reply. */
export function isDryRunMode(mode: ToolMode): boolean {
  return mode !== 'auto_reply';
}

export function toToolSpecs(tools: readonly AgentTool[]): ToolSpec[] {
  return tools.map((t) => ({
    name: t.key,
    description: t.description,
    parameters: t.inputSchema,
  }));
}
