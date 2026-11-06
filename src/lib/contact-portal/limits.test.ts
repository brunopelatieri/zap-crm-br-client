import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PORTAL_LIMITS, PORTAL_SESSION_TTL_S } from './limits';

describe('PORTAL_LIMITS', () => {
  it('todo limite é inteiro positivo (o banco recusa o resto com 22023)', () => {
    for (const [key, value] of Object.entries(PORTAL_LIMITS)) {
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
    expect(Number.isInteger(PORTAL_SESSION_TTL_S)).toBe(true);
  });

  it('valores de partida da SPEC 083 §7.1', () => {
    expect(PORTAL_LIMITS.code_ttl_s).toBe(600);
    expect(PORTAL_LIMITS.code_max_attempts).toBe(5);
    expect(PORTAL_LIMITS.send_phone_min_interval_s).toBe(60);
    expect(PORTAL_LIMITS.send_phone_per_hour).toBe(5);
  });
});

// Contrato com a migração: cada `limit_value(p_limits, '<chave>')` da 093
// precisa existir aqui, e cada chave daqui precisa ser lida lá. Sem isso,
// uma chave nova no SQL só aparece como 22023 no primeiro pedido real.
describe('supabase/migrations/093_contact_portal.sql', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../../supabase/migrations/093_contact_portal.sql'
  );

  it('lê exatamente as chaves de PORTAL_LIMITS', () => {
    if (!existsSync(migrationPath)) {
      // `supabase/` fica fora do git: num checkout sem ela, nada a conferir.
      return;
    }
    const sql = readFileSync(migrationPath, 'utf-8');
    const keys = new Set(
      [...sql.matchAll(/limit_value\(p_limits,\s*'([a-z_]+)'\)/g)].map(
        (m) => m[1]
      )
    );
    expect([...keys].sort()).toEqual(Object.keys(PORTAL_LIMITS).sort());
  });

  it('as migrações seguintes só leem chaves que existem (095)', () => {
    const dir = path.dirname(migrationPath);
    for (const name of ['095_contact_portal_limit_locks.sql']) {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      const sql = readFileSync(file, 'utf-8');
      for (const m of sql.matchAll(/limit_value\(p_limits,\s*'([a-z_]+)'\)/g)) {
        expect(Object.keys(PORTAL_LIMITS), `${name}: ${m[1]}`).toContain(m[1]);
      }
    }
  });
});
