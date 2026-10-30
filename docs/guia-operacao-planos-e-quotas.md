# Guia de operação — planos e quotas (SPEC 059)

> Como o **operador** (o mantenedor, não o cliente) liga/desliga o motor de
> quotas, cadastra planos, atribui plano a uma conta, concede exceções e
> resolve pedidos de troca. Para o desenho técnico completo, veja
> [`docs/spec-059-motor-de-quotas.md`](./spec-059-motor-de-quotas.md).

---

## 0. Configurações da plataforma (`platform_settings`)

Toda instância do ZAP CRM BR tem exatamente **uma linha** na tabela `platform_settings` — ela centraliza 11 configurações globais que afetam todas as contas de uma vez. Não são `.env` (redeploy) nem SQL direto (risco); o console (`/admin/settings`, SPEC 062 §12) edita a maioria delas sem parar o servidor.

### 0.1. Os 11 campos — o que cada um faz

| Campo | Tipo | Default | Escrita | Impacto |
| --- | --- | --- | --- | --- |
| **id** | BOOLEAN PK | TRUE | Jamais | Garante linha única |
| **quotas_enforced** | BOOLEAN | FALSE | Console + SQL | ⚠️ Liga/desliga TODO motor de quotas — ver §3 |
| **default_plan_code** | TEXT | `'unlimited'` | Console | Plano padrão para contas novas e canceladas |
| **default_yearly_discount_percent** | INTEGER (0–100) | 17 | Console | Desconto % anual que planos sem próprio valor herdam |
| **support_email** | TEXT | NULL | Console | E-mail no rodapé da página `/blocked`; sem valor = bloqueado sem contato |
| **grace_days** | INTEGER (≥0) | 7 | Console | Dias de carência após vencimento (`past_due`); bloqueio automático não existe (D-7) |
| **self_service_enabled** | BOOLEAN | TRUE | Console | TRUE = cliente troca de plano na hora (§10 abaixo); FALSE = fila de aprovação |
| **retention_defaults** | JSONB | `{}` | Console | Padrão global de limpeza de mensagens por canal — cadeia: política da conta → **este campo** → `.env` → sem limite |
| **payment_instructions** | TEXT | NULL | Console | Instruções de pagamento (ex.: Pix, boleto) — só informação, ainda não consumido em tela alguma |
| **billing_contact** | TEXT | NULL | Console | Contato de cobrança — só informação, uso interno/comercial |
| **updated_at** | TIMESTAMPTZ | NOW() | Auto | Timestamp da última mudança |

### 0.2. Criticidade — o que quebra se ficar errado

**🔴 Crítica (afeta enforcement direto):**
- `quotas_enforced = FALSE` → nenhuma quota é aplicada, toda conta age como ilimitada — perfeito para preparação sem risco, perigoso se esquecido ligado
- `default_plan_code` inválido (código que não existe em `plans.code`) → conta nova falha ao nascer; conta cancelada fica pendurada

**🟠 Alta (experiência quebrada):**
- `support_email` vazio quando há bloqueio → pessoa bloqueada fica sem saber para quem reclamar, gera suporte excessivo
- `self_service_enabled = FALSE` mas ninguém aprova solicitações → cliente fica meses em "pendente" invisível

**🟡 Média (degrada recursos específicos):**
- `grace_days` muito grande (ex.: 180) → conta permanece `past_due` por meses antes de final warning
- `retention_defaults` sem configuração + `.env` sem `MESSAGE_RETENTION_ENABLED` → mensagens nunca são limpas, custo de storage cresce

**🟢 Baixa (só informação):**
- `payment_instructions` e `billing_contact` vazios → não há consumidor na UI ainda, não afeta função

### 0.3. Como editar `platform_settings`

**Porta 1: Console web (recomendado)**
```
/admin/settings → seção "Configurações da plataforma"
```
Todos os campos editem sozinhos ao perder foco, com mudança gravada em `platform_audit_log`. O "switch" de **Quotas** é a exceção — pede confirmação por diálogo, mostrando quantas contas seriam afetadas na hora.

**Porta 2: SQL direto (único para `quotas_enforced`)**
```sql
UPDATE platform_settings
  SET quotas_enforced = TRUE,
      support_email = 'suporte@exemplo.com',
      grace_days = 14
  WHERE id = TRUE;
```

**Porta 3: API de automação (x-admin-secret)**
Não existe endpoint — SQL direto é o único caminho para automação. A próxima SPEC pode trazer uma rota para isso, mas hoje fica fora.

---

## 1. As três peças que compõem "o plano de uma conta"

| Peça | Onde mora | Quem muda |
| --- | --- | --- |
| **Interruptor global** | `platform_settings.quotas_enforced` (uma linha só, no banco) | Só via SQL direto hoje — não existe rota admin para isto (§2) |
| **Catálogo de planos** | tabela `plans` | `POST /api/admin/plans` ou `supabase/setup/plans-seed.sql` |
| **Plano de UMA conta** | tabela `account_plans` (1 linha por conta, sempre existe) | `PUT /api/admin/accounts/{accountId}/plan` ou aprovando uma solicitação |

**Regra de ouro (D-1):** enquanto `quotas_enforced = FALSE`, **nada é bloqueado**
— toda conta se comporta como no plano `unlimited`, não importa qual plano
esteja atribuído a ela em `account_plans`. Ligar o interruptor é o único jeito
de os limites passarem a valer de verdade. Isso significa que dá pra preparar
tudo (catálogo, planos das contas, overrides) com o interruptor desligado, sem
nenhum risco de bloquear alguém sem querer, e só ligar quando estiver pronto.

---

## 2. Autenticação das rotas de operador

Toda rota `/api/admin/**` exige o header `x-admin-secret` com o valor de
`PLATFORM_ADMIN_SECRET` (variável de servidor). **Sem essa variável definida,
a rota responde `503`** de propósito (falha alto, nunca abre — mesmo padrão de
`AUTOMATION_CRON_SECRET` nas rotas de cron).

