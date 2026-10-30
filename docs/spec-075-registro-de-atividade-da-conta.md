# SPEC 075 — Registro de atividade da conta: um lugar só para "quem fez o quê"

| Campo            | Valor                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | **Proposta** — aguardando ratificação das decisões D-1…D-16                                                                                                                                               |
| Data             | 2026-09-09                                                                                                                                                                                                |
| Escopo           | Registro append-only de atividade **da conta**: o widget "Atividade recente" do `/dashboard` passa a ler dele, e nasce a página `/activity` com filtros por canal, ator, tipo de recurso, período e busca livre |
| Fora de escopo   | **O console do proprietário da plataforma** (SPEC 062, `platform_audit_log`). É outra trilha, de outro público, com outro dono — não entra aqui nem por leitura nem por escrita (§14)                      |
| Depende de       | SPEC 048/049 (canais e inbox multicanal), SPEC 055 (`webhook_ingest_logs`), SPEC 059 (precedente de trigger de quota), SPEC 060 (retenção), SPEC 062 (papéis, bloqueio, `platform_audit_log`), SPEC 067 (`conversation_exports`), SPEC 074 (`message_deletion_log` — o gatilho deste pedido) |
| Migração         | **084** — `account_activity_log`, seus índices, RLS e as triggers do §3.4 (confirmar `vn`/`rs` com o mantenedor antes de aplicar)                                                                          |
| Dependências npm | Nenhuma. A extensão `pg_trgm` só entra se D-9 for ratificado na opção B                                                                                                                                   |

---

## Contexto

O mantenedor testou a SPEC 074 — apagou uma mensagem enviada, o balão
ficou vermelho, a linha entrou em `message_deletion_log` — e então
perguntou a coisa óbvia: **onde eu vejo isso?**

Não vê. A SPEC 074 §15 deixou explícito que a tela de leitura do log
ficava de fora; hoje aquele registro só existe para quem abre o SQL
editor do Supabase. E o widget que teria o nome certo para mostrar —
"Atividade recente", no `/dashboard` — não serve, porque ele **não é um
log**: é uma consulta ao vivo do estado atual de cinco tabelas.

O pedido, nas palavras do mantenedor: concentrar todo o rastro de
atividade **da conta** em dois lugares —

1. o widget **"Atividade recente"** do `/dashboard`;
2. uma **página nova de detalhes/auditoria**, com filtros por canal, por
   usuário (quem fez a ação), por tipo de recurso (disparo, contato,
   conversa, automação…), por período e um campo de **busca por texto
   livre**.

E, dito com todas as letras: **o console do proprietário fica fora**. A
`platform_audit_log` responde "o que o dono da plataforma fez com as
contas"; esta SPEC responde "o que a minha equipe fez dentro da minha
conta". Público diferente, dono diferente, retenção diferente. Misturar
as duas produziria uma tela em que o admin de uma conta lê a operação
comercial do SaaS.

---

## 1. O fato que decide o desenho inteiro

Dois fatos, na verdade. Cada um mata uma solução aparentemente óbvia.

### 1.1 "Atividade recente" não é um log — é um `ORDER BY … LIMIT 10`

[`loadActivity`](../src/lib/dashboard/queries.ts) dispara cinco consultas
em paralelo e intercala o resultado por timestamp:

| Fonte                                    | Consulta                                          | O que o item significa               |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| RPC `dashboard_recent_inbound`           | 10 mensagens recebidas mais recentes              | "Nova msg de {contato}"              |
| `contacts`                               | `ORDER BY created_at DESC LIMIT 10`               | "Novo contato: {nome}"               |
| `deals`                                  | `ORDER BY updated_at DESC LIMIT 10`               | "Negócio {título} — {estágio atual}" |
| `broadcasts` (`source <> 'webhook'`)     | `ORDER BY created_at DESC LIMIT 5`                | "Broadcast {nome} {status}"          |
| `automation_logs`                        | `ORDER BY created_at DESC LIMIT 10`               | execução da automação                |

Repare no terceiro: `deals` é ordenado por **`updated_at`**, e o texto
mostra o **estágio atual**. Não é "o negócio X foi movido para Proposta
às 14h" — é "o negócio X, que foi tocado às 14h, está hoje em Fechado".
Se alguém mover o mesmo negócio de novo, a linha antiga não vira
histórico: ela é **reescrita**. O mesmo vale para contato editado (não
aparece: `contacts` entra por `created_at`), para conversa reatribuída
(não aparece) e para mensagem apagada (não aparece).

Ou seja: das cinco fontes, só `automation_logs` é um log de verdade. As
outras quatro são o estado presente das tabelas, disfarçado de linha do
tempo. **Consultar mais tabelas ao vivo não conserta isso** — nenhum
`SELECT` sobre `contacts` recupera o nome que o contato tinha antes da
edição, nem o estágio de onde o negócio saiu, porque essa informação
nunca foi gravada.

> Daí a decisão mais importante do documento, e é a D-1: **para o feed
> virar rastro, algum evento precisa ser gravado no instante em que
> acontece.** Não há caminho de leitura que substitua isso.

### 1.2 Metade das ações não passa por rota nenhuma

A tentação seguinte é "então cada rota grava o evento". Não fecha,
porque boa parte das mutações deste app **não passa por rota**: sai do
navegador direto para o PostgREST, com o cliente sujeito à RLS.
Conferido nesta sessão, não presumido:

| Ação                                    | Onde acontece                                                                     | Caminho             |
| --------------------------------------- | --------------------------------------------------------------------------------- | ------------------- |
| Criar/editar contato                    | [`contact-form.tsx:267,280`](../src/components/contacts/contact-form.tsx)         | **navegador → DB**  |
| Excluir contatos em massa               | [`contacts/page.tsx:332`](<../src/app/(dashboard)/contacts/page.tsx>)             | **navegador → DB**  |
| Mover negócio de estágio (kanban)       | [`pipelines/page.tsx:318`](<../src/app/(dashboard)/pipelines/page.tsx>)           | **navegador → DB**  |
| Excluir negócio                         | [`deal-form.tsx:295`](../src/components/pipelines/deal-form.tsx)                  | **navegador → DB**  |
| Criar funil / estágios                  | `pipelines/page.tsx:133,148,365,377`                                              | **navegador → DB**  |
| Etiquetar contato                       | `contact-form.tsx:308,321` (`contact_tags`)                                       | **navegador → DB**  |
| Ativar/desativar/duplicar/excluir automação | `automations/page.tsx:110,130,145`                                             | rota                |
| Apagar mensagem enviada                 | `/api/inbox/messages/[id]/delete`                                                 | rota                |
| Atribuir/transferir conversa            | `/api/inbox/conversations/**`                                                     | rota                |
| Disparar campanha                       | `/api/broadcasts/send`, `/api/broadcasts/cron`                                    | rota / cron         |
| Ingestão por webhook                    | `/api/v1/ingest/contact`                                                          | rota (service_role) |

