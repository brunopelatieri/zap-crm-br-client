# SPEC 089 — F0: medições com chave real

| Campo    | Valor                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data     | 2026-11-26                                                                                                                                                                                                                      |
| SPEC     | [SPEC 089](./spec-089-agentes-de-ia-openrouter-rag-ferramentas.md), F0 (§9)                                                                                                                                                     |
| Chave    | Chave do OpenRouter do mantenedor, com limite de US$ 2,50. Usada só em variável de ambiente de processo; não está em arquivo, log, URL nem neste documento. **Revogar ao fim da F0** (ela ficou no histórico da conversa).      |
| Custo    | **US$ 0,0016** no total (cerca de 50 chamadas: 5 modelos de chat, tool calling em 2 passos, embeddings, erros provocados). Medido por `GET /api/v1/key` (`usage`).                                                              |
| Banco    | `vn` (`awylbfsywsrnkztvovud`, conferido com `get_project_url` antes da primeira leitura). **Só SELECT**: nenhuma escrita, nenhum DDL.                                                                                           |
| Fixtures | [`docs/spec-089-f0-fixtures/`](./spec-089-f0-fixtures/): 16 JSON, um por caso, com request e response reais. Anonimizados: sem chave, `user_id`, `workspace_id`, rótulo da chave e domínio de produção trocados por marcadores. |
| Código   | Nenhum em `src/`. Bibliotecas testadas em pasta temporária fora do repositório; `package.json` intocado.                                                                                                                        |

---

## 1. OpenRouter

Documentação lida (formato Markdown oficial, `https://openrouter.ai/docs/...md`): referência da API, seleção de provedor, tool calling, embeddings, contabilização de uso e erros. Cada fato abaixo foi conferido com chamada real, salvo onde dito.

### 1.1 Chat completions (D-1)

- `POST https://openrouter.ai/api/v1/chat/completions`, formato OpenAI. Resposta: `id` (`gen-…`), `object: "chat.completion"`, `model`, **`provider`** (nome do provedor que atendeu, por exemplo `Claude Platform on AWS`, `Azure`, `DeepInfra`), `choices[0].message.{content, refusal, reasoning}`, `finish_reason` normalizado (`stop`, `tool_calls`) e `native_finish_reason` do provedor (`end_turn`, `STOP`, `completed`).
- `usage`: `prompt_tokens`, `completion_tokens`, `total_tokens`, **`cost`**, `is_byok`, `prompt_tokens_details.{cached_tokens, cache_write_tokens}`, `completion_tokens_details.reasoning_tokens` e `cost_details.{upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost}`.
- O cabeçalho `x-generation-id` repete o `id`.
- Fixture: `chat-completion.json`.

### 1.2 Custo (D-6)

- **Campo: `usage.cost`**, número em **USD** (crédito do OpenRouter), presente em toda resposta 200 de chat **e** de embeddings. Não precisa pedir: a doc diz que `usage: { include: true }` está obsoleto e sem efeito, e a chamada real confirma (veio sem o parâmetro).
- `cost_details.upstream_inference_cost` é o que o provedor cobrou. Com chave própria do provedor (BYOK) os dois diferem; sem BYOK, nas medições, foram iguais.
- Valor típico medido: chat curto com o modelo padrão proposto, US$ 0,000134; dois passos de ferramenta, cerca de US$ 0,00027; embeddings de 2 frases, US$ 0,0000006.
- Para a F1: `ai_usage_log.cost_usd` recebe `usage.cost`. OpenAI e Anthropic diretos seguem com `cost_usd` nulo.

### 1.3 Tool calling (D-15)

