import { describe, it, expect } from 'vitest';
import { allTools, getTool, toolsForTurn, toToolSpecs } from './registry';
import { TOOL_KEYS, type ToolsConfig } from './types';

const ALL_ON: ToolsConfig = Object.fromEntries(
  TOOL_KEYS.map((k) => [k, { enabled: true }])
) as ToolsConfig;

describe('tool catalog invariants (SPEC 089 D-16, §2)', () => {
  it('has every declared key exactly once', () => {
    expect(
      allTools()
        .map((t) => t.key)
        .sort()
    ).toEqual([...TOOL_KEYS].sort());
  });

  it('no input schema lets the model name an account, contact, conversation or user', () => {
    const forbidden = /(account|contact|conversation|user|tenant)_?id/i;
    for (const t of allTools()) {
      expect(t.inputSchema.type, t.key).toBe('object');
      expect(t.inputSchema.additionalProperties, t.key).toBe(false);
      for (const prop of Object.keys(t.inputSchema.properties)) {
        expect(prop, `${t.key}.${prop}`).not.toMatch(forbidden);
      }
    }
  });

  it('has no destructive tool (delete, send to others, campaigns)', () => {
    for (const t of allTools()) {
      expect(t.key).toMatch(/^[a-z][a-z_]*$/);
      expect(t.key).not.toMatch(
        /delete|destroy|send_message|broadcast|campaign|merge/
      );
    }
  });

  it('every write tool is marked write', () => {
    const reads = allTools()
      .filter((t) => t.risk === 'read')
      .map((t) => t.key)
      .sort();
    expect(reads).toEqual([
      'get_contact_profile',
      'list_contact_deals',
      'search_knowledge',
    ]);
  });
});

describe('toolsForTurn — AI_TOOL_WRITES=off (SPEC 089 F8)', () => {
  const ON: ToolsConfig = Object.fromEntries(
    TOOL_KEYS.map((k) => [k, { enabled: true }])
  ) as ToolsConfig;

  it('drops every write but handoff_to_human from a live auto-reply', () => {
    const prev = process.env.AI_TOOL_WRITES;
    process.env.AI_TOOL_WRITES = 'off';
    try {
      const live = toolsForTurn(ON, 'auto_reply');
      expect(live.filter((t) => t.risk === 'write').map((t) => t.key)).toEqual([
        'handoff_to_human',
      ]);
      expect(live.some((t) => t.key === 'search_knowledge')).toBe(true);
      // The playground only simulates: it keeps showing the writes.
      expect(
        toolsForTurn(ON, 'playground').some((t) => t.key === 'create_deal')
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AI_TOOL_WRITES;
      else process.env.AI_TOOL_WRITES = prev;
    }
  });

  it('absent: nothing changes', () => {
    const prev = process.env.AI_TOOL_WRITES;
    delete process.env.AI_TOOL_WRITES;
    try {
      expect(
        toolsForTurn(ON, 'auto_reply').some((t) => t.key === 'create_deal')
      ).toBe(true);
    } finally {
      if (prev !== undefined) process.env.AI_TOOL_WRITES = prev;
    }
  });
});

describe('toolsForTurn — born off, narrowed by mode (D-16, D-18)', () => {
  it('nothing is offered by default', () => {
    expect(toolsForTurn(undefined, 'auto_reply')).toEqual([]);
    expect(toolsForTurn({}, 'playground')).toEqual([]);
    expect(
      toolsForTurn({ search_knowledge: { enabled: false } }, 'draft')
    ).toEqual([]);
  });

  it('the draft (a human in the loop) only ever gets read tools (D-18)', () => {
    const tools = toolsForTurn(ALL_ON, 'draft');
    expect(tools.every((t) => t.risk === 'read')).toBe(true);
    expect(tools).toHaveLength(3);
  });

  it('the live auto-reply gets the enabled write tools too (F5: real writes)', () => {
    const keys = toolsForTurn(ALL_ON, 'auto_reply').map((t) => t.key);
    expect(keys).toHaveLength(TOOL_KEYS.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        'update_contact_fields',
        'add_contact_tags',
        'remove_contact_tags',
        'create_deal',
        'move_deal_stage',
        'add_internal_note',
        'handoff_to_human',
      ])
    );
    // An account that enabled only a read tool never gets a write one.
    expect(
      toolsForTurn({ search_knowledge: { enabled: true } }, 'auto_reply').map(
        (t) => t.key
      )
    ).toEqual(['search_knowledge']);
  });

  it('the playground also gets the enabled write tools (they simulate)', () => {
    expect(toolsForTurn(ALL_ON, 'playground')).toHaveLength(TOOL_KEYS.length);
    expect(
      toolsForTurn(
        { add_contact_tags: { enabled: true, tagIds: [] } },
        'playground'
      ).map((t) => t.key)
    ).toEqual(['add_contact_tags']);
  });

  it('specs carry name, description and schema only', () => {
    const [spec] = toToolSpecs([getTool('search_knowledge')!]);
    expect(Object.keys(spec).sort()).toEqual([
      'description',
      'name',
      'parameters',
    ]);
    expect(spec.name).toBe('search_knowledge');
  });
});
