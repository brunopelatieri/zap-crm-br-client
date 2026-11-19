// ============================================================
// Isolamento da área do contato — regras de código (SPEC 083 §6).
//
// O isolamento vem da construção: o contato não tem JWT do Supabase,
// então nada da CRM o reconhece. O que pode quebrar isso é código: uma
// rota da área falando direto com o Supabase, uma rota da CRM lendo o
// cookie da área, uma rota do contato fora de `/area` (onde o cookie
// não chega). Este teste varre `src/` e acusa cada caso — inclusive em
// arquivos que ainda não existem (F3–F5), quando passarem a existir.
// ============================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PORTAL_COOKIE_PATH, PORTAL_SESSION_COOKIE } from './session';

const SRC = path.resolve(__dirname, '../..');
const PORTAL_LIB = path.join(SRC, 'lib', 'contact-portal');

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

/** Todas as RPCs `public.portal_*` da área (migrações 093–096), `service_role` só. */
const PORTAL_RPC_NAMES = [
  'portal_request_code',
  'portal_complete_code',
  'portal_login',
  'portal_create_session',
  'portal_resolve_session',
  'portal_select_account',
  'portal_change_password',
  'portal_logout',
  'portal_public_account',
  'portal_account_settings_get',
  'portal_account_settings_set',
  'portal_access_status',
  'portal_active_contact_ids',
  'portal_invite',
  'portal_set_blocked',
  'portal_end_sessions',
  'portal_account_summary',
] as const;

const sourceFiles = walk(SRC).filter((f) => !isTest(f));
// Lido uma vez: são ~700 arquivos e várias varreduras.
const contents = new Map<string, string>();
const read = (f: string) => {
  let code = contents.get(f);
  if (code === undefined) {
    code = readFileSync(f, 'utf-8');
    contents.set(f, code);
  }
  return code;
};

const importsFrom = (code: string, spec: RegExp) =>
  [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].some((m) => spec.test(m[1]));

describe('isolamento da área do contato', () => {
  it('a sessão da área não é cookie do Supabase e só vale em /area', () => {
    expect(PORTAL_SESSION_COOKIE).not.toMatch(/^sb-/);
    expect(PORTAL_COOKIE_PATH).toBe('/area');
  });

  it('nenhuma rota do contato em /api/area (o cookie Path=/area não chegaria)', () => {
    const misplaced = sourceFiles
      .map(rel)
      .filter((f) => f.startsWith('app/api/area/'));
    expect(misplaced).toEqual([]);
  });

  it('o nome do cookie só aparece em session.ts', () => {
    const offenders = sourceFiles
      .filter((f) => read(f).includes(PORTAL_SESSION_COOKIE))
      .map(rel);
    expect(offenders).toEqual(['lib/contact-portal/session.ts']);
  });

  it('só service.ts (e o lado da conta, em lib/contact-portal) toca o Supabase', () => {
    const offenders = walk(PORTAL_LIB)
      .filter((f) => !isTest(f))
      .filter((f) => importsFrom(read(f), /^@\/lib\/supabase\//))
      .map(rel)
      .filter(
        (f) =>
          f !== 'lib/contact-portal/service.ts' &&
          f !== 'lib/contact-portal/account.ts'
      );
    expect(offenders).toEqual([]);
  });

  it('telas e rotas da área não importam cliente Supabase nenhum', () => {
    const portalUi = sourceFiles.filter((f) => {
      const r = rel(f);
      return (
        r.startsWith('app/(portal)/') ||
        r.startsWith('components/contact-portal/')
      );
    });
    const offenders = portalUi
      .filter((f) => importsFrom(read(f), /^@\/lib\/supabase\//))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('nenhuma rota da CRM lê a sessão da área', () => {
    // A CRM fala com a área só pelo lado da conta: as rotas de
    // /api/contact-portal (F5) e, fora delas, só `contact-portal/account`
    // (ex.: o resumo no console /admin). Sessão, jornadas e o resto do
    // lado do contato nunca entram numa rota de /api.
    const offenders = sourceFiles
      .filter((f) => {
        const r = rel(f);
        return (
          r.startsWith('app/api/') && !r.startsWith('app/api/contact-portal/')
        );
      })
      .filter((f) =>
        importsFrom(read(f), /^@\/lib\/contact-portal(\/(?!account$)|$)/)
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('as RPCs portal_* só são chamadas de dentro de lib/contact-portal', () => {
    // Lista FECHADA (F5-07): `portal_*` também é nome de coluna de outros
    // módulos (ex.: `forms.portal_visibility`), e uma expressão aberta
    // acusava falso positivo. Função nova da área entra aqui junto com a
    // migração — e o teste abaixo cobra a lista contra o SQL.
    const callsPortalRpc = new RegExp(
      `['"](${PORTAL_RPC_NAMES.join('|')})['"]`
    );
    const offenders = sourceFiles
      .filter((f) => !f.startsWith(PORTAL_LIB))
      .filter((f) => callsPortalRpc.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('a lista de RPCs da área bate com as funções criadas nas migrações', () => {
    const migrationsDir = path.resolve(SRC, '..', 'supabase', 'migrations');
    let files: string[];
    try {
      files = readdirSync(migrationsDir).filter((n) =>
        /^(09[3-9]|1\d\d)_contact_portal.*\.sql$/.test(n)
      );
    } catch {
      return; // migrações ficam fora do git: sem a pasta (fork), nada a conferir
    }
    if (files.length === 0) return;
    const created = new Set<string>();
    for (const name of files) {
      const sql = readFileSync(path.join(migrationsDir, name), 'utf-8');
      for (const m of sql.matchAll(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(portal_[a-z_]+)/gi
      )) {
        created.add(m[1]);
      }
    }
    expect([...created].sort()).toEqual([...PORTAL_RPC_NAMES].sort());
  });
});
