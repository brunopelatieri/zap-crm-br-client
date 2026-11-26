# SPEC 063 — Notificações do sistema: SMTP oficial + eventos de plano

> **Status:** F1-F8 implementadas (2026-08-27) — migração 070 escrita, **ainda não aplicada** (aguarda autorização projeto por projeto: `vn`/`rs`/`jh`, por regra do `AGENTS.md`); suíte 100% verde, `build` verde; teste manual (§10) e verificação visual do console (sem sessão de proprietário disponível no ambiente) ainda pendentes
> **Data:** 2026-08-26
> **Migração:** `070_system_notifications.sql` (confira `ls supabase/migrations/` antes — a última hoje é a 068; a 069 é da [SPEC 062](./spec-062-console-do-proprietario.md))
> **Nova dependência:** `nodemailer` (§4.1 justifica)
> **Irmã:** SPEC 062 — quem **emite** os eventos é ela; quem **entrega** é esta

---

## 1. Princípio que organiza tudo

> **O aviso nunca pode derrubar a ação que o originou.**

Um cliente clicando "Confirmar troca de plano" não pode receber erro porque o
servidor SMTP do mantenedor está fora do ar. Três regras derivam disso, e
nenhuma é negociável:

1. **Gravar primeiro, entregar depois.** A ação grava o evento numa outbox
   dentro da **mesma transação lógica** da mudança; a entrega acontece depois,
   fora do caminho da resposta. Se a entrega falhar, o evento continua lá para a
   próxima tentativa.
2. **Toda entrega é idempotente por chave.** `dedupe_key` com `UNIQUE`: o cron
   pode rodar mil vezes que o aviso de "vence em 7 dias" sai uma vez só.
3. **Canal ausente é no-op silencioso, não erro.** Sem SMTP configurado, o
   e-mail simplesmente não sai — o webhook continua, o console continua, e o
   `.env` incompleto de um fork nunca quebra a operação dele. É o oposto do
   padrão "falha alto" das rotas de cron, e de propósito: lá o segredo ausente
   significa "o recurso não pode funcionar"; aqui significa "este canal está
   desligado".

O restante segue a casa: **a decisão é TypeScript puro (o que avisar, com que
texto, com que chave), a persistência é do banco.**

---

## 2. Modelo de dados — migração `070_system_notifications.sql`

### 2.1. `system_notifications` — a outbox

```sql
CREATE TABLE IF NOT EXISTS system_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL,          -- 'plan.changed', 'account.blocked', … (§3.1)
  account_id   UUID REFERENCES accounts(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Idempotência. NULL = sempre entrega (evento pontual, ex. uma troca
  -- de plano manual); preenchido = no máximo uma vez com aquela chave.
  dedupe_key   TEXT,

  email_status TEXT NOT NULL DEFAULT 'pending'
               CHECK (email_status IN ('pending','sent','failed','skipped')),
  hook_status  TEXT NOT NULL DEFAULT 'pending'
               CHECK (hook_status  IN ('pending','sent','failed','skipped')),
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_system_notifications_dedupe
  ON system_notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- A varredura de reentrega só olha o que ainda tem trabalho.
CREATE INDEX IF NOT EXISTS idx_system_notifications_pending
  ON system_notifications (next_attempt_at)
  WHERE email_status = 'pending' OR hook_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_system_notifications_created
  ON system_notifications (created_at DESC);
```

**Dois status, não um.** O e-mail pode sair e o webhook falhar (ou o contrário),
e um status único forçaria reenviar o que já chegou — o proprietário receberia o
mesmo e-mail três vezes porque o n8n dele estava fora. `skipped` é o canal
desligado por configuração, distinto de `failed`: um é escolha, o outro é
problema.

**`ON DELETE SET NULL` no `account_id`.** O aviso de "conta cancelada" precisa
sobreviver à conta — é o registro do que aconteceu com ela.

RLS ligada, **zero policies** — só `service_role`, mesma decisão de
`platform_audit_log` (SPEC 062 §3.5). O console lê por rota de servidor.

