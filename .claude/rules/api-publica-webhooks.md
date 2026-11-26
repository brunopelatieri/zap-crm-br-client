---
paths:
  - 'src/lib/api/v1/**'
  - 'src/app/api/v1/**'
  - 'src/lib/api-keys/**'
  - 'src/lib/webhooks/**'
  - 'public/openapi*.json'
  - 'docs/public-api.md'
  - 'mcp-server/src/**'
  - 'docs/mcp.md'
---

# API pública `/api/v1`, webhooks de saída e MCP

- Mudança em `/api/v1/**` (endpoint, campo, escopo, evento) edita os **três** juntos: `docs/public-api.md`, `public/openapi.json` e `public/openapi.pt-BR.json`.
- Valide os dois JSON com `npx @redocly/cli lint` e confira a paridade estrutural (comando no domínio); só `summary`/`description` mudam entre eles.
- Exemplos de requisição e resposta ficam em inglês nos dois JSON; erro de `/api/**` é sempre em inglês.
- Toda rota `/api/v1/**` passa por `requireApiKey`; escopo novo em `src/lib/api-keys/scopes.ts` é mudança de contrato, e o escopo é a conta, nunca um agente.
- Chave de API só se cria e revoga pelo painel, nunca por endpoint `/api/v1`.
- `fetch` para URL vinda de usuário usa `isDeliverableUrl` **e** `redirect: 'manual'` (SSRF); webhook de saída é assinado em `sign.ts`.
- MCP é somente leitura até opt-in; ferramenta que escreve respeita o opt-in e o `confirm` do disparo.
- MCP nunca ganha ferramenta de exclusão de conta ou de usuário (SPEC 091 A-19, ratificada).

Detalhe: leia `docs/context/api-publica-webhooks.md`. Procedimento: skill `endpoint-api-publica`.
