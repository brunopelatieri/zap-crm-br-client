---
paths:
  - 'src/lib/flows/**'
  - 'src/components/flows/**'
  - 'src/app/api/flows/**'
---

# Flows — editor visual e motor

- Rascunho pode ser incompleto; ativar não: `validate.ts` roda no cliente **e** no servidor, e os limites da Meta espelham `meta-api.ts` (mude os dois juntos).
- Canal em flow é **escopo** (`flows.channel_id`, NULL = todos), não "enviar por": a resposta sai pelo canal da conversa; o flow escopado vence o genérico.
- Uma execução ativa por conversa (`idx_one_active_run_per_conversation`).
- Menu degradado é um **par** (saída numerada + casador da resposta) em `degraded-menu.ts`; nunca separe os dois.
- O cron de flows não é opcional: sem ele a execução abandonada bloqueia novos gatilhos na conversa.
- Motor com service role: filtre por `account_id`; `admin-client` nunca vai ao navegador; `ingest.ts` repassa `channel_id`.
- Entrada única do inbound é `dispatchInboundToFlows`; fallback por `resolveFallbackPolicy`, nunca o JSONB cru.

Detalhe: leia `docs/context/flows.md`.
