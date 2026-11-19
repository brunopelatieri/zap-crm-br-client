// Console `/admin` (SPEC 085 §10, F4): o editor de planos e a tela da conta
// leem `FEATURE_KEYS` / `USAGE_QUOTA_KEYS` e rotulam por `Plan.featureLabel.*`
// e `Plan.quotaLabel.*`. Chave nova sem rótulo apareceria como texto cru no
// console do proprietário.

import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';
import { FEATURE_KEYS, USAGE_QUOTA_KEYS } from '@/lib/plans/types';

type Labels = {
  Plan: {
    featureLabel: Record<string, string>;
    quotaLabel: Record<string, string>;
  };
};

describe.each([
  ['en', en as unknown as Labels],
  ['pt-BR', ptBR as unknown as Labels],
])('rótulos de plano (%s)', (_locale, dict) => {
  it('toda chave de recurso tem rótulo', () => {
    for (const key of FEATURE_KEYS) {
      expect(dict.Plan.featureLabel[key], `featureLabel.${key}`).toBeTruthy();
    }
  });

  it('toda quota de uso tem rótulo, inclusive as de formulários', () => {
    for (const key of USAGE_QUOTA_KEYS) {
      expect(dict.Plan.quotaLabel[key], `quotaLabel.${key}`).toBeTruthy();
    }
    for (const key of ['forms', 'form_responses_month', 'form_upload_mb']) {
      expect(USAGE_QUOTA_KEYS).toContain(key);
    }
    expect(FEATURE_KEYS).toContain('forms_enabled');
  });
});
