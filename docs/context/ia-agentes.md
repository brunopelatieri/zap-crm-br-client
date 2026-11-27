# IA — rascunho, auto-reply, base de conhecimento e provedores

> Domínio da SPEC 079. Rule: `.claude/rules/ia-agentes.md`. Versões: [`status.md`](./status.md). Mapa: [`INDEX.md`](./INDEX.md). Arquitetura detalhada dos componentes: [`../references/agents-ai-components-architecture.md`](../references/agents-ai-components-architecture.md).

## Onde mexer

- **Auto-reply (resposta automática):** `src/lib/ai/auto-reply.ts` (`dispatchInboundToAiReply`)
- **Montar o turno (prompt + conhecimento + canal), único ponto:** `src/lib/ai/compose.ts` (`composeAgentTurn`), usado por auto-reply, rascunho e playground
- **Chamar o modelo (normaliza provedores):** `src/lib/ai/generate.ts`, `providers/{openai,anthropic,openrouter,shared}.ts` (o OpenRouter tem adaptador próprio; `openai.ts` não o conhece)
- **OpenRouter:** catálogo de modelos só como sugestão (`openrouter-models.ts`, `GET /api/ai/models`), privacidade em `provider-options.ts`, custo em `usage.cost` → `ai_usage_log.cost_usd`
- **Versões do prompt:** `src/lib/ai/prompt-versions.ts`, `src/app/api/ai/prompt-versions/`, `src/components/agents/ai-prompt-versions.tsx`
- **Portão de plano `ai_enabled` (estrito, ligado desde 2026-11-27):** `src/lib/ai/plan-gate.ts`, lido no auto-reply (depois da conta bloqueada) e nas rotas `/api/ai/**`
- **Chave/configuração da conta:** `src/lib/ai/config.ts`, `src/app/api/ai/config/route.ts`
- **Prompt, limites, modelo padrão:** `src/lib/ai/defaults.ts` (`buildSystemPrompt`, `HANDOFF_SENTINEL`)
- **Contexto da conversa:** `src/lib/ai/context.ts`
- **Base de conhecimento (chunk, embedding, recuperação):** `src/lib/ai/knowledge.ts` (`searchKnowledge`/`retrieveKnowledge`), `query.ts` (consulta com até 3 mensagens e palavras da busca textual), `sources.ts`, `chunk.ts`, `embeddings.ts`, `src/app/api/ai/knowledge/` (inclui `search`, "Testar recuperação"; tela `src/components/agents/ai-knowledge-search.tsx`)
- **Fontes da base e indexação (F2):** `src/lib/ai/ingest/` (`extract-file.ts` PDF/DOCX/TXT/MD/CSV, `extract-url.ts` com guarda de SSRF, `html-to-text.ts`, `faq.ts`, `documents.ts` criação e hash, `indexer.ts` estados e varredura do cron, `limits.ts`), rotas `knowledge/{upload,import-url,reindex}` e `[id]`, tela `src/components/settings/ai-knowledge.tsx` (chaves `Agents.knowledge.*`)
- **Entrega a um humano:** `src/lib/ai/handoff.ts`
- **Consumo de tokens:** `src/lib/ai/usage.ts`, `src/app/api/ai/usage/`, `src/components/agents/ai-usage.tsx`
- **Rascunho e playground:** `src/app/api/ai/{draft,playground}/`, `src/components/agents/ai-playground.tsx`
- **Entrada na UI:** `/agents`, aba de IA em `src/components/settings/`

## Regras que não podem quebrar