- Request: `tools: [{ type: "function", function: { name, description, parameters } }]` e `tool_choice: "auto"`. Resposta: `finish_reason: "tool_calls"` e `message.tool_calls: [{ type: "function", index, id, function: { name, arguments } }]`, com **`arguments` em string JSON**. Segundo passo: a mensagem `assistant` com as `tool_calls` volta no histórico, seguida de uma mensagem `{ role: "tool", tool_call_id, content }` por chamada.
- Testado em 5 modelos (seção 1.7). O que o motor da F4 precisa tratar:
  - **chamadas paralelas são comuns**: 3 dos 5 modelos pediram duas `search_knowledge` no mesmo passo (`tool-calls-parallel.json`). O limite de 4 passos conta passos, não chamadas;
  - `content` pode vir **junto** com `tool_calls` (deepseek: "Deixe-me consultar…"). O texto intermediário não pode ir ao cliente (`tool-calls-with-content.json`);
  - o formato do `id` da chamada varia por provedor (`toolu_…`, `call_…`, `tool_search_knowledge_…`, `dluY3aznb`). Tratar como string opaca.
- Fixtures: `tool-calls-parallel.json`, `tool-calls-with-content.json`, `tool-result-final-answer.json`.

### 1.4 Modelo sem suporte a ferramentas (regra 5 do §5.3)

- Requisição com `tools` para um modelo sem `tools` em `supported_parameters` (`mistralai/pixtral-large-2502`): **HTTP 404**, `error.message` "No endpoints found that support tool use. Try disabling \"search_knowledge\"…", `error.metadata.failed_routing_step: "Filter by Tool Compatibility"`. É recusado no roteamento, **sem custo**.
- Para a F4: o sinal confiável é o `failed_routing_step`, não o texto da mensagem. É ele que dispara "desligar as ferramentas neste turno e refazer".
- Fixture: `error-404-tools-unsupported.json`.

### 1.5 Embeddings (D-3, D-4)

- `POST /api/v1/embeddings` com `model: "openai/text-embedding-3-small"`, `input` string ou array. Resposta: `data[].{object: "embedding", index, embedding}`, **1536 dimensões** (conferido), `usage.{prompt_tokens, total_tokens, cost}`, `provider: "OpenAI"`. D-3 confirmada.
- Fixture: `embeddings.json` (vetores completos).

### 1.6 Privacidade (D-5) e atribuição

- **Preferência: `provider: { "data_collection": "deny" }`** (valores `"allow"`, que é o padrão, ou `"deny"`). É a que exclui provedores que podem guardar dados. Conferido de verdade: com `deny`, 3 de 4 modelos gratuitos testados foram recusados com **HTTP 404** "No endpoints found matching your data policy (Free model training)", `failed_routing_step: "Filter by Data Policy"` (`error-404-data-policy.json`). Nos modelos pagos testados o `deny` foi aceito e roteou normalmente (Haiku, gpt-4.1-nano, deepseek).
- Existe uma opção mais restritiva, `provider: { "zdr": true }` (só endpoints com retenção zero). Também aceita nos testes. Fica registrada; **a D-5 usa `data_collection`**, que é o que a decisão descreve.
- Valor inválido (`"banana"`) devolve **400** com mensagem de validação (`error-400-invalid-provider-option.json`).
- **Atribuição**: `HTTP-Referer` (URL do app) e **`X-OpenRouter-Title`** (nome do app; a doc diz que `X-Title` ainda é aceito). Conferido em `GET /api/v1/generation?id=`: o `HTTP-Referer` enviado aparece em `origin` e a geração ganha um `app_id`. O título não aparece nesse retorno; não deu para conferir onde ele é exibido.

### 1.7 Catálogo de modelos e modelo padrão (D-2)

- `GET https://openrouter.ai/api/v1/models`: **público, sem chave**, cerca de 900 KB, `{ data, total_count, links }`, 477 modelos em 2026-11-26. Campos para a rota `GET /api/ai/models` da F1:
  - `id` (`fornecedor/modelo`);
  - `name`;
  - `context_length`;
  - **suporte a ferramentas = `supported_parameters` contém `"tools"`**;
  - também úteis: `pricing.{prompt, completion}` (USD por token, em string), `architecture.output_modalities`, `expiration_date`, `reasoning.{mandatory, default_effort}`.
