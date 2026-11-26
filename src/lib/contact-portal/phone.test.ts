import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { phoneCandidates } from './phone';

const br = { brMode: true };

describe('phoneCandidates', () => {
  it('celular atual → canônico primeiro e a variante sem o nono dígito', () => {
    expect(phoneCandidates('+55 (19) 9 9123-4567', br)).toEqual([
      '5519991234567',
      '551991234567',
    ]);
  });

  it('celular digitado sem o nono dígito → canônico (com o 9) primeiro', () => {
    expect(phoneCandidates('(19) 9123-4567', br)).toEqual([
      '5519991234567',
      '551991234567',
    ]);
  });

  it('as duas formas do mesmo celular dão os mesmos candidatos', () => {
    expect(phoneCandidates('19991234567', br)).toEqual(
      phoneCandidates('1991234567', br)
    );
  });

  it('fixo → um candidato só', () => {
    expect(phoneCandidates('(11) 3456-7890', br)).toEqual(['551134567890']);
  });

  it('estrangeiro válido → um candidato só', () => {
    expect(phoneCandidates('+44 20 7946 0958', br)).toEqual(['442079460958']);
  });

  it('número que não normaliza → null (resposta neutra, sem banco)', () => {
    expect(phoneCandidates('', br)).toBeNull();
    expect(phoneCandidates('123', br)).toBeNull();
    expect(phoneCandidates('(00) 99999-9999', br)).toBeNull();
  });

  it('todo candidato casa com o formato que o banco aceita', () => {
    for (const raw of ['19991234567', '1991234567', '1134567890']) {
      for (const c of phoneCandidates(raw, br) ?? []) {
        expect(c).toMatch(/^[0-9]{10,15}$/);
      }
    }
  });
});

// Paridade com `contact_portal.canonical_phone` (migração 095, A-9): o
// convite conta o limite pelo canônico calculado no banco, a web pelo
// primeiro candidato daqui. Os mesmos pares estão nas asserções da 095.
const CANONICAL_PAIRS: [stored: string, canonical: string][] = [
  ['551999249658', '5519999249658'], // celular legado → ganha o 9
  ['5519999249658', '5519999249658'], // celular atual
  ['551932345678', '551932345678'], // fixo
  ['551188887777', '551188887777'], // 8 dígitos começando com 8: fixo
  ['447911123456', '447911123456'], // estrangeiro
];

describe('canônico = contact_portal.canonical_phone (095)', () => {
  it.each(CANONICAL_PAIRS)('%s → %s', (stored, canonical) => {
    expect(phoneCandidates(stored, br)?.[0]).toBe(canonical);
  });

  it('a 095 afirma os mesmos pares', () => {
    const file = path.resolve(
      __dirname,
      '../../../supabase/migrations/095_contact_portal_limit_locks.sql'
    );
    // `supabase/` fica fora do git: num checkout sem ela, nada a conferir.
    if (!existsSync(file)) return;
    const sql = readFileSync(file, 'utf-8');
    for (const [stored, canonical] of CANONICAL_PAIRS) {
      expect(sql).toMatch(
        new RegExp(`ARRAY\\['${stored}',\\s*'${canonical}'\\]`)
      );
    }
  });
});