Este é **exatamente o muro em que a SPEC 059 bateu** ao implementar
quotas: contar contatos no TypeScript não funcionava porque o navegador
insere contato direto, e a solução foi trigger no Postgres
(`enforce_contact_quota`, migração 067 §9). O mesmo raciocínio vale aqui,
e pela mesma razão física.

### 1.3 Consequência: dois escritores, uma tabela

| Escritor                                                       | Cobre                                                                        | O que ele sabe                                                                    | O que ele **não** sabe                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Trigger** no Postgres (`SECURITY DEFINER`)                   | O que o navegador escreve direto: contato, negócio, etiqueta, funil          | `auth.uid()`, a linha `OLD`/`NEW` inteira, portanto o **de → para** de verdade    | Canal usado, motivo, resposta do provedor, intenção ("importação")   |
| **Helper central** `recordActivity()` em `src/lib/activity/`   | O que só a rota/motor sabe: canal, desfecho do provedor, campanha, template  | Todo o contexto de negócio                                                        | Nada que não passe por ele — **uma rota que esquecer não registra**  |

Não é redundância: é divisão de território. A regra desta SPEC é que
**cada tipo de evento tem um escritor só** — a tabela do §4 diz qual — e
a trigger tem uma guarda para não gravar duas vezes o que a rota já
gravou (§3.4).

### 1.4 Inventário: o que o schema já registra hoje

Levantado por varredura de `supabase/migrations/`. Estas tabelas **não
somem** e não são substituídas: continuam donas do detalhe.

| Tabela                                       | Migração | SPEC | Registra                                                  | Vai para o feed?                        |
| -------------------------------------------- | -------- | ---- | --------------------------------------------------------- | --------------------------------------- |
| `message_deletion_log`                       | 083      | 074  | `mark` / `purge` / `revoke_retry` de mensagem             | **Sim** — é o gatilho do pedido         |
| `broadcast_audit_log`                        | 048      | —    | `dispatched`/`scheduled`/`blocked_quota`/`canceled`…      | **Sim**                                 |
| `automation_logs`                            | 006      | —    | execução de automação (`success`/`partial`/`failed`)      | **Sim**, só falhas e primeira execução (§4) |
| `conversation_exports`                       | 077      | 067  | exportação de conversa em PDF/ZIP                          | **Sim**                                 |
| `contact_exports`                            | 064      | 051  | exportação de contatos CSV/XLSX                            | **Sim**                                 |
| `contact_consent_events`                     | 048      | —    | opt-in / opt-out                                           | **Sim**                                 |
| `account_plan_events`, `account_plan_payments` | 067/071 | 059/062 | troca de plano, renovação                                | **Sim** (só o resumo)                   |
| `webhook_ingest_logs`                        | 065      | 055  | **falhas** da ingestão por webhook                         | **Sim**                                 |
| `flow_runs` / `flow_run_events`              | 010      | —    | execução de fluxo, evento a evento                         | Só `started`/`completed`/`error` (§4)   |
| `channel_cold_sends`                         | 062      | —    | envio a frio por canal (contador de segurança)             | **Não** — é medição, não ação           |
| `ai_usage_log`                               | 033      | —    | tokens gastos por IA                                       | **Não** — é medição                     |
| `contact_check_queue`, `evolution_harvested_contacts` | 078 | 069 | fila de checagem, captação                              | Só o resumo do lote (§4)                |
| `system_notifications`                       | 070      | 063  | outbox de e-mail/webhook de eventos de plano               | **Não** — é entrega, e já tem tela      |
| `platform_audit_log`                         | 069      | 062  | o que o **proprietário da plataforma** fez                 | **Nunca** (§14)                         |

Repare no formato: cada uma tem colunas próprias, `CHECK` próprio, RLS
própria (de `is_account_member(account_id)` a `auth.uid() = user_id` em
`automation_logs`, que é de 2025 e escapa por usuário, não por conta) e
`account_id` em umas e não em outras. **Um `UNION ALL` de catorze
tabelas com cinco filtros, busca livre e paginação estável é a coisa que
mata esta página** — cada filtro vira um predicado repetido catorze
vezes, e a paginação por cursor sobre um `UNION` ordenado não usa índice
nenhum. Daí a D-2.

---

## 2. O que já existe e será reusado (nada disto se reescreve)

- **`is_account_member(account_id, min_role)`** (017) — o mesmo predicado
  que toda RLS da casa usa. A RLS do §3.3 é uma linha por causa dele.
- **`src/lib/auth/roles.ts`** — `hasMinRole`, e um predicado novo
  `canViewAccountActivity` entra ali, não inline no componente.
- **`writePlatformAudit`** ([`src/lib/platform/audit.ts`](../src/lib/platform/audit.ts))
  — **o molde do escritor**: união de literais para `action`, e a regra
  "nunca lança" (uma ação sem rastro é ruim; uma ação que falha por causa
  do rastro é pior). `recordActivity()` copia a postura, não o código —
  são tabelas e públicos diferentes.
- **`enforce_contact_quota` / `normalize_contact_created_via`** (067) —
  o molde da trigger `SECURITY DEFINER … OWNER TO postgres`, e a prova de
  que `auth.uid()` chega íntegro dentro dela quando a escrita vem do
  navegador.
- **`ActivityFeed`** ([`activity-feed.tsx`](../src/components/dashboard/activity-feed.tsx))
  — o componente **não é reescrito**: ganha tipos novos em `KIND_THEME`,
  e o `viewAll` deixa de apontar para `/inbox` e passa a apontar para a
  página nova.
- **`WebhookLogSettings`** ([`webhook-log-settings.tsx`](../src/components/settings/webhook-log-settings.tsx))
  — o precedente de UI de log dentro do app: `SettingsPanelHead` + Card +
  lista + `Select` de filtro + `RequireRole` na ação destrutiva. A página
  nova segue essa gramática.
