# SPEC 089 — Agentes de IA: OpenRouter, base de conhecimento ampliada, execução de ações e ajuste do agente

| Campo            | Valor                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | **Proposta, com D-19 ratificada** — treinar modelo (fine-tuning) fica fora, por decisão do mantenedor em 2026-11-26. D-1…D-18 e D-20 aguardam ratificação. Nada implementado.                                                          |
| Data             | 2026-11-26                                                                                                                                                                                                                             |
| Escopo           | `src/lib/ai/` (provedores, recuperação, motor de ferramentas, ajuste), `src/app/api/ai/**`, página `/agents`, `src/components/agents/`, `src/components/settings/ai-*.tsx`                                                             |
| Depende de       | Migrações 029–033 (IA), SPEC 049 (capacidades de canal), SPEC 075 (registro de atividade). Conversa com a SPEC 086 (I-14 e I-15, ainda não implementadas)                                                                              |
| SPECs irmãs      | [SPEC 090](./spec-090-api-publica-e-mcp-gestao-de-recursos.md) (API pública e MCP gerenciam o agente e os demais recursos) e [SPEC 091](./spec-091-assistente-da-plataforma-e-mcp-do-proprietario.md) (assistente do SaaS no `/admin`) |
| Migração         | Provisórias **102** (provedores + base de conhecimento), **103** (ferramentas + auditoria) e **104** (ajuste do agente). Conferir `ls supabase/migrations/` e [`status.md`](./context/status.md) antes de criar                        |
| Dependências npm | A definir na F0: extrator de PDF e de DOCX (D-7). Nenhum SDK de provedor: os adaptadores continuam em `fetch`                                                                                                                          |
| i18n             | Chaves novas em `Agents.*` e `Activity.actions.ai.*`, nos dois dicionários                                                                                                                                                             |

---

## 1. Contexto

O gerenciador de **Agentes de IA** (`/agents`) hoje é um assistente de resposta com chave própria da conta (BYO): redige rascunho para o atendente e responde sozinho no WhatsApp até entregar a conversa a um humano. Ele só sabe **falar**: não consulta nada além de uma base de conhecimento colada à mão e não executa nenhuma ação no CRM.

O pedido é levar o agente ao tripé **RAG + Fine-tuning + Tool Calling**, incluir o **OpenRouter** como provedor e preparar o terreno para que o MCP do sistema trabalhe junto com o agente.

## 2. Objetivo

1. **OpenRouter** como terceiro provedor de chat (e de embeddings, com uma chave só).
2. **Base de conhecimento ampliada**: novas fontes (arquivo, URL, perguntas e respostas), estado de indexação, recuperação híbrida de verdade, busca em português, fontes citadas e tela de teste de recuperação.
3. **Execução de ações (tool calling)**: o agente consulta e altera o CRM por um catálogo de ferramentas com permissão por conta, limite de passos e auditoria.
4. **Ajuste do agente** no lugar do treinamento de modelo: treinar modelo **fica fora** (D-19, ratificada em 2026-11-26; estudo de viabilidade no §7); a terceira perna do tripé é entregue por versões de prompt, exemplos dinâmicos, captura de correções humanas, avaliação e exportação de dataset.
5. **Um só ponto de montagem do turno** (`src/lib/ai/compose.ts`), usado por auto-reply, rascunho, playground, avaliação e pela API pública da SPEC 090.

### Não-objetivos

- **Vários agentes por conta** (um por canal, por fila ou por horário). `ai_configs` continua com uma linha por conta. Fica como pendência P-1.
- **Treinar ou hospedar modelo (fine-tuning).** Fora por decisão ratificada em 2026-11-26 (D-19, §7). Nenhuma fase desta SPEC cria job de treino, tela de treino nem integração com API de fine-tuning.
- **Embeddings com dimensão diferente de 1536.** A coluna `vector(1536)` e o índice HNSW não mudam.
- **Ferramenta que envia mensagem para outro contato**, que dispara campanha ou que apaga dado. O agente age só sobre o contato da conversa em que está.
- **Voz, imagem e leitura de mídia recebida.** O contexto segue só com mensagens de texto (regra 7 de [`ia-agentes.md`](./context/ia-agentes.md)).
- **Reescrita de consulta por LLM e reordenação (rerank) por modelo.** Custam uma chamada a mais por mensagem; ficam para depois de medir a F3.
- **Gestão do agente pela API pública e pelo MCP**: é a SPEC 090.
- **Assistente do proprietário do SaaS**: é a SPEC 091.

---

## 3. Estado de partida (medido em 2026-11-26)

