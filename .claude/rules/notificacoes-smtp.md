---
paths:
  - 'src/lib/mailer/**'
  - 'src/lib/notifications/**'
  - 'src/components/email-spam-notice.tsx'
---

# Notificações do sistema — SMTP e webhook

- O aviso nunca derruba a ação que o originou: grava na outbox (`system_notifications`) e entrega depois; `emitSystemEvent` nunca lança.
- Idempotência por `dedupe_key`; a chave de aviso periódico inclui a data do período; colisão `23505` significa "já existe", não erro.
- Canal ausente (sem `SMTP_HOST` ou `SYSTEM_NOTIFICATION_EMAIL`) é no-op silencioso, o oposto do cron (`503`).
- Entrega só em `after()` ou na fase do cron de automações, nunca dentro da requisição; não existe cron novo para isso.
- Timeout obrigatório (SMTP e `AbortSignal.timeout` no webhook).
- E-mail sem dado de contato ou conversa; `render.ts` é puro, HTML inline, sem recurso externo.
- Webhook de saída reaproveita a guarda SSRF e assina com HMAC; `plan.requested` mantém o campo legado `event`.
- E-mails do Supabase Auth não passam por aqui. Nunca leia `.env*`.

Detalhe: leia `docs/context/notificacoes-smtp.md`.
