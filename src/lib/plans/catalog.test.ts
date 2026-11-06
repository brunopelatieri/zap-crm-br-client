import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  validateCatalog,
  validateOverrides,
  type CatalogPlanInput,
} from './catalog';

describe('validateCatalog', () => {
  it('catálogo válido não gera erro', () => {
    const plans: CatalogPlanInput[] = [
      {
        code: 'free',
        limits: { contacts: 250, members_total: 2 },
        features: { ai_enabled: false },
      },
    ];
    expect(validateCatalog(plans)).toEqual([]);
  });

  it('chave desconhecida em limits é erro', () => {
    const plans: CatalogPlanInput[] = [
      { code: 'free', limits: { contatcs: 250 }, features: {} },
    ];
    expect(validateCatalog(plans)).toEqual([
      { planCode: 'free', field: 'limits', key: 'contatcs' },
    ]);
  });

  it('chave desconhecida em features é erro', () => {
    const plans: CatalogPlanInput[] = [
      { code: 'free', limits: {}, features: { ia_enabled: true } },
    ];
    expect(validateCatalog(plans)).toEqual([
      { planCode: 'free', field: 'features', key: 'ia_enabled' },
    ]);
  });

  it('objeto vazio é sempre válido (chave ausente é permissivo — D-3)', () => {
    expect(
      validateCatalog([{ code: 'unlimited', limits: {}, features: {} }])
    ).toEqual([]);
  });
});

describe('validateOverrides', () => {
  it('override numérico válido para chave de quota não gera erro', () => {
    expect(validateOverrides({ contacts: 15000 })).toEqual([]);
  });

  it('override booleano válido para chave de feature não gera erro', () => {
    expect(validateOverrides({ ai_enabled: true })).toEqual([]);
  });

  it('chave desconhecida é erro unknown_key', () => {
    expect(validateOverrides({ contatcs: 100 })).toEqual([
      { key: 'contatcs', reason: 'unknown_key' },
    ]);
  });

  it('string numa chave de quota é erro wrong_type (o cast do Postgres quebraria)', () => {
    expect(validateOverrides({ contacts: 'unlimited' })).toEqual([
      { key: 'contacts', reason: 'wrong_type' },
    ]);
  });

  it('número não-inteiro numa chave de quota é erro wrong_type', () => {
    expect(validateOverrides({ contacts: 12.5 })).toEqual([
      { key: 'contacts', reason: 'wrong_type' },
    ]);
  });

  it('número numa chave de feature é erro wrong_type', () => {
    expect(validateOverrides({ ai_enabled: 1 })).toEqual([
      { key: 'ai_enabled', reason: 'wrong_type' },
    ]);
  });

  it('objeto vazio é válido', () => {
    expect(validateOverrides({})).toEqual([]);
  });
});

// Extrai cada bloco `-- PLAN: <code>` dos seeds comerciais e valida contra
// types.ts. Compensa o JSONB sem CHECK no banco (SPEC 059 §5, D-2): o
// seed é o único lugar onde a chave errada não seria pega por typecheck.
// Os dois seeds (genérico e o do `vn`) passam pela mesma régua (SPEC 083
// §5.4); o bloco comentado de um plano também é lido — o regex não liga
// para `--`, e é melhor validar um plano desligado do que deixá-lo
// envelhecer com chave errada.
describe.each(['plans-seed.sql', 'plans-seed-vn.sql'])(
  'supabase/setup/%s',
  (seedFile) => {
    const seedPath = path.resolve(
      __dirname,
      '../../../supabase/setup',
      seedFile
    );

    function readPlans(): CatalogPlanInput[] | null {
      if (!existsSync(seedPath)) {
        // `supabase/` fica fora do git: num checkout sem o seed, nada a conferir.
        return null;
      }
      const sql = readFileSync(seedPath, 'utf-8');
      const blockPattern =
        /-- PLAN: (\w+)[\s\S]*?'(\{.*?\})'::jsonb[\s\S]*?'(\{.*?\})'::jsonb/g;

      const plans: CatalogPlanInput[] = [];
      let match: RegExpExecArray | null;
      while ((match = blockPattern.exec(sql)) !== null) {
        const [, code, limitsJson, featuresJson] = match;
        plans.push({
          code,
          limits: JSON.parse(limitsJson),
          features: JSON.parse(featuresJson),
        });
      }
      return plans;
    }

    it('todo plano do seed usa só chaves conhecidas', () => {
      const plans = readPlans();
      if (!plans) return;
      expect(plans.length).toBeGreaterThan(0);
      expect(validateCatalog(plans)).toEqual([]);
    });

    // Formulários (PRD 084 D-10, SPEC 085 §5.3): a chave fail-closed e as
    // três quotas de uso entram nos dois seeds, em todo plano — inclusive
    // no `enterprise` comentado do `vn`.
    it('forms_enabled é explícito (booleano) em todo plano', () => {
      const plans = readPlans();
      if (!plans) return;
      for (const plan of plans) {
        expect(
          typeof plan.features.forms_enabled,
          `${seedFile}: plano ${plan.code}`
        ).toBe('boolean');
      }
    });

    it('as três quotas de formulário estão em todo plano, como inteiro ≥ 0', () => {
      const plans = readPlans();
      if (!plans) return;
      for (const plan of plans) {
        for (const key of ['forms', 'form_responses_month', 'form_upload_mb']) {
          const value = plan.limits[key];
          expect(
            Number.isInteger(value) && (value as number) >= 0,
            `${seedFile}: plano ${plan.code} sem ${key} válido`
          ).toBe(true);
        }
      }
    });

    it('plano sem forms_enabled tem as três quotas em 0 (PRD 084 §7: Grátis)', () => {
      const plans = readPlans();
      if (!plans) return;
      for (const plan of plans) {
        if (plan.features.forms_enabled === false) {
          expect(plan.limits.forms, `${seedFile}: ${plan.code}`).toBe(0);
          expect(plan.limits.form_responses_month).toBe(0);
          expect(plan.limits.form_upload_mb).toBe(0);
        }
      }
    });

    it('contact_portal_enabled é explícito em todo plano (PRD 082 D-1: nasce false)', () => {
      // Chave ausente não libera (plan_feature_strict), mas o seed grava o
      // `false` mesmo assim: a decisão comercial fica visível no catálogo
      // e no editor do console, e não dependente do default de uma função.
      const plans = readPlans();
      if (!plans) return;
      for (const plan of plans) {
        expect(plan.features, `${seedFile}: plano ${plan.code}`).toHaveProperty(
          'contact_portal_enabled',
          false
        );
      }
    });
  }
);