| Fato                                                                                                                                                                                                                                 | Onde                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `AiProvider = 'openai' \| 'anthropic'`; `generateReply` despacha por `switch` para dois adaptadores em `fetch`                                                                                                                       | `src/lib/ai/types.ts`, `generate.ts`, `providers/`                  |
| `ai_configs`: **uma linha por conta** (`account_id UNIQUE`), `provider` com `CHECK IN ('openai','anthropic')`; a rota `POST /api/ai/config` repete a mesma validação                                                                 | migração 029, `src/app/api/ai/config/route.ts` L88                  |
| `ai_usage_log.provider` tem o mesmo `CHECK`; `mode IN ('auto_reply','draft')`; o playground grava como `draft`                                                                                                                       | migração 033                                                        |
| Adaptadores devolvem só `{ text, usage }`. Não há `tools`, `tool_calls` nem laço de passos                                                                                                                                           | `providers/shared.ts` (`ProviderArgs`), `openai.ts`, `anthropic.ts` |
| Handoff por sentinela de texto `[[HANDOFF]]`, removida em `parseGeneration`                                                                                                                                                          | `defaults.ts`, `generate.ts`                                        |
| Base de conhecimento: documento = `title` + `content` colado; sem arquivo, URL, estado, etiqueta nem interruptor                                                                                                                     | migração 030, `src/components/settings/ai-knowledge.tsx`            |
| Fatiamento por parágrafo, 1.200 caracteres, sem sobreposição e sem título da seção                                                                                                                                                   | `chunk.ts`                                                          |
| Embeddings fixos: OpenAI `text-embedding-3-small`, 1536 dimensões, URL fixa `api.openai.com`                                                                                                                                         | `embeddings.ts`                                                     |
| Recuperação: semântica primeiro (se houver chave), depois **completa** com léxica até `k = 5`. Sem fusão de ranking, sem limiar de distância: os 5 mais próximos entram no prompt mesmo quando nada é relevante                      | `knowledge.ts` (`retrieveKnowledge`)                                |
| Busca léxica com configuração `'simple'` (sem radical nem stopword de português) e `plainto_tsquery` (todos os termos precisam casar)                                                                                                | migração 030 (`match_ai_knowledge_fts`)                             |
| Consulta = só a última mensagem do cliente                                                                                                                                                                                           | `query.ts` (`latestUserMessage`)                                    |
| Indexação é síncrona dentro da rota; documento grande segura a requisição                                                                                                                                                            | `src/app/api/ai/knowledge/route.ts`                                 |
| O prompt é montado em **dois lugares** (auto-reply e rascunho), já apontado pela SPEC 086 §2                                                                                                                                         | `auto-reply.ts`, `src/app/api/ai/draft/route.ts`                    |
| No auto-reply, a vaga (`claim_ai_reply_slot`) é reivindicada **depois** de gerar o texto                                                                                                                                             | `auto-reply.ts` L198                                                |
| `ai_enabled` existe em `FEATURE_KEYS`, mas **nenhum código o lê**: `grep` em `src/` só acha `plans/types.ts` e `catalog.test.ts`. O mesmo vale para `api_v1_enabled`, `flows_enabled`, `broadcasts_enabled` e `webhooks_out_enabled` | `src/lib/plans/types.ts` L85–90                                     |
| SPEC 086 I-14 (`leadProfile`) e I-15 (`[[FORM:slug]]`) **não estão no código** (`grep leadProfile` vazio)                                                                                                                            | `src/lib/ai/`                                                       |
| `/agents` tem três abas: Playground, Configuração e Uso                                                                                                                                                                              | `src/app/(dashboard)/agents/page.tsx`                               |
| Limites: `MAX_OUTPUT_TOKENS = 1024`, 20 mensagens de contexto, timeout de 30 s, `aiAutoReplyAccount` 30/min                                                                                                                          | `defaults.ts`, `src/lib/rate-limit.ts`                              |

---

## 4. Decisões

Em estado **Proposta**, exceto a **D-19, ratificada pelo mantenedor em 2026-11-26**. A coluna "Recomendação" é a posição desta SPEC.