- O catálogo inclui variantes `:free` e `:batch` do mesmo modelo. A busca da tela deve mostrar as duas como estão (D-2: sugestão, não lista permitida).
- Detalhe por modelo: `GET /api/v1/models/{id}/endpoints` (lista de provedores). Não traz a política de dados de cada endpoint.
- Amostra: `models-catalog-sample.json`.

**Comparação (mesma pergunta em português, sem base e depois com ferramenta):**

| Modelo                                     | USD/M entrada / saída | Sem base (alucinação?)                                         | Tool calling                                                       | Uso do resultado da ferramenta           |
| ------------------------------------------ | --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `anthropic/claude-haiku-5.5`               | 0,10 / 0,50           | **Não inventou**: disse que não tinha o dado e ofereceu humano | 2 chamadas paralelas, consultas boas; estável em 3 de 3 repetições | Correto (R$ 129,00; 7 dias corridos)     |
| `openai/gpt-4.1-nano`                      | 0,10 / 0,40           | Inventou preço (R$ 150)                                        | 2 chamadas paralelas; estável em 3 de 3                            | Correto                                  |
| `deepseek/deepseek-v4-flash`               | 0,09 / 0,18           | Inventou preço (R$ 97,90)                                      | 2 paralelas, com texto junto                                       | Correto, mais prolixo                    |
| `mistralai/mistral-small-3.2-24b-instruct` | 0,075 / 0,20          | Inventou preço (R$ 99,90)                                      | 1 chamada                                                          | **Errado**: manteve o R$ 99,90 inventado |
| `google/gemini-2.5-flash-lite`             | 0,10 / 0,40           | Inventou preço (R$ 99,90)                                      | 1 chamada                                                          | **502 em 3 de 3** (resposta vazia)       |

**Modelo padrão definido: `anthropic/claude-haiku-5.5`.** É barato, aceita ferramentas, tem contexto de 1M, escreve bem em português e foi o único que não inventou fato sem base, que é o comportamento certo para um agente de atendimento com RAG. Custos a saber:

- o Haiku usa mais tokens de entrada com `tools` (597 contra 144 do gpt-4.1-nano, porque o formato da Anthropic acrescenta instruções de ferramenta);
- o catálogo diz `reasoning.default_effort: "medium"`, e a chamada sem parâmetro gastou 95 tokens de raciocínio. Com `reasoning: { "enabled": false }` (ou `effort: "none"`) caiu a 0 (`chat-completion-reasoning-off.json`).

Se a F1 deve mandar o raciocínio desligado é escolha de implementação, a anotar lá; o identificador não muda. O `gpt-4.1-nano` é a alternativa mais barata, mas inventou preço e é de 2025-04.

### 1.8 Erros

| Caso                                 | HTTP    | Corpo (resumo)                                                                                                                                | Fixture                                  |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Sem crédito para o pedido            | **402** | `error.code: 402`, "This request requires more credits, or fewer max_tokens…", `metadata.limit_source: "openrouter_key_limit"`, `remedy_hint` | `error-402-insufficient-credits.json`    |
| Modelo sem ferramentas               | 404     | `failed_routing_step: "Filter by Tool Compatibility"`                                                                                         | `error-404-tools-unsupported.json`       |
| Privacidade sem endpoint compatível  | 404     | `failed_routing_step: "Filter by Data Policy"`                                                                                                | `error-404-data-policy.json`             |
| Modelo inexistente                   | **400** | "… is not a valid model ID"                                                                                                                   | `error-400-invalid-model.json`           |
| Opção de provedor inválida           | 400     | "provider.data_collection: Invalid option…"                                                                                                   | `error-400-invalid-provider-option.json` |
| Chave inválida                       | 401     | "User not found."                                                                                                                             | `error-401-invalid-key.json`             |
| Provedor devolveu vazio              | 502     | "Provider returned an empty response", `metadata.provider_name`                                                                               | `error-502-empty-response.json`          |
| Limite do provedor (pool partilhado) | 429     | "Provider returned error", `metadata.limit_source: "upstream_provider_shared_pool"`, `remedy_hint`                                            | `error-429-upstream-rate-limit.json`     |

