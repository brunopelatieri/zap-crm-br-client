import { describe, it, expect } from 'vitest';
import { customFieldIds, isToolEnabled, parseToolsConfig } from './config';

const U1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const U2 = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('parseToolsConfig (fail-closed, D-16)', () => {
  it('anything that is not an object is "all off"', () => {
    for (const raw of [null, undefined, 'x', 1, [], true]) {
      expect(parseToolsConfig(raw)).toEqual({});
    }
  });

  it('drops unknown tools and needs enabled === true', () => {
    const cfg = parseToolsConfig({
      delete_everything: { enabled: true },
      search_knowledge: { enabled: 'yes' },
      get_contact_profile: { enabled: true },
    });
    expect(cfg).toEqual({
      search_knowledge: { enabled: false },
      get_contact_profile: { enabled: true },
    });
    expect(isToolEnabled(cfg, 'search_knowledge')).toBe(false);
    expect(isToolEnabled(cfg, 'get_contact_profile')).toBe(true);
    expect(isToolEnabled(undefined, 'get_contact_profile')).toBe(false);
  });

  it('keeps only well-formed allow-list entries, deduplicated', () => {
    const cfg = parseToolsConfig({
      get_contact_profile: {
        enabled: true,
        visible_fields: [
          'Email',
          'email',
          'tags',
          'password',
          `custom:${U1}`,
          'custom:nope',
          42,
        ],
      },
      list_contact_deals: {
        enabled: true,
        pipeline_ids: [U1, 'x', U2.toUpperCase()],
      },
      update_contact_fields: {
        enabled: true,
        writable_fields: ['name', 'phone', 'tags'],
      },
      add_contact_tags: { enabled: true, tag_ids: 'not-a-list' },
    });
    expect(cfg.get_contact_profile?.visibleFields).toEqual([
      'email',
      'tags',
      `custom:${U1}`,
    ]);
    expect(cfg.list_contact_deals?.pipelineIds).toEqual([U1, U2]);
    // phone and tags are not writable fields.
    expect(cfg.update_contact_fields?.writableFields).toEqual(['name']);
    expect(cfg.add_contact_tags?.tagIds).toEqual([]);
  });

  it('extracts custom field ids', () => {
    expect(customFieldIds(['email', `custom:${U1}`])).toEqual([U1]);
    expect(customFieldIds(undefined)).toEqual([]);
  });
});
