# IA — rascunho, auto-reply, base de conhecimento e provedores

> Domínio da SPEC 079. Rule: `.claude/rules/ia-agentes.md`. Versões: [`status.md`](./status.md). Mapa: [`INDEX.md`](./INDEX.md). Arquitetura detalhada dos componentes: [`../references/agents-ai-components-architecture.md`](../references/agents-ai-components-architecture.md).

## Onde mexer

- **Auto-reply (resposta automática):** `src/lib/ai/auto-reply.ts` (`dispatchInboundToAiReply`)
- **Chamar o modelo (normaliza provedores):** `src/lib/ai/generate.ts`, `providers/{openai,anthropic,shared}.ts`
- **Chave/configuração da conta:** `src/lib/ai/config.ts`, `src/app/api/ai/config/route.ts`
- **Prompt, limites, modelo padrão:** `src/lib/ai/defaults.ts` (`buildSystemPrompt`, `HANDOFF_SENTINEL`)
- **Contexto da conversa:** `src/lib/ai/context.ts`
- **Base de conhecimento (chunk, embedding):** `src/lib/ai/knowledge.ts`, `chunk.ts`, `embeddings.ts`, `src/app/api/ai/knowledge/`
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
9. **Base de conhecimento é híbrida**: busca semântica só se houver chave de embeddings; completa com busca textual. Recuperação é melhor esforço — falha não impede a resposta.
10. **O motor usa `service_role`** (`src/lib/ai/admin-client.ts`): filtre sempre por `account_id`; nunca importe no navegador.

## Armadilhas

- "Auto-reply nunca dispara", sem erro: uma automação ativa de mensagem/palavra-chave (regra 2), agente atribuído, conversa já em handoff, ou `claim_ai_reply_slot` falhando.
- Respostas duplicadas ao cliente: o `stand down` da regra 2 foi removido ou um fluxo também respondeu.
- Custo inesperado: o limite por conta e o teto por conversa existem para proteger a chave do dono; não os contorne em campanha.

## Decisões ratificadas, ainda sem código

- **Fine-tuning (treinar modelo) está fora** do ZAP CRM BR, por decisão do mantenedor em 2026-11-26 ([SPEC 089](../spec-089-agentes-de-ia-openrouter-rag-ferramentas.md) D-19, motivo no §7). Não crie job de treino, tela de treino nem integração com API de fine-tuning; reabrir exige nova decisão do mantenedor. O campo de modelo continua aceitando o identificador de um modelo já treinado por fora.
- O restante da SPEC 089 (OpenRouter, base de conhecimento ampliada, execução de ações, ajuste do agente) é **proposta**, não regra vigente: confira o Status da SPEC antes de implementar.

## Mais

[`catalogo-specs.md`](./catalogo-specs.md) · variáveis `AI_*` em `src/lib/ai/defaults.ts`.
