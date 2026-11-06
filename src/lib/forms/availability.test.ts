import { describe, expect, it } from 'vitest';

import {
  isFormAvailable,
  parseAvailabilityRow,
  UNAVAILABLE_MESSAGE_KEYS,
  UNAVAILABLE_REASONS,
  unavailableMessageKeys,
} from './availability';
import { ACCOUNT_ID, FORM_ID } from './test-fixtures';

describe('parseAvailabilityRow (form_public_availability, migração 098)', () => {
  it('linha disponível vira o tipo estreito com form e conta', () => {
    const a = parseAvailabilityRow({
      status: 'available',
      reason: 'ok',
      form_id: FORM_ID,
      account_id: ACCOUNT_ID,
    });
    expect(isFormAvailable(a)).toBe(true);
    expect(a).toEqual({
      status: 'available',
      reason: 'ok',
      formId: FORM_ID,
      accountId: ACCOUNT_ID,
    });
  });

  it('fail-closed: linha ausente, motivo desconhecido ou "available" sem ids é indisponível', () => {
    expect(parseAvailabilityRow(null)).toMatchObject({
      status: 'unavailable',
      reason: 'not_found',
    });
    expect(
      parseAvailabilityRow({ status: 'unavailable', reason: 'novo_motivo' })
    ).toMatchObject({ status: 'unavailable', reason: 'not_found' });
    expect(
      parseAvailabilityRow({
        status: 'available',
        reason: 'ok',
        form_id: FORM_ID,
      })
    ).toMatchObject({ status: 'unavailable' });
  });

  it('cada motivo conhecido é preservado', () => {
    for (const reason of UNAVAILABLE_REASONS) {
      expect(
        parseAvailabilityRow({
          status: 'unavailable',
          reason,
          form_id: FORM_ID,
        })
      ).toMatchObject({ status: 'unavailable', reason, formId: FORM_ID });
    }
  });

  it('todos os motivos mostram a MESMA tela neutra (PRD 084 D-11)', () => {
    const keys = new Set(
      UNAVAILABLE_REASONS.map((r) => JSON.stringify(unavailableMessageKeys(r)))
    );
    expect(keys.size).toBe(1);
    expect(unavailableMessageKeys('feature_not_in_plan')).toBe(
      UNAVAILABLE_MESSAGE_KEYS
    );
    // Nenhuma chave menciona plano, quota ou bloqueio.
    expect(JSON.stringify(UNAVAILABLE_MESSAGE_KEYS)).not.toMatch(
      /plan|quota|block/i
    );
  });
});
