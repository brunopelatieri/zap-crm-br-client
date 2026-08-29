import { describe, it, expect } from 'vitest';
import { buildWabaGroups } from './waba-groups';

describe('buildWabaGroups (SPEC 064 D-2)', () => {
  it('returns one group per distinct WABA', () => {
    const groups = buildWabaGroups([
      { channelId: 'ch-1', name: 'Vendas', isDefault: true, wabaId: 'waba-a' },
      {
        channelId: 'ch-2',
        name: 'Suporte',
        isDefault: false,
        wabaId: 'waba-b',
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.wabaId).sort()).toEqual(['waba-a', 'waba-b']);
  });

  it('merges two channels that share the same WABA into one group', () => {
    const groups = buildWabaGroups([
      { channelId: 'ch-1', name: 'Vendas', isDefault: false, wabaId: 'waba-a' },
      {
        channelId: 'ch-2',
        name: 'Vendas 2',
        isDefault: true,
        wabaId: 'waba-a',
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Vendas / Vendas 2');
    // isDefault do grupo é o OU dos dois canais.
    expect(groups[0].isDefault).toBe(true);
  });

  it('drops a channel with no WABA resolved yet', () => {
    const groups = buildWabaGroups([
      {
        channelId: 'ch-1',
        name: 'Novo número',
        isDefault: false,
        wabaId: null,
      },
    ]);
    expect(groups).toHaveLength(0);
  });

  it('sorts the default WABA first', () => {
    const groups = buildWabaGroups([
      { channelId: 'ch-1', name: 'A', isDefault: false, wabaId: 'waba-a' },
      { channelId: 'ch-2', name: 'B', isDefault: true, wabaId: 'waba-b' },
    ]);
    expect(groups[0].wabaId).toBe('waba-b');
  });

  it("keeps the first channel id seen for a group as the group's representative channel", () => {
    const groups = buildWabaGroups([
      { channelId: 'ch-1', name: 'Vendas', isDefault: false, wabaId: 'waba-a' },
      {
        channelId: 'ch-2',
        name: 'Vendas 2',
        isDefault: false,
        wabaId: 'waba-a',
      },
    ]);
    expect(groups[0].channelId).toBe('ch-1');
  });
});
