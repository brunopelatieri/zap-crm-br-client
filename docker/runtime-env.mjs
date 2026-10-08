// Configuração em tempo de execução das variáveis NEXT_PUBLIC_* (imagem Docker).
//
// O PROBLEMA. O Next grava `process.env.NEXT_PUBLIC_*` como texto literal no
// bundle do navegador, no middleware (Edge) e nos bundles do servidor, NA HORA
// DO BUILD. Mudar essas variáveis na stack do Portainer não muda nada: o valor
// já está dentro dos arquivos da imagem.
//
// A SOLUÇÃO. A imagem é construída UMA vez com valores-MARCADOR (definidos no
// Dockerfile e repetidos em PLACEHOLDERS abaixo). Ao subir, este script troca
// cada marcador pelo valor que a stack passou em `environment:`. A mesma imagem
// pública serve para qualquer Supabase/domínio, sem `--build-arg` e sem terminal
// na VPS.
//
// Modos:
//   node runtime-env.mjs                 (padrão, ao subir o container)
//   node runtime-env.mjs --verify-build  (no build: confere que TODO marcador
//                                         sobreviveu ao minificador do Next)
//
// Se mudar um marcador, mude nos DOIS lugares: aqui e no ENV do Dockerfile.
// O `--verify-build` reprova o build se ficarem fora de sincronia.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLACEHOLDERS = [
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    marker: 'https://zapcrm-placeholder-supabase-url.invalid',
    required: true,
    check: (v) => /^https?:\/\/[^\s/]+/.test(v) || 'precisa começar com http:// ou https://',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    marker: 'zapcrm-placeholder-supabase-anon-key',
    required: true,
  },
  {
    name: 'NEXT_PUBLIC_SITE_URL',
    marker: 'https://zapcrm-placeholder-site-url.invalid',
    required: true, // `new URL(SITE_URL)` em src/app/layout.tsx estoura se vazio
    check: (v) => /^https?:\/\/[^\s/]+/.test(v) || 'precisa começar com http:// ou https://',
  },
  {
    name: 'NEXT_PUBLIC_APP_LOCALE',
    marker: 'zapcrm-placeholder-app-locale',
    required: false,
    fallback: 'pt-BR',
  },
  {
    name: 'NEXT_PUBLIC_SIGNUP_ENABLED',
    marker: 'zapcrm-placeholder-signup-enabled',
    required: false,
    fallback: '', // ausente = cadastro público ligado (src/lib/auth/signup-flag.ts)
  },
];

const ROOT = process.cwd();
const SCAN_ROOTS = ['.next', 'server.js'];
// `.next/cache` é cache do webpack (centenas de MB, sem nada que o servidor leia).
const SKIP_DIRS = new Set(['cache']);
const TEXT_EXT = /\.(js|mjs|cjs|html|rsc|json|body|txt)$/;
const MARKER_FILE = join(ROOT, '.next', '.runtime-env.sha256');

function* walk(path) {
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (st.isFile()) {
    if (TEXT_EXT.test(path)) yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(path, entry.name));
    } else if (TEXT_EXT.test(entry.name)) {
      yield join(path, entry.name);
    }
  }
}

function allFiles() {
  return SCAN_ROOTS.flatMap((r) => [...walk(join(ROOT, r))]);
}

function fail(message) {
  console.error(`[runtime-env] ERRO: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- build ----
if (process.argv.includes('--verify-build')) {
  const counts = new Map(PLACEHOLDERS.map((p) => [p.name, 0]));
  for (const file of allFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const p of PLACEHOLDERS) {
      if (text.includes(p.marker)) counts.set(p.name, counts.get(p.name) + 1);
    }
  }
  let bad = false;
  for (const p of PLACEHOLDERS) {
    const n = counts.get(p.name);
    console.log(`[runtime-env] marcador de ${p.name}: ${n} arquivo(s)`);
    if (n === 0) bad = true;
  }
  if (bad) {
    fail(
      'algum marcador NÃO está no código gerado. Ou o marcador do Dockerfile difere do daqui, ou o minificador do Next resolveu a variável em tempo de build (nesse caso ela não pode ser trocada em runtime e esta técnica não serve para ela).'
    );
  }
  process.exit(0);
}

// -------------------------------------------------------------- runtime ----
const values = {};
for (const p of PLACEHOLDERS) {
  const raw = (process.env[p.name] ?? '').trim();
  const value = raw === '' ? (p.fallback ?? '') : raw;
  if (p.required && value === '') {
    fail(
      `${p.name} não está definida. Defina-a em "environment:" da stack no Portainer e atualize a stack.`
    );
  }
  // O valor entra como TEXTO dentro de arquivos .js: aspas, barra invertida
  // ou quebra de linha quebrariam o JavaScript do bundle inteiro.
  if (/["'`\\\r\n]/.test(value)) {
    fail(`${p.name} contém aspas, crase, barra invertida ou quebra de linha.`);
  }
  if (value !== '' && p.check) {
    const verdict = p.check(value);
    if (verdict !== true) fail(`${p.name} inválida: ${verdict}`);
  }
  values[p.name] = value;
}

const fingerprint = createHash('sha256').update(JSON.stringify(values)).digest('hex');
if (existsSync(MARKER_FILE)) {
  const applied = readFileSync(MARKER_FILE, 'utf8').trim();
  if (applied === fingerprint) {
    console.log('[runtime-env] container já configurado com estes valores — nada a trocar.');
    process.exit(0);
  }
  fail(
    'este container já foi configurado com OUTROS valores (os marcadores originais já foram substituídos e não há como trocar de novo). Recrie o container: no Portainer, "Update the stack" com a opção de recriar/re-puxar a imagem, em vez de apenas reiniciar.'
  );
}

const replaced = new Map(PLACEHOLDERS.map((p) => [p.name, 0]));
let filesTouched = 0;
for (const file of allFiles()) {
  let text = readFileSync(file, 'utf8');
  let changed = false;
  for (const p of PLACEHOLDERS) {
    if (text.includes(p.marker)) {
      text = text.split(p.marker).join(values[p.name]);
      replaced.set(p.name, replaced.get(p.name) + 1);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(file, text);
    filesTouched += 1;
  }
}

for (const p of PLACEHOLDERS) {
  console.log(
    `[runtime-env] ${p.name}: ${replaced.get(p.name)} arquivo(s)` +
      (p.name === 'NEXT_PUBLIC_SUPABASE_ANON_KEY' ? '' : ` -> ${values[p.name] || '(vazio)'}`)
  );
}
if (replaced.get('NEXT_PUBLIC_SUPABASE_URL') === 0) {
  fail('nenhum marcador do Supabase encontrado — a imagem foi construída com outro Dockerfile?');
}
writeFileSync(MARKER_FILE, fingerprint);
console.log(`[runtime-env] ok: ${filesTouched} arquivo(s) configurado(s).`);