- **Validação da chave sem gastar crédito**: `GET /api/v1/key` responde 200 com o limite e o saldo da chave e 401 com chave inválida (`key-info.json`). É o candidato para `validateAiCredentials` do OpenRouter na F1, no lugar de uma chamada de chat.
- O 402 foi provocado pedindo `max_tokens: 100000` num modelo caro: o OpenRouter estima o custo **antes** de gerar e recusa sem cobrar. Como a chave tinha limite, a causa veio como `openrouter_key_limit`. Com saldo de conta zerado o código também é 402 (doc), mas com outro `limit_source`, que não foi medido. O mapeamento `402 → insufficient_credits` do §5.1 vale para os dois.

### 1.9 Onde a doc e a realidade divergem (ou a doc não diz)

1. **Modelo inexistente dá 400**, não 404. Só 404 indica falha de roteamento (ferramentas ou privacidade), distinguida por `metadata.failed_routing_step`.
2. **O corpo dos erros 402 e 429 traz `user_id`** (identificador da conta OpenRouter do dono da chave) e o 402 traz o hash da chave numa URL. A F1 **não pode gravar o corpo cru** em log nem em `ai_usage_log`: só `code`, `limit_source` e `failed_routing_step`.
3. **Embeddings respondem `model: "text-embedding-3-small"` sem o prefixo `openai/`.** A D-4 deve gravar em `embedding_model` o identificador **pedido**, não o ecoado, senão o filtro por modelo falha.
4. **`dimensions` é respeitado** em embeddings (pedido 512, veio 512). O adaptador nunca deve mandar esse campo: a coluna é `vector(1536)`.
5. O catálogo diz que `google/gemini-2.5-flash-lite` aceita ferramentas, mas o passo com resultado de ferramenta falhou com 502 em 3 de 3 tentativas. Aceitar ferramentas no catálogo não garante o laço completo, e é por isso que existe o "Testar ferramentas" do §5.3.
6. O catálogo de chat (`/api/v1/models`) **não lista modelos de embedding**: eles ficam em `GET /api/v1/embeddings/models` (40 modelos).
7. A generation API mostra o `HTTP-Referer` em `origin` e deixa `http_referer: null`. O título (`X-OpenRouter-Title`) não aparece lá.
8. `GET /api/v1/models/{id}/endpoints` não expõe a política de dados de cada provedor: não dá para mostrar na tela, antes da chamada, quais modelos sobram com o filtro de privacidade ligado.

---

## 2. Extração de PDF e DOCX (D-7)

Teste em pasta temporária fora do repositório, Node 24.22.2 local. A imagem de produção é `node:22-bookworm-slim` (`Dockerfile`), e as duas recomendadas não exigem versão de Node acima disso. Arquivos de teste gerados para a medição, com acentos, título, lista e tabela: PDF de 55 KB impresso pelo Edge headless (fonte TrueType embutida, como um PDF comum) e DOCX de 10 KB gerado pelo pacote `docx`.

| Biblioteca     | Versão | Licença      | Instalada                  | Binário nativo                                                                | Manutenção (npm)  | Resultado                                                                                                                                    |
| -------------- | ------ | ------------ | -------------------------- | ----------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **`unpdf`**    | 2.2.3  | MIT          | **3,5 MB, 0 dependências** | **Não** (pdf.js serverless embutido; `@napi-rs/canvas` só como peer opcional) | 2026-11-26 (UnJS) | PDF: texto completo, acentos corretos, ordem de leitura certa, 104 ms                                                                        |
| `pdf-parse`    | 2.4.5  | Apache-2.0   | 92 MB                      | **Sim**: depende de `@napi-rs/canvas` (`canvas-win32-x64-msvc` instalado)     | 2025-10           | PDF: igual ao `unpdf`, com tabulações na tabela e rodapé "-- 1 of 1 --"                                                                      |
| `officeparser` | 8.9.0  | MIT          | 163 MB                     | Sim (`@napi-rs/canvas`) e `tesseract.js`                                      | 2026-11           | Descartada pelo tamanho e pelo binário antes de medir a qualidade                                                                            |
| **`mammoth`**  | 1.13.0 | BSD-2-Clause | 7 MB, 24 pacotes JS puro   | **Não**                                                                       | 2026-09           | DOCX: acentos corretos, 49 ms. `extractRawText` achata a tabela (uma célula por parágrafo); `convertToHtml` preserva títulos, lista e tabela |

