# Notificações do sistema — SMTP + webhook (outbox de eventos)

> Domínio da SPEC 079. Rule: `.claude/rules/notificacoes-smtp.md`. Migração atual e rotas de cron: [`status.md`](./status.md). Quem **emite** os eventos de plano/conta: [`planos-quotas-admin.md`](./planos-quotas-admin.md). Mapa: [`INDEX.md`](./INDEX.md).

## Onde mexer

- **Emitir um evento:** `src/lib/notifications/emit.ts` (`emitSystemEvent`)
- **Tipos de evento e `dedupe_key`:** `src/lib/notifications/types.ts` (fonte de verdade), `dedupe.ts`
- **Entregar (e-mail + webhook), recuo:** `src/lib/notifications/dispatch.ts` (`deliverPending`), `backoff.ts`, `webhook.ts`
- **Configuração e envio de e-mail:** `src/lib/mailer/` (`config`, `transport`, `render`, `send`)
- **Console de notificações:** `/admin/notifications` (ver [`planos-quotas-admin.md`](./planos-quotas-admin.md))
- **Aviso "pode cair em spam":** `src/components/email-spam-notice.tsx`
- **Templates dos e-mails do **Supabase Auth**:** [`../templates_email_send/`](../templates_email_send/) — outro canal, ver abaixo

## Regras que não podem quebrar

1. **O aviso nunca derruba a ação que o originou** ([SPEC 063](../spec-063-notificacoes-do-sistema-smtp.md) §1). Grava-se primeiro numa outbox (`system_notifications`) e entrega-se depois; `emitSystemEvent` **nunca lança**.
2. **Idempotência por `dedupe_key`** (`UNIQUE` parcial, só onde a chave não é nula). Chave de aviso periódico **inclui a data do período** (`plan.expiring:<conta>:<period_end>:<dias>`); sem ela, a conta que renova nunca mais recebe o aviso. `quota.exceeded` leva `YYYY-MM-DD` (uma por dia). Colisão `23505` = "já existe", não erro.
3. **Canal ausente é no-op silencioso, não erro** — o oposto do cron (que responde `503`). Sem `SMTP_HOST` **ou** sem `SYSTEM_NOTIFICATION_EMAIL`, o e-mail está desligado; `mailer/config.ts` devolve `null` e avisa uma vez por processo, nunca lança. `.env` incompleto de um fork não pode quebrar o cadastro dele.
4. **Duas portas, uma implementação** (`deliverPending`): (1) `after()` na rota que originou — entrega normal, fora do caminho da resposta; (2) uma fase do cron de automações (`/api/automations/cron`) como rede de segurança — **não existe cron novo para isso**. Entregar dentro da requisição é violação da regra 1. Sem o agendamento do cron de automações, só a porta 1 funciona (ver [`automacoes-cron.md`](./automacoes-cron.md)).
5. **Cada canal é entregue e marcado separadamente.** Falha → `attempts + 1`, `last_error`, recuo exponencial (teto 6 h); ao atingir o limite de tentativas vira `failed` e fica visível no console. Claim por `UPDATE … RETURNING` impede dupla entrega com dois processos.
6. **Timeout é obrigatório.** SMTP com `connectionTimeout`/`socketTimeout` (10 s) e webhook com `AbortSignal.timeout`; sem eles uma conexão aceita e muda segura o `after()` e atrasa o cron.
7. **E-mail sem dado de conversa ou contato**: o corpo diz qual conta e qual quota, nunca quem é o contato (atravessa servidores de terceiros e fica arquivado). `render.ts` é puro, em pt-BR, HTML mínimo inline — sem CSS externo, imagem remota ou fonte web (cai em spam). Termina com o link para a conta no console. `render.test.ts` guarda essas regras.
8. **Webhook de saída reutiliza a guarda SSRF** e assina o corpo com HMAC (`X-ZapCRM-Signature`) quando `SYSTEM_EVENT_WEBHOOK_SECRET` existe. `plan.requested` mantém o campo legado `event` no payload — workflows n8n antigos dependem dele. URL legada: `PLAN_REQUEST_WEBHOOK_URL`; nova: `SYSTEM_EVENT_WEBHOOK_URL`.
9. **A própria outbox precisa de purga** agendada; sem ela cresce sem fim (SPEC 063 §2.2).

## Variáveis (nomes; valores nunca aqui)

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_FROM`, `SYSTEM_NOTIFICATION_EMAIL`, `PLAN_REQUEST_WEBHOOK_URL`, `SYSTEM_EVENT_WEBHOOK_URL`, `SYSTEM_EVENT_WEBHOOK_SECRET`; `NEXT_PUBLIC_SITE_URL` monta o link do console. Passo a passo: README § "Notificações do sistema (SMTP + webhook)". Não leia `.env*`.

## Não confundir com os e-mails do Auth

Confirmação de cadastro, redefinição de senha e troca de e-mail saem pelo **Supabase Auth**, com templates em `docs/templates_email_send/` colados no painel do Supabase — não passam por esta outbox. Detalhes e armadilha do Site URL em [`auth-e-conta.md`](./auth-e-conta.md).

## Armadilhas

- Mesmo aviso repetido: `dedupe_key` nulo onde deveria ter chave, ou índice único sem o `WHERE dedupe_key IS NOT NULL`.
- Workflow n8n parou após deploy: campo `event` legado removido de `plan.requested`.
- E-mail em spam: HTML com recurso externo, ou domínio remetente sem SPF/DKIM.

## Mais

[`../spec-063-notificacoes-do-sistema-smtp.md`](../spec-063-notificacoes-do-sistema-smtp.md) · [`catalogo-specs.md`](./catalogo-specs.md).