| #    | Decisão                                                                                                                                                                                                                                                                                                                               | Recomendação e motivo                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | **OpenRouter entra como provedor `openrouter`**, pelo endpoint compatível com OpenAI (`/api/v1/chat/completions`). `openai.ts` vira um adaptador genérico `openai-compatible.ts` (URL base + cabeçalhos extras) e os dois provedores passam por ele.                                                                                  | Um adaptador, dois provedores: menos código e o tool calling da F4 serve aos dois de uma vez.                                                                           |
| D-2  | **Modelo continua texto livre** (regra 8). Para o OpenRouter a tela ganha busca sobre o catálogo público de modelos, como sugestão, nunca como lista permitida. O modelo padrão do OpenRouter é definido na F0 com o identificador conferido no catálogo.                                                                             | Identificadores do OpenRouter têm o formato `fornecedor/modelo` e mudam rápido.                                                                                         |
| D-3  | **Embeddings pelo OpenRouter**: coluna nova `embeddings_provider` (`openai` \| `openrouter`). Com `provider = openrouter` e sem chave de embeddings própria, a **chave do chat é reaproveitada**. O modelo continua `text-embedding-3-small` (no OpenRouter, `openai/text-embedding-3-small`, 1536 dimensões).                        | Conta no OpenRouter configura a IA com uma chave só. A doc do OpenRouter confirma o endpoint `/api/v1/embeddings` com esse modelo e dimensão (ver §11).                 |
| D-4  | **Cada fatia grava o modelo de embedding** (`embedding_model`). Trocar de provedor de embeddings não mistura vetores: a busca semântica filtra pelo modelo atual e a tela pede reindexação quando há fatias de outro modelo.                                                                                                          | Vetores de modelos diferentes não são comparáveis, e o erro seria silencioso.                                                                                           |
| D-5  | **Privacidade no OpenRouter**: a requisição pede que o roteamento exclua provedores que retêm dados para treino (preferência de provedor do OpenRouter, nome exato conferido na F0) e a tela mostra um aviso de que a conversa passa por terceiros. O interruptor fica em `provider_options` e nasce ligado.                          | A conversa do cliente final é dado pessoal (LGPD); o padrão tem de ser o mais restritivo.                                                                               |
| D-6  | **Custo no uso**: `ai_usage_log` ganha `cost_usd` (nulo quando o provedor não informa). O painel de uso mostra custo quando existir.                                                                                                                                                                                                  | O OpenRouter devolve o custo da chamada; OpenAI e Anthropic não. Campo a conferir na F0.                                                                                |
| D-7  | **Novas fontes da base**: arquivo (PDF, DOCX, TXT, MD, CSV), URL de uma página, e pares de pergunta e resposta. O texto é **extraído no servidor e só o texto é guardado**; o arquivo original não fica em Storage.                                                                                                                   | Sem bucket novo, sem quota de armazenamento e menos superfície de LGPD. Limites: 10 MB por arquivo e 500 mil caracteres por documento (valores a ratificar).            |
| D-8  | **Importar URL passa pela guarda de SSRF**: `isDeliverableUrl` **e** `redirect: 'manual'`, timeout de 10 s, só `text/html` e `text/plain`, corpo máximo de 2 MB.                                                                                                                                                                      | Regra do domínio [`api-publica-webhooks.md`](./context/api-publica-webhooks.md): `fetch` para URL vinda de usuário usa os dois.                                         |
| D-9  | **Indexação fora da requisição**: o documento nasce `pending`, a rota responde, e a indexação roda em `after()`. Estados: `pending`, `indexing`, `ready`, `error`. `indexing` há mais de 10 minutos é mostrado como falha, com botão de reindexar. Sem fase nova de cron.                                                             | Arquivo grande não pode segurar a requisição; e nenhum agendador novo para operar.                                                                                      |
| D-10 | **Recuperação híbrida por fusão de ranking (RRF)** numa RPC nova, `match_ai_knowledge_hybrid`, com **limiar de distância**: fatia semântica acima do limiar e sem casamento léxico não entra no prompt. As RPCs antigas ficam até a F3 ser validada.                                                                                  | Hoje os 5 vizinhos mais próximos entram sempre, mesmo irrelevantes, e viram alucinação com cara de fonte.                                                               |
| D-11 | **Busca léxica em português**: coluna gerada `fts_pt` (`portuguese` + `unaccent`) ao lado da `fts` atual (`simple`); a consulta usa `websearch_to_tsquery` e casa em qualquer uma das duas.                                                                                                                                           | Contas sem chave de embeddings dependem só da léxica, e em `simple` "preços" não acha "preço".                                                                          |
| D-12 | **Fatiamento com contexto**: sobreposição de 150 caracteres, o título da seção (cabeçalho Markdown ou título do documento) é prefixado a cada fatia, e um par de pergunta e resposta nunca é partido. `chunkText` continua pura e determinística.                                                                                     | Fatia sem título perde o assunto ("o prazo é de 7 dias": prazo de quê?).                                                                                                |
| D-13 | **Consulta = últimas mensagens do cliente** (até 3, limitadas a 600 caracteres), não só a última.                                                                                                                                                                                                                                     | "E quanto custa?" sozinho não recupera nada. Não custa chamada extra de LLM.                                                                                            |
| D-14 | **Fontes rastreáveis**: a recuperação devolve `{ chunkId, documentId, title, score }`. O playground mostra as fontes usadas; `ai_usage_log` guarda os `knowledge_document_ids`. O texto enviado ao cliente **não** leva citação.                                                                                                      | Dá para ver qual documento responde o quê e qual nunca é usado.                                                                                                         |
| D-15 | **Motor de ferramentas próprio e neutro** (`src/lib/ai/agent-loop.ts`), sem SDK: tipos internos de mensagem com chamada e resultado de ferramenta, traduzidos por adaptador (formato `tools`/`tool_calls` no compatível com OpenAI; `tool_use`/`tool_result` no Anthropic). Limites: **4 passos** por resposta e prazo total de 60 s. | Mantém o padrão do módulo (adaptador isolado, erro tipado) e dá ao provedor novo o mesmo motor.                                                                         |
| D-16 | **A ferramenta está presa à conversa.** O contexto (`accountId`, `conversationId`, `contactId`) vem do motor; o modelo **nunca** informa identificador de conta ou de contato. Toda ferramenta nasce **desligada**; o admin liga uma a uma e define as listas permitidas (etiquetas, funis, campos).                                  | A mensagem do cliente é conteúdo não confiável: uma injeção de prompt não pode alcançar outro contato nem outra conta.                                                  |
| D-17 | **Com ferramentas ligadas, a vaga é reivindicada antes do laço** (`claim_ai_reply_slot` sobe para antes de `generate`). Se o turno terminar em handoff, a vaga fica gasta.                                                                                                                                                            | Hoje a vaga vem depois do texto. Com ação que escreve, perder a corrida deixaria efeito colateral sem resposta enviada. Preferimos responder de menos.                  |
| D-18 | **Rascunho e playground não escrevem.** No rascunho (humano no circuito) só ferramentas de leitura. No playground as de escrita rodam em **simulação**: mostram o que seria chamado e com quais argumentos.                                                                                                                           | Testar o agente não pode alterar contato real.                                                                                                                          |
| D-19 | **Ratificada (mantenedor, 2026-11-26): treinar modelo (fine-tuning) fica fora.** No lugar, a perna do tripé passa a ser o **ajuste do agente** (§7.2), cujas peças seguem como proposta da F7. O sistema continua aceitando o identificador de um modelo já treinado no campo de modelo.                                              | Estudo de viabilidade no §7.1.                                                                                                                                          |
| D-20 | **`ai_enabled` passa a valer**, com semântica **não estrita** (chave ausente = permitido) e só depois de conferir o catálogo vivo do `vn`. Quotas novas de plano: `knowledge_documents` e `ai_tool_calls_month`, ausentes = ilimitado.                                                                                                | A chave existe desde a 067 e nunca bloqueou nada; ligá-la em modo estrito desligaria a IA de quem já usa. O banco decide a quota (regra 1 de `planos-quotas-admin.md`). |