### 2.2. Retenção da própria outbox

A tabela cresce para sempre se ninguém podar. A migração cria a função, e
`supabase/setup/cron-jobs.sql` ganha o bloco **comentado**:

```sql
CREATE OR REPLACE FUNCTION purge_system_notifications(p_keep_days INTEGER DEFAULT 90)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ … $$;
```

Só apaga linhas **já resolvidas** (nenhum canal em `pending`) e mais velhas que
`p_keep_days`. Uma pendente de 6 meses é um sintoma para investigar, não lixo
para varrer.

### 2.3. Asserções finais

- `system_notifications` com RLS ligada e zero policies;
- índice único de `dedupe_key` existe e é **parcial** (senão duas linhas de
  `dedupe_key IS NULL` colidiriam);
- `purge_system_notifications` não é executável por `anon`/`authenticated`
  (`REVOKE`, no padrão de `purge_channel_messages` da 068).

---

## 3. O catálogo de eventos

### 3.1. Tipos

`src/lib/notifications/types.ts` é a **fonte de verdade** — união literal, no
padrão de `QUOTA_KEYS`/`FEATURE_KEYS`:

| Tipo | Emitido por | `dedupe_key` |
| --- | --- | --- |
| `account.created` | `handle_new_user` → primeiro acesso (§3.3) | `account.created:<account_id>` |
| `plan.changed` | Autosserviço (`/api/account/plan/change`) e console | `null` (toda troca é um fato novo) |
| `plan.requested` | `/api/account/plan/request` (plano sob medida) | `null` |
| `plan.canceled` | `/api/account/plan/cancel` | `null` |
| `plan.cancel_reverted` | idem, DELETE | `null` |
| `plan.canceled_applied` | Cron de ciclo, no vencimento | `plan.canceled_applied:<acc>:<period_end>` |
| `plan.renewed` | Rota de renovação do sistema externo de cobrança (SPEC 062 §6.2) | `plan.renewed:<acc>:<paymentRef>` — a mesma chave que dá idempotência à renovação |
| `plan.expiring` | Cron de ciclo (7 e 1 dia) | `plan.expiring:<acc>:<period_end>:<dias>` |
| `plan.expired` | Cron de ciclo | `plan.expired:<acc>:<period_end>` |
| `plan.grace_ended` | Cron de ciclo | `plan.grace_ended:<acc>:<period_end>` |
| `account.blocked` / `account.unblocked` | Console (SPEC 062 §5.2) | `null` |
| `member.blocked` / `member.unblocked` | Console | `null` |
| `quota.exceeded` | `parseQuotaError` nos pontos de enforcement | `quota.exceeded:<acc>:<metric>:<YYYY-MM-DD>` — um por dia (D-10 do PRD) |

**A chave de `plan.expiring` inclui a data do período.** Sem ela, uma conta que
renova no mês seguinte nunca mais receberia o aviso — a chave já teria sido
usada. Com ela, cada período tem o seu.

### 3.2. O payload — versionado e compatível com o que já existe

```jsonc
{
  "v": 1,
  "type": "plan.changed",
  "event": "plan_change_requested",   // ← compat, só nos tipos que já existiam
  "occurredAt": "2026-08-26T14:03:11.482Z",
  "account": { "id": "…", "name": "Acme Ltda", "ownerEmail": "ana@acme.com" },
  "plan": {
    "fromCode": "essential", "toCode": "professional", "toName": "Profissional",
    "billingCycle": "yearly", "priceCents": 298800, "currency": "BRL",
    "currentPeriodEnd": "2027-08-26T14:03:11.482Z"
  },
  "actor": "self-service:ana@acme.com",
  "message": null
}
```