```bash
# .env.local (ou variável de ambiente do host em produção)
PLATFORM_ADMIN_SECRET=<gere com: openssl rand -hex 32>
```

Todos os exemplos de `curl` abaixo assumem:

```bash
export ADMIN_SECRET="cole-o-valor-de-PLATFORM_ADMIN_SECRET-aqui"
export BASE_URL="http://localhost:3000"   # ou o domínio de produção
```

⚠️ Isto não é um usuário de plataforma com login — é um segredo de servidor
(D-9). Qualquer script/pessoa que tenha esse valor age como operador. Trate
como uma credencial de produção.

**Existe uma segunda porta, com login: `/admin`** (SPEC 062). Todo `curl`
deste guia continua funcionando — é a porta certa para automação e scripts —
mas se você é uma pessoa clicando, o console web faz a mesma coisa sem
`x-admin-secret`: basta a sessão do e-mail listado em
`PLATFORM_OWNER_EMAILS` (variável de servidor própria, não confundir com
`PLATFORM_ADMIN_SECRET`). As duas portas chamam o mesmo código
(`src/lib/platform/`) — nenhuma faz nada que a outra não veria no
`account_plan_events`/`platform_audit_log`. Cada seção abaixo aponta o
equivalente no console quando existir um.

---

## 3. Habilitar as quotas (ligar o interruptor)

**Console:** `/admin/settings` → switch "Quotas" → confirma num diálogo que
mostra quantas contas seriam afetadas na hora. É a via recomendada — o SQL
abaixo continua funcionando (e é o único jeito num projeto onde
`PLATFORM_OWNER_EMAILS` ainda não foi configurada), mas não tem a
confirmação com o número de contas.

Por SQL direto no projeto Supabase certo (⚠️ confirme com o mantenedor qual
projeto — `vn`, `rs` ou `jh` — antes de rodar, regra do `AGENTS.md`):

```sql
UPDATE platform_settings SET quotas_enforced = TRUE;
```

O que muda no app assim que isso roda (sem precisar de deploy nem restart):

- A aba/página **"Plano e uso"** passa a aparecer na sidebar e no menu do
  avatar (antes fica escondida).
- `account_effective_limits()` (e portanto `plan_limit()`/`plan_feature()`)
  param de devolver `'{}'` e passam a ler o plano de verdade de cada conta.
- A trigger `enforce_contact_quota` passa a bloquear criação de contato quando
  a conta estoura a quota do plano dela.
- As checagens de quota de membro (`redeem_invitation`, `set_member_role`,
  `POST /api/account/invitations`) e de canal (`POST
  /api/channels/evolution/instances`, `POST /api/whatsapp/config`) passam a
  valer.

**Antes de ligar em um projeto com contas reais**, confira o §5 (toda conta
precisa estar num plano que faça sentido) — senão todo mundo cai no plano
`unlimited` (semeado pela migração 067) e nada muda na prática, o que é seguro
mas também não é o que você provavelmente quer.

---

## 4. Desabilitar as quotas (voltar ao padrão)

```sql
UPDATE platform_settings SET quotas_enforced = FALSE;
```

Efeito imediato: toda quota volta a ser ilimitada para toda conta, a
página "Plano e uso" some da navegação de novo. **Nada é apagado** — os planos
atribuídos em `account_plans`, os overrides e o histórico em
`account_plan_events` continuam intactos, só deixam de ser aplicados. Religar
depois (§3) restaura o comportamento exatamente de onde parou.

Use isto se algo se comportar de forma inesperada em produção e você precisar
de uma saída de emergência rápida — é uma UPDATE de uma linha, reversível na
hora.

---

## 5. Cadastrar/atualizar o catálogo comercial

### 5.1. Opção A — rodar o script pronto (recomendado para o catálogo padrão)

`supabase/setup/plans-seed.sql` semeia os quatro planos comerciais (Grátis,
Essencial, Profissional, Empresarial) com os preços e quotas do
[PRD 058 §7](./prd-058-planos-e-quotas.md). É **idempotente** — rodar de novo
depois de editar um preço/limite no arquivo atualiza os planos existentes
(`ON CONFLICT (code) DO UPDATE`), não duplica.

```bash
# Local: cole o conteúdo do arquivo no SQL editor do projeto Supabase certo,
# ou via MCP/CLI. Não é uma migração — não afeta forks de terceiros.
```

Para mudar um preço ou limite: edite `supabase/setup/plans-seed.sql` e rode de
novo. **"Sob medida" não está no script** de propósito (preço negociado, sem
`price_cents` fixo) — crie esse plano pela API (§5.2) quando negociar com um
cliente específico, com `is_public: false`.

### 5.2. Opção B — criar ou editar UM plano pela API

`POST /api/admin/plans` faz upsert por `code` — se o código já existir,
atualiza; se não, cria.

```bash
curl -X POST "$BASE_URL/api/admin/plans" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "custom-cliente-x",
    "name": "Sob medida — Cliente X",
    "description": "Negociado em 2026-08",
    "price_cents": 129900,
    "currency": "BRL",
    "billing_period": "monthly",
    "limits": {
      "contacts": 80000,
      "members_total": 40,
      "members_admin": 12,
      "members_agent": 25,
      "members_viewer": 3,
      "channels_whatsapp_qr": 3,
      "channels_whatsapp_cloud": 1
    },
    "features": {
      "ai_enabled": true,
      "api_v1_enabled": true,
      "flows_enabled": true,
      "broadcasts_enabled": true,
      "webhooks_out_enabled": true
    },
    "is_public": false,
    "is_active": true,
    "sort_order": 50
  }'
```

Regras que a rota já valida antes de gravar:

- `code` e `name` são obrigatórios.
- Toda chave em `limits` precisa ser uma das quotas conhecidas
  (`contacts`, `members_total`, `members_admin`, `members_agent`,
  `members_viewer`, `channels_whatsapp_qr`, `channels_whatsapp_cloud`) — chave
  desconhecida (typo) é rejeitada com `400` antes de gravar.
- Toda chave em `features` precisa ser uma das flags conhecidas
  (`ai_enabled`, `api_v1_enabled`, `flows_enabled`, `broadcasts_enabled`,
  `webhooks_out_enabled`).
- `limits`/`features` ausentes viram `{}` (nenhuma quota = ilimitado nessa
  chave, D-3). `0` numa quota **bloqueia** aquele recurso por completo — não é
  a mesma coisa que "ausente".
- `is_public: false` mantém o plano fora do catálogo que a conta vê em
  "Plano e uso" — use para planos sob medida/negociados.

**Listar o catálogo inteiro** (inclusive planos privados/inativos — visão de
operador, diferente da pública):

```bash
curl -H "x-admin-secret: $ADMIN_SECRET" "$BASE_URL/api/admin/plans"
```

Não existe rota de exclusão de plano de propósito: uma conta assinando o plano
impede o apagamento no banco (`plan_id ON DELETE RESTRICT`). Para
"aposentar" um plano, edite-o com `"is_active": false` (some do catálogo
público, mas continua funcionando para quem já está nele).

---

## 6. Ver ou trocar o plano de UMA conta

### 6.1. Ver o plano atual + histórico

```bash
curl -H "x-admin-secret: $ADMIN_SECRET" \
  "$BASE_URL/api/admin/accounts/<ACCOUNT_ID>/plan"
```

Devolve `accountPlan` (plano/status/overrides atuais) e `events` (últimos 20
registros de `account_plan_events` — quem mudou o quê, quando).

### 6.2. Trocar o plano (efetivar um upgrade/downgrade)

**Console:** `/admin/accounts/{id}` → botão "Trocar plano" — mesmo diálogo,
mesma escrita em `account_plan_events`, só o `actor` muda
(`console:<seu e-mail>` em vez do texto livre que você digita no `curl`).

Isto é o que confirma na prática uma troca **quando o operador decide
direto** ou aprova uma solicitação (§7). Com o autosserviço ligado (D-3,
SPEC 062 §6.1), a maioria das trocas para um plano público nem chega até
aqui — o próprio cliente troca pela tela "Plano e uso"
(`POST /api/account/plan/change`), na hora, sem aprovação. Esta rota
continua sendo o caminho para: planos **não públicos** (sob medida),
contas sem autosserviço ligado, ou qualquer ajuste que só o operador deveria
fazer (mudar `status` para `suspended`, conceder um `limitOverrides`):