- **`maskPhoneForLog`** — telefone em log é mascarado. Vale aqui também.
- **O cron de retenção** (`/api/messages/retention/cron`, SPEC 060) — é
  onde a varredura do §8 entra, sem rota nova nem agendamento novo.

---

## 3. Modelo de dados — migração 084

### 3.1 `account_activity_log`

```sql
CREATE TABLE IF NOT EXISTS account_activity_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- ---------- QUEM ----------
  actor_kind      TEXT NOT NULL
                    CHECK (actor_kind IN ('user','system','contact','api')),
  -- SET NULL, não CASCADE: o colega sai da equipe, o rastro fica.
  actor_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Congelado no instante do evento — é o que sobra quando o login some,
  -- e é metade do que a busca livre procura (D-9).
  actor_name      TEXT,
  actor_role      TEXT CHECK (actor_role IN ('owner','admin','agent','viewer')),

  -- ---------- O QUÊ ----------
  resource_type   TEXT NOT NULL CHECK (resource_type IN (
                    'message','conversation','contact','deal','broadcast',
                    'automation','flow','channel','member','export',
                    'plan','tag','webhook')),
  action          TEXT NOT NULL,           -- catálogo fechado no §4
  -- SEM FK, de propósito e pelo mesmo motivo da 078/083: o recurso pode
  -- deixar de existir — registrar que ele foi APAGADO é justamente o
  -- caso de uso. ON DELETE CASCADE mataria o registro junto com o que
  -- ele existe para registrar.
  resource_id     UUID,
  resource_label  TEXT,                    -- desnormalizado, 160 chars (D-8)

  -- ---------- ONDE ----------
  channel_id      UUID,                    -- sem FK: instância QR morre, registro fica
  channel_type    TEXT CHECK (channel_type IN ('whatsapp_cloud','whatsapp_qr')),
  conversation_id UUID,
  contact_id      UUID,

  -- ---------- CONTEXTO ----------
  -- Ponteiro para a tabela especializada que tem o detalhe (D-2).
  source_table    TEXT,
  source_id       UUID,
  -- de→para, motivo, contadores. JSONB para não migrar a cada campo novo,
  -- no mesmo espírito de broadcast_audit_log.details.
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Três escolhas que merecem defesa explícita:

1. **`resource_label` desnormalizado.** Sem ele, "campanha Black Friday
   cancelada" vira "campanha `a3f1…` cancelada" no dia em que a campanha
   for apagada — e uma tela de auditoria que só mostra UUID de coisa
   apagada não serve para nada. É o mesmo raciocínio de
   `broadcast_audit_log.broadcast_name` (048) e de
   `message_deletion_log.content_preview` (083).
2. **`source_table`/`source_id` em vez de copiar o detalhe.** O feed
   guarda a frase; a tabela especializada guarda a prova. "Ver detalhes"
   na linha do feed sabe para onde ir sem que esta tabela precise
   conhecer o schema de catorze outras.
3. **Nenhuma FK para o recurso.** Já explicado no comentário, e é a
   mesma decisão que a 083 tomou e documentou.

### 3.2 Índices — um por filtro, `created_at` sempre por último

A página tem cinco filtros combináveis. O `created_at DESC` fecha todos
os índices compostos porque **o período é o filtro que sempre está
ligado** (a tela abre com um intervalo padrão) e a ordenação é sempre a
mesma:

```sql
-- feed sem filtro + filtro só de período (o caminho mais quente)
CREATE INDEX IF NOT EXISTS idx_activity_account_created
  ON account_activity_log (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_account_type_created
  ON account_activity_log (account_id, resource_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_account_actor_created
  ON account_activity_log (account_id, actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Parcial: a maioria dos eventos NÃO tem canal (contato, negócio, plano).
-- O índice fica do tamanho do subconjunto que o filtro de canal alcança.
CREATE INDEX IF NOT EXISTS idx_activity_account_channel_created
  ON account_activity_log (account_id, channel_id, created_at DESC)
  WHERE channel_id IS NOT NULL;

-- Deep-link "atividade deste contato/desta conversa"
CREATE INDEX IF NOT EXISTS idx_activity_account_resource
  ON account_activity_log (account_id, resource_type, resource_id)
  WHERE resource_id IS NOT NULL;
```

A busca livre depende da D-9 e por isso está fora deste bloco.

### 3.3 RLS — o corte de quem vê

```sql
ALTER TABLE account_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_activity_log_select ON account_activity_log;
CREATE POLICY account_activity_log_select ON account_activity_log FOR SELECT
  USING (
    is_account_member(account_id, 'admin')          -- admin/owner: tudo
    OR (actor_user_id = auth.uid())                 -- agente: só o que ELE fez (D-5)
  );
```

**Nenhuma policy de INSERT/UPDATE/DELETE.** Quem grava é o helper com
`service_role` ou a trigger `SECURITY DEFINER` (dona `postgres`, que por
ser dona da tabela não é barrada pela RLS — o mesmo mecanismo que faz
`enforce_contact_quota` escrever em `account_usage_counters`). Log que o
auditado edita não é log — a frase é da 083 e continua valendo.

O braço `actor_user_id = auth.uid()` é o que a D-5 precisa ratificar: ele
é o que permite ao agente ver a própria atividade no widget do dashboard
**sem** ver a do colega ao lado.

### 3.4 As triggers — só para o que o navegador escreve direto

Uma função genérica, chamada por gatilhos específicos:

```sql
CREATE OR REPLACE FUNCTION log_account_activity(
  p_account_id UUID, p_resource_type TEXT, p_action TEXT,
  p_resource_id UUID, p_resource_label TEXT, p_metadata JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid();
BEGIN
  INSERT INTO account_activity_log (
    account_id, actor_kind, actor_user_id, actor_name, actor_role,
    resource_type, action, resource_id, resource_label, metadata
  ) VALUES (
    p_account_id,
    -- service_role e cron não têm auth.uid(): viram 'system'.
    CASE WHEN v_uid IS NULL THEN 'system' ELSE 'user' END,
    v_uid,
    (SELECT full_name FROM profiles WHERE user_id = v_uid),
    (SELECT role::TEXT FROM account_members
      WHERE account_id = p_account_id AND user_id = v_uid),
    p_resource_type, p_action, p_resource_id,
    LEFT(COALESCE(p_resource_label, ''), 160), COALESCE(p_metadata, '{}'::jsonb)
  );
END;
$$;
```

Gatilhos previstos na v1 — e **só estes**:

| Tabela         | Evento                         | Ação gravada           | Guarda                                                                                          |
| -------------- | ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `contacts`     | `AFTER INSERT`                 | `contact.created`      | **Pula quando `created_via IN ('import','audience','api','inbound')`** — ver abaixo              |
| `contacts`     | `AFTER UPDATE`                 | `contact.updated`      | Só quando `name`/`phone`/`email`/`company` mudaram; `metadata` guarda o de→para desses campos    |
| `contacts`     | `AFTER DELETE`                 | `contact.deleted`      | `resource_label` = nome do contato apagado (é a única cópia que sobra)                           |
| `deals`        | `AFTER UPDATE OF stage_id`     | `deal.stage_changed`   | Só quando `OLD.stage_id IS DISTINCT FROM NEW.stage_id`; `metadata` = `{from, to}` com os nomes   |
| `deals`        | `AFTER INSERT` / `AFTER DELETE`| `deal.created/deleted` | —                                                                                                 |
| `contact_tags` | `AFTER INSERT` / `AFTER DELETE`| `contact.tagged/untagged` | Ver D-7: entra na v1 ou fica para a fase seguinte                                              |

> **A guarda de `created_via` é o que impede a importação de 10 000
> contatos virar 10 000 linhas de feed.** Uma importação é **um** evento
> humano ("Fulano importou uma planilha com 10 000 contatos") e é a rota
> de importação que grava essa única linha, via helper. A trigger só
> registra o contato criado **à mão**, um a um, na tela. Mesma lógica
> para `created_via = 'inbound'` (contato que nasceu de uma mensagem
> recebida — isso já é a linha de mensagem no feed) e para `'api'`
> (quem chama a API tem `webhook_ingest_logs` e o funil).

Duas coisas que a trigger **não** consegue e que ninguém deve esperar
dela: o **canal** usado (não está na linha de `contacts`) e o **motivo**
(não existe no `NEW`). Evento nascido de trigger tem `channel_id NULL` e
`metadata` magro — é o preço de cobrir um caminho de escrita que não
passa por código nosso.

### 3.5 O que **não** entra na migração

- Nenhuma coluna nova em `messages`, `contacts`, `deals` ou `broadcasts`.
- Nenhuma alteração nas catorze tabelas do §1.4 — elas continuam
  exatamente como estão, com a RLS que têm.
- **Nenhum backfill.** Ver D-4: o registro começa no dia em que a
  migração roda, e a tela diz isso na cara.

---

## 4. Catálogo de eventos da v1

Um catálogo fechado (união de literais no TypeScript, `CHECK`
implícito pela disciplina do helper) — **não** uma `action` de texto
livre. Texto livre num log é o que produz `contact_updated`,
`contact.update` e `contactUpdated` convivendo na mesma coluna seis meses
depois, e aí nenhum filtro funciona.

| `resource_type` | `action`                                  | Escritor | Fonte de detalhe (`source_table`) |
| --------------- | ----------------------------------------- | -------- | --------------------------------- |
| `message`       | `message.deleted`                         | helper   | `message_deletion_log`            |
| `message`       | `message.purged`                          | helper   | `message_deletion_log`            |
| `message`       | `message.deleted_by_contact`              | helper   | `message_deletion_log`            |
| `conversation`  | `conversation.assigned`                   | helper   | —                                 |
| `conversation`  | `conversation.transferred`                | helper   | —                                 |
| `conversation`  | `conversation.exported`                   | helper   | `conversation_exports`            |
| `contact`       | `contact.created` / `updated` / `deleted` | trigger  | —                                 |
| `contact`       | `contact.imported` (lote, 1 linha)        | helper   | —                                 |
| `contact`       | `contact.exported`                        | helper   | `contact_exports`                 |
| `contact`       | `contact.opted_out` / `opted_in`          | helper   | `contact_consent_events`          |
| `deal`          | `deal.created` / `stage_changed` / `deleted` | trigger | —                                |
| `broadcast`     | `broadcast.created`                       | helper   | —                                 |
| `broadcast`     | `broadcast.dispatched`                    | helper   | `broadcast_audit_log`             |
| `broadcast`     | `broadcast.scheduled` / `canceled` / `blocked` | helper | `broadcast_audit_log`           |
| `automation`    | `automation.enabled` / `disabled`         | helper   | —                                 |
| `automation`    | `automation.created` / `updated` / `deleted` | helper | —                                |
| `automation`    | `automation.failed`                       | helper   | `automation_logs`                 |
| `flow`          | `flow.activated` / `deactivated`          | helper   | —                                 |
| `flow`          | `flow.run_failed`                         | helper   | `flow_run_events`                 |
| `channel`       | `channel.connected` / `disconnected` / `deleted` | helper | —                              |
| `channel`       | `channel.default_changed`                 | helper   | —                                 |
| `member`        | `member.invited` / `joined` / `role_changed` / `removed` | helper | —                    |
| `webhook`       | `webhook.ingest_failed`                   | helper   | `webhook_ingest_logs`             |
| `plan`          | `plan.changed` / `renewed` / `requested`  | helper   | `account_plan_events`             |

**O que fica explicitamente fora da v1** (e é decisão, não esquecimento
— ver D-7 e §14): cada mensagem enviada ou recebida (é a tabela
`messages` inteira, duplicada), cada passo de fluxo, cada execução
bem-sucedida de automação, abrir/ler uma conversa, login/logout,
alteração de configuração de IA, edição de template, criação de resposta
rápida, mudança de etiqueta na conta (a etiqueta em si, não o contato
etiquetado).

---

## 5. O escritor central — `src/lib/activity/record.ts`

```ts
export interface ActivityEntry {
  accountId: string;
  action: ActivityAction;           // união fechada do §4
  resourceType: ActivityResourceType;
  resourceId?: string | null;
  resourceLabel?: string | null;    // truncado em 160 pelo helper
  actor:
    | { kind: 'user'; userId: string; name?: string; role?: AccountRole }
    | { kind: 'system'; name?: string }   // cron, motor
    | { kind: 'api'; keyId: string }      // API pública v1
    | { kind: 'contact'; contactId: string };
  channelId?: string | null;
  channelType?: ChannelType | null;
  conversationId?: string | null;
  contactId?: string | null;
  source?: { table: string; id: string } | null;
  metadata?: Record<string, unknown>;
}

/** Nunca lança. Uma ação sem rastro é ruim; uma ação que falha por
 *  causa do rastro é pior (mesma postura de writePlatformAudit). */
export async function recordActivity(
  db: SupabaseClient,
  entry: ActivityEntry
): Promise<void>;
```

Regras que o teste co-locado (`record.test.ts`) trava:

1. **`resourceLabel` truncado em 160** e telefone passado por
   `maskPhoneForLog` antes de virar rótulo.
2. **`metadata` nunca carrega segredo** — nem token de canal, nem
   `Authorization`, nem conteúdo de mensagem (o preview de conteúdo é
   assunto de `message_deletion_log`, que já decidiu isso na D-15 da 074).
   Uma lista de chaves proibidas é verificada em runtime, não só por
   convenção.
3. **`metadata` truncado em 4 KB.** Sem teto, um `details` de campanha
   com 3 000 destinatários entra inteiro na tabela do feed.
4. **`actor.kind === 'user'` exige `userId`** — sem ator não há coluna a
   filtrar, e o evento vira ruído não filtrável.
5. **Nunca lança.** Falha grava `console.error` e segue. O custo dessa
   escolha é honesto e precisa estar escrito na tela: **o log pode ter
   buracos** (D-12).

Consumidores da v1 — a lista de rotas que passam a chamar o helper está
nas fases F3/F4 (§12).

---

## 6. Leitura

### 6.1 `src/lib/activity/query.ts` — a regra de negócio, testável

```ts
export interface ActivityFilters {
  from?: string;  to?: string;          // ISO; padrão = últimos 30 dias
  actorUserId?: string;
  resourceTypes?: ActivityResourceType[];
  channelIds?: string[];
  search?: string;                       // D-9
  cursor?: string;                       // paginação por (created_at, id)
  limit?: number;                        // teto 100
}
```

Paginação **por cursor `(created_at, id)`**, não por `OFFSET`: um log
recebe linhas novas enquanto o operador pagina, e `OFFSET` faz a página 2
repetir linhas que a página 1 já mostrou. O `id` desempata o mesmo
milissegundo.

### 6.2 A rota `GET /api/account/activity`

Segue o molde de `/api/account/webhook-logs` (SPEC 055): cliente de
sessão (RLS ligada — a policy do §3.3 é a autoridade, o guarda de papel
na rota é a segunda tranca, não a primeira), `requireRole` conforme D-5,
mensagens de erro **em inglês** (padrão de `/api/**`), resposta com
`items` + `nextCursor` + `total` aproximado.

Junções feitas do lado do servidor, não pelo `select` embutido do
PostgREST: `profiles` (nome do ator, quando `actor_user_id` ainda existe)
e `channels` (nome do canal). O `actor_name`/`resource_label` congelados
são o *fallback* quando a junção não acha nada — e não achar nada é o
caso normal para quem saiu da equipe.

---

## 7. Interface

### 7.1 O widget "Atividade recente" muda de fonte, não de forma

- `loadActivity()` deixa de disparar cinco consultas e passa a fazer
  **uma**, em `account_activity_log`, com `limit` 50 (o mesmo teto que o
  seletor `5 / 10 / 20 / 50` do rodapé já assume hoje).
- `ActivityKind` cresce de cinco (`message | contact | deal | broadcast |
  automation`) para o conjunto de `resource_type` do §3.1, e `KIND_THEME`
  ganha ícone/cor para cada um. O componente em si não muda.
- O texto do item deixa de ser montado com string interpolada em
  português dentro de `queries.ts` (que é o que existe hoje — `` `Novo
  contato: ${…}` ``, fora do i18n) e passa a ser **uma chave de tradução
  por `action`**, com os valores vindo de `metadata`/`resource_label`.
  Isto conserta, de lambuja, um furo de i18n que existe hoje no widget.
- `viewAll` deixa de apontar para `/inbox` e aponta para a página nova.
- **Estado vazio honesto**: enquanto a tabela for jovem, o widget diz que
  o registro começou em tal data, em vez de fingir que nada aconteceu na
  conta (D-4).

### 7.2 A página `/activity`

Layout no molde de `/contacts` (barra de filtros no topo, lista densa,
paginação no rodapé), não no molde de `/settings` — não é configuração.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Atividade da conta                                    [Exportar CSV]?│  ← D-13
├──────────────────────────────────────────────────────────────────────┤
│ [Período ▾] [Usuário ▾] [Tipo ▾] [Canal ▾]   [🔍 Buscar…]  [Limpar]  │
├──────────────────────────────────────────────────────────────────────┤
│ 09/09 14:32  ⛔ Bruno (admin)  apagou uma mensagem          Vendas   │
│              "segue o link do orça…"        · Revogada    [detalhes] │
│ 09/09 14:10  👤 Marina (agent) editou o contato Ana Paula            │
│              telefone: (11) 9•••• → (11) 9••••              [ver]    │
│ 09/09 13:58  📻 Sistema        disparou "Black Friday" (312)  Cloud  │
│ 09/09 11:02  💼 Bruno (admin)  moveu "Loja X" Proposta → Fechado     │
├──────────────────────────────────────────────────────────────────────┤
│ 4 de ~1 240 eventos · 30 dias                          [Carregar +]  │
└──────────────────────────────────────────────────────────────────────┘
```

Cada linha: hora, ícone por `resource_type`, ator (nome + papel), frase
traduzida, canal quando existe, e um destino — deep-link para o recurso
quando ele ainda existe (`/inbox?c=…`, `/contacts`, `/broadcasts/[id]`),
ou expansão do `metadata` quando não existe mais.

### 7.3 Os filtros, e o que cada um custa

| Filtro         | Fonte das opções                              | Índice que serve                        | Armadilha                                                                                            |
| -------------- | --------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Período**    | Presets (hoje, 7d, 30d, 90d) + intervalo livre | Todos — `created_at DESC` fecha cada um | Fuso: o corte é feito em UTC no servidor a partir do intervalo local; é o mesmo bug que a 067 já corrigiu uma vez |
| **Usuário**    | `account_members` ⋈ `profiles`                | `idx_activity_account_actor_created`    | Precisa oferecer **"Sistema"** e **membros que saíram** (`actor_user_id` órfão, mas `actor_name` congelado) |
| **Tipo**       | Constante do §3.1 (não consulta o banco)      | `idx_activity_account_type_created`     | Multi-seleção vira `IN (…)`, que ainda usa o índice                                                  |
| **Canal**      | `channels` da conta                           | `idx_activity_account_channel_created` (parcial) | **A maioria dos eventos não tem canal.** Filtrar por canal esconde contato, negócio, plano — a tela precisa dizer isso (D-10) |
| **Busca livre**| —                                             | Ver D-9                                 | É o filtro caro; ver abaixo                                                                          |

### 7.4 A busca livre — o que ela procura

Procura em **`resource_label` e `actor_name`**: "Black Friday", "Ana
Paula", "Marina". **Não** procura em `metadata` (JSONB inteiro), e não
procura no conteúdo de mensagem — que não está aqui.

Duas implementações possíveis, e é a D-9:

- **(A) `ILIKE '%termo%'` sem índice.** Zero migração extra. Varre o
  conjunto **já recortado pelo período e pelos outros filtros** — que é o
  ponto: a busca nunca roda sozinha sobre a tabela inteira, porque a tela
  sempre tem um período ativo. Aceitável até a casa dos ~10⁵ eventos por
  conta, que é onde este produto vive.
- **(B) `pg_trgm` + índice GIN.** Rápido em qualquer tamanho, tolera
  digitação parcial — ao custo de uma extensão a mais no banco e de um
  índice que pesa mais que a tabela em escrita.

Recomendo **(A) agora, (B) quando doer**, com a consulta escrita de um
jeito que a troca seja um `CREATE INDEX` e nenhuma linha de TypeScript.

### 7.5 Onde a página fica

Item novo no menu lateral (`sidebar.tsx`), depois de `/dashboard`, ícone
`ScrollText`, visível conforme D-5. **Não** entra no rail de
`/settings`: o rail é para configuração, e o `SECTION_META` já tem
catorze itens.

---

## 8. Volume e retenção

Estimativa honesta, para uma conta ativa de porte médio (5 agentes,
2 000 contatos, 3 campanhas/mês) com o catálogo do §4:

| Origem                                | Eventos/mês (ordem de grandeza) |
| ------------------------------------- | ------------------------------- |
| Contato criado/editado à mão          | 200–600                         |
| Negócio movido no kanban              | 300–900                         |
| Conversa atribuída/transferida        | 400–1 200                       |
| Campanha, automação, canal, membro    | 50–200                          |
| Mensagem apagada, exportação, opt-out | 20–100                          |
| **Total**                             | **~1 000–3 000/mês**            |

Isto é uma tabela pequena — a decisão de **não** registrar mensagem a
mensagem é o que a mantém assim. Ainda assim, ela cresce para sempre, e é
a única tabela desta SPEC que cresce sem teto.

Proposta (D-6): **regra própria, não a da SPEC 060.** A SPEC 060 recorta
por conta × **tipo de canal**, porque conversa é do canal; atividade não
é. Em vez disso:

- `ACTIVITY_LOG_RETENTION_DAYS` no `.env`, **padrão 180**, `0` = nunca
  apagar;
- a varredura é uma sentença a mais dentro do cron que já existe
  (`/api/messages/retention/cron`) — **sem rota nova, sem agendamento
  novo**, o que importa num deploy em que o `pg_cron` do projeto `vn`
  nunca foi instalado;
- **nasce desligada**, como a 060 nasceu: a migração 084 não apaga uma
  linha sequer.

---

## 9. Quem vê o quê — a pergunta de LGPD

Não é detalhe de permissão: é a diferença entre uma tela de auditoria e
uma tela de vigilância entre colegas.

- **Admin/owner** veem toda a atividade da conta. Justificativa legítima
  (art. 7º, IX — legítimo interesse do controlador na segurança e
  auditoria da própria operação), e é o mesmo corte que
  `message_deletion_log` já adotou.
- **Agent** vê, no máximo, **a própria atividade** — o braço
  `actor_user_id = auth.uid()` da RLS. Um agente ver que o colega ao lado
  editou 40 contatos ontem não serve a nenhuma finalidade do produto e
  transforma o feed num painel de produtividade alheia.
- **Viewer** não vê a página. É um papel de leitura de dados
  operacionais, não de auditoria de pessoas.
- **Contato** nunca é ator com nome próprio no sentido de vigilância: o
  `actor_kind = 'contact'` existe para eventos como "o contato apagou uma
  mensagem" (074 §9), e o rótulo é o contato mesmo, com telefone
  mascarado.
- **A exclusão da conta (SPEC 073) leva tudo junto**: `ON DELETE CASCADE`
  em `account_id`. Está certo e é intencional — o rastro é dado da conta.

---

## 10. i18n

Namespace novo `Activity` em `messages/en.json` (fonte da verdade) e
`messages/pt-BR.json`, com três blocos:

- `Activity.page` — título, filtros, rótulos de período, estados vazios,
  "carregar mais", o aviso do §7.1 sobre a data em que o registro começou,
  e o contador de eventos sem canal (D-10);
- `Activity.actions.<action>` — **uma chave por linha do catálogo do §4**,
  com placeholders (`{actor}`, `{label}`, `{from}`, `{to}`, `{count}`).
  São ~30 chaves, e são elas que tiram o português cru de dentro de
  `queries.ts`;
- `Activity.resourceTypes.<type>` — rótulo do filtro de tipo.

Mais `Sidebar.activity`. Erros de `/api/account/activity` em **inglês**;
a UI traduz pelo código. `npm run i18n:check` fecha a paridade — são
~1 600 chaves hoje e o script falha se um dicionário divergir do outro.

---

## 11. Decisões que precisam de ratificação

| #        | Decisão                                                                                              | Recomendação (aguardando ratificação)                                                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-1**  | Tabela de eventos nova, ou continuar lendo várias tabelas ao vivo?                                   | **Tabela nova** (`account_activity_log`). Nenhuma consulta ao vivo recupera o estágio de onde o negócio saiu nem o nome que o contato tinha — a informação nunca foi gravada (§1.1). Sem gravar evento, "atividade recente" continua sendo estado atual disfarçado de linha do tempo         |
| **D-2**  | As catorze tabelas de log já existentes: `UNION` na leitura, ou linha-resumo no feed (write-through)? | **Write-through**: o feed guarda a frase + `source_table`/`source_id`; a tabela especializada continua dona do detalhe. `UNION ALL` de catorze schemas diferentes com cinco filtros, busca e paginação estável não usa índice nenhum (§1.4)                                                   |
| **D-3**  | Quem grava: cada rota direto, ou um helper central?                                                  | **Helper central `recordActivity()` para rota/motor + trigger no Postgres para o que o navegador escreve direto.** Não é redundância: contato, negócio e etiqueta **não passam por rota nenhuma** (§1.2) — helper sozinho perderia metade dos eventos, exatamente como aconteceu com a quota na SPEC 059 |
| **D-4**  | Fazer backfill do histórico existente?                                                               | **Não.** Backfill de `contacts.created_at` produziria "criado" sem ator e sem canal, e nada de "editado"/"movido" — histórico falso é pior que histórico ausente. O registro começa na data da migração, e a tela **diz isso** (§7.1)                                                        |
| **D-5**  | Quem vê a página e o widget?                                                                         | **Página: admin/owner** (espelha `message_deletion_log`). **Widget: agent vê só a própria atividade** (braço `actor_user_id = auth.uid()` na RLS). **Viewer não vê a página.** É a decisão de LGPD do §9 e precisa da sua palavra                                                            |
| **D-6**  | Retenção: entra na SPEC 060 ou tem regra própria?                                                    | **Regra própria** — a 060 recorta por tipo de canal, e atividade não é do canal. `ACTIVITY_LOG_RETENTION_DAYS`, padrão **180**, `0` = nunca; varredura pendurada no cron de retenção que já existe; **nasce desligada** (§8). Ratificar o prazo                                              |
| **D-7**  | Escopo de eventos da v1                                                                              | **O catálogo do §4** (~28 ações). Fora: cada mensagem enviada/recebida, cada passo de fluxo, execução bem-sucedida de automação, leitura de conversa, login/logout, edição de template/resposta rápida/config de IA. `contact.tagged/untagged` é o item de fronteira — **cabe na v1?**        |
| **D-8**  | Guardar `resource_label` desnormalizado?                                                             | **Sim, 160 caracteres.** Sem ele, "campanha Black Friday cancelada" vira UUID no dia em que a campanha for apagada — e é justamente o recurso apagado que a auditoria precisa nomear. Mesmo raciocínio de `broadcast_audit_log.broadcast_name`                                               |
| **D-9**  | Busca livre: onde procura e com qual índice?                                                         | Procura em **`resource_label` + `actor_name`**, nunca em `metadata` nem em conteúdo de mensagem. **(A) `ILIKE` sem índice agora** — a busca sempre roda sobre o recorte de período; **(B) `pg_trgm` + GIN** quando doer. Ratificar se pode entrar extensão nova no banco                       |
| **D-10** | Filtro de canal esconde os eventos sem canal?                                                        | **Sim, esconde** — filtro é filtro. Mas a tela mostra "N eventos sem canal ocultos por este filtro", senão o operador conclui que o contato criado hoje sumiu                                                                                                                                |
| **D-11** | Registrar leitura (quem abriu/exportou o quê)?                                                       | **Exportação sim** (conversa e contatos — as duas já têm tabela própria); **abrir conversa não** — o volume é a tabela `messages` de novo, e a finalidade seria vigiar agente, não auditar mudança                                                                                             |
| **D-12** | Falha ao gravar o evento derruba a ação do usuário?                                                  | **Nunca** (postura de `writePlatformAudit`). O preço é que o log pode ter buracos, e isso precisa estar escrito na tela — um log que se apresenta como completo sendo incompleto é pior que um que avisa                                                                                       |
| **D-13** | "Exportar CSV" na página nova?                                                                       | **Recomendo deixar para a fase seguinte.** A infraestrutura existe (SPEC 051), mas exportar auditoria é dado de pessoa saindo do sistema — merece a mesma conversa de LGPD do §9, não um botão de brinde                                                                                       |
| **D-14** | Endereço da página: `/activity` no menu, ou `/settings?tab=activity`?                                | **`/activity`, item novo no menu lateral.** Não é configuração, e o rail de Settings já tem catorze itens. Custo: mais um item no menu — **é sua chamada**                                                                                                                                    |
| **D-15** | A API pública `/api/v1` ganha leitura do log?                                                        | **Fora de escopo na v1.** Entraria com escopo novo (`activity:read`) e obrigaria as três edições de `docs/public-api.md` + os dois `openapi*.json`. Vale uma fase própria depois que o catálogo assentar                                                                                       |
| **D-16** | Migração 084 — em quais projetos aplicar?                                                            | **Perguntar antes de aplicar** (regra do AGENTS.md). `vn` e `rs` estão sincronizados até a 083; `jh` foi descontinuado. Nenhum `apply_migration` sem a sua confirmação explícita                                                                                                              |

---

## 12. Fases

| Fase    | Entrega                                                                                                                                                | Verificação                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **F1**  | Migração **084**: `account_activity_log`, os cinco índices, RLS do §3.3, `log_account_activity()` + as triggers do §3.4, bloco de asserções finais      | `typecheck`; tabela, índices e políticas presentes; trigger dispara em `INSERT` manual |
| **F2**  | `src/lib/activity/types.ts` (catálogo do §4 como união fechada) + `record.ts` + `record.test.ts` (truncagem, máscara de telefone, chaves proibidas, "nunca lança") | `test`                                                                          |
| **F3**  | Helper ligado ao **caminho quente**: apagar mensagem (074), atribuir/transferir conversa, disparar/agendar/cancelar campanha, exportações               | `test` das rotas; linhas conferidas por SQL                                     |
| **F4**  | Helper ligado ao **resto** do catálogo: automação, fluxo, canal, membro, plano, `webhook.ingest_failed`, importação de contatos (a linha-resumo do §3.4) | `test`                                                                          |
| **F5**  | `query.ts` + `query.test.ts` (cursor estável, cada filtro, combinação de filtros, fuso do período) + `GET /api/account/activity` + `route.test.ts`      | `test`; `curl` autenticado como owner, admin, agent e viewer                    |
| **F6**  | Widget: `loadActivity` passa a ler a tabela nova, `ActivityKind` cresce, textos saem do i18n, `viewAll` aponta para `/activity`, estado vazio honesto   | Navegador; `queries.test.ts` atualizado                                         |
| **F7**  | Página `/activity`: lista, cinco filtros, busca, paginação por cursor, deep-links, item no `sidebar.tsx` conforme D-5/D-14                              | Navegador, quatro papéis                                                        |
| **F8**  | Retenção (§8): `ACTIVITY_LOG_RETENTION_DAYS`, varredura no cron existente, `README` atualizado                                                          | `test`; prévia (dry-run) antes de qualquer apagamento                           |
| **F9**  | i18n (en + pt-BR, ~40 chaves) e gate completo                                                                                                          | `typecheck && i18n:check && lint && test && format:check && build`               |
| **F10** | Teste manual (§13)                                                                                                                                     | Checklist assinado pelo mantenedor                                              |

A migração 084 **só depois de confirmar com o mantenedor** em qual
projeto Supabase aplicar (D-16). Conferir `ls supabase/migrations/` na
hora de escrever a F1: 083 era a última nesta sessão, mas o número livre
pode ter mudado.

---

## 13. Teste manual (§F10) — 14 itens, quatro papéis, dois canais

1. **A trigger pega o que a rota não vê.** Criar um contato à mão pela
   tela. Esperado: linha `contact.created` com `actor_user_id` **do
   usuário logado** (não NULL) e `actor_role` correto — provando que
   `auth.uid()` chega dentro da trigger a partir do navegador.
2. **Edição registra o de→para.** Editar o telefone desse contato pelo
   modal. Esperado: `contact.updated` com `metadata` trazendo o valor
   antigo e o novo, **ambos mascarados**; e o rótulo não vaza o número
   inteiro.
3. **Exclusão sobrevive ao recurso.** Excluir o contato. Esperado:
   `contact.deleted` com `resource_label` = nome do contato — e as linhas
   dos itens 1 e 2 **continuam lá**, sem virar NULL (prova de que não há
   FK com `CASCADE`).
4. **Kanban.** Arrastar um negócio de estágio. Esperado:
   `deal.stage_changed` com `{from: "Proposta", to: "Fechado"}` nos
   **nomes**, não em UUID.
5. **Importação não inunda.** Importar uma planilha com 500 contatos.
   Esperado: **uma** linha `contact.imported` com `{count: 500}` — e
   **nenhuma** linha `contact.created` (a guarda de `created_via` do
   §3.4). Conferir `SELECT count(*)`.
6. **O gatilho original desta SPEC.** Apagar uma mensagem enviada (074).
   Esperado: `message.deleted` no feed do dashboard **e** na página, com
   canal preenchido, e "detalhes" levando à linha correspondente em
   `message_deletion_log`.
7. **Ator "Sistema".** Deixar o cron disparar uma campanha agendada.
   Esperado: `broadcast.dispatched` com `actor_kind = 'system'`, sem
   `actor_user_id`, e o filtro de usuário oferecendo "Sistema" como opção.
8. **Membro que saiu.** Remover um membro que gerou eventos. Esperado: as
   linhas dele continuam, `actor_user_id` vira NULL, e a tela exibe o
   `actor_name` **congelado** em vez de "Desconhecido".
9. **Os cinco filtros, combinados.** Período 7 dias + usuário Marina +
   tipo `contact` + busca "Ana". Esperado: resultado coerente; e o
   `EXPLAIN` da consulta usando `idx_activity_account_actor_created` ou
   `idx_activity_account_type_created`, não `Seq Scan`.
10. **Filtro de canal e o aviso.** Filtrar por um canal. Esperado: os
    eventos de contato/negócio somem **e a tela avisa quantos ocultou**
    (D-10).
11. **Paginação estável.** Abrir a página, gerar um evento novo em outra
    aba, clicar "Carregar mais". Esperado: **nenhuma linha repetida**
    entre as páginas (o teste que `OFFSET` reprova e o cursor passa).
12. **RLS de verdade, pelo navegador.** Como **agent**: no widget, ver só
    as próprias ações; a página, conforme D-5. Como **viewer**: sem
    acesso. E, nos dois casos, `supabase.from('account_activity_log')
    .select('*')` **direto pelo console do browser** devolve só o
    permitido — a rota não é a única tranca.
13. **Log imutável.** Como admin, tentar `UPDATE`/`DELETE` em
    `account_activity_log` pelo cliente do navegador: barrado (só
    `SELECT`).
14. **Retenção não apaga sozinha.** Com `ACTIVITY_LOG_RETENTION_DAYS`
    ausente do `.env`, rodar o cron de retenção. Esperado: **zero** linhas
    de atividade apagadas. Depois, com o valor definido, rodar a prévia e
    conferir o número **antes** de deixar apagar.

SQL de conferência:

```sql
-- o feed cru, do jeito que a página lê
SELECT created_at, actor_kind, actor_name, actor_role,
       resource_type, action, resource_label,
       channel_type, source_table, metadata
FROM account_activity_log
WHERE account_id = '<uuid>'
ORDER BY created_at DESC, id DESC
LIMIT 40;

-- a inundação do item 5 não aconteceu
SELECT action, count(*)
FROM account_activity_log
WHERE account_id = '<uuid>' AND resource_type = 'contact'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY action;

-- o item 9 usa índice
EXPLAIN ANALYZE
SELECT * FROM account_activity_log
WHERE account_id = '<uuid>'
  AND resource_type = 'contact'
  AND created_at >= NOW() - INTERVAL '7 days'
ORDER BY created_at DESC LIMIT 50;
```

---

## 14. Fora de escopo

- **O console do proprietário da plataforma (SPEC 062).**
  `platform_audit_log` não é lida por esta tela, não é escrita por este
  helper e não aparece neste feed. São trilhas paralelas de públicos
  distintos: o dono da plataforma auditando contas de um lado; o dono da
  conta auditando a própria equipe do outro. **Pedido explícito do
  mantenedor**, e é a decisão certa mesmo sem o pedido.
- **Mensagem a mensagem no feed.** É a tabela `messages` duplicada. Quem
  quer isso quer o inbox, que já existe e é melhor nisso.
- **Login, logout e sessão.** É auditoria de autenticação, mora no
  Supabase Auth e tem outra retenção. `sessions-card.tsx` já mostra o que
  o produto precisa hoje.
- **Diff campo a campo genérico** ("versionamento de linha"). O
  `metadata` guarda o de→para dos campos que a trigger observa (§3.4) —
  não é um histórico de versões do recurso. Isso é outra SPEC, e o
  modelo de dados é outro (o mesmo problema que a 074 §15 apontou para
  "editar mensagem enviada").
- **Alertas/notificação a partir do feed** ("me avise quando alguém
  excluir contatos em massa"). Precisa de regra, canal de entrega e
  deduplicação — a SPEC 063 já tem o outbox, mas ligar as duas é trabalho
  próprio.
- **Exportar a auditoria** (D-13) e **leitura pela API pública** (D-15).
- **Backfill** (D-4).
