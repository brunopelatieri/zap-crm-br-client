// ============================================================
// Isolamento dos formulários — regras de código (SPEC 085 E-9, PRD 084
// D-9). Mesmo molde de `contact-portal/isolation.test.ts`: varre `src/`
// e acusa o que não pode existir, inclusive em arquivos que só a F2/F3
// vão criar.
// ============================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as adminClient from './admin-client';

const SRC = path.resolve(__dirname, '../..');

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const isTest = (f: string) => /\.test\.tsx?$/.test(f);
const sourceFiles = walk(SRC).filter((f) => !isTest(f));
const read = (f: string) => readFileSync(f, 'utf-8');
const importsFrom = (code: string, spec: RegExp) =>
  [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].some((m) => spec.test(m[1]));

const ADMIN_SPEC =
  /^@\/lib\/supabase\/admin$|^@\/lib\/forms\/admin-client$|\.\/admin-client$/;

describe('isolamento dos formulários', () => {
  it('admin-client só reexporta o cliente service-role canônico', () => {
    expect(Object.keys(adminClient)).toEqual(['supabaseAdmin']);
    expect(typeof adminClient.supabaseAdmin).toBe('function');
  });

  it('nenhum componente de formulário nem a página pública importa service-role', () => {
    const offenders = sourceFiles
      .filter((f) => {
        const r = rel(f);
        return (
          r.startsWith('components/forms/') ||
          r.startsWith('app/(public)/f/') ||
          r.startsWith('app/f/')
        );
      })
      .filter((f) => importsFrom(read(f), ADMIN_SPEC))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('dentro de lib/forms, só quem precisa do service-role o importa', () => {
    const offenders = sourceFiles
      .filter((f) => rel(f).startsWith('lib/forms/'))
      .filter((f) => importsFrom(read(f), ADMIN_SPEC))
      .map(rel)
      .sort();
    expect(offenders).toEqual([
      'lib/forms/admin-client.ts',
      'lib/forms/plan-gate.ts',
      // F3: o ÚNICO ponto das rotas e da página pública (`public-service.ts`);
      // as rotas `app/api/forms/public/**` só o chamam.
      'lib/forms/public-service.ts',
    ]);
  });

  it('a projeção pública é o único arquivo que monta o payload do visitante', () => {
    // Quem monta `PublicFormPayload` fora de project-public.ts fura o
    // contrato E-9 (o teste de contrato só cobre a projeção oficial).
    const offenders = sourceFiles
      .filter((f) => !rel(f).startsWith('lib/forms/project-public.ts'))
      .filter((f) => !rel(f).startsWith('lib/forms/types.ts'))
      .filter((f) => /PublicFormPayload\s*=\s*\{/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
