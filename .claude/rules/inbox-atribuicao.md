---
paths:
  - 'src/lib/inbox/**'
  - 'src/components/inbox/**'
  - 'src/app/api/inbox/**'
  - 'src/app/api/whatsapp/media/**'
  - 'src/lib/presence.ts'
  - 'src/lib/emoji/**'
  - 'src/lib/storage/**'
  - 'src/lib/pipelines/**'
  - 'src/lib/tags.ts'
  - 'src/lib/messages/**'
---

# Inbox, atribuição, mídia privada e apagar mensagem

- Filtro de aba no cliente não é autorização: o isolamento é a RLS por linha (migração 039); decisão de acesso nova precisa existir no banco.
- Reivindicar é atômico (`claim_conversation`); atribuível é `owner | admin | agent` (`ASSIGNABLE_ACCOUNT_ROLES`), nunca `viewer`.
- Service role não herda a 039: automação, flow e API que atribuem validam conta **e** papel do destino.
- Todo `.update()` leva `.select()`; zero linhas devolvidas é erro (RLS recusa em silêncio).
- Quadro "Time" é sobre `conversations` e só `admin`+; não é o funil (`deals`). Não misture os módulos.
- Mídia é privada (`chat-media`, `flow-media`): URL assinada; a rota de mídia recebida confere a conversa do chamador. `scripts/` é ignorado pelo git: o que o runtime precisa (fontes do PDF, dados de emoji) vive em `src/`.
- Apagar mensagem enviada **marca** (decide `planDeletion`); recebida nunca se apaga; tudo vai para `message_deletion_log`; a Cloud API não revoga.

Detalhe: leia `docs/context/inbox-atribuicao.md`.
