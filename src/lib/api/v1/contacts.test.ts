import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  resolveAuditUserId,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});

// SPEC 064 F3 — a autoria das linhas criadas pela API pública.
describe('resolveAuditUserId', () => {
  function makeDb(owner: string | null) {
    const tables: string[] = [];
    const client = {
      from: (table: string) => {
        tables.push(table);
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: owner === null ? null : { owner_user_id: owner },
              error: null,
            }),
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    return { db: client, tables };
  }

  it('attributes writes to the account owner and never reads whatsapp_config', async () => {
    // It used to prefer `whatsapp_config.user_id`. With two official
    // numbers that is two rows saved by two different people, so the
    // query would pick an arbitrary one and silently change who every
    // API-created contact is attributed to.
    const { db, tables } = makeDb('owner-1');

    await expect(resolveAuditUserId(db, 'acc-1')).resolves.toBe('owner-1');
    expect(tables).toEqual(['accounts']);
  });

  it('throws when the owner cannot be resolved', async () => {
    const { db } = makeDb(null);

    await expect(resolveAuditUserId(db, 'acc-1')).rejects.toBeInstanceOf(
      ContactError
    );
  });
});