1. **A chave do provedor é da conta (BYO) e fica criptografada** com `src/lib/whatsapp/encryption.ts` (AES-GCM). A rota de configuração **nunca devolve a chave**; ao salvar sem chave nova, reaproveita a cifrada. Não logue nem exponha `api_key` / `embeddings_api_key`.
2. **O robô só responde quando todas as condições abaixo valem** (qualquer uma falsa = não responde, a mensagem fica no inbox para um humano): conta **não bloqueada** (primeira checagem, antes de gastar token) · IA configurada e `auto_reply_enabled` · **nenhuma automação ativa** de `new_message_received`/`keyword_match` (para não responder em dobro) · conversa **sem agente atribuído** · `ai_autoreply_disabled` falso · contador abaixo do teto por conversa · limite de taxa por conta (`aiAutoReplyAccount`). Flows que já consumiram a mensagem têm prioridade: o chamador exclui esse caso.
3. **O teto de respostas por conversa é reivindicado atomicamente** pela RPC `claim_ai_reply_slot` (cap + incremento num `UPDATE`); nunca troque por "ler o contador e depois enviar". Erro nessa RPC é problema de deploy (função sem `EXECUTE` para `service_role`, migração não aplicada) — o código loga alto de propósito.
4. **Handoff**: o modelo é instruído a emitir o sentinela `[[HANDOFF]]` quando não puder ajudar; `generateReply` o remove e o motor grava um resumo **determinístico** em `conversations.ai_handoff_summary` (sem outra chamada ao LLM, via `handoff.ts`), seta `ai_autoreply_disabled` naquela conversa e atribui ao agente de handoff configurado — sem agente, a conversa fica na fila; o destino só vale se for membro atribuível (`isAssignableMember`, ver [`inbox-atribuicao.md`](./inbox-atribuicao.md)).
5. **O auto-reply sai pelo canal da conversa**, reaproveitando `engineSendText` (`src/lib/flows/meta-send.ts`); o texto respeita as capacidades do tipo de canal (`resolveChannelTypeForConversation`).
6. **A janela de 24 h está aberta por construção** (reagimos a uma mensagem recém-chegada); não adicione checagem de janela aqui. Já o rascunho para o agente humano não envia nada.
7. **Contexto = últimas N mensagens de texto** (`AI_CONTEXT_MESSAGE_LIMIT`), mídia/template/interativo ficam de fora. Retenção agressiva por contagem esvazia esse contexto — ver o piso de idade em [`atividade-painel-retencao.md`](./atividade-painel-retencao.md).
8. **Modelo é texto livre na UI** (IDs mudam rápido); `AI_PROVIDER_DEFAULT_MODEL` é só pré-preenchimento, nunca lista permitida. Saída limitada por `MAX_OUTPUT_TOKENS`; timeout por `AI_REQUEST_TIMEOUT_MS`.
9. **Base de conhecimento é híbrida** (F3): uma só RPC, `match_ai_knowledge_hybrid`, funde busca por sentido (só se houver alvo de embeddings: chave própria, ou, no OpenRouter, a chave do chat reaproveitada) e busca textual em português por reciprocal rank, com limiar de distância. Recuperação é melhor esforço — falha não impede a resposta.
10. **O motor usa `service_role`** (`src/lib/ai/admin-client.ts`): filtre sempre por `account_id`; nunca importe no navegador.

## Armadilhas

- "Auto-reply nunca dispara", sem erro: uma automação ativa de mensagem/palavra-chave (regra 2), agente atribuído, conversa já em handoff, ou `claim_ai_reply_slot` falhando.
- Respostas duplicadas ao cliente: o `stand down` da regra 2 foi removido ou um fluxo também respondeu.
- Custo inesperado: o limite por conta e o teto por conversa existem para proteger a chave do dono; não os contorne em campanha.

## OpenRouter (SPEC 089 F1, no código desde 2026-11-26)

- Provedor `openrouter`: adaptador próprio em `fetch`. 402 vira `insufficient_credits`; 404 se distingue por `error.metadata.failed_routing_step` (política de dados × ferramentas); o corpo de erro traz `user_id` da conta e **nunca** é gravado ou devolvido cru (links da mensagem viram `[link]`).
- A chave é validada por `GET /api/v1/key` (sem custo); o modelo não é validado ali. O modelo padrão fica em `OPENROUTER_DEFAULT_MODEL` (`defaults.ts`); o catálogo só sugere, nunca restringe (regra 8).
- Privacidade: `provider_options.deny_data_collection` nasce **desligado**; ligado, o chat leva `provider: { data_collection: "deny" }`. Não vale para embeddings (não medido na F0).
- Migração 102 (provedor, `embeddings_provider`, `provider_options`, `cost_usd`, `ai_prompt_versions`): **aplicada no `vn` em 2026-11-27**; em outro banco, aplique antes de subir este código, porque `loadAiConfig` seleciona as colunas novas.
- **Portão `ai_enabled` estrito (D-20) ligado**: chave ausente no plano = IA bloqueada (auto-reply não responde; rotas dão 403 `FEATURE_NOT_IN_PLAN`; `GET /api/ai/config` devolve `feature_in_plan: false`). Plano novo precisa nascer com `ai_enabled` explícito, senão a conta perde a IA. Ficam abertos: `DELETE` de config e de documento, `GET /api/ai/usage` e o `autoreply/:id`.

## Base de conhecimento ampliada (SPEC 089 F2, no código desde 2026-11-27)