**Recomendação: `unpdf` para PDF e `mammoth` para DOCX.** As duas são JS puro, pequenas, com licença permissiva e mantidas em 2026, e extraíram português sem perda. Para a F2:

- No DOCX, usar `mammoth.convertToHtml` e passar o HTML pelo mesmo conversor HTML→texto do `extract-url.ts`: um caminho só, e os títulos viram o `heading` das fatias da D-12.
- **Não testado** e a conferir na F2:
  - `npm run build` do Next 16 com as duas, para confirmar que o bundler aceita o `unpdf` sem entrar em `serverExternalPackages`;
  - PDF digitalizado, só imagem: o esperado é texto vazio, e o documento deve ir para `error` com motivo claro, sem OCR;
  - PDF com senha;
  - arquivo perto do limite de 10 MB.

---

## 3. Catálogo vivo de `ai_enabled` no `vn` (D-20)

Lido em 2026-11-26, só com SELECT, depois de `get_project_url` devolver `awylbfsywsrnkztvovud`.

**Planos** (`plans.features ->> 'ai_enabled'`):

| `code`                 | Nome                 | Ativo | Público | `ai_enabled` | Contas |
| ---------------------- | -------------------- | ----- | ------- | ------------ | ------ |
| `free`                 | Grátis               | sim   | sim     | `true`       | 3      |
| `essential`            | Essencial            | sim   | sim     | `false`      | 0      |
| `professional`         | Profissional         | sim   | sim     | `true`       | 0      |
| `unlimited`            | Inicial              | não   | não     | **ausente**  | 1      |
| `vn_personal`          | VN Personal          | sim   | não     | **ausente**  | 1      |
| `valen_ranch_personal` | Valen Ranch Personal | sim   | não     | `true`       | 1      |

**Contas** (6 no total, todas com `account_plans`):

- **nenhum `limit_overrides` tem `ai_enabled`**;
- **`ai_configs`: 0 linhas**, então nenhuma conta tem IA configurada nem ativa hoje. `ai_usage_log` e `ai_knowledge_documents` também estão vazias;
- `platform_settings.quotas_enforced = true`.

**Efeito do modo estrito, medido**: `plan_feature_strict(conta, 'ai_enabled')` já devolve **`false` para 2 contas**, a do plano `unlimited` e a do `vn_personal`. O `plan_feature` antigo, não estrito, devolve `true` para as 6. Se o código da F1 entrasse sem o dado, essas duas contas perderiam a IA. Nenhuma das duas usa IA hoje.

**Funções e extensões:**

- `plan_feature_strict(p_account_id uuid, p_key text)` existe: `SECURITY DEFINER`, `search_path` fixo, chave ausente = `FALSE`, e `anon` e `authenticated` **sem** `EXECUTE`. Só `service_role` chama, então o portão da F1 lê com `supabaseAdmin()`, como `src/lib/forms/plan-gate.ts` já faz.
- `vector` 0.8.0 instalada (schema `public`). `unaccent` 1.1 disponível e **não instalada**, como a D-11 previa.
- Fora do escopo, registrado como achado: `pg_cron` 1.6.4 está **instalado** no `vn`, com 3 jobs (`zapcrm-broadcasts-cron`, `zapcrm-automations-cron`, `zapcrm-flows-cron`, todos `*/5 * * * *`), **todos com `active = false`**. O comando dos jobs não foi lido. Não muda a D-9, que usa o serviço `zapcrm_cron` da stack.

### 3.1 SQL de dados para o mantenedor aplicar (não executado)

