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

- Base de conhecimento (`src/lib/ai/ingest/`): URL importada passa por `isDeliverableUrl` em cada salto e `redirect: 'manual'`; só o texto é guardado; a indexação roda em `after()` e a fase 8 do `/api/automations/cron` a retoma (`pending`/`indexing` parado); quota `knowledge_documents` é do banco; `/api/ai/knowledge/upload` fica fora do `matcher` do middleware (corpo truncado acima de 10 MB).

- Recuperação (F3): `retrieveKnowledge`/`searchKnowledge` chamam `match_ai_knowledge_hybrid` (RRF, limiar de distância); fontes saem em `ComposedTurn.sources` e nunca no texto ao cliente; a RPC é `SECURITY DEFINER` com guarda de conta; as RPCs antigas `match_ai_knowledge_fts`/`_semantic` não existem mais (104b), não as recrie.

Detalhe: leia `docs/context/ia-agentes.md`.