Decisões em aberto, sem recomendação fechada, estão no §12.

---

## 5. Desenho

### 5.1 Provedores (F1)

```text
src/lib/ai/providers/
  openai-compatible.ts   generateOpenAiCompatible({ baseUrl, headers, ...ProviderArgs })
  openai.ts              embrulha o genérico com api.openai.com
  openrouter.ts          embrulha o genérico com openrouter.ai/api/v1 + cabeçalhos de atribuição
  anthropic.ts           inalterado até a F4
  shared.ts              providerHttpError ganha 402 → code 'insufficient_credits'
```

- `AiProvider` ganha `'openrouter'`; `AI_PROVIDER_DEFAULT_MODEL` ganha a entrada (D-2). O `switch` de `generateReply` continua exaustivo: o TypeScript acusa provedor esquecido.
- `embeddings.ts`: `embedTexts(target, inputs)` recebe `{ provider, apiKey }` no lugar da chave solta; a URL e o nome do modelo saem de uma tabela por provedor.
- Rota `POST /api/ai/config`: aceita `openrouter`, valida a chave com `validateAiCredentials` como hoje e continua **sem devolver chave** (regra 1).
- Rota nova `GET /api/ai/models?provider=openrouter&q=`: proxy com cache de 1 h do catálogo público do OpenRouter, devolvendo `id`, nome, contexto e se o modelo aceita ferramentas. Host fixo, `redirect: 'manual'`.
- Migração 102: troca os dois `CHECK` de provedor (`ai_configs` e `ai_usage_log`), adiciona `embeddings_provider`, `provider_options jsonb`, `cost_usd`.
- **Versões de prompt** entram já aqui, por serem baratas e pré-requisito da SPEC 090: tabela `ai_prompt_versions` (`account_id`, `system_prompt`, `note`, `source` `panel` \| `api`, `created_by`, `created_at`). Todo salvamento que muda `system_prompt` grava uma versão; a tela lista, compara e restaura.

### 5.2 Base de conhecimento (F2 e F3)

Colunas novas (migração 102):

