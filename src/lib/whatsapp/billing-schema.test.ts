/**
 * SPEC 076 — vocabulário compartilhado de schema ausente e leitura do flag
 * (`billing-schema.ts`), usado por `billing-signal.ts` e `billing-server.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SCHEMA_MISSING_CODES,
  errMsg,
  isSchemaMissingError,
  readBillingMonitorFlag,
} from './billing-schema';

function flagDb(result: { data?: unknown; error?: unknown } | 'throw') {
  return {
    from: () => ({
      select: () => ({
        maybeSingle: async () => {
          if (result === 'throw') throw new Error('network down');
          return { data: result.data ?? null, error: result.error ?? null };
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('isSchemaMissingError', () => {
  it('reconhece tabela, coluna e função ausentes (Postgres e PostgREST)', () => {
    for (const code of [
      '42P01',
      '42703',
      '42883',
      'PGRST202',
      'PGRST204',
      'PGRST205',
    ]) {
      expect(isSchemaMissingError({ code })).toBe(true);
      expect(SCHEMA_MISSING_CODES.has(code)).toBe(true);
    }
  });

  it('o resto não é schema ausente (nem erro sem código, nem null)', () => {
    expect(isSchemaMissingError({ code: '57014' })).toBe(false);
    expect(isSchemaMissingError({ code: 42703 })).toBe(false); // só string
    expect(isSchemaMissingError({ message: 'x' })).toBe(false);
    expect(isSchemaMissingError(null)).toBe(false);
    expect(isSchemaMissingError(undefined)).toBe(false);
  });

  it('errMsg prefere a mensagem e cai no próprio valor', () => {
    expect(errMsg({ message: 'boom' })).toBe('boom');
    expect(errMsg('plain')).toBe('plain');
  });
});

describe('readBillingMonitorFlag', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('true / false conforme a coluna', async () => {
    expect(
      await readBillingMonitorFlag(
        flagDb({ data: { whatsapp_billing_monitor_enabled: true } }),
        't'
      )
    ).toBe(true);
    expect(
      await readBillingMonitorFlag(
        flagDb({ data: { whatsapp_billing_monitor_enabled: false } }),
        't'
      )
    ).toBe(false);
  });

  it('sem linha de platform_settings: false (não é "não sei")', async () => {
    expect(await readBillingMonitorFlag(flagDb({ data: null }), 't')).toBe(
      false
    );
  });

  it('erro de leitura (ex.: coluna ausente) ou exceção: null, e o tag vai ao log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await readBillingMonitorFlag(
        flagDb({ error: { code: '42703', message: 'no column' } }),
        'meu-tag'
      )
    ).toBeNull();
    expect(await readBillingMonitorFlag(flagDb('throw'), 'meu-tag')).toBeNull();
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('[meu-tag]');
  });
});
