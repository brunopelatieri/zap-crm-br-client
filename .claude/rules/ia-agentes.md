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

Detalhe: leia `docs/context/ia-agentes.md`.