| Tabela                   | Colunas                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai_knowledge_documents` | `source_type` (`text` \| `file` \| `url` \| `faq`), `source_name`, `source_url`, `mime_type`, `status`, `index_error`, `chunk_count`, `char_count`, `content_hash`, `is_enabled`, `tags text[]`, `indexed_at` |
| `ai_knowledge_chunks`    | `heading`, `embedding_model`, `fts_pt` (gerada)                                                                                                                                                               |

- **Ingestão** (`src/lib/ai/ingest/`): `extract-file.ts` (por tipo MIME, biblioteca da F0), `extract-url.ts` (guarda de SSRF, remove navegação e scripts, fica com o texto principal), `faq.ts` (um par por fatia). Todos devolvem texto puro para o mesmo `ingestDocument`.
- **Idempotência**: `content_hash` igual ao gravado = não reindexa.
- **Interruptor por documento**: `is_enabled = false` tira o documento da recuperação sem apagar.
- **RPC `match_ai_knowledge_hybrid`** (`p_account_id`, `p_query`, `p_query_embedding` texto ou nulo, `p_embedding_model`, `p_match_count`, `p_max_distance`): duas CTEs (semântica e léxica), fusão `1 / (60 + posição)`, junta o título do documento. `SECURITY DEFINER` com `search_path` fixo, checagem de vínculo com a conta para quem não é `service_role`, `REVOKE ALL … FROM PUBLIC` **e** `FROM anon`, como manda [`supabase-rls-mcp.md`](./context/supabase-rls-mcp.md). Depois do DDL, `get_advisors` (security) no `vn`.
- **Tela "Testar recuperação"** na aba Conhecimento: o admin digita uma pergunta e vê as fatias ranqueadas, com pontuação, origem (semântica, léxica ou ambas) e documento. Não chama o LLM. Rota `POST /api/ai/knowledge/search`.
- **Recuperação continua melhor esforço** (regra 9): qualquer falha devolve menos resultados e nunca impede a resposta.

### 5.3 Execução de ações (F4 a F6)

```text
src/lib/ai/
  compose.ts        composeAgentTurn(): prompt + conhecimento + exemplos + perfil do lead + ferramentas
  agent-loop.ts     runAgentTurn({ config, system, messages, tools, ctx, limits })
  tools/
    registry.ts     catálogo: { key, description, inputSchema, risk, handler }
    knowledge.ts    search_knowledge
    contact.ts      get_contact_profile, update_contact_fields, add_contact_tags, remove_contact_tags
    deals.ts        list_contact_deals, create_deal, move_deal_stage
    notes.ts        add_internal_note
    handoff.ts      handoff_to_human
    forms.ts        send_form_link            (depende da SPEC 086 e de FORM_LINK_SECRET)
    http.ts         ferramentas HTTP definidas pela conta (F6)
