---
paths:
  - 'src/lib/ai/**'
  - 'src/components/agents/**'
  - 'src/app/api/ai/**'
---

# IA — rascunho, auto-reply e provedores

- A chave do provedor é da conta e fica criptografada (`encryption.ts`); a rota de configuração nunca a devolve e ninguém a loga.
- O auto-reply só responde quando todas as condições valem: conta não bloqueada (primeira checagem), IA configurada, nenhuma automação ativa de mensagem/palavra-chave, conversa sem agente atribuído, `ai_autoreply_disabled` falso, teto e limite de taxa. Qualquer uma falsa = deixa para o humano.
- O teto por conversa é reivindicado atomicamente por `claim_ai_reply_slot`; nunca "ler o contador e depois enviar".
- Handoff: sentinela `[[HANDOFF]]` e resumo determinístico (`handoff.ts`), sem segunda chamada ao LLM.
- A resposta sai pelo canal da conversa (`engineSendText`); não adicione checagem de janela de 24 h aqui.
- O motor usa service role (`admin-client.ts`): filtre por `account_id`; nunca no navegador.
- Modelo é texto livre na UI; `AI_PROVIDER_DEFAULT_MODEL` é só pré-preenchimento. Recuperação da base de conhecimento é melhor esforço.
- `ai_enabled` vale em modo estrito (`plan-gate.ts`): plano sem a chave bloqueia a IA; toda rota nova de `/api/ai/**` que gaste token ou mude config chama `requireAiFeature` depois do `requireRole`.
- O prompt e o contexto do turno saem de `compose.ts` (`composeAgentTurn`), não de montagem própria em cada chamador. OpenRouter tem adaptador próprio; o corpo de erro dele traz `user_id` e nunca é gravado cru.

- Base de conhecimento (`src/lib/ai/ingest/`): URL importada sai por `safeRequest` (endereço validado na conexão, `redirect: 'return'`, cada salto checado de novo); DOCX passa por `zip-guard.ts` (XML pelo conteúdo) e PDF é lido página a página; só o texto é guardado; a indexação roda em `after()` e a fase 8 do `/api/automations/cron` a retoma (`pending`/`indexing` parado); quota `knowledge_documents` é do banco; `/api/ai/knowledge/upload` fica fora do `matcher` do middleware (corpo truncado acima de 10 MB).

- Recuperação (F3): `retrieveKnowledge`/`searchKnowledge` chamam `match_ai_knowledge_hybrid` (RRF, limiar de distância); fontes saem em `ComposedTurn.sources` e nunca no texto ao cliente; a RPC é `SECURITY DEFINER` com guarda de conta; as RPCs antigas `match_ai_knowledge_fts`/`_semantic` não existem mais (104b), não as recrie.

- Ferramentas (F4/F5): motor em `agent-loop.ts`, catálogo em `tools/`. Nascem desligadas (`tools_config`); o contexto só sai de `buildToolContext` (contato da linha da conversa, nunca do modelo nem do payload); nenhum esquema tem id de conta/contato/conversa; todo handler filtra por `account_id` e resolve nome → id dentro da conta **e** da lista permitida (vazia = nada); resultado volta embrulhado por `wrapToolResult`.
- Escrita (F5): só roda de verdade no auto-reply; playground/eval simulam, rascunho só lê; todo handler de escrita chama `guardWrite`. Com ferramenta no turno a vaga (`claim_ai_reply_slot`) vem **antes** do laço. Chamada real é auditada **antes** de rodar por `claim_ai_tool_call` (teto de 10 escritas por conversa e quota `ai_tool_calls_month` são do banco); `ai_tool_calls` não tem escrita direta; entrada mascarada; escrita vira linha `ai.tool_*` no registro de atividade. Escrita em conta real só pelo rollout da SPEC 089 §13; `AI_TOOL_WRITES=off` desliga todas as escritas (`tools/kill-switch.ts`).
- Ferramenta HTTP da conta (F6, `ai_custom_tools`): URL fixa do admin, o modelo só preenche campos (nunca host, caminho nem porta); chamada só por `safeRequest` (`src/lib/http/safe-request.ts`: endereço validado na conexão, https, sem redirecionamento), nunca `fetch` direto; cabeçalhos cifrados, só de escrita, lidos na hora da chamada e nunca em rota, log, auditoria nem resposta ao modelo (`headers_encrypted` não é legível por `authenticated`: não use `select('*')`); trocar o host exige redigitar os valores; playground/eval só descrevem a chamada e o rascunho só roda `read`. Lógica em `tools/custom-tools.ts`, não na rota.

- Ajuste do agente (F7, `src/lib/ai/tuning/`): só exemplo `approved` entra no prompt (`compose.ts` → `match_ai_examples`, melhor esforço); candidato vem de `captureAfterSend` (rascunho editado ou 1ª resposta após handoff) e **nada** entra sem aprovação do admin; todo texto guardado, exportado ou avaliado passa por `maskPersonalData` (marcas, nunca valor parcial); rotas `examples/**` e `eval/**` são admin+ com `tuningGuard` e `ai_enabled`; a avaliação roda em modo `eval` (ferramentas em `dryRun`), exige `confirm: true` e uma rodada por conta; não crie treino de modelo (D-19).

- Endurecimento (F8): resposta do auto-reply com link que não está no system prompt do turno é retida e vira handoff (`output-guard.ts`); o auto-reply relê a conversa antes de enviar e a 110 recusa vaga e ferramenta em conversa pausada ou atribuída; trechos da base vão embrulhados em `<knowledge_excerpt>` por `neutralizeUntrusted` e as instruções do admin vão por último; no máximo `MAX_CALLS_PER_TURN` chamadas por resposta; texto livre não entra na auditoria nem no rótulo do registro de atividade; `ai_tool_calls` sai com 90 dias (`purge_ai_tool_calls`).

Detalhe: leia `docs/context/ia-agentes.md`.