**Vencimento nesta troca (SPEC 062 §3.3.1, decisão B, 2026-08-30):** trocar de
plano por aqui **herda** o vencimento que a conta já tinha — nunca reinicia o
ciclo como o autosserviço faz. Se a conta nunca teve vencimento (backfill, ou
nasceu no `unlimited`) e o plano novo é pago mensal/anual, um vencimento é
calculado **a partir da data desta troca** (nunca retroativo). Se o plano novo
não vence (Grátis, `unlimited`, sob medida sem ciclo), o vencimento é limpo.
Ver [guia do console §5.3](./guia-console-do-proprietario.md#53-trocar-o-plano-de-uma-conta)
e [SPEC 062 §3.3.1](./spec-062-console-do-proprietario.md#331-troca-de-plano-pelo-console-e-o-vencimento-decisão-b-2026-08-30)
para a regra completa.

```bash
curl -X PUT "$BASE_URL/api/admin/accounts/<ACCOUNT_ID>/plan" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "actor": "bruno@zapcrmbr.com",
    "planCode": "professional",
    "reason": "Upgrade confirmado por Pix em 2026-08-25"
  }'
```

- `actor` é **obrigatório** — vai para o histórico append-only
  (`account_plan_events`), então use algo identificável (seu e-mail, ou
  `"sistema-x"` se for automação).
- `planCode` é opcional — omita para só mudar `status`/`limitOverrides` sem
  trocar de plano.
- Qualquer troca grava uma linha em `account_plan_events` automaticamente.
- **Nada é apagado ao rebaixar (D-4).** Uma conta com 10.000 contatos que
  desce para um plano de 2.000 continua com os 10.000 contatos, legíveis e
  exportáveis — só a criação de contato *novo* passa a ser recusada até ela
  voltar a caber no limite ou fazer upgrade. A conta fica em **overage**
  visível na barra de uso.

### 6.3. Conceder uma exceção por conta (override)

Para negociar um limite diferente do plano padrão sem criar um plano novo:

```bash
curl -X PUT "$BASE_URL/api/admin/accounts/<ACCOUNT_ID>/plan" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "actor": "bruno@zapcrmbr.com",
    "limitOverrides": { "contacts": 15000, "channels_whatsapp_qr": 5 },
    "reason": "Negociado — 15k contatos e 5 instâncias QR por 6 meses"
  }'
```

- `limitOverrides` **substitui por completo** o objeto de overrides da conta
  (não faz merge com o que já existia) — mande sempre o objeto completo com
  tudo que deve valer.
- Mande `"limitOverrides": {}` para remover todos os overrides e voltar a
  usar só os limites do plano.
- Chave desconhecida ou valor do tipo errado (ex. `"contacts": "muito"`) é
  rejeitado com `400` antes de gravar — sem isso, o erro só apareceria depois,
  como uma falha crua de banco no próximo contato criado por aquela conta.
- `0` numa chave de override bloqueia aquele recurso por completo para a
  conta (ex. `"channels_whatsapp_cloud": 0` tira o WhatsApp oficial dela,
  mesmo que o plano dela inclua).

### 6.4. Suspender uma conta (inadimplência)

```bash
curl -X PUT "$BASE_URL/api/admin/accounts/<ACCOUNT_ID>/plan" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "actor": "bruno@zapcrmbr.com", "status": "suspended", "reason": "Pagamento em atraso" }'
```

Status válidos: `trialing`, `active`, `past_due`, `suspended`, `canceled`.
⚠️ **Só `status` em si é gravado agora** — o schema já suporta esses status,
mas o comportamento de bloqueio automático por `suspended` (impedir envio,
manter leitura) ainda não está implementado no motor de enforcement; é
trabalho futuro (SPEC 059 §11). Hoje, mudar o status é só registro/sinalização
na UI ("Suspenso" aparece na tela "Plano e uso"), não bloqueia nada sozinho.

---

## 7. Resolver solicitações de troca de plano

> ⚠️ **Desde a SPEC 062 (D-3), isto só acontece quando o autosserviço está
> desligado (`platform_settings.self_service_enabled = FALSE`) ou o plano
> escolhido não é público.** Com o autosserviço ligado — o padrão — um admin
> da conta clicando "Escolher este plano" na tela "Plano e uso" troca **na
> hora**, sem passar por aqui: `POST /api/account/plan/change` já aplica o
> plano/ciclo escolhido e recalcula o vencimento, sem fila de aprovação. Esta
> seção só se aplica ao que sobra: plano sob medida (sempre não público) ou
> um deployment que desligou o autosserviço de propósito.

Quando o autosserviço está desligado (ou o plano não é público), o clique
grava uma solicitação (`plan_change_requests`, status `pending`) e **não
troca nada sozinho** (D-8) — precisa de você. **Console:** `/admin/requests`
lista, aprova e rejeita pela tela — os `curl` abaixo continuam sendo o
caminho de automação.

### 7.1. Listar solicitações pendentes

```bash
curl -H "x-admin-secret: $ADMIN_SECRET" "$BASE_URL/api/admin/plan-requests"
# ?status=all lista todas (pending/approved/rejected/canceled)
```

### 7.2. Aprovar (depois de confirmar o pagamento fora do sistema)

```bash
curl -X PATCH "$BASE_URL/api/admin/plan-requests" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<REQUEST_ID>",
    "decision": "approved",
    "actor": "bruno@zapcrmbr.com",
    "note": "Pix confirmado"
  }'
```

Aprovar já efetiva a troca (equivalente a chamar o §6.2 com o plano pedido) —
**overrides existentes na conta são preservados**, só o plano/status mudam.

### 7.3. Rejeitar

```bash
curl -X PATCH "$BASE_URL/api/admin/plan-requests" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<REQUEST_ID>",
    "decision": "rejected",
    "actor": "bruno@zapcrmbr.com",
    "note": "Pagamento não confirmado"
  }'
```

O cliente vê o cancelamento refletido na tela "Plano e uso" (o botão
"Escolher este plano" volta a aparecer). Uma solicitação em `pending` também
pode ser cancelada pelo próprio admin da conta, sem passar por você — botão
"Cancelar solicitação" na UI (`DELETE /api/account/plan/request`).

### 7.4. Avisos automáticos de nova solicitação (opcional)

Desde a SPEC 063, uma solicitação de plano é só **um** dos quinze eventos
que alimentam a outbox de notificações do sistema (troca de plano,
bloqueio, vencimento, quota estourada, conta nova, …) — o guia completo
dela está em
[docs/guia-console-do-proprietario.md §20](./guia-console-do-proprietario.md#20-notificações-do-sistema-adminnotifications-spec-063).
`PLAN_REQUEST_WEBHOOK_URL` **continua valendo** — é a mesma variável de
antes, só que agora recebe todos os eventos, não só `plan_change_requested`:

```bash
PLAN_REQUEST_WEBHOOK_URL=https://seu-n8n.exemplo.com/webhook/plan-request

# Alias novo (SPEC 063) — se as duas existirem, esta vence. Prefira-a em
# deploys novos; a de cima é só compatibilidade com quem já configurou.
SYSTEM_EVENT_WEBHOOK_URL=
```

Sem nenhuma das duas, é um no-op silencioso — a solicitação é gravada
normalmente, só não dispara aviso. A URL passa pela mesma guarda de SSRF que
os webhooks de saída por conta. Some ainda o canal de **e-mail** (SMTP),
independente do webhook — ver o guia do console para as variáveis
`SMTP_*`/`SYSTEM_NOTIFICATION_EMAIL` e para `/admin/notifications`, onde dá
para conferir o que foi entregue e reenviar o que falhou.

### 7.5. Confirmar um pagamento recebido fora do sistema (renovação, SPEC 062 §6.2)

**Console:** `/admin/accounts/{id}` → **"Registrar pagamento"** (forma, valor,
identificador e prévia do novo vencimento) e **"Alterar vencimento"** para
ajustar a data sem pagamento. É o caminho para o operador — **não use SQL
para mexer em `current_period_end`**: o `UPDATE` direto não deixa trilha, não
tira a conta de `past_due`, não define o fuso (o vencimento é 23:59:59 de São
Paulo) e corre contra o cron de ciclo de vida. Ver
[guia do console §5.5 e §5.6](./guia-console-do-proprietario.md#55-alterar-a-data-de-vencimento-spec-078).

**API de máquina** (o resto desta seção): sem gateway integrado, o sistema de
cobrança do cliente — ou um script seu — chama esta rota pelo
`x-admin-secret`. É literalmente a forma que um webhook de gateway de
pagamento assumiria no futuro, sem migração nova:

```bash
curl -X POST "$BASE_URL/api/admin/accounts/<ACCOUNT_ID>/billing/renew" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentRef": "fatura-2026-09-1042",
    "paidAt": "2026-08-27T12:00:00Z",
    "periods": 1,
    "note": "Pix conciliado"
  }'
```

- `paymentRef` é **obrigatório e é a chave de idempotência**: chamar de novo
  com o MESMO valor (retentativa do seu script, clique duplo) devolve
  `{ "status": "already_applied" }` — o vencimento **não** avança duas vezes.
- O vencimento avança a partir do vencimento **atual** da conta, nunca de
  hoje — pagar atrasado não encurta o período que o cliente já tinha
  comprado.
- Se a conta estava `past_due` (§8 do desenho técnico — a varredura de
  vencimento já marcou carência) **ou `trialing`** (desde a SPEC 078), volta
  para `active` e limpa a carência. `suspended` e `canceled` não mudam, e
  pagamento nunca desbloqueia a conta.
- **O console e esta rota compartilham a mesma chave de idempotência.** Se o
  operador registrou o Pix no console com o ID E2E como identificador e o seu
  sistema de cobrança reportar o mesmo ID aqui, a resposta é
  `already_applied` — o vencimento avança uma vez só. Use o mesmo valor nos
  dois lados.
- **`already_applied` só vale para um pagamento vigente da MESMA conta.**
  `paymentRef` é único na plataforma inteira, então a rota confere de quem é
  a linha que já usa o valor: de **outra conta** → `409` com
  `code: "payment_ref_in_use"`; de um pagamento **desfeito** pelo operador no
  console → `409` com `code: "payment_ref_reversed"` (o identificador
  continua ocupado de propósito, para o mesmo pagamento não ser reaplicado).
  Nos dois casos **nada foi aplicado** — trate como erro, não como sucesso.
  Para registrar de novo um pagamento desfeito, use outro identificador.
- O webhook de saída `plan.renewed` agora leva `data.source` (`"api"` aqui,
  `"console"` quando o operador registra pela tela).
- Um plano sem ciclo de cobrança (Grátis, ou o `unlimited` de backfill)
  devolve `400` — não há vencimento para avançar.

Esta rota **não** substitui a §6.2 (trocar de plano) nem o autosserviço —
ela só confirma que o período atual foi pago e empurra a data. Trocar de
plano continua sendo `PUT .../plan` (operador) ou o autosserviço do cliente.

---

## 8. Recontar o uso de uma conta (se o contador divergir)

`account_usage_counters` é mantido por trigger a cada INSERT/DELETE de
contato — não deveria divergir de `count(*) FROM contacts`. Se algum caminho
fora do fluxo normal mexer na tabela direto (`TRUNCATE`, um script de
manutenção, uma restauração de backup parcial), recalcule:

```sql
SELECT recount_account_usage('<ACCOUNT_ID>'::uuid);
```

Isso é a mesma função que a migração 067 usou no backfill inicial — segura de
rodar a qualquer momento, para qualquer conta.

---

## 9. Checklist rápido

| Quero... | Faço |
| --- | --- |
| Ligar quotas num projeto | `UPDATE platform_settings SET quotas_enforced = TRUE;` (§3) |
| Desligar (emergência) | `UPDATE platform_settings SET quotas_enforced = FALSE;` (§4) |
| Publicar/atualizar os planos padrão | Editar e rodar `supabase/setup/plans-seed.sql` (§5.1) |
| Criar um plano sob medida | `POST /api/admin/plans` com `is_public: false` (§5.2) |
| Ver o plano de uma conta | `GET /api/admin/accounts/{id}/plan` (§6.1) |
| Trocar o plano de uma conta | `PUT /api/admin/accounts/{id}/plan` com `planCode` (§6.2) |
| Negociar um limite diferente pra uma conta | `PUT .../plan` com `limitOverrides` (§6.3) |
| Aprovar/rejeitar um pedido do cliente | `GET`/`PATCH /api/admin/plan-requests` ou `/admin/requests` (§7) |
| Confirmar um pagamento e avançar o vencimento | Console: "Registrar pagamento"; automação: `POST .../billing/renew` com `paymentRef` (§7.5) |
| Mudar a data de vencimento sem ser um pagamento | Console: `/admin/accounts/{id}` → "Alterar vencimento" (nunca por SQL) |
| Corrigir contador de uso divergente | `SELECT recount_account_usage(...)` (§8) |
| Fazer qualquer coisa acima clicando, não com `curl` | `/admin`, login com o e-mail de `PLATFORM_OWNER_EMAILS` (§2) |

---

## 10. Armadilhas conhecidas

| Sintoma | Causa provável |
| --- | --- |
| Rota `/api/admin/**` devolve `503` | `PLATFORM_ADMIN_SECRET` não está definido no servidor |
| Rota `/api/admin/**` devolve `401` | Header `x-admin-secret` ausente ou com valor errado |
| Liguei o interruptor e nada mudou pro cliente | Toda conta nasce no plano `unlimited` (sem limites) — ela precisa estar num plano de verdade primeiro (§6.2) |
| `limitOverrides` não fez efeito nenhum | Lembre: `limitOverrides` **substitui** o objeto inteiro, não faz merge — se você mandou só uma chave, as outras que existiam antes foram removidas |
| Override rejeitado com 400 | Chave fora de `QUOTA_KEYS`/`FEATURE_KEYS` (`src/lib/plans/types.ts`), ou tipo errado (quota precisa ser inteiro, feature precisa ser booleano) |
| Erro cru do Postgres ao criar contato numa conta específica | Sinal de um override antigo com valor inválido gravado *antes* da validação existir — corrija via §6.3 com um objeto válido |
| "Plano e uso" não aparece na navegação mesmo com plano atribuído | `quotas_enforced` ainda está `FALSE` (§3) — a tela só aparece com o interruptor ligado |
| Status `suspended` não bloqueou nada | Esperado por enquanto — enforcement de suspensão é trabalho futuro (§6.4) |
| Contador de contatos "errado" na tela de uso | Rode `recount_account_usage()` (§8) |
| Vencimento "nunca acontece" (conta continua `active` depois do dia) | `AUTOMATION_CRON_SECRET` não configurado, ou `pg_cron` não instalado neste projeto Supabase — a fase 5 de `/api/automations/cron` (SPEC 062 §8) depende do mesmo agendamento da retenção e das automações; confira `cron.job` antes de suspeitar de bug de código |
| Mexi em `current_period_end` por SQL e a conta continua `past_due` / o cron a marcou em atraso minutos depois | `UPDATE` direto não limpa a carência nem serializa com o cron. Use "Alterar vencimento" no console (SPEC 078), que faz as duas coisas numa transação |
| Renovação avançou o vencimento duas vezes | `paymentRef` ausente no corpo do `POST .../billing/renew`, ou seu script gerou uma `paymentRef` nova a cada retentativa em vez de reusar a mesma (§7.5) |
| Cliente clicou "Escolher este plano" e nada aconteceu / foi para uma fila que não existe mais | `self_service_enabled` está `TRUE` (padrão) — a troca já aconteceu na hora; confira `account_plan_events` com `actor='self-service:<email>'`, não `plan_change_requests` |

---

## 12. Comportamento detalhado: o que acontece quando um limite é atingido

Este guia responde "e aí?" para cada tipo de quota e cada cenário, incluindo a diferença crítica entre limite de plano e limite de deployment (D-4, D-5).

### 12.1. Contatos (`contacts`)

**Cenário 1: Plano Essencial, 2.000 contatos, operador criando novo contato**

Ações que **são bloqueadas** (recusam o `INSERT`):
- Formulário de contato (`src/components/contacts/contact-form.tsx:264`)
- Importação em lote CSV/XLSX/Sheets (`src/components/contacts/import-modal.tsx`)
- API pública (`POST /api/v1/contacts`)
- Audiência de disparo (`src/lib/audience/resolve.ts`)
- Webhook de entrada de terceiros (`POST /api/v1/ingest/contact`)

Mensagem (obrigatória, específica):
```
Limite do plano Essencial atingido: 2.000 de 2.000 contatos.
Remova contatos ou mude de plano para continuar.
```

Link direto para a aba "Plano e uso" está na mensagem.

**Cenário 2: Mensagem recebida de um cliente (inbound) — conta em 2.000 contatos**

- Contato **é criado normalmente** — nunca é bloqueado (D-5)
- A trigger `enforce_contact_quota` **não falha**, apenas incrementa o contador
- Conta entra em *overage*: `2.001 / 2.000` mostrado em vermelho na aba "Plano e uso"
- Cliente pode ler, exportar e responder normalmente (D-4)
- **Motivo:** perder a mensagem de um cliente final é pior que overage — quem paga é punido por alguém tentar falar com ela

**Rebaixamento com overage (D-4):**

Conta com 5.000 contatos desce do plano Profissional (10.000) para Essencial (2.000):
- ✅ Os 5.000 contatos **continuam existentes**, legíveis, exportáveis
- ✅ Agente pode responder a qualquer conversa
- ❌ Criar novo contato é bloqueado até:
  - Deletar contatos e voltar a caber (≤ 2.000), ou
  - Fazer upgrade novamente
- ⚠️ Barra de uso mostra `5.000 / 2.000` em **vermelho**, com o valor do excedente explícito

Nenhum dado é apagado automaticamente — é a garantia legal de D-4.

### 12.2. Membros (usuários) — quotas por papel

**Cenário 1: Plano de 5 usuários, invitar o 6º**

Convidar alguém para ser `agent` (padrão) quando já há 5 membros:
- Rota `POST /api/account/invitations` **recusa antes de gravar** a solicitação
- Resposta HTTP 400 com mensagem específica:
```
Limite de usuários atingido: 5 de 5 (total).
Remova um membro ou mude de plano para continuar.
```

**Cenário 2: Plano de 2 admins, promover 3º agente a admin**

Conta com: 1 owner, 1 admin, 2 agents, 1 viewer.
Tenta promover um dos agents a admin (seria o 3º admin total = owner + 2):
- RPC `set_member_role` **falha antes de fazer a mudança**
- Mensagem específica:
```
Limite de admins atingido: 2 de 2.
Remova um admin ou rebaixe alguém para continuar.
```

**Regra do owner (D-6):**
- Owner **nunca é bloqueado** — não dá para expulsá-lo nem contar com dois owners num mesmo plano
- Owner conta tanto em `members_total` quanto em `members_admin`
- Mesmo se `members_admin = 0`, o owner está lá

**Convites pendentes ocupam vaga (§4.1 da SPEC):**

Plano de 5 usuários, já tem 4 membros ativos. Operador emite 3 convites:
- Convites pendentes (não aceitos) **contam como vagas ocupadas**
- Quinto membro: ✅ pode convidar (4 + 1 convite = 5 total)
- Sexto membro: ❌ falha (4 + 2 convites já = 6, ou se o primeiro aceitar, volta a 5)
- Motivo: sem isso, operador convidaria 20 pessoas num plano de 5 e deixaria todas em purgativo, esperando um clicar no link para bloquear o resto

**Ninguém é expulso ao rebaixar (D-4):**

Conta com owner + 10 admins desce para plano de 2 admins:
- ✅ Os 11 membros **continuam existindo**
- ❌ Promover qualquer outro a admin falha (já está no teto)
- ❌ Convidar novo admin falha
- ⚠️ A barra de "Admins" mostra `11 / 2` em vermelho
- Solução: rebaixar 9 admins a agents, ou fazer upgrade

### 12.3. Canais — WhatsApp QRCode (Evolution)

**Cenário 1: Plano de 1 instância QRCode, criar 2ª**

Conta no plano Essencial (`channels_whatsapp_qr: 1`), já tem 1 instância conectada.
Tenta parear nova instância via QRCode:
- Rota `POST /api/channels/evolution/instances` **recusa antes de chamar a Evolution**
- Resposta HTTP 403 com mensagem clara:
```
Limite do plano Essencial atingido: 1 de 1 instância QRCode.
Mude de plano para conectar mais números.
```

**Cenário 2: 21ª instância de todo o deployment (teto VPS)**

Mesmo com um plano que permite 3 instâncias, se já há 20 no deployment (outros clientes):
- Rota **recusa com mensagem diferente**:
```
Limite de infraestrutura atingido: 20 de 20 instâncias no servidor.
Entre em contato com o suporte para solicitar expansão.
```

**Por quê mensagens diferentes?** Porque "o limite é do plano" e "o limite é da VPS" são dois problemas diferentes:
- Plano = cliente pode resolver sozinho (upgrade)
- VPS = operador precisa agir (mais Evolution Go, ou escala horizontal)

**Instâncias já conectadas em overage (D-4):**

Conta com 2 instâncias downgrade para plano de 1:
- ✅ Ambas as instâncias **continuam conectadas e operacionais**
- ❌ Criar 3ª falha (recusa por limite)
- ⚠️ Barra mostra `2 / 1` em vermelho
- Solução: desconectar uma, ou fazer upgrade

### 12.4. Canais — WhatsApp oficial (Cloud)

**Cenário 1: Plano Grátis (`channels_whatsapp_cloud: 0`)**

Admin tenta conectar número de WhatsApp Business (Cloud) oficial:
- Rota `POST /api/whatsapp/config` **recusa a conexão**
- Mensagem:
```
Plano Grátis não inclui WhatsApp oficial.
Mude para Essencial ou superior para conectar um número.
```

**Cenário 2: Plano tem oficial (`channels_whatsapp_cloud: 1`), tenta conectar 2º**

Conta no plano Profissional, já conectou 1 número oficial. Tenta ligar outro:
- Rota **recusa** (índice parcial em `channels` garante max 1 por account)
- Mensagem:
```
Você já tem o máximo de números oficiais (1) para sua conta.
```

**Nota D-7:** suportar N números oficiais é um projeto separado — exigiria remover dois índices únicos e mexer em templates, webhook e inbox. Agora é sempre 0 ou 1.

### 12.5. Recursos booleanos (IA, Flows, API v1, etc.)

**Cenário 1: Plano Grátis (`ai_enabled: false`)**

- Aba de IA em Configurações **não aparece na navegação**
- Botão de "Rascunho com IA" no inbox **não é renderizado**
- Se a rota `/api/ai/draft` for chamada mesmo assim (ex.: DevTools):
  - Responde HTTP 403 `feature_not_enabled`
- Motivo: UI é a primeira defesa, mas não é a última — rota também guarda

**Cenário 2: Plano Essencial (`flows_enabled: false`)**

- Aba "Flows" some da sidebar
- Link direto para `/flows` redireciona a `/settings?tab=plan` com aviso
- Resposta 403 se a rota de criação for chamada

**Recursos em overage** (não aplica — são booleanos):
- Um recurso está ou ativado (true) ou desativado (false)
- Não tem "overage" em feature

### 12.6. Diferença: limite de plano vs. limite de deployment

| Cenário | Limite de plano | Limite de deployment | Mensagem ao usuário |
| --- | --- | --- | --- |
| 2ª instância QRCode, plano de 1 | ✅ Falha aqui | — | "Limite do plano" |
| 21ª instância QRCode, deployment de 20 | — | ✅ Falha aqui | "Limite de infraestrutura" |
| 2ª instância QRCode, plano de 3 mas deployment já tem 20 | ✅ Plano permite | ✅ Deployment nega | "Limite de infraestrutura" |

**Ordem de checagem (SPEC 059 §3.4):**
1. Primeiro checamos `EVOLUTION_MAX_INSTANCES_TOTAL` (deployment)
2. Depois `plan_limit(account_id, 'channels_whatsapp_qr')` (plano)

Se ambos são checados e ambos falham, a mensagem é a do **deployment** (primeiro que falhou).

**Implicação comercial (PRD §6):**

O teto de deployment (padrão 20) define **quantas instâncias QRCode cabem vender por VPS**.

Exemplo: com 20 de teto, um plano de 3 instâncias cabe em ~6 clientes por VPS. Vender a 10 clientes exigiria mais Evolution Go — é restrição física, não de banco.

### 12.7. Estado de overage — quando a conta fica visível como "excedida"

Um plano é considerado em **overage** quando a conta:
- Tem mais dados/membros/canais do que o limite atual permite

**Para contatos:**
- Limite = 2.000, uso = 2.001+ → overage
- Criação de novo é bloqueada
- Barra de uso: `2.001 / 2.000` em vermelho

**Para membros:**
- Limite total = 5, membros = 6+ → overage
- Convidar ou promover é bloqueado
- Barra de "Usuários": `6 / 5` em vermelho

**Para canais:**
- Limite de QRCode = 1, instâncias = 2+ → overage
- Criar nova falha
- Barra de "QRCode": `2 / 1` em vermelho

**Quando acaba o overage:**

1. **Deletar dados:** remover 1 contato → `2.000 / 2.000` (cheio, mas não mais overage)
2. **Fazer upgrade:** passar de 2.000 para 10.000 → `2.001 / 10.000` (voltou a caber)
3. **Desconectar canal:** remover instância 2 → `1 / 1` (de novo no limite)

**Ao rebaixar, overage é esperado (D-4):**

Rebaixando Profissional (10.000) → Essencial (2.000) com 5.000 contatos:
- Resultado: `5.000 / 2.000` em overage de verdade
- Nada é apagado
- Criação nova bloqueada até sair do overage
- Status é **permanente** até resolver

### 12.8. Resumo visual

```
┌─ Limite de plano ─┐
│  Atingido?        │
│  SIM → bloqueia   │
│  criação (D-4)    │
│  Dados NÃO são    │
│  apagados (D-4)   │
│  Conta em overage │
└───────────────────┘

┌─ Contato inbound ─┐
│  Exceção: D-5     │
│  NUNCA bloqueia   │
│  Conta para uso   │
│  Entra em overage │
│  visível (sem     │
│  perder mensagem) │
└───────────────────┘

┌─ Limite deployment┐
│  (EVOLUTION_MAX_) │
│  TOTAL_INSTANCES) │
│  Checado ANTES do │
│  limite de plano  │
│  Mensagem diferente
│  para operador    │
│  saber do que se  │
│  trata            │
└───────────────────┘
```

---

| O quê | Arquivo |
| --- | --- |
| Guarda de segredo do operador | `src/lib/auth/platform-admin.ts` |
| Catálogo (criar/editar plano) | `src/app/api/admin/plans/route.ts` |
| Plano de uma conta (ver/trocar/override/status) | `src/app/api/admin/accounts/[accountId]/plan/route.ts` |
| Solicitações de troca (listar/resolver) | `src/app/api/admin/plan-requests/route.ts` |
| Solicitação pelo cliente (criar/cancelar) | `src/app/api/account/plan/request/route.ts` |
| Plano efetivo + uso da conta logada | `src/app/api/account/plan/route.ts`, `src/lib/plans/account-plan.ts` |
| Validação de chaves de quota/feature | `src/lib/plans/catalog.ts` (`validateCatalog`, `validateOverrides`) |
| Chaves conhecidas (fonte da verdade) | `src/lib/plans/types.ts` (`QUOTA_KEYS`, `FEATURE_KEYS`) |
| Seed comercial | `supabase/setup/plans-seed.sql` |
| **Configurações da plataforma** (`platform_settings`, UI e API) | Tela: `src/app/(platform)/admin/settings/page.tsx`; Rota: `src/app/api/platform/settings/route.ts`; **Schema completo + referência técnica:** [§13 deste documento](./guia-operacao-planos-e-quotas.md#13-referência-técnica-platform_settings-no-supabase) |
| **Schema da plataforma** (todas as migrações) | `supabase/migrations/067_plans_and_quotas.sql` (campo base `quotas_enforced`, `default_plan_code`); `069_platform_console.sql` (ciclo/desconto/retenção/autosserviço/bloqueio); `070_system_notifications.sql` (outbox, sem campos em `platform_settings`) |
| Tela do cliente | `src/app/(dashboard)/plan/page.tsx`, `src/components/plan/*` |

---

## 13. Referência técnica: `platform_settings` no Supabase

### 13.1. Schema — 11 colunas, 1 linha garantida

```sql
CREATE TABLE platform_settings (
  id                              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  quotas_enforced                 BOOLEAN NOT NULL DEFAULT FALSE,
  default_plan_code               TEXT NOT NULL DEFAULT 'unlimited',
  payment_instructions            TEXT,
  billing_contact                 TEXT,
  default_yearly_discount_percent INTEGER NOT NULL DEFAULT 17 CHECK (… >= 0 AND … <= 100),
  support_email                   TEXT,
  grace_days                      INTEGER NOT NULL DEFAULT 7 CHECK (… >= 0),
  self_service_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  retention_defaults              JSONB NOT NULL DEFAULT '{}',
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

A coluna **`id`** é `BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id)` — força exatamente uma linha, imutável. Tanto `INSERT INTO platform_settings (id) VALUES (TRUE)` quanto `ON CONFLICT DO NOTHING` funcionam.

### 13.2. RLS — leitura pública, escrita só `service_role`

```sql
DROP POLICY … ON platform_settings;
CREATE POLICY platform_settings_select ON platform_settings
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Nenhuma policy de INSERT/UPDATE/DELETE — só service_role escreve.
```

Toda conta logada enxerga a tabela, mas ninguém consegue modificá-la direto pelo Supabase.js. Escrita vem de:
1. Console (`/admin/settings`) → rota servidor com `service_role`
2. SQL direto no Supabase (painel)

### 13.3. Trigger de `updated_at` — automático

```sql
DROP TRIGGER IF EXISTS set_updated_at ON platform_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

Toda vez que **qualquer campo** muda, `updated_at` é rebumpado. É uma convenção — hoje ninguém lê essa coluna, mas está lá para o futuro ("plataforma foi reconfiguradora há quanto tempo?").

### 13.4. Referências cruzadas

- `default_plan_code` → FK **soft** para `plans(code)` (não há CHECK no banco, mas a rota `/api/platform/settings` valida antes de gravar).
- `retention_defaults` → estrutura em `src/lib/retention/types.ts` (`RetentionConfig`); herança: conta > **este campo** > `.env` > sem limite.
- Avisos de vencimento/bloqueio → tabelas `account_plan_events`, `platform_audit_log`, `system_notifications`.

### 13.5. Variáveis de `.env` que completam a configuração

| Var | Usa | Crítica | Se faltar |
| --- | --- | --- | --- |
| `AUTOMATION_CRON_SECRET` | Gatilho de cron (`/api/automations/cron`, `/api/broadcasts/cron`) | 🔴 | Nada é agendado, silenciosamente |
| `MESSAGE_RETENTION_ENABLED` | Trigger da varredura de mensagens | 🟡 | Limpeza **não roda**, `retention_defaults` é só registro |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_USER` | E-mail transacional e avisos | 🟡 | E-mail é no-op, `system_notifications.email_status` fica `skipped` |
| `SYSTEM_NOTIFICATION_EMAIL` | Destinatário dos avisos do console | 🟡 | Avisos não são entregues (webhook continua tentando) |
| `SYSTEM_EVENT_WEBHOOK_URL`, `SYSTEM_EVENT_WEBHOOK_SECRET` | Webhook de eventos | 🟡 | Webhook é no-op, `system_notifications.hook_status` fica `skipped` |
| `PLATFORM_OWNER_EMAILS` | Acesso ao console (`/admin`) | 🔴 | `/admin` → 404 |
| `PLATFORM_ADMIN_SECRET` | Rotas `/api/admin/**` | 🔴 | `/api/admin/**` → 503 |

---

## 14. Armadilhas conhecidas (expansão do §10)
