import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CHOICE_FIELD_TYPES,
  FIELD_TYPES,
  INPUT_FIELD_TYPES,
  YES_NO_OPTION_IDS,
} from './types';

const MIGRATION_097 = path.resolve(
  __dirname,
  '../../../supabase/migrations/097_forms_core.sql'
);

/** Lista de um `CHECK (col IN (...))` da migração, em ordem de escrita. */
function checkList(sql: string, column: string): string[] {
  const re = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i');
  const m = re.exec(sql);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('tipos de bloco (SPEC 085 §4.1)', () => {
  it('a união fechada tem 14 tipos e bate com o CHECK da migração 097', () => {
    expect(FIELD_TYPES).toHaveLength(14);
    const sql = readFileSync(MIGRATION_097, 'utf-8');
    expect(checkList(sql, 'type')).toEqual([...FIELD_TYPES]);
  });

  it('statement é o único sem entrada; escolhas são as quatro com options', () => {
    expect(INPUT_FIELD_TYPES).toEqual(
      FIELD_TYPES.filter((t) => t !== 'statement')
    );
    expect([...CHOICE_FIELD_TYPES].sort()).toEqual(
      ['dropdown', 'multi_select', 'single_select', 'yes_no'].sort()
    );
    expect(YES_NO_OPTION_IDS).toEqual(['yes', 'no']);
  });

  it('os CHECKs de status das tabelas batem com os tipos TS', () => {
    const sql = readFileSync(MIGRATION_097, 'utf-8');
    expect(checkList(sql, 'status')).toEqual([
      'draft',
      'published',
      'archived',
    ]);
    expect(checkList(sql, 'identity_mode')).toEqual(['phone', 'token']);
    expect(checkList(sql, 'portal_visibility')).toEqual([
      'none',
      'fill',
      'responses',
      'both',
    ]);
  });
});