- **Fontes**: texto colado, arquivo (PDF, DOCX, TXT, MD, CSV; 10 MB), página por URL e perguntas e respostas. **Só o texto é guardado** (500 mil caracteres por documento); o arquivo original não vai para Storage. PDF só de imagem e PDF com senha viram erro claro (sem OCR).
- **Importar URL passa pela guarda de SSRF**: `isDeliverableUrl` antes de **cada** requisição e `redirect: 'manual'` (os redirecionamentos, no máximo 3, são seguidos à mão e cada salto é checado de novo); 10 s, só `text/html` e `text/plain`, corpo até 2 MB. Mudou a rota? Mantenha o teste de URL bloqueada de `extract-url.test.ts` e de `routes.test.ts`.
- **Indexação fora da requisição**: o documento nasce `pending`, a rota responde e `after()` indexa (`pending → indexing → ready | error`). A fase 8 do `/api/automations/cron` retoma `pending` e `indexing` parado há mais de 10 min (5 por ciclo, 3 tentativas, depois `error` e botão de reindexar). "Documento parado em `pending`/`indexing`" = checar o cron antes do código.
- **Fatias** (D-12): título da seção prefixado, sobreposição de 150 caracteres, um par de pergunta e resposta por fatia. `content_hash` igual na conta = 409, sem reindexar. `is_enabled` e `tags` valem na hora. `embedding_model` é gravado por fatia (o filtro por modelo na busca está na RPC da F3).
- **Quota de plano `knowledge_documents`**: decidida pela trigger do banco (103); ausente = ilimitado; a rota traduz `QUOTA_EXCEEDED` em 403 `quota_exceeded`.
- **Upload fora do `matcher` do middleware** (`/api/ai/knowledge/upload`): o middleware entrega o corpo truncado acima de 10 MB. A rota confere a sessão sozinha; não a recoloque no `matcher` sem tratar isso.
- Migração 103 **aplicada no `vn` em 2026-11-27**. Em outro banco, aplique antes de subir este código: sem ela as rotas de `/api/ai/knowledge` falham (colunas novas). `scripts/verify-103-ai-knowledge-sources.sql` confere quota e `is_enabled` (se desfaz sozinho).

## Recuperação híbrida (SPEC 089 F3, no código desde 2026-11-27; migração 104 **aplicada no `vn` em 2026-11-27**)

- **Uma RPC só**: `match_ai_knowledge_hybrid` (104): duas CTEs (semântica filtrada por `embedding_model`; textual em `fts_pt` `portuguese`+`unaccent` OU `fts` `simple`), fusão `1/(60+posição)`, junta o título do documento, só documento `is_enabled` e `ready`. **Fatia só semântica acima do limiar de distância (`KNOWLEDGE_MAX_DISTANCE`, `defaults.ts`, 0,55, medido numa base sintética de 19 trechos e a reconferir numa conta real) e sem palavra em comum não entra no prompt**: pergunta sem resposta na base traz zero trecho.
- **A busca textual é um `or` de palavras** (`buildLexicalQuery`, `query.ts`): mensagem de cliente é longa e conversacional; "todas as palavras" não acharia nada. Só letras e dígitos sobrevivem (não dá para injetar operador do `websearch`) e stopwords saem.
- **Consulta** (D-13): as últimas até 3 mensagens do cliente, 600 caracteres (`buildRetrievalQuery`). O embedding é do texto inteiro.
- **Fontes** (D-14): `{ chunkId, documentId, title, score }` voltam em `ComposedTurn.sources`; o playground as mostra, `ai_usage_log.knowledge_document_ids` as guarda (só quando há; a coluna é da 104). **Nunca vão no texto ao cliente.**
- **`embedding_model` normalizado**: `openai/text-embedding-3-small` e `text-embedding-3-small` são o mesmo modelo de 1536 dimensões; a RPC remove o prefixo `openai/` dos dois lados antes de comparar (trocar de provedor de embeddings não esconde a base).
- **Falha da RPC**: se a RPC híbrida falhar (erro de banco), `searchKnowledge` devolve zero trecho com `searchFailed` (a tela de teste avisa; o turno segue sem a base). Não há mais reserva: as RPCs antigas `match_ai_knowledge_fts` e `_semantic` saem na migração `104b` (aplicar **depois** do deploy do código da F3).
- **Segurança da RPC**: `SECURITY DEFINER`, `search_path = public, pg_temp`, guarda `auth.role() = 'service_role'` OU `is_account_member` (42501 caso contrário), `REVOKE` de `PUBLIC` e `anon`. **A 103 recriou as RPCs antigas como `SECURITY DEFINER` sem guarda e desfez a 032** (qualquer autenticado lia fatias de outra conta); a 104 as devolveu a `SECURITY INVOKER` e a 104b as apaga.
- **"Testar recuperação"**: `POST /api/ai/knowledge/search` (admin+, `ai_enabled`, limite de taxa; gasta um embedding da chave da conta, não chama o LLM). Aceita `max_distance` só para aquela chamada, para calibrar.
- Verificação do banco: `scripts/verify-104-ai-knowledge-hybrid.sql` (se desfaz sozinho). Fixture de teste: `src/lib/ai/__fixtures__/match-hybrid-rows.json`.

## Decisões ratificadas, ainda sem código

- **Fine-tuning (treinar modelo) está fora** do ZAP CRM BR, por decisão do mantenedor em 2026-11-26 ([SPEC 089](../spec-089-agentes-de-ia-openrouter-rag-ferramentas.md) D-19, motivo no §7). Não crie job de treino, tela de treino nem integração com API de fine-tuning; reabrir exige nova decisão do mantenedor. O campo de modelo continua aceitando o identificador de um modelo já treinado por fora.
- O restante da SPEC 089 (execução de ações, ajuste do agente; F1, F2 e F3 já estão no código) é **proposta**, não regra vigente: confira o Status da SPEC antes de implementar.

## Mais

[`catalogo-specs.md`](./catalogo-specs.md) · variáveis `AI_*` em `src/lib/ai/defaults.ts`.
