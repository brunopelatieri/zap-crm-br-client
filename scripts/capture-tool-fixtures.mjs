#!/usr/bin/env node
// ============================================================
// Captura as fixtures REAIS de tool calling da Anthropic e da OpenAI
// (SPEC 089 F4), gravando em docs/spec-089-f4-fixtures/. A Anthropic já foi
// capturada (2026-11-27) e é a fixture de anthropic.test.ts; a OpenAI direta
// ainda não: openai.test.ts usa respostas montadas pela documentação.
//
// Fluxo de 2 passos, com a mesma pergunta e as mesmas 2 ferramentas das
// fixtures da F0 (docs/spec-089-f0-fixtures/tool-calls-parallel.json):
//   1. a pergunta + as ferramentas -> o modelo devolve tool calls;
//   2. devolve os resultados (os mesmos textos de tool-result-final-answer.json)
//      -> o modelo responde em texto.
// System prompt, mensagem do usuário e definições das ferramentas são lidos
// da própria fixture da F0, para que não haja divergência.
//
// Como rodar (Node 22, sem dependências; PowerShell):
//   $env:ANTHROPIC_API_KEY='sk-ant-...'
//   node scripts/capture-tool-fixtures.mjs --provider anthropic --model claude-haiku-4-5-20251001
//
//   $env:OPENAI_API_KEY='sk-...'
//   node scripts/capture-tool-fixtures.mjs --provider openai --model gpt-4.1-mini
//
// Saída: docs/spec-089-f4-fixtures/<provider>-tool-calls.json (passo 1) e
// <provider>-tool-result-final.json (passo 2), no formato
// {captured_at, source, note, endpoint, method, request, response:{status,headers,body}}.
//
// Anonimização: a chave NUNCA é gravada (nem cabeçalhos de autenticação);
// só uma lista curta de cabeçalhos de resposta é mantida; campos de
// organização/conta/usuário/projeto no corpo viram "<REDACTED>". Confira o
// JSON antes de commitar. Gasto: duas chamadas curtas (centavos).
// ============================================================
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const F0 = resolve(ROOT, 'docs/spec-089-f0-fixtures');
const OUT = resolve(ROOT, 'docs/spec-089-f4-fixtures');

const PROVIDERS = {
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    url: 'https://api.anthropic.com/v1/messages',
    endpoint: '/v1/messages',
    defaultModel: 'claude-haiku-4-5-20251001',
  },
  openai: {
    env: 'OPENAI_API_KEY',
    url: 'https://api.openai.com/v1/chat/completions',
    endpoint: '/v1/chat/completions',
    defaultModel: 'gpt-4.1-mini',
  },
};

// Cabeçalhos de resposta que podem ser gravados (todo o resto é descartado:
// openai-organization, openai-project, set-cookie, cf-*, etc.).
const KEEP_HEADERS = new Set([
  'content-type',
  'request-id',
  'x-request-id',
  'anthropic-version',
  'openai-version',
  'openai-model',
]);

// Campos do corpo que identificam conta/organização/usuário.
const SENSITIVE_KEY = /^(organization|organization_id|org_id|user_id|user|project|project_id|account_id|workspace_id)$/i;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? argv[++i];
    }
  }
  return out;
}

function fail(msg) {
  console.error(`Erro: ${msg}`);
  process.exit(1);
}

function scrub(value, secret) {
  if (Array.isArray(value)) return value.map((v) => scrub(v, secret));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && v != null ? '<REDACTED>' : scrub(v, secret);
    }
    return out;
  }
  if (typeof value === 'string' && secret && value.includes(secret)) {
    return value.split(secret).join('<REDACTED>');
  }
  return value;
}

function keptHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (KEEP_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  return out;
}

async function call(cfg, apiKey, headers, request) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const msg = body?.error?.message ?? text.slice(0, 200);
    fail(`HTTP ${res.status} de ${cfg.endpoint}: ${scrub(msg, apiKey)}`);
  }
  return { status: res.status, headers: keptHeaders(res.headers), body };
}