**O campo `event` legado é obrigatório em `plan.requested`.** O
`PLAN_REQUEST_WEBHOOK_URL` já está em produção com um workflow n8n do outro
lado, filtrando por `event: 'plan_change_requested'` e pelos campos raiz
`accountId`/`planCode` do formato atual (`src/lib/plans/request-webhook.ts`).
Quebrar isso silenciosamente é o pior desfecho possível: o aviso simplesmente
para de chegar, sem erro em lugar nenhum. Nos tipos **novos**, só o formato novo.

### 3.3. `account.created` sem tocar em `handle_new_user`

A tentação é emitir dentro do trigger de cadastro. Não: trigger não faz HTTP, e
enfiar uma inserção de outbox lá dentro coloca um caminho de falha no meio do
`signup` — o mesmo motivo pelo qual a SPEC 059 §2.8 embrulhou a atribuição de
plano num `EXCEPTION WHEN OTHERS`. O evento é emitido pelo **primeiro
`getCurrentAccount()` bem-sucedido** da conta, com `dedupe_key` garantindo uma
única emissão para sempre.

---

## 4. Os dois canais

### 4.1. E-mail — SMTP por variável de ambiente

```bash
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587                    # 465 → TLS implícito; 587/25 → STARTTLS
SMTP_USER=avisos@exemplo.com
SMTP_PASSWORD=…
SMTP_SECURE=false                # true força TLS implícito (independe da porta)
SMTP_FROM="ZAP CRM BR <avisos@exemplo.com>"
SYSTEM_NOTIFICATION_EMAIL=dono@exemplo.com   # destinatário dos avisos
```

**Sem `SMTP_HOST` ou sem `SYSTEM_NOTIFICATION_EMAIL`, o canal é `skipped`** —
com um `console.warn` uma vez por processo, não por evento (senão o log vira
ruído e o operador para de ler).

**Por que `nodemailer` e não uma API HTTP.** O mantenedor pediu SMTP
explicitamente, e SMTP é o que funciona com qualquer provedor já contratado
(inclusive o do próprio domínio) sem amarrar o projeto a um fornecedor — o que
importa num projeto auto-hospedável que outras pessoas fazem fork. Implementar
SMTP à mão (socket, STARTTLS, AUTH, quoted-printable, anexos) é reescrever uma
biblioteca madura com pior resultado. É a primeira dependência de runtime nova
em muitas versões, e ela se paga.

`src/lib/mailer/transport.ts` é **server-only** e mantém um transporte único por
processo (`pool: true`), com `connectionTimeout`/`socketTimeout` de 10 s — sem
timeout, um SMTP que aceita a conexão e não responde segura o `after()` até o
teto da função.

**Nunca use este transporte para autenticação** (confirmação de cadastro,
recuperação de senha): isso é do Supabase Auth (D-11 do PRD), e misturar faz um
aviso comercial competir com o e-mail que deixa alguém entrar no sistema.

### 4.2. O conteúdo do e-mail

`src/lib/mailer/render.ts` — **puro**, sem I/O: `renderSystemEmail(payload)` →
`{ subject, text, html }`.

- Assunto padronizado e ordenável na caixa de entrada:
  `[ZAP CRM BR] Acme Ltda — plano alterado para Profissional (anual)`.
- Corpo em **texto** primeiro (é o que o operador lê no celular), HTML mínimo
  inline — nada de CSS externo, imagem remota ou fonte web: cliente de e-mail
  descarta, e o e-mail cai em spam com mais facilidade.
- Em **pt-BR**, sem `next-intl`: o destinatário é o mantenedor, e carregar o
  runtime de i18n num módulo de servidor puro só para isso é peso sem ganho.
  Fica registrado como o ponto de entrada para o dia em que o e-mail for para o
  cliente final (aí sim, por locale da conta).
- **Nenhum dado de conversa ou contato no corpo.** O aviso diz "a conta X
  estourou a quota de contatos", nunca quem é o contato. Um e-mail atravessa
  servidores de terceiros e fica arquivado para sempre.
- Todo e-mail termina com o link direto para a conta no console
  (`{APP_URL}/admin/accounts/<id>`) — o aviso que não leva à ação vira ruído.

### 4.3. Webhook