No padrão já usado para `contact_portal_enabled` e `forms_enabled` (`UPDATE plans SET features = features || …`). É dado, não migração. Idempotente: só grava onde a chave falta, então rodar de novo não muda nada. Aplicar no SQL Editor do `vn` **antes** de qualquer código da F1 que leia a chave.

**Decidido pelo mantenedor (2026-11-26):** `true` nos dois planos sem a chave, `unlimited` (Inicial, inativo) incluído. Isso preserva o comportamento de hoje: ninguém perde IA quando o portão estrito entrar.

```sql
-- SPEC 089 F0 / D-20: dado de ai_enabled antes do portão estrito da F1.
-- vn (awylbfsywsrnkztvovud). Idempotente: só grava onde a chave falta.
BEGIN;

-- 1) Todo plano ganha ai_enabled explícito. Em 2026-11-26 afeta 2 planos:
--    unlimited (Inicial, inativo, 1 conta) e vn_personal (1 conta).
UPDATE public.plans
   SET features   = COALESCE(features, '{}'::jsonb) || '{"ai_enabled": true}'::jsonb,
       updated_at = now()
 WHERE NOT (COALESCE(features, '{}'::jsonb) ? 'ai_enabled');

-- 2) Conta com IA ativa cujo plano não libera IA ganha a exceção por conta.
--    Em 2026-11-26 afeta 0 linhas (ai_configs vazia); fica como guarda
--    para alguma conta que configure IA antes da F1.
UPDATE public.account_plans ap
   SET limit_overrides = COALESCE(ap.limit_overrides, '{}'::jsonb) || '{"ai_enabled": true}'::jsonb,
       updated_at      = now()
  FROM public.plans p, public.ai_configs ac
 WHERE p.id = ap.plan_id
   AND ac.account_id = ap.account_id
   AND ac.is_active
   AND NOT (COALESCE(ap.limit_overrides, '{}'::jsonb) ? 'ai_enabled')
   AND COALESCE((p.features ->> 'ai_enabled')::boolean, FALSE) = FALSE;

COMMIT;

-- 3) Conferência (rodar depois do COMMIT): todo plano com a chave e
--    nenhuma conta com IA ativa bloqueada pelo modo estrito.
SELECT code, features ->> 'ai_enabled' AS ai_enabled
  FROM public.plans
 ORDER BY sort_order;

SELECT ap.account_id,
       p.code,
       public.plan_feature_strict(ap.account_id, 'ai_enabled') AS ai_estrito,
       ac.is_active AS ia_ativa
  FROM public.account_plans ap
  JOIN public.plans p ON p.id = ap.plan_id
  LEFT JOIN public.ai_configs ac ON ac.account_id = ap.account_id
 ORDER BY p.code;
```

Esperado depois do passo 1: `ai_estrito = true` nas **6** contas (3 do `free`, 1 do `valen_ranch_personal` e as 2 dos planos corrigidos). Hoje o `essential` (`false`) não tem conta.

Os seeds de `supabase/setup/plans-seed*.sql` já gravam `ai_enabled` explícito nos planos que criam (`free`, `essential`, `professional`, `enterprise`). Os planos `unlimited`, `vn_personal` e `valen_ranch_personal` não estão nos seeds. O dado vivo também já difere do `plans-seed-vn.sql`: o seed grava `free` com `ai_enabled: false`, e no `vn` o plano está `true` (editado pelo painel, presume-se). O catálogo vivo é a referência; o seed não foi alterado.

---

## 4. O que fica para o mantenedor

1. **Aplicar o SQL do §3.1** no SQL Editor do `vn`, antes da F1 (valor `true` em todos os planos sem a chave, decidido em 2026-11-26).
2. **Revogar a chave do OpenRouter** usada na F0 (gasto de US$ 0,0016 de US$ 2,50).
3. Confirmar o modelo padrão `anthropic/claude-haiku-5.5` (D-2). O valor saiu da medição, mas a palavra final é sua.
4. Achado fora do escopo: `pg_cron` instalado no `vn` com 3 jobs inativos (§3).