```

Contrato de uma ferramenta:

```ts
interface AgentTool<I> {
  key: string; // estável, snake_case, em inglês
  description: string; // em inglês, é lida pelo modelo
  inputSchema: JsonSchema; // sem account_id, contact_id nem conversation_id
  risk: 'read' | 'write';
  handler(ctx: ToolContext, input: I): Promise<ToolResult>;
}
interface ToolContext {
  db: SupabaseClient; // service_role; todo handler filtra por accountId
  accountId: string;
  conversationId: string | null; // nulo no playground
  contactId: string | null;
  mode: 'auto_reply' | 'draft' | 'playground' | 'eval';
  dryRun: boolean; // D-18
  toolConfig: Record<string, unknown>; // listas permitidas da conta
}
```

Catálogo inicial:

| Ferramenta                                 | Risco               | O que faz                                                                | Limite definido pelo admin     |
| ------------------------------------------ | ------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| `search_knowledge`                         | leitura             | Nova busca na base com a consulta que o modelo escolher                  | nenhum                         |
| `get_contact_profile`                      | leitura             | Nome, etiquetas, campos personalizados e negócios do contato da conversa | quais campos o agente pode ver |
| `list_contact_deals`                       | leitura             | Negócios do contato e etapa de cada um                                   | quais funis                    |
| `update_contact_fields`                    | escrita             | Nome, e-mail, empresa e campos personalizados                            | lista de campos graváveis      |
| `add_contact_tags` / `remove_contact_tags` | escrita             | Etiquetas do contato                                                     | lista de etiquetas permitidas  |
| `create_deal` / `move_deal_stage`          | escrita             | Cria negócio ou muda de etapa                                            | funis e etapas permitidos      |
| `add_internal_note`                        | escrita             | Nota interna na conversa, visível só para a equipe                       | nenhum                         |
| `handoff_to_human`                         | escrita             | Entrega a conversa, com motivo e resumo escritos pelo modelo             | nenhum                         |
| `send_form_link`                           | escrita             | Inclui na resposta o link com token de um formulário publicado           | lista de formulários           |
| ferramenta HTTP (F6)                       | definida pela conta | Chama um endpoint externo (estoque, pedido, agenda)                      | URL, método, esquema e segredo |

Regras do motor:

1. **Lógica de negócio reaproveitada**: cada handler chama a função de `src/lib/` que o painel já usa (`createDeal` de `pipelines/deals.ts`, etiquetas de `tags.ts`, e assim por diante). Onde a regra hoje mora dentro de uma rota, ela é extraída para `src/lib/` com teste ao lado (trabalho compartilhado com a SPEC 090 §5.1).
2. **Resultado de ferramenta é dado, não instrução**: volta ao modelo embrulhado e truncado em 4 KB, com a mesma instrução que o scaffold já dá para a mensagem do cliente.
3. **Handoff**: com ferramentas ligadas, `handoff_to_human` é o caminho preferido e o resumo passa a ser o do modelo. A sentinela `[[HANDOFF]]` continua valendo como reserva, com o resumo determinístico de `handoff.ts`.
4. **Formulário**: `send_form_link` substitui o `[[FORM:slug]]` da SPEC 086 I-15 quando há ferramentas; sem ferramentas, vale o desenho da 086. O modelo continua sem ver link real.
5. **Modelo sem suporte a ferramentas**: erro do provedor na primeira chamada com `tools` desliga as ferramentas **naquele turno** e refaz sem elas; a tela tem "Testar ferramentas" e o catálogo do OpenRouter informa o suporte.
6. **Auditoria**: tabela `ai_tool_calls` (append-only: conta, conversa, contato, modo, ferramenta, entrada, resumo da saída, estado, duração). Escrita também vira linha do registro de atividade (SPEC 075) com `actor_kind = 'system'` e ação `ai.tool_*`.
7. **Limites**: 4 passos, 60 s, `MAX_OUTPUT_TOKENS` por passo, teto por conversa de chamadas de escrita (padrão 10) e a quota `ai_tool_calls_month` (D-20). Cada passo grava uso em `ai_usage_log` (`steps`, `tool_calls`).
8. **Os portões do auto-reply não mudam** (regra 2 de `ia-agentes.md`): conta bloqueada, automação ativa, agente atribuído, conversa em handoff, teto e limite por conta continuam antes de tudo.

Ferramenta HTTP da conta (F6): tabela `ai_custom_tools` (nome, descrição, esquema de entrada, URL, método, cabeçalhos **cifrados** com `encryption.ts`, timeout). Execução com `isDeliverableUrl`, `redirect: 'manual'`, timeout de 10 s e resposta truncada. A rota nunca devolve os cabeçalhos. Só admin cria.

### 5.4 Tela `/agents`

Abas: **Playground** · **Configuração** (provedor, modelo, prompt com versões) · **Conhecimento** (documentos, fontes, teste de recuperação) · **Ferramentas** (liga e desliga, listas permitidas, histórico de chamadas) · **Ajuste** (exemplos, correções capturadas, avaliação, exportação) · **Uso** (tokens, custo, passos). O playground passa a mostrar fontes usadas e chamadas de ferramenta simuladas. Toda string nova nos dois dicionários; `t.rich()` conferido no navegador (o `typecheck` não pega ICU).

---

## 6. Como o MCP trabalha com o agente

Três sentidos, três lugares:

| Sentido                                                                 | Onde é tratado                                                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gerenciar o agente pelo MCP** (prompt, base, ferramentas, teste)      | SPEC 090 §4.2: endpoints `/api/v1/agent/**` e toolset `agent` do servidor MCP                                                                                                    |
| **O agente usar as capacidades do CRM**                                 | Esta SPEC, §5.3: o catálogo de ferramentas roda **dentro do processo**, chamando `src/lib/`. Não passa por HTTP nem pelo servidor MCP: seria uma volta inútil e uma chave a mais |
| **O agente usar servidores MCP de terceiros** como fonte de ferramentas | Pendência P-2: conector de MCP remoto. Proposto como fase opcional depois da F6, com a mesma guarda de SSRF, lista permitida de ferramentas e resultado tratado como dado        |

O ponto comum é a **camada de serviço em `src/lib/`**: a mesma função atende o painel, a ferramenta do agente e o endpoint `/api/v1` que o MCP chama.

---

## 7. Fine-tuning: estudo de viabilidade

> **Decisão ratificada em 2026-11-26 (D-19):** o fine-tuning fica fora do ZAP CRM BR. O estudo abaixo fica como registro do motivo. Reabrir o assunto exige nova decisão do mantenedor, não só o gatilho técnico do fim desta seção.

### 7.1 Conclusão: treinar modelo não é viável hoje

| Caminho                                | Situação medida em 2026-11-26                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OpenAI**                             | A plataforma de fine-tuning **está sendo encerrada**. Organizações que nunca treinaram não criam mais jobs desde 2026-05-07; a partir de **2026-12-15 nenhuma organização cria job novo**. Só a família `gpt-4.1` era treinável, e esses modelos base saem do ar em **2027-01-14** (o `nano` em 2026-10-23). |
| **Anthropic**                          | A API direta não oferece fine-tuning. Não reconferido nesta sessão: confirmar na F0.                                                                                                                                                                                                                         |
| **OpenRouter**                         | Não tem API de treinamento. Os _Private Endpoints_ (anunciados em 2026-10-14) roteiam um modelo já treinado em outro provedor, mas são adicional do plano Enterprise e exigem que o modelo já esteja no catálogo.                                                                                            |
| **Modelo aberto com LoRA** (terceiros) | Tecnicamente possível, mas exige curadoria de centenas de exemplos por conta, custo de treino, hospedagem dedicada, reavaliar a cada troca de modelo base e base legal para usar conversa de cliente como dado de treino. Preços e ofertas não medidos nesta sessão.                                         |

Construir a funcionalidade sobre o provedor BYO principal significaria entregar algo que para de funcionar em semanas. Para uma conta típica do ZAP (pequena empresa, poucos milhares de conversas), o ganho também é duvidoso: o que se espera de um modelo treinado (tom, formato, vocabulário, conduta em casos recorrentes) se resolve com contexto bem montado, e muda no dia em que o dono edita um exemplo, sem job de treino.

### 7.2 O que entra no lugar: ajuste do agente (F7)

| Peça                      | O que é                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Versões de prompt**     | Já na F1 (§5.1): histórico, comparação e restauração.                                                                                                                                                                                                                                                   |
| **Exemplos dinâmicos**    | Tabela `ai_examples` (mensagem do cliente + resposta ideal, etiquetas, estado, embedding). A cada turno os 3 exemplos **aprovados** mais parecidos com a mensagem entram no prompt como "como este negócio responde". É o few-shot recuperado por similaridade.                                         |
| **Captura de correções**  | Quando o atendente **edita** um rascunho da IA antes de enviar, ou responde depois de um handoff, o par vira **candidato** a exemplo. Nada entra no prompt sem aprovação do admin. Dado pessoal é mascarado na captura (telefone, e-mail, CPF).                                                         |
| **Avaliação**             | `ai_eval_cases` (conversas de referência com o que se espera, inclusive "deve entregar a um humano") e `ai_eval_runs`. O admin roda o conjunto contra a configuração atual e compara lado a lado com a rodada anterior antes de trocar prompt ou modelo. Julgamento humano; juiz por LLM fica como P-3. |
| **Exportação de dataset** | Exemplos aprovados em JSONL no formato de chat, para quem quiser treinar por fora.                                                                                                                                                                                                                      |
| **Modelo já treinado**    | O campo de modelo aceita o identificador de um modelo treinado no provedor da conta. Endpoint próprio compatível com OpenAI é a pendência P-4.                                                                                                                                                          |

**Gatilho para reabrir o treinamento:** existir um provedor com fine-tuning por autosserviço, inferência sem servidor dedicado, acessível com a chave da própria conta e com modelo base de vida útil previsível. O dataset da exportação já estará pronto.

---

## 8. Segurança e LGPD

- **Chaves**: `api_key`, `embeddings_api_key` e cabeçalhos de ferramenta HTTP seguem cifrados (AES-GCM) e nunca voltam em rota nem em log.
- **Injeção de prompt**: mensagem do cliente, conteúdo de documento, página importada por URL e resultado de ferramenta são todos **dados não confiáveis**. A defesa não é o texto do prompt, é o desenho: ferramenta presa à conversa (D-16), listas permitidas, nenhuma ferramenta destrutiva, limite de passos e auditoria.
- **`service_role`**: o motor continua com `admin-client.ts`; todo handler filtra por `account_id` e recebe o contato do contexto, nunca do modelo (regra 10).
- **SSRF**: importação de URL e ferramenta HTTP usam `isDeliverableUrl` + `redirect: 'manual'`.
- **Terceiros**: OpenRouter repassa a conversa a outro provedor; aviso na tela e roteamento restritivo por padrão (D-5).
- **Exemplos e avaliação** guardam trecho de conversa: mascaramento na captura, exclusão em cascata com a conta e retenção a definir (P-5).
- **Conta bloqueada**: nenhuma chamada de LLM nem de ferramenta (primeira checagem do auto-reply, mantida).
- Revisão de segurança dedicada na F8, antes de ligar ferramentas de escrita em qualquer conta.

## 9. Fases

| Fase | Entrega                                                                                                                                                                                           | Migração | Modelo sugerido                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------ |
| F0   | Medições com chave real: chat, ferramentas, embeddings, custo e preferência de privacidade no OpenRouter; biblioteca de PDF e DOCX; catálogo vivo de `ai_enabled` no `vn`. Sem código de produção | —        | Opus 5.5                                   |
| F1   | OpenRouter (chat + embeddings + catálogo de modelos), `compose.ts`, versões de prompt, `cost_usd`                                                                                                 | 102      | Sonnet 5.5                                 |
| F2   | Base: fontes novas, estado de indexação, fatiamento com contexto, interruptor e etiquetas                                                                                                         | 102      | Sonnet 5.5                                 |
| F3   | Base: RPC híbrida, `fts_pt`, limiar, consulta com 3 mensagens, fontes, tela de teste de recuperação                                                                                               | 102      | Sonnet 5.5; RPC revisada com Opus 5.5      |
| F4   | Motor de ferramentas, adaptadores com `tools`, ferramentas de leitura, simulação no playground                                                                                                    | 103      | Opus 5.5 (motor), Sonnet 5.5 (adaptadores) |
| F5   | Ferramentas de escrita, auditoria, vaga antes do laço, aba Ferramentas, quotas                                                                                                                    | 103      | Sonnet 5.5                                 |
| F6   | Ferramenta HTTP da conta                                                                                                                                                                          | 103      | Sonnet 5.5                                 |
| F7   | Ajuste do agente: exemplos, captura, avaliação, exportação                                                                                                                                        | 104      | Sonnet 5.5                                 |
| F8   | Revisão de segurança, roteiro manual, atualização de `ia-agentes.md`, da rule e do `status.md`                                                                                                    | —        | Opus 5.5                                   |

Uma fase por sessão, com `/code-review high` ao fim de cada uma. F1 a F3 são independentes de F4 a F6: dá para entregar OpenRouter e base nova antes de qualquer ferramenta. Antes de aplicar cada migração no `vn`, confirmar com o mantenedor.

## 10. Testes

- **Unitários, ao lado do módulo**: adaptador genérico (OpenAI e OpenRouter com `fetch` simulado, inclusive 402), tradução de ferramentas nos dois formatos, `agent-loop` (limite de passos, prazo, erro de ferramenta, modelo sem suporte), cada handler (lista permitida, simulação, recusa fora do contexto), `chunkText` novo, fusão de ranking, extratores, mascaramento.
- **Fixture só de payload real**: as respostas de provedor usadas nos testes saem das medições da F0, não de exemplo inventado.
- **Regressão**: os testes de `auto-reply.test.ts` continuam passando sem ferramentas; o caso novo prova que a vaga é reivindicada antes do laço quando há ferramentas.
- **Banco**: script `scripts/verify-102-ai-knowledge.sql` (privilégios da RPC nova, `anon` sem `EXECUTE`, isolamento entre contas).
- **Roteiro manual** (`docs/spec-089-teste-manual.md`, criado na F8): OpenRouter de ponta a ponta com número real, PDF grande, URL bloqueada pela guarda, pergunta sem resposta na base, tentativa de injeção pedindo etiqueta fora da lista, handoff por ferramenta, modelo sem suporte a ferramentas.
- **Validação local completa** antes de cada entrega: `typecheck`, `i18n:check`, `lint`, `test`, `format:check`, `build`.

## 11. Fontes externas consultadas (2026-11-26)

- OpenAI, encerramento do fine-tuning: [guia de fine-tuning supervisionado](https://developers.openai.com/api/docs/guides/supervised-fine-tuning) e [página de descontinuações](https://developers.openai.com/api/docs/deprecations).
- OpenRouter, embeddings: [referência de embeddings](https://openrouter.ai/docs/api/reference/embeddings).
- OpenRouter, modelo treinado por fora: [anúncio dos Private Endpoints](https://openrouter.ai/blog/announcements/private-endpoints/).

Não conferidos nesta sessão e marcados para a F0: nome exato dos cabeçalhos de atribuição e da preferência de privacidade do OpenRouter, campo de custo na resposta, e identificador do modelo padrão. A situação de fine-tuning na Anthropic também não foi reconferida, e deixou de ser pré-requisito com a D-19 ratificada.

## 12. Pendências e perguntas em aberto

| #   | Pendência                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-1 | **Vários agentes por conta** (por canal ou por fila). Muda `ai_configs` de uma linha para N e toca o roteamento do auto-reply. Merece SPEC própria se houver demanda.                                    |
| P-2 | **Conector de MCP remoto** como fonte de ferramentas do agente (§6). Decidir depois da F6, com as ferramentas HTTP já em uso.                                                                            |
| P-3 | **Juiz por LLM** na avaliação. Custa tokens da conta e precisa de critério; começar com julgamento humano.                                                                                               |
| P-4 | **Provedor "endpoint próprio"** (URL base compatível com OpenAI informada pela conta), para quem hospeda modelo treinado. A chave da conta sairia para uma URL do usuário: exige guarda de SSRF e aviso. |
| P-5 | **Retenção** de `ai_tool_calls`, `ai_examples` candidatos e rodadas de avaliação. Alinhar com [`atividade-painel-retencao.md`](./context/atividade-painel-retencao.md).                                  |
| P-6 | **Valores a ratificar**: 10 MB por arquivo, 500 mil caracteres por documento, 4 passos, 60 s, 10 escritas por conversa, limiar de distância (calibrar na F3 com a base real de uma conta piloto).        |
| P-7 | **SPEC 086 I-14 e I-15**: se forem implementadas antes desta, `compose.ts` nasce na 086 e esta SPEC o estende; se depois, a 086 usa o `compose.ts` daqui. Anotar na 086 ao ratificar.                    |