`src/lib/notifications/webhook.ts` substitui `src/lib/plans/request-webhook.ts`,
preservando **exatamente** as três garantias que ele já tem: guarda de **SSRF**
(`isDeliverableUrl` de `src/lib/webhooks/ssrf.ts`), `redirect: 'manual'` e
`AbortSignal.timeout(DELIVERY_TIMEOUT_MS)`. A URL vir do `.env` nunca foi motivo
para pular a checagem, e continua não sendo.

```bash
PLAN_REQUEST_WEBHOOK_URL=https://n8n.exemplo.com/webhook/zapcrm   # continua valendo
SYSTEM_EVENT_WEBHOOK_URL=…                                        # alias novo; se as duas existirem, esta vence
```

Assinatura HMAC do corpo (`X-ZapCRM-Signature`), reaproveitando
`src/lib/webhooks/sign.ts`, quando `SYSTEM_EVENT_WEBHOOK_SECRET` estiver
definida — opcional para não quebrar o workflow que já existe sem verificação.

---

## 5. Despacho: duas portas, uma implementação

`src/lib/notifications/dispatch.ts` (server-only) — `deliverPending(now, limit)`:

1. reivindica as linhas devidas (`next_attempt_at <= now`, algum canal
   `pending`) com `UPDATE … RETURNING` — o mesmo padrão de claim de
   `message_retention_state` (SPEC 060 §3.3), que impede duas execuções
   sobrepostas entregarem o mesmo aviso duas vezes;
2. entrega **cada canal separadamente**, marcando só o que foi;
3. no erro, `attempts + 1`, `last_error` e recuo exponencial
   (`next_attempt_at = now + 2^attempts minutos`, teto de 6 h);
4. em `attempts >= 6`, marca `failed` e para — um SMTP com senha errada não
   melhora na décima tentativa, e a linha fica visível no console (§6).

**Porta 1 — `after()` na rota que originou.** O aviso sai em segundos, sem
segurar a resposta. É a entrega normal.

**Porta 2 — fase 6 de `/api/automations/cron`.** Varre pendentes e reentrega. É
a rede de segurança de tudo que a porta 1 perdeu (processo reiniciado, SMTP fora
do ar por dez minutos, evento emitido pelo próprio cron).

O argumento de não criar uma rota de cron nova é o mesmo da SPEC 060 §6 e vale
inteiro aqui: um `cron.schedule` a mais é uma ação manual de todo operador em
produção, inclusive forks — e quem não a fizesse teria avisos que nunca chegam,
sem erro em lugar nenhum.

---

## 6. Interface

O console (SPEC 062) ganha `/admin/notifications`: as últimas 100 linhas da
outbox, com tipo, conta, os dois status, tentativas e erro. Filtro por
`failed` e botão **Reenviar** (zera `next_attempt_at` e `attempts`).

No topo, um `Alert` no padrão do `retention-panel.tsx` quando o SMTP não está
configurado: "e-mail desligado — os avisos estão indo só para o webhook". Sem
esse aviso, a hipótese natural do operador é que o sistema está quebrado, quando
o `.env` é que está incompleto.

`/admin/settings` mostra os canais em modo leitura (host, porta, remetente,
destinatário, URL do webhook mascarada) — **valores de `.env` nunca são
editáveis pela tela** e a senha nunca é devolvida pela API, nem mascarada com o
tamanho real.

i18n: `Platform.notifications.*` em `messages/en.json` (fonte) e
`messages/pt-BR.json` (espelho). O **conteúdo dos e-mails** não passa por
`next-intl` (§4.2).

---

## 7. Núcleo TypeScript

