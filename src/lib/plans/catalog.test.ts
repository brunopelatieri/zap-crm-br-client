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

// Extrai cada bloco `-- PLAN: <code>` do seed comercial e valida contra
// types.ts. Compensa o JSONB sem CHECK no banco (SPEC 059 §5, D-2): o
// seed é o único lugar onde a chave errada não seria pega por typecheck.
describe('supabase/setup/plans-seed.sql', () => {
  const seedPath = path.resolve(
    __dirname,
    '../../../supabase/setup/plans-seed.sql'
  );

  it('todo plano do seed comercial usa só chaves conhecidas', () => {
    if (!existsSync(seedPath)) {
      // F8 ainda não escreveu o seed comercial — nada a validar ainda.
      return;
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

    expect(plans.length).toBeGreaterThan(0);
    expect(validateCatalog(plans)).toEqual([]);
  });
});
