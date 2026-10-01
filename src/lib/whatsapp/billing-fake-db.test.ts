/**
 * O fake de `whatsapp_billing_status` simula os CHECK/NOT NULL da migração
 * 086 (`checkBillingRow`). Estes testes garantem que ele REJEITA o que o
 * Postgres rejeitaria — sem isso, o resto da suíte provaria menos do que
 * parece.
 */

import { describe, expect, it } from 'vitest';

import {
  BILLING_ROW_DEFAULTS,
  checkBillingRow,
  makeFakeDb,
  type FakeState,
  type WriteLog,
} from './billing-fake-db';

function world() {
  const state: FakeState = {
    channels: [],
    whatsapp_config: [],
    whatsapp_billing_status: [],
    platform_settings: [],
  };
  const writes: WriteLog[] = [];
  return { state, writes, db: makeFakeDb('admin', state, writes) };
}

describe('checkBillingRow', () => {
  it('aceita um payload válido e nulos onde o CHECK permite', () => {
    expect(
      checkBillingRow({
        account_id: 'a',
        waba_id: 'w',
        health_overall: 'AVAILABLE',
        health_error_kind: null,
        payment_clear_reason: 'manual',
        health_error_message: 'x'.repeat(500),
        health_consecutive_failures: 0,
      })
    ).toBeNull();
  });

  it('recusa valor fora do vocabulário, tipo de erro inválido e mensagem longa', () => {
    expect(checkBillingRow({ health_overall: 'FOO' })?.code).toBe('23514');
    expect(checkBillingRow({ spend_error_kind: 'weird' })?.code).toBe('23514');
    expect(checkBillingRow({ payment_clear_reason: 'auto' })?.code).toBe(
      '23514'
    );
    expect(
      checkBillingRow({ spend_error_message: 'x'.repeat(501) })?.code
    ).toBe('23514');
  });

  it('recusa NULL em coluna NOT NULL', () => {
    expect(checkBillingRow({ health_consecutive_failures: null })?.code).toBe(
      '23502'
    );
    expect(checkBillingRow({ waba_id: null })?.code).toBe('23502');
  });
});

describe('makeFakeDb — escritas em whatsapp_billing_status', () => {
  it('upsert inválido falha com 23514 e NÃO grava', async () => {
    const { db, state, writes } = world();
    const { error } = await db
      .from('whatsapp_billing_status')
      .upsert(
        { account_id: 'a', waba_id: 'w', health_overall: 'FOO' },
        { onConflict: 'account_id,waba_id' }
      )
      .select('*')
      .maybeSingle();
    expect(error).toMatchObject({ code: '23514' });
    expect(state.whatsapp_billing_status).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('update inválido também falha e deixa a linha como estava', async () => {
    const { db, state } = world();
    state.whatsapp_billing_status.push({
      ...BILLING_ROW_DEFAULTS,
      account_id: 'a',
      waba_id: 'w',
    });
    const { error } = await db
      .from('whatsapp_billing_status')
      .update({ health_error_kind: 'bogus' })
      .eq('account_id', 'a');
    expect(error).toMatchObject({ code: '23514' });
    expect(state.whatsapp_billing_status[0]!.health_error_kind).toBeNull();
  });

  it('upsert válido mescla só as colunas enviadas', async () => {
    const { db, state } = world();
    state.whatsapp_billing_status.push({
      ...BILLING_ROW_DEFAULTS,
      account_id: 'a',
      waba_id: 'w',
      payment_blocked_since: '2026-10-01T00:00:00.000Z',
    });
    await db
      .from('whatsapp_billing_status')
      .upsert(
        { account_id: 'a', waba_id: 'w', health_overall: 'LIMITED' },
        { onConflict: 'account_id,waba_id' }
      )
      .select('*')
      .maybeSingle();
    expect(state.whatsapp_billing_status[0]).toMatchObject({
      health_overall: 'LIMITED',
      payment_blocked_since: '2026-10-01T00:00:00.000Z',
    });
  });
});