| Arquivo | Responsabilidade |
| --- | --- |
| `src/lib/notifications/types.ts` | `SystemEventType` (união literal), `SystemEventPayload`, `DeliveryStatus` — fonte de verdade |
| `src/lib/notifications/dedupe.ts` | `dedupeKeyFor(event)` — puro. A tabela da §3.1 em código |
| `src/lib/notifications/emit.ts` | **Server-only.** `emitSystemEvent(event)` — grava na outbox (`ON CONFLICT (dedupe_key) DO NOTHING`) e agenda a porta 1 |
| `src/lib/notifications/dispatch.ts` | **Server-only.** `deliverPending()` (§5) |
| `src/lib/notifications/webhook.ts` | Entrega HTTP + SSRF + assinatura (§4.3) |
| `src/lib/notifications/backoff.ts` | `nextAttemptAt(attempts, now)`, `hasGivenUp(attempts)` — puros |
| `src/lib/mailer/config.ts` | Lê e valida o `.env`. Incompleto → `null` + `warn` uma vez. **Nunca lança** |
| `src/lib/mailer/transport.ts` | **Server-only.** Transporte `nodemailer` único por processo |
| `src/lib/mailer/render.ts` | `renderSystemEmail(payload)` → assunto/texto/html. Puro |

### 7.1. Testes obrigatórios

`dedupe.test.ts` — a tabela inteira da §3.1; especialmente que `plan.expiring`
de períodos **diferentes** gera chaves diferentes e que `quota.exceeded` do
mesmo dia gera a mesma (é o teste que impede a enxurrada de D-10).

`backoff.test.ts` — crescimento, teto de 6 h, desistência em 6 tentativas.

`config.test.ts` — `.env` vazio (canal desligado, sem lançar), porta não
numérica, `SMTP_SECURE` em maiúscula/`'1'`, host presente sem destinatário
(também desligado — e-mail sem destino não é configuração parcial, é nenhuma).

`render.test.ts` — um caso por tipo de evento: assunto contém conta e ação;
corpo **não** contém telefone, e-mail de contato nem texto de mensagem
(asserção negativa explícita — é a regra de privacidade da §4.2 virando teste);
link do console presente.

`webhook.test.ts` — payload de `plan.requested` mantém `event:
'plan_change_requested'` e os campos raiz do formato atual (o teste de
compatibilidade da §3.2); URL privada recusada pelo SSRF.

---

## 8. Fases

| Fase | Entrega | Pronto quando |
| --- | --- | --- |
| **F1** | Migração 070: outbox, índices, `purge_system_notifications`, asserções | Suíte verde; nada muda no app |
| **F2** | `types`, `dedupe`, `backoff`, `mailer/config`, `mailer/render` + testes (§7.1) | `npm run test` verde, incluindo as asserções negativas de privacidade |
| **F3** | `emit.ts` + `webhook.ts` (substituindo `request-webhook.ts`) + `dispatch.ts` + fase 6 do cron | Com `.env` vazio: evento gravado, ambos os canais `skipped`, nenhum erro. Com webhook: chega igual ao formato de hoje |
| **F4** | SMTP: `nodemailer`, transporte, entrega, backoff | E-mail chega ao destinatário; SMTP errado → `failed` depois de 6 tentativas, sem afetar o webhook |
| **F5** | Emissão nos pontos: troca/solicitação/cancelamento de plano, bloqueios (SPEC 062), `account.created`, `quota.exceeded` | Cada ação da §3.1 produz exatamente uma linha na outbox |
| **F6** | Ciclo: `plan.expiring`/`expired`/`grace_ended`/`canceled_applied` (junto da fase 5 do cron da SPEC 062 §8) | Rodar o cron dez vezes no mesmo dia → um aviso só |
| **F7** | `/admin/notifications`, alerta de canal desligado, `/admin/settings` em leitura, i18n | `i18n:check` verde; senha do SMTP nunca aparece na resposta da API |
| **F8** | Operação: `cron-jobs.sql` (bloco opcional de purga), `.env` no README, guia de operação atualizado | Guia descreve os dois canais e como diagnosticar um `failed` |

**Migração:** a F1 aplica a 070 — e, pela regra do `AGENTS.md`, **só depois de
confirmar com o mantenedor**, projeto por projeto (`vn`, `rs`, `jh`).

---

## 9. Armadilhas específicas desta SPEC

