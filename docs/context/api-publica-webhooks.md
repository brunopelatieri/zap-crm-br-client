# API pública `/api/v1`, chaves, webhooks de saída e servidor MCP

> Domínio sob demanda (SPEC 079). Rule: `.claude/rules/api-publica-webhooks.md`. Skill: `endpoint-api-publica`. Mapa completo conceito → arquivo: [`docs/public-api.md` § Implementation reference](../public-api.md#implementation-reference-source-map) — leia só essa seção e a do endpoint que vai mexer.

## Regra dos 3 arquivos (contrato)

Qualquer mudança em `/api/v1/**` — endpoint novo, campo alterado/removido, escopo novo, evento de webhook novo — edita **os três juntos, na mesma alteração**:

| Arquivo                                                        | Papel                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`docs/public-api.md`](../public-api.md)                       | **Fonte de verdade** (prosa, em inglês): autenticação, escopos, cada endpoint, exemplos `curl`                         |
| [`public/openapi.json`](../../public/openapi.json)             | OpenAPI 3.1 gerado a partir do documento acima (paths, schemas, exemplos)                                              |
| [`public/openapi.pt-BR.json`](../../public/openapi.pt-BR.json) | Espelho: mesmos paths/`operationId`/schemas/`$ref`/`enum`/`required`/exemplos; **só** `summary`/`description` em pt-BR |

- Exemplos de requisição/resposta ficam **em inglês nos dois JSON** — é o que trafega na rede.
- Validar os dois: `npx @redocly/cli lint public/openapi.json` e `npx @redocly/cli lint public/openapi.pt-BR.json`.
- Paridade estrutural (nenhum `$ref`/`type`/`enum`/`required` pode divergir; só prosa). Remove só os **textos** `summary`/`description`/`title` (propriedades de schema com esses nomes continuam comparadas) e compara — tem de imprimir `paridade OK`:

```bash
node -e "const s=o=>Array.isArray(o)?o.map(s):o&&typeof o==='object'?Object.fromEntries(Object.entries(o).filter(([k,v])=>!(typeof v==='string'&&['summary','description','title'].includes(k))).map(([k,v])=>[k,s(v)])):o;const [a,b]=['public/openapi.json','public/openapi.pt-BR.json'].map(f=>JSON.stringify(s(require('./'+f))));console.log(a===b?'paridade OK':'DIVERGE')"
```

## Mensagens e idioma

- Toda resposta de `/api/**` (pública **e** interna) devolve erro em **inglês**, de propósito: integrações e logs consomem um idioma estável. A UI traduz pelo status/forma do erro com `next-intl` ([`i18n`](./i18n.md)). Não localize payload de API.
- Envelope de resposta e `ApiError`: `src/lib/api/v1/respond.ts`; paginação por cursor: `src/lib/api/v1/pagination.ts`.

## Autenticação, escopos e conta

- `requireApiKey` (`src/lib/auth/api-context.ts`) resolve chave → contexto de conta e barra conta bloqueada antes de toda rota `/api/v1/**`.
- Vocabulário de escopos: `src/lib/api-keys/scopes.ts` (`API_SCOPES`). Escopo novo = mudança de contrato (3 arquivos). O escopo é a **conta**, nunca um agente ([`public-api.md` § Scopes](../public-api.md#scopes)).
- Criar/revogar chave é **só pelo painel** (`/api/account/api-keys`, sessão por cookie, admin+); não existe endpoint `/api/v1` para isso. Endpoints de webhook, ao contrário, são geridos por `/api/v1/webhooks`.
- Rate limit: `RATE_LIMITS.publicApi` em `src/lib/rate-limit.ts`.
- Webhook de entrada (`POST /api/v1/ingest/contact`, SPEC 055): o contrato é deste domínio; a lógica de contato/funil é de [`contatos-audiencia`](./contatos-audiencia.md).

## Webhooks de saída

| Peça                         | Arquivo                         |
| ---------------------------- | ------------------------------- |
| Vocabulário de eventos       | `src/lib/webhooks/events.ts`    |
| Assinatura HMAC              | `src/lib/webhooks/sign.ts`      |
| Entrega + contador de falhas | `src/lib/webhooks/deliver.ts`   |
| CRUD de endpoints            | `src/lib/webhooks/endpoints.ts` |
| **Guarda SSRF**              | `src/lib/webhooks/ssrf.ts`      |

**SSRF:** a URL do webhook é controlada por quem tem `webhooks:manage`, e quem faz a requisição é o nosso servidor. `fetch` para URL vinda de usuário passa por `isDeliverableUrl` (resolve o host e recusa loopback, privado, link-local, ULA, reservado) **e** usa `redirect: 'manual'` (senão um 3xx leva a um host interno) — assim fazem `deliver.ts`, o motor de automações, `src/lib/notifications/webhook.ts` e a exportação de mídia do inbox. Quando o destino é um host fixo, a alternativa é allowlist de host + `redirect: 'manual'` (`src/lib/spreadsheet/google-sheets.ts`). Código novo usa um dos dois. Risco residual documentado no topo de `ssrf.ts`: DNS rebinding.

## Servidor MCP (`mcp-server/`)

- Camada fina sobre a API pública: toda chamada autentica e é escopada por chave como qualquer cliente. Ferramentas em `mcp-server/src/tools/` (`read.ts`, `write.ts`, `broadcast.ts`).
- **Somente leitura até opt-in** (escrita e disparo são ligados explicitamente; disparo exige `confirm`). Ferramenta nova que escreve respeita esse opt-in.
- **Sem ferramenta de exclusão de conta ou de usuário**, em nenhum conjunto e com qualquer opt-in ([SPEC 091](../spec-091-assistente-da-plataforma-e-mcp-do-proprietario.md) A-19, ratificada em 2026-11-26). A ampliação do MCP (SPEC 090) e o MCP do proprietário (SPEC 091) são propostas: confira o Status de cada uma.
- Endpoint novo que deva aparecer no MCP: ferramenta nova + [`docs/mcp.md`](../mcp.md) e [`mcp-server/README.md`](../../mcp-server/README.md).
