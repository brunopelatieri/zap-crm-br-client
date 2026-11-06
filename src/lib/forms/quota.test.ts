import { describe, expect, it } from 'vitest';

import type { PlanUsage } from '@/lib/plans/types';

import {
  BYTES_PER_MB,
  bytesToMbCeil,
  checkFormsAvailableQuota,
  FORM_RESPONSES_METRIC_PREFIX,
  isFormsQuotaError,
  mbToBytes,
  monthMetricKey,
  monthQuotaHasRoom,
  parseFormsQuotaError,
  parseMonthQuotaRow,
  parseUploadQuotaRow,
  uploadQuotaHasRoom,
} from './quota';

describe('monthMetricKey — virada do mês em America/Sao_Paulo (SPEC 085 §5.2)', () => {
  it('um segundo antes da meia-noite de Brasília ainda é o mês anterior', () => {
    // 2026-12-01 02:59:59 UTC = 2026-11-30 23:59:59 em São Paulo (UTC-3).
    expect(monthMetricKey(new Date('2026-12-01T02:59:59Z'))).toBe(
      `${FORM_RESPONSES_METRIC_PREFIX}2026-11`
    );
  });

  it('à meia-noite de Brasília vira o mês novo (mesmo que em UTC já virou há 3 h)', () => {
    expect(monthMetricKey(new Date('2026-12-01T03:00:00Z'))).toBe(
      `${FORM_RESPONSES_METRIC_PREFIX}2026-12`
    );
  });

  it('mesma chave que a função SQL form_month_metric produz', () => {
    // Formato `form_responses:YYYY-MM` — contrato com a migração 098.
    expect(monthMetricKey(new Date('2026-01-15T12:00:00Z'))).toMatch(
      /^form_responses:\d{4}-\d{2}$/
    );
    expect(monthMetricKey(new Date('2026-07-01T01:00:00Z'), 'UTC')).toBe(
      'form_responses:2026-07'
    );
  });
});

describe('conversões e folga', () => {
  it('MB arredonda para cima; limite null é ilimitado', () => {
    expect(bytesToMbCeil(0)).toBe(0);
    expect(bytesToMbCeil(1)).toBe(1);
    expect(bytesToMbCeil(BYTES_PER_MB)).toBe(1);
    expect(bytesToMbCeil(BYTES_PER_MB + 1)).toBe(2);
    expect(mbToBytes(null)).toBeNull();
    expect(mbToBytes(2)).toBe(2 * BYTES_PER_MB);
  });

  it('uploadQuotaHasRoom soma o declarado ao usado', () => {
    expect(uploadQuotaHasRoom({ usedBytes: 90, limitBytes: 100 }, 10)).toBe(
      true
    );
    expect(uploadQuotaHasRoom({ usedBytes: 90, limitBytes: 100 }, 11)).toBe(
      false
    );
    expect(uploadQuotaHasRoom({ usedBytes: 1e12, limitBytes: null }, 1)).toBe(
      true
    );
  });

  it('linhas das RPCs viram estado tipado, tolerando string/null', () => {
    expect(
      parseUploadQuotaRow({ used_bytes: '1024', limit_bytes: null })
    ).toEqual({ usedBytes: 1024, limitBytes: null });
    expect(parseMonthQuotaRow({ used: 3, limit: '200' })).toEqual({
      used: 3,
      limit: 200,
    });
    expect(parseMonthQuotaRow(null)).toEqual({ used: 0, limit: null });
    expect(monthQuotaHasRoom({ used: 200, limit: 200 })).toBe(false);
    expect(monthQuotaHasRoom({ used: 0, limit: null })).toBe(true);
  });

  it('erro de quota só é "de formulários" quando a métrica é forms', () => {
    expect(
      parseFormsQuotaError({ message: 'QUOTA_EXCEEDED:forms:5:5' })
    ).toEqual({ metric: 'forms', used: 5, limit: 5 });
    expect(isFormsQuotaError({ message: 'QUOTA_EXCEEDED:contacts:1:1' })).toBe(
      false
    );
    expect(isFormsQuotaError(new Error('boom'))).toBe(false);
  });

  it('checkFormsAvailableQuota lê o bucket forms do uso do plano', () => {
    const usage = {
      buckets: [{ key: 'forms', used: 1, limit: 1 }],
    } as unknown as PlanUsage;
    expect(checkFormsAvailableQuota(usage)).toEqual({
      used: 1,
      limit: 1,
      available: false,
    });
    expect(
      checkFormsAvailableQuota({ buckets: [] } as unknown as PlanUsage)
    ).toEqual({ used: 0, limit: null, available: true });
  });
});
