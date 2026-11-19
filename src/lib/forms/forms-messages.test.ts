// ============================================================
// Namespace `Forms` (construtor, lista, compartilhar) — SPEC 085 §10.1.
//
// O `i18n:check` só compara a árvore de chaves; nada pega, no `typecheck`:
//   1. ICU inválido (`INVALID_MESSAGE` só aparece no navegador);
//   2. placeholder diferente entre en e pt-BR;
//   3. chave usada num componente e ausente do dicionário (`MISSING_MESSAGE`);
//   4. um código novo de `FormIssueCode`/tipo de bloco/modelo sem texto.
// Este teste fecha as quatro.
// ============================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import IntlMessageFormat from 'intl-messageformat';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';

import { FORMS_API_ERROR_CODES, isFormsApiErrorCode } from './error-codes';
import { FORM_TEMPLATE_IDS } from './templates';
import { FIELD_TYPES } from './types';

type Block = Record<string, unknown>;

function flatten(obj: Block, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push([p, value]);
    else if (value && typeof value === 'object')
      out.push(...flatten(value as Block, p));
  }
  return out;
}

function get(root: Block, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Block)[part] : undefined,
      root
    );
}

const FORMS_EN = (en as Block).Forms as Block;
const FORMS_PT = (ptBR as Block).Forms as Block;

/** Nomes de placeholder (`{name}`) de uma mensagem ICU, sem os de plural/select. */
function placeholders(message: string): string[] {
  const ast = new IntlMessageFormat(message, 'en').getAst() as unknown[];
  const names = new Set<string>();
  const visit = (nodes: unknown[]) => {
    for (const n of nodes as Array<Record<string, unknown>>) {
      if (typeof n.value === 'string' && n.type !== 0) names.add(n.value);
      const options = n.options as
        Record<string, { value: unknown[] }> | undefined;
      if (options) for (const o of Object.values(options)) visit(o.value);
    }
  };
  visit(ast);
  return [...names].sort();
}

describe('Forms — ICU e paridade de placeholders', () => {
  it('o namespace existe nos dois dicionários', () => {
    expect(FORMS_EN).toBeDefined();
    expect(FORMS_PT).toBeDefined();
  });

  it.each([
    ['en', FORMS_EN],
    ['pt-BR', FORMS_PT],
  ])('%s: toda mensagem compila em ICU', (locale, block) => {
    for (const [key, message] of flatten(block)) {
      expect(
        () => new IntlMessageFormat(message, locale),
        `${locale} Forms.${key}`
      ).not.toThrow();
    }
  });

  it('os placeholders são idênticos nos dois idiomas', () => {
    const pt = new Map(flatten(FORMS_PT));
    for (const [key, message] of flatten(FORMS_EN)) {
      expect(placeholders(pt.get(key) ?? ''), `Forms.${key}`).toEqual(
        placeholders(message)
      );
    }
  });

  it('Sidebar.forms existe nos dois', () => {
    expect(((en as Block).Sidebar as Block).forms).toBeTruthy();
    expect(((ptBR as Block).Sidebar as Block).forms).toBeTruthy();
  });
});

describe('Forms — cobertura do que o código enumera', () => {
  const validateSource = readFileSync(
    path.resolve(__dirname, 'validate.ts'),
    'utf-8'
  );
  const issueCodes = [
    ...(
      /export type FormIssueCode =([\s\S]*?);/.exec(validateSource)?.[1] ?? ''
    ).matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]);

  it('o parser achou os códigos de problema', () => {
    expect(issueCodes.length).toBeGreaterThan(40);
  });

  it.each(['en', 'pt-BR'])('%s: todo FormIssueCode tem texto', (locale) => {
    const block = (locale === 'en' ? FORMS_EN : FORMS_PT).issues as Block;
    for (const code of issueCodes) {
      expect(block[code], `issues.${code}`).toEqual(expect.any(String));
    }
  });

  it.each(['en', 'pt-BR'])(
    '%s: todo tipo de bloco, modelo e código de erro da API tem texto',
    (locale) => {
      const f = locale === 'en' ? FORMS_EN : FORMS_PT;
      for (const type of FIELD_TYPES) {
        expect(get(f, `builder.types.${type}.name`), type).toEqual(
          expect.any(String)
        );
        expect(get(f, `builder.types.${type}.hint`), type).toEqual(
          expect.any(String)
        );
      }
      for (const id of FORM_TEMPLATE_IDS) {
        expect(get(f, `create.templates.${id}.name`), id).toEqual(
          expect.any(String)
        );
        expect(get(f, `create.templates.${id}.description`), id).toEqual(
          expect.any(String)
        );
      }
      for (const code of ['generic', ...FORMS_API_ERROR_CODES]) {
        expect(get(f, `errors.${code}`), code).toEqual(expect.any(String));
      }
      for (const status of ['draft', 'published', 'archived']) {
        expect(get(f, `status.${status}`), status).toEqual(expect.any(String));
      }
    }
  );
});

// ------------------------------------------------------------
// Toda chave LITERAL usada pelos componentes existe nos dois dicionários.
// Escopo por função (o mesmo `t` aponta para namespaces diferentes em
// funções diferentes do mesmo arquivo).
// ------------------------------------------------------------

const SRC = path.resolve(__dirname, '../..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

function usedKeys(files: string[]): Array<{ file: string; key: string }> {
  const out: Array<{ file: string; key: string }> = [];
  for (const file of files) {
    const whole = readFileSync(file, 'utf-8');
    for (const chunk of whole.split(/\n(?=(?:export )?(?:async )?function )/)) {
      const vars = new Map<string, string>();
      for (const m of chunk.matchAll(
        /const (\w+) = useTranslations\('([^']+)'\)/g
      )) {
        vars.set(m[1], m[2]);
      }
      for (const [v, ns] of vars) {
        const re = new RegExp(`\\b${v}\\(\\s*('[^']*'|"[^"]*")`, 'g');
        for (const m of chunk.matchAll(re)) {
          out.push({
            file: path.relative(SRC, file).split(path.sep).join('/'),
            key: `${ns}.${m[1].slice(1, -1)}`,
          });
        }
      }
    }
  }
  return out;
}

describe('Forms — chaves usadas pelos componentes', () => {
  const files = [
    ...walk(path.join(SRC, 'components/forms')),
    ...walk(path.join(SRC, 'app/(dashboard)/forms')),
  ];
  const used = usedKeys(files).filter((u) => u.key.startsWith('Forms.'));

  it('o extrator achou as chaves (senão o teste passaria vazio)', () => {
    expect(used.length).toBeGreaterThan(200);
  });

  it.each([
    ['en', en],
    ['pt-BR', ptBR],
  ])('%s: nenhuma chave usada está faltando', (_locale, dict) => {
    const missing = used
      .filter((u) => typeof get(dict as Block, u.key) !== 'string')
      .map((u) => `${u.key} (${u.file})`);
    expect(missing).toEqual([]);
  });
});

describe('isFormsApiErrorCode', () => {
  it('só os códigos estáveis; texto de papel/sessão cai no erro genérico', () => {
    expect(isFormsApiErrorCode('QUOTA_EXCEEDED')).toBe(true);
    expect(isFormsApiErrorCode('Insufficient role')).toBe(false);
    expect(isFormsApiErrorCode('Unauthorized')).toBe(false);
    expect(isFormsApiErrorCode(undefined)).toBe(false);
  });
});