| Sintoma | Causa provável |
| --- | --- |
| Workflow n8n parou de receber depois do deploy | Campo `event` legado removido do payload de `plan.requested` (§3.2) |
| Mesmo aviso três vezes | `dedupe_key` nulo onde deveria ter chave, ou índice único criado **sem** o `WHERE dedupe_key IS NOT NULL` |
| Aviso de vencimento nunca mais chega depois da renovação | `dedupe_key` sem a data do período na composição (§3.1) |
| Enxurrada de `quota.exceeded` numa importação | Chave sem o `YYYY-MM-DD` (D-10 do PRD) |
| Troca de plano falhando com erro 500 | Entrega feita **dentro** da requisição em vez do `after()` — viola a §1 |
| Cron de automações atrasando | Timeout do SMTP ausente (§4.1): conexão aceita e sem resposta segura o `after()` |
| E-mail em spam | HTML com CSS externo/imagem remota (§4.2), ou remetente sem SPF/DKIM no domínio |
| E-mail chega com dado de contato do cliente | Violação da §4.2 — o teste de `render.test.ts` existe justamente para isso |
| Aviso duplicado com dois processos | Claim da §5 não conferido antes de entregar |
| `.env` incompleto derrubando o cadastro | `mailer/config.ts` lançando em vez de devolver `null` |
| Outbox com milhões de linhas | Purga da §2.2 nunca agendada |
| Tela quebrada só em pt-BR | Chave nova em um dicionário só — `npm run i18n:check` |

---

## 10. Teste manual

1. `.env` sem SMTP → troca de plano funciona, linha na outbox com
   `email_status='skipped'`, webhook entregue.
2. SMTP com senha errada → `failed` após 6 tentativas com recuo crescente;
   `hook_status` permanece `sent` (não reentrega o que já chegou).
3. Webhook apontando para IP privado → recusado pelo SSRF, `failed`, e-mail
   continua saindo.
4. Payload de `plan.requested` conferido campo a campo contra o formato atual.
5. Cron rodado dez vezes no dia do "vence em 7 dias" → um único e-mail.
6. Renovação: novo período gera novo aviso no ciclo seguinte.
7. Reenviar pelo console → entrega e limpa o erro.
8. Corpo do e-mail conferido a olho: nenhum telefone, nome de contato ou texto
   de mensagem.

---

## 11. Variáveis de ambiente

```bash
# E-mail do sistema. Sem SMTP_HOST ou SYSTEM_NOTIFICATION_EMAIL → canal desligado.
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USER=avisos@exemplo.com
SMTP_PASSWORD=…
SMTP_SECURE=false
SMTP_FROM="ZAP CRM BR <avisos@exemplo.com>"
SYSTEM_NOTIFICATION_EMAIL=dono@exemplo.com

# Webhook. A primeira continua valendo (compat); a segunda é o alias novo.
PLAN_REQUEST_WEBHOOK_URL=https://n8n.exemplo.com/webhook/zapcrm
SYSTEM_EVENT_WEBHOOK_URL=
SYSTEM_EVENT_WEBHOOK_SECRET=          # opcional — assina o corpo (HMAC)

# Já existente: usado no link "abrir conta no console" dentro do e-mail.
NEXT_PUBLIC_SITE_URL=https://app.zapcrmbr.com
```

---

## 12. Deixado para depois

- **E-mail para o cliente final** (recibo da troca, aviso de vencimento na caixa
  dele) — a infra nasce pronta; falta locale por conta, remetente verificado no
  domínio e opt-out.
- **Aviso in-app** reaproveitando a tabela `notifications` (027) — o dono da
  conta veria o vencimento sem depender de e-mail.
- **Digest diário** em vez de um e-mail por evento, para quando o volume crescer.
- **Outros canais** (WhatsApp para o próprio mantenedor, Slack) — o webhook já
  cobre via n8n; um canal nativo só se virar rotina.

---

## 13. Validação antes de entregar cada fase

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```
