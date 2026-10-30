---
name: endpoint-api-publica
description: Criar ou alterar endpoint /api/v1, escopo de API key, evento de webhook de saída ou OpenAPI. Mantém docs/public-api.md e os dois openapi*.json em paridade.
---

# Endpoint da API pública `/api/v1`

## Quando usar

Ao criar, alterar ou remover endpoint, campo, escopo de chave ou evento de webhook em `/api/v1/**`, ou ao editar `public/openapi*.json`.

## Como funciona

1. **Leia o mapa**, não o arquivo inteiro: `docs/public-api.md` § "Implementation reference (source map)" e a seção do endpoint que vai mexer.
2. **Implemente** em `src/app/api/v1/<recurso>/route.ts`:
   - autenticação por `requireApiKey` (`src/lib/auth/api-context.ts`), que também barra conta bloqueada;
   - envelope e erros por `src/lib/api/v1/respond.ts`, paginação por `pagination.ts`;
   - escopo novo em `src/lib/api-keys/scopes.ts` (`API_SCOPES`) — é mudança de contrato; o escopo é a conta, nunca um agente;
   - rate limit `RATE_LIMITS.publicApi`; mensagens de erro em **inglês**;
   - a lógica fica em `src/lib/` com `*.test.ts` ao lado.
3. **Edite os três arquivos juntos, na mesma alteração:**

   | Arquivo                     | Papel                                        |
   | --------------------------- | -------------------------------------------- |
   | `docs/public-api.md`        | fonte de verdade (prosa, inglês)             |
   | `public/openapi.json`       | OpenAPI 3.1 gerado a partir dela             |
   | `public/openapi.pt-BR.json` | espelho; só `summary`/`description` em pt-BR |

   Exemplos de requisição e resposta ficam em inglês nos dois JSON.

4. **Valide:** `npx @redocly/cli lint public/openapi.json` e `npx @redocly/cli lint public/openapi.pt-BR.json`. Depois rode o comando de paridade estrutural que está em `docs/context/api-publica-webhooks.md` (seção "Regra dos 3 arquivos") — tem de imprimir `paridade OK`. Não copie o comando para outro lugar.

5. **Evento de webhook de saída novo:** vocabulário em `src/lib/webhooks/events.ts` + os três arquivos acima. Se a URL vem do usuário, `fetch` passa por `isDeliverableUrl` e usa `redirect: 'manual'` (SSRF).
6. **Se deve aparecer no MCP:** ferramenta nova em `mcp-server/src/tools/` + `docs/mcp.md` + `mcp-server/README.md`; escrita respeita o opt-in.
7. **Gate local** do `AGENTS.md` (typecheck, i18n, lint, test, format, build) antes de entregar.

Detalhe completo: `docs/context/api-publica-webhooks.md`.

## Exemplos

- "Adicionar campo `x` na resposta de contatos" → rota + os três arquivos + lint ×2 + paridade.
- "Escopo novo `foo:read`" → `scopes.ts`, seção Scopes de `public-api.md`, schema nos dois JSON.
- "Expor esse endpoint no MCP" → passos 1–4 e depois o passo 6.
