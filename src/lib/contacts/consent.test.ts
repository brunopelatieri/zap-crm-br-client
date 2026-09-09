import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { excludesOptedOut, isOptedOut, setContactOptIn } from './consent';

const recordActivityMock = vi.fn(async () => undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivityMock(...(args as [])),
}));

function makeDb(row: Record<string, unknown>) {
  return {
    rpc: vi.fn(async () => ({ data: [row], error: null })),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe('excludesOptedOut', () => {
  it('marketing (categoria ausente ou desconhecida) exclui opted_out', () => {
    expect(excludesOptedOut(null)).toBe(true);
    expect(excludesOptedOut('marketing')).toBe(true);
  });

  it('utility/authentication alcançam quem optou por sair', () => {
    expect(excludesOptedOut('utility')).toBe(false);
    expect(excludesOptedOut('AUTHENTICATION')).toBe(false);
  });
});

describe('isOptedOut', () => {
  it('true só para opted_out', () => {
    expect(isOptedOut({ opt_in_status: 'opted_out' })).toBe(true);
    expect(isOptedOut({ opt_in_status: 'opted_in' })).toBe(false);
    expect(isOptedOut({ opt_in_status: 'unknown' })).toBe(false);
  });
});

// SPEC 075 F4 — setContactOptIn é o único caminho de escrita de
// contact_consent_events; hooká-lo aqui alimenta account_activity_log.
describe('setContactOptIn — ponte com account_activity_log (SPEC 075)', () => {
  it('registra contact.opted_out quando o estado MUDA e accountId foi passado', async () => {
    const db = makeDb({
      contact_id: 'contact-1',
      opt_in_status: 'opted_out',
      opt_in_updated_at: '2026-09-09T00:00:00Z',
      changed: true,
    });

    await setContactOptIn(db, {
      contactId: 'contact-1',
      status: 'opted_out',
      source: 'inbound_keyword',
      keyword: 'sair',
      accountId: 'acct-1',
    });

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: 'acct-1',
        resourceType: 'contact',
        action: 'contact.opted_out',
        resourceId: 'contact-1',
        contactId: 'contact-1',
        actor: { kind: 'system', name: 'inbound_keyword' },
      })
    );
  });

  it('não registra nada quando o estado NÃO mudou (changed: false)', async () => {
    const db = makeDb({
      contact_id: 'contact-1',
      opt_in_status: 'opted_out',
      opt_in_updated_at: '2026-09-09T00:00:00Z',
      changed: false,
    });

    await setContactOptIn(db, {
      contactId: 'contact-1',
      status: 'opted_out',
      source: 'inbound_keyword',
      accountId: 'acct-1',
    });

    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it('não registra nada sem accountId (chamador antigo, sem quebrar)', async () => {
    const db = makeDb({
      contact_id: 'contact-1',
      opt_in_status: 'opted_in',
      opt_in_updated_at: '2026-09-09T00:00:00Z',
      changed: true,
    });

    await setContactOptIn(db, {
      contactId: 'contact-1',
      status: 'opted_in',
      source: 'manual',
    });

    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