async function save(name, provider, step, note, cfg, apiKey, request, response) {
  const file = resolve(OUT, name);
  const fixture = scrub(
    {
      captured_at: new Date().toISOString().slice(0, 10),
      source: `${provider}, chamada real (SPEC 089 F4, scripts/capture-tool-fixtures.mjs)`,
      note,
      endpoint: cfg.endpoint,
      method: 'POST',
      request,
      response,
    },
    apiKey
  );
  await writeFile(file, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  console.log(`Gravado (passo ${step}): ${file}`);
}

async function loadF0() {
  const calls = JSON.parse(
    await readFile(resolve(F0, 'tool-calls-parallel.json'), 'utf8')
  );
  const final = JSON.parse(
    await readFile(resolve(F0, 'tool-result-final-answer.json'), 'utf8')
  );
  const msgs = calls.request.messages;
  const toolOutputs = final.request.messages
    .filter((m) => m.role === 'tool')
    .map((m) => m.content);
  return {
    system: msgs.find((m) => m.role === 'system').content,
    user: msgs.find((m) => m.role === 'user').content,
    openaiTools: calls.request.tools,
    // [0] = preço do plano, [1] = prazo de devolução (mesmos textos da F0).
    priceResult: toolOutputs[0],
    returnsResult: toolOutputs[1],
  };
}

/** Texto devolvido para uma tool call, escolhido pelo conteúdo da pergunta. */
function resultFor(f0, name, args) {
  if (name === 'search_knowledge') {
    return /devol|prazo|troca|reembols/i.test(String(args?.query ?? ''))
      ? f0.returnsResult
      : f0.priceResult;
  }
  return '<resultado_ferramenta>Tags adicionadas ao contato.</resultado_ferramenta>';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function runAnthropic(cfg, apiKey, model, f0) {
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const tools = f0.openaiTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
  const base = { model, max_tokens: 400, system: f0.system, tools };

  const req1 = { ...base, messages: [{ role: 'user', content: f0.user }] };
  const res1 = await call(cfg, apiKey, headers, req1);
  await save(
    'anthropic-tool-calls.json',
    'Anthropic',
    1,
    'Primeiro passo com tools: blocos tool_use (possivelmente paralelos), stop_reason tool_use.',
    cfg,
    apiKey,
    req1,
    res1
  );

  const uses = (res1.body.content ?? []).filter((b) => b.type === 'tool_use');
  if (uses.length === 0) {
    fail(
      'o modelo não pediu nenhuma ferramenta no passo 1; passo 2 não executado (rode de novo ou ajuste o modelo).'
    );
  }
  const req2 = {
    ...base,
    messages: [
      { role: 'user', content: f0.user },
      { role: 'assistant', content: res1.body.content },
      {
        role: 'user',
        content: uses.map((u) => ({
          type: 'tool_result',
          tool_use_id: u.id,
          content: resultFor(f0, u.name, u.input),
        })),
      },
    ],
  };
  const res2 = await call(cfg, apiKey, headers, req2);
  await save(
    'anthropic-tool-result-final.json',
    'Anthropic',
    2,
    'Segundo passo: assistant com tool_use + uma mensagem user com os tool_result; resposta final em texto.',
    cfg,
    apiKey,
    req2,
    res2
  );
}

async function runOpenAi(cfg, apiKey, model, f0) {
  const headers = { authorization: `Bearer ${apiKey}` };
  const base = {
    model,
    max_tokens: 400,
    temperature: 0.2,
    tools: f0.openaiTools,
    tool_choice: 'auto',
  };
  const baseMessages = [
    { role: 'system', content: f0.system },
    { role: 'user', content: f0.user },
  ];

  const req1 = { ...base, messages: baseMessages };
  const res1 = await call(cfg, apiKey, headers, req1);
  await save(
    'openai-tool-calls.json',
    'OpenAI',
    1,
    'Primeiro passo com tools: tool_calls (possivelmente paralelas), finish_reason tool_calls.',
    cfg,
    apiKey,
    req1,
    res1
  );

  const msg = res1.body.choices?.[0]?.message;
  const toolCalls = msg?.tool_calls ?? [];
  if (toolCalls.length === 0) {
    fail(
      'o modelo não pediu nenhuma ferramenta no passo 1; passo 2 não executado (rode de novo ou ajuste o modelo).'
    );
  }
  const req2 = {
    ...base,
    messages: [
      ...baseMessages,
      { role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls },
      ...toolCalls.map((c) => ({
        role: 'tool',
        tool_call_id: c.id,
        content: resultFor(f0, c.function.name, parseJson(c.function.arguments)),
      })),
    ],
  };
  const res2 = await call(cfg, apiKey, headers, req2);
  await save(
    'openai-tool-result-final.json',
    'OpenAI',
    2,
    'Segundo passo: mensagens role=tool (tool_call_id) e resposta final em texto.',
    cfg,
    apiKey,
    req2,
    res2
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = args.provider;
  const cfg = PROVIDERS[provider];
  if (!cfg) fail('use --provider anthropic|openai');
  const apiKey = process.env[cfg.env];
  if (!apiKey) fail(`defina a variável de ambiente ${cfg.env}`);
  const model = args.model ?? cfg.defaultModel;

  await mkdir(OUT, { recursive: true });
  const f0 = await loadF0();
  console.log(`Provedor: ${provider} | modelo: ${model}`);
  if (provider === 'anthropic') await runAnthropic(cfg, apiKey, model, f0);
  else await runOpenAi(cfg, apiKey, model, f0);
  console.log('Pronto. Revise os JSON antes de commitar.');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
