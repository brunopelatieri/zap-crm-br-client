# Guia do console do proprietário (`/admin`, SPEC 062)

> Como o **proprietário da plataforma** (o mantenedor, com login — não o
> segredo de servidor de `/api/admin/**`) opera contas, planos, bloqueio e
> retenção pelo navegador. Para o desenho técnico completo, veja
> [`docs/spec-062-console-do-proprietario.md`](./spec-062-console-do-proprietario.md).
> Para as mesmas operações por `curl`/automação (a outra porta, com
> `x-admin-secret`), veja
> [`docs/guia-operacao-planos-e-quotas.md`](./guia-operacao-planos-e-quotas.md) —
> as duas portas chamam o mesmo código em `src/lib/platform/`, então o que
> uma faz a outra também produziria, com um `actor` diferente no histórico.

---

## 1. O que é o console, em uma frase

`/admin` é a única porta que **enxerga além de uma conta**: lista todas as
contas do deployment, bloqueia/desbloqueia, troca plano, edita o catálogo
comercial e o padrão global de retenção — tudo isso sem nunca afrouxar uma
policy de RLS para conseguir (SPEC 062 §1). Toda leitura cross-account
acontece numa rota de servidor com `service_role`, atrás de uma checagem de
sessão — nunca pelo `supabase-js` direto do navegador.

**Não é um segundo sistema de permissões.** Não existe papel "operador" no
schema, não existe tabela `platform_admins`. O proprietário é identificado
por uma lista de e-mails na variável de servidor `PLATFORM_OWNER_EMAILS` —
de propósito (§2): uma tabela criaria um caminho de escalonamento de
privilégio *dentro do banco* (uma policy errada, um script de manutenção, um
dump restaurado promoveria alguém a operador de todas as contas); o `.env`
exige acesso ao servidor, o mesmo nível de confiança que
`PLATFORM_ADMIN_SECRET` já exige para `/api/admin/**`.

---

## 2. Como entrar

```bash
# .env.local (ou variável de ambiente do host em produção)
PLATFORM_OWNER_EMAILS=bruno@zapcrmbr.com,outra-pessoa@zapcrmbr.com
```

Lista separada por vírgula. **Sem essa variável, o console não existe** —
não é uma questão de permissão, é que `/admin` e toda rota `/api/platform/**`
respondem **404** para qualquer requisição, mesmo do e-mail certo.

Depois de configurar a variável:

1. Faça login normalmente em `/login` — **é a mesma tela de login de
   qualquer cliente**, o mesmo Supabase Auth. Não existe uma segunda tela de
   login "de operador".
2. Abra `/admin`.

A guarda (`requirePlatformOwner()`, `src/lib/platform/owner.ts`) checa, nesta
ordem, e **todas**:

1. `PLATFORM_OWNER_EMAILS` definida no servidor;
2. sessão Supabase válida (`getUser()`, que valida no servidor de auth — não
   `getSession()`, que confiaria num cookie local não verificado de novo);
3. `email_confirmed_at` não nulo — um e-mail não confirmado não prova posse
   do endereço;
4. o e-mail da sessão, normalizado (`trim` + `toLowerCase`) e comparado com
   `timingSafeEqual` por item da lista, bate com algum item.

**Qualquer uma das quatro falhando dá exatamente o mesmo 404** — de
propósito (§2.4): um estranho batendo em `/admin` não pode diferenciar
"a variável não existe" de "minha sessão expirou" de "meu e-mail não está na
lista". O diagnóstico real (qual das quatro falhou) só existe no log do
servidor, nunca na resposta HTTP.

**O e-mail do proprietário pode ou não ter uma conta de cliente comum neste
mesmo banco** (`profiles`/`accounts`) — os dois casos funcionam. Se ele
tiver, o console usa isso para uma coisa: barrar o autobloqueio (§6 abaixo).
Se não tiver, essa checagem simplesmente não encontra nada e segue.

**Saindo:** botão "Sign out" no cabeçalho do console — chama
`supabase.auth.signOut()` direto (o console não usa o `AuthProvider` do
`(dashboard)`, que é um layout independente de propósito).

### Se você se trancar fora

Bloquear a própria conta ou o próprio usuário é recusado na tela **e** na
rota (§4.4, §6 abaixo) — mas isso só cobre o proprietário bloqueando **a si
mesmo**. Se `PLATFORM_OWNER_EMAILS` for editada errado, ou a variável sumir
num deploy, a única saída é corrigir a variável e reiniciar o servidor — não
existe recuperação por SQL para "esqueci de configurar a variável", porque
não há tabela nenhuma para consertar.

---

## 3. Mapa das seções

| Seção | Rota | O quê |
| --- | --- | --- |
| Visão geral | `/admin` | Números do deployment inteiro, cada um um link filtrado |
| Contas | `/admin/accounts` | Lista + busca + filtros; `/admin/accounts/{id}` é o detalhe |
| Planos | `/admin/plans` | Catálogo comercial — criar, editar, aposentar |
| Retenção | `/admin/retention` | Padrão global de limpeza de mensagens, por tipo de canal |
| Solicitações | `/admin/requests` | Pedidos de troca de plano pendentes de aprovação |
| Configurações | `/admin/settings` | Interruptores e parâmetros da plataforma inteira |
| Notificações | `/admin/notifications` | A outbox de avisos do sistema (SPEC 063) — quem foi avisado, por qual canal, e o que falhou |

O cabeçalho mostra seu e-mail, a navegação entre as seções, um link "Back to
app" (volta para o `(dashboard)` normal) e o botão de sair. O layout **não
tem** sidebar de inbox nem seletor de conta — misturar os dois criaria um
estado sem sentido ("qual conta está selecionada?" não existe aqui, o
console lê todas de uma vez).

---

## 4. Visão geral (`/admin`)

Seis cards, cada um lendo `GET /api/platform/summary` e levando, ao clicar,
para `/admin/accounts` já com o filtro aplicado — um número que não leva a
lugar nenhum vira enfeite na segunda semana:

| Card | Link | Como é calculado |
| --- | --- | --- |
| Active accounts | `?status=active` | `status ∈ {active, trialing}` **e** não bloqueada |
| Blocked accounts | `?blocked=true` | `accounts.blocked_at IS NOT NULL` |
| Expiring in 7 days | `?expiringInDays=7` | `current_period_end` dentro de 7 dias, ainda não vencido (borda inclusiva: vence *exatamente* no dia 7 conta) |
| Expired | `?expired=true` | `current_period_end` já passou |
| Open requests | (vai para `/admin/requests`) | `plan_change_requests` com `status='pending'` |
| Over quota | `?overage=true` | Uso de contatos acima do limite do plano — **ver limitação abaixo** |

Um `Alert` aparece no topo quando `quotas_enforced = FALSE`: "Quotas are
turned off — no limit is being enforced on any account." Sem isso, o
proprietário edita planos por uma hora e conclui que o sistema está
quebrado — é a mesma armadilha do guia de operação, do outro lado.

**Limitação conhecida (F3/F4, ainda não revisitada):** "Over quota" olha só
a quota de **contatos** (a única persistida como contador — `contacts` em
`account_usage_counters`). Uma conta estourando só a quota de membros ou de
canais **não aparece aqui nem no filtro da lista** — o detalhe de UMA conta
(`/admin/accounts/{id}`) mostra o uso real de todas as quotas; é lá que essa
lacuna não existe.

---

## 5. Contas (`/admin/accounts`)

### 5.1. A lista

Uma **linha por conta** (nunca por usuário) — busca por nome
(`?q=`), e os filtros que os cards da visão geral já aplicam
(`status`, `blocked`, `expiringInDays`, `expired`, `overage`, mais `plan`
por código, todos combináveis na querystring). Paginado em 25 por página
(`pageSize` até 100).

Colunas: nome da conta (com badge "Blocked" quando aplicável) · plano + ciclo
· status (badge) · vencimento · nº de membros · contatos usados/limite ·
botão "Open account".

> A consulta é **uma ida ao banco por página**, nunca uma por conta dentro
> de um laço — é o que faz a tela abrir rápido mesmo com centenas de contas
> (SPEC 062 §7.2).

### 5.2. O detalhe de uma conta (`/admin/accounts/{id}`)

Seções, nesta ordem:

1. **Cabeçalho** — nome, badge de bloqueio (com "desde quando"), data de
   criação, motivo do bloqueio (se houver), e o switch de bloqueio da
   **conta** (§6).
2. **Plano** — plano atual, ciclo (mensal/anual), status, adesão
   (`started_at`), vencimento (`current_period_end`, ou "no expiration"),
   "cancelamento agendado para …" quando `cancel_at_period_end = true`, e
   "carência até …" quando `grace_until` estiver preenchido. Três botões:
   **"Alterar vencimento"** (§5.5), **"Registrar pagamento"** (§5.6) e
   **"Trocar plano"** (§5.3). Os dois primeiros ficam desabilitados, com o
   motivo, quando o plano não tem ciclo de cobrança.
3. **Pagamentos** — os 20 últimos pagamentos da conta e o botão "Desfazer"
   (§5.6). Só aparece para planos com ciclo.
4. **Uso** — as mesmas barras de quota que o cliente vê em "Plano e uso"
   (`PlanUsageBars`, componente reaproveitado) — a garantia de que o
   proprietário vê **exatamente** o que o cliente vê quando liga
   reclamando dela.
5. **Retenção** — a política de retenção **daquela conta**, por tipo de
   canal (§8 abaixo — mesmo componente que a tela global usa, com a prévia
   calculada sobre os dados reais desta conta).
6. **Membros** — nome, e-mail, papel (**texto simples, não editável** — ver
   limitação abaixo), status (badge "Blocked"/"Active"), o lápis de **editar
   nome/e-mail** (§5.7) e o switch de bloqueio de **cada pessoa** (§6).
7. **Histórico** — `account_plan_events` e `platform_audit_log`
   intercalados por data, mais recente primeiro (até 20 eventos de plano e
   50 ações do console — vencimento alterado, pagamento registrado/desfeito,
   perfil de usuário editado). Cada linha mostra `actor` — é aqui que "isso
   foi um clique meu ou um script?" se responde (§13 abaixo).

**Limitações conhecidas desta seção (não implementadas ainda):**

- **Não dá para editar o papel de um membro pelo console.** A coluna
  "Role" é só leitura; não existe `PUT /api/platform/users/{id}/role` (a
  SPEC original previa essa rota — não foi construída). Promover/rebaixar
  continua sendo pelo próprio dashboard da conta (um admin/owner dela
  fazendo isso de dentro), não pelo console.
- **Não existe botão de "recontar uso"** nesta tela. `SELECT
  recount_account_usage('<id>')` continua sendo SQL direto — ver
  [guia de operação §8](./guia-operacao-planos-e-quotas.md#8-recontar-o-uso-de-uma-conta-se-o-contador-divergir).

### 5.3. Trocar o plano de uma conta

Botão "Trocar plano" no cartão de plano abre um diálogo com: seletor do
plano de destino (lista o catálogo inteiro, inclusive planos privados),
seletor de status (`trialing`/`active`/`past_due`/`suspended`/`canceled`) e
um campo de motivo (texto livre, vai para `account_plan_events.reason`).
Confirmar chama `PUT /api/platform/accounts/{id}/plan` — a **mesma** função
(`changeAccountPlan`) que `PUT /api/admin/accounts/{id}/plan` chama pela
outra porta, então "as duas portas produzem o mesmo evento" é garantido por
construção, não por disciplina de manter duas cópias sincronizadas.

O `actor` gravado é sempre `console:<seu e-mail>` — nunca lido do corpo da
requisição (o navegador não pode alegar ser outra pessoa). Toda troca grava
**duas** linhas: uma em `account_plan_events` (histórico visível ao cliente
pela API/console) e uma em `platform_audit_log` (`action: 'plan.change'`,
só visível ao proprietário).

**Este diálogo HERDA o vencimento existente — não recomeça o ciclo** (SPEC 062
§3.3.1, decisão B, 2026-08-30). Diferente do autosserviço do cliente (§10
abaixo, que sempre recomeça o período "sem pró-rata"), o console é neutro por
padrão: se a conta já vencia num certo dia, continua vencendo naquele mesmo
dia depois da troca — trocar o Essencial pelo Profissional no dia 15 não
empurra o vencimento. Só em dois casos o vencimento muda:

- A conta **nunca teve vencimento** (veio do backfill, ou nasceu no
  `unlimited`) e o plano novo é pago mensal/anual → um vencimento é calculado
  **a partir da data desta troca**, nunca retroativo.
- O plano novo **não vence** (Grátis, `unlimited`, sob medida sem ciclo) → o
  vencimento existente é limpo, junto com cancelamento agendado e carência
  (nenhum dos dois faz sentido sem vencimento).

Antes de 2026-08-30, `changeAccountPlan` nunca tocava nessas colunas — o
efeito colateral era `current_period_end` ficar `NULL` para sempre em
qualquer conta trocada só pelo console (o caminho mais comum sem gateway de
pagamento), escondendo o bloco de ciclo/adesão/vencimento da tela "Plano e
uso" do cliente. Reaproveita o mesmo `computePeriodEnd()`
(`@/lib/plans/billing.ts`) que o autosserviço do cliente (§10 abaixo,
`src/lib/plans/self-service.ts`) já usava — mesma regra de fim de mês, sem
duplicar lógica.

**Limitação conhecida:** o diálogo **não tem campo para `limitOverrides`**
(a exceção por conta — "15.000 contatos em vez de 2.000"). A rota por trás
(`PUT .../plan`) aceita o campo no corpo, então dá para conceder um override
pelo console chamando a rota direto (`fetch` no console autenticado, ou
sessão de navegador via DevTools) — mas não há um formulário para isso
ainda. Pela porta de automação, é
[`PUT /api/admin/accounts/{id}/plan` com `limitOverrides`](./guia-operacao-planos-e-quotas.md#63-conceder-uma-exceção-por-conta-override).

### 5.4. Criar uma conta nova para um cliente (provisionamento)

**Não existe rota no console (nem em `/api/platform/**`, nem em
`/api/admin/**`) que crie uma conta + usuário owner diretamente** — nenhuma
delas faz `INSERT` em `accounts` ou chama a Admin API de Auth do Supabase.
Não é um recurso escondido em outro lugar; é uma lacuna conhecida (§15).

**O que de fato cria uma conta é a linha em `auth.users`** — não importa por
qual porta ela chega. A trigger `on_auth_user_created`
(`supabase/migrations/017_account_sharing.sql:719-721`) chama
`handle_new_user()` (`017_account_sharing.sql:691-721`), que faz, na mesma
transação:

```sql
INSERT INTO public.accounts (name, owner_user_id) VALUES (…, NEW.id) RETURNING id INTO v_account_id;
INSERT INTO public.profiles (user_id, …, account_id, account_role) VALUES (NEW.id, …, v_account_id, 'owner');
```

Ou seja: **toda conta nasce com exatamente um dono, atribuído atomicamente no
cadastro.** Não existe (e não deveria existir) um caminho que crie uma conta
sem dono, ou que promova alguém a dono depois sem passar por
`transfer_account_ownership` (ver abaixo).

**A. O cliente se cadastra sozinho (caminho normal).** Ele acessa `/signup`,
preenche e-mail/senha/nome — `supabase.auth.signUp()` no cliente, nenhuma
lógica de conta no app. A trigger faz o resto. É o fluxo para o qual o
produto foi desenhado; não exige nada do mantenedor.

**B. O mantenedor provisiona por ele** (venda fechada antes do primeiro
login, demonstração, migração de outro sistema). Como não existe rota no app
para isso, o caminho é criar o usuário direto no Supabase, **fora da
aplicação** — a mesma trigger dispara do mesmo jeito, porque ela reage a
qualquer `INSERT` em `auth.users`, não a uma origem específica:

1. No painel do projeto Supabase certo (⚠️ confirme com o mantenedor qual —
   `vn`, `rs` ou `jh` — antes de criar usuário nele) → **Authentication →
   Users → Add user** → e-mail + senha (ou "Send invite email" para o
   próprio cliente escolher a senha). Isso grava em `auth.users`, e a
   trigger cria `accounts` + `profiles.account_role = 'owner'` na mesma
   transação.
2. Confira que a conta nasceu certa:
   ```sql
   SELECT a.id, a.name, p.email, p.account_role
     FROM accounts a JOIN profiles p ON p.account_id = a.id
    WHERE p.email = '<email do cliente>';
   ```
3. Com `quotas_enforced = TRUE`, a conta nasce no plano
   `platform_settings.default_plan_code` (o padrão do deployment) — troque
   pelo plano vendido em `/admin/accounts/{id}` → "Trocar plano" (§5.3), ou
   por `PUT /api/admin/accounts/{id}/plan`
   ([guia de operação §6.2](./guia-operacao-planos-e-quotas.md#62-trocar-o-plano-efetivar-um-upgradedowngrade)).

**Não crie a linha em `accounts` manualmente por SQL sem um `auth.users`
real por trás.** Nada além do trigger sabe montar `profiles`/`account_plans`
corretamente, e uma conta sem correspondência em `auth.users` não tem por
quem ser logada.

**O que isso não faz:** transferir a posse de uma conta **já existente**
para outra pessoa — isso é `transfer_account_ownership(p_new_owner_user_id)`
(`018_account_member_rpcs.sql:217-283`): só o owner atual pode chamar, e o
alvo **já precisa ser membro da mesma conta** (o owner atual vira `admin`, o
alvo vira `owner`). Sem UI ainda; é RPC direta por SQL.

**Convite nunca cria um segundo owner.** `account_invitations.role` tem
`CHECK (role <> 'owner')` no banco (`017_account_sharing.sql:94`) e a rota
`POST /api/account/invitations` recusa `role: 'owner'` antes de gravar
(`src/app/api/account/invitations/route.ts:189-198`) — uma conta tem sempre
exatamente um dono, e `set_member_role` bloqueia explicitamente promover ou
rebaixar para/de `'owner'` por esse caminho (`018_account_member_rpcs.sql:95-102`).

### 5.5. Alterar a data de vencimento (SPEC 078)

Botão **"Alterar vencimento"** no cartão de plano. Serve para o caso em que
a data certa não é "uma renovação": cliente negociou um prazo, o vencimento
foi gravado errado, um teste que precisa ir até o fim do mês. **Não é um
pagamento** — não aparece no cartão "Pagamentos" e não dispara `plan.renewed`.

- **Data** — um *dia* no calendário de São Paulo, de hoje até hoje + 3 anos.
  O plano vale até 23:59:59 daquele dia (a conversão é feita no banco, não no
  navegador, então o dia nunca desloca por causa do fuso de quem opera).
  Data passada não é aceita: dispararia `past_due` + carência já vencida na
  próxima varredura (§11). Para "este cliente já está inadimplente", use o
  diálogo de status do "Trocar plano" (§5.3).
- **Ciclo** — mensal ou anual. É o único lugar do console que grava `yearly`;
  o diálogo de troca de plano (§5.3) mantém o ciclo da conta. Mude para anual
  **antes** de registrar o pagamento de um cliente anual, senão o pagamento
  avança 1 mês em vez de 1 ano.
- **Efeitos** — uma conta `past_due` volta para `active` e a carência é
  limpa (o vencimento agora está no futuro). Cancelamento agendado **não**
  é desfeito: ele passa a valer na nova data (o diálogo avisa). A data de
  adesão não muda.
- **Só para planos com ciclo.** Plano Grátis, `unlimited` ou sob medida não
  vence: o botão fica desabilitado com o motivo. Sem isso o cron marcaria
  `past_due` num plano que, por definição, não vence.
- **Rastro** — `platform_audit_log` (`billing.period_end.set`, com
  vencimento anterior e novo, status e ciclo), a atividade da conta
  ("O vencimento do plano foi alterado", visível ao cliente em `/activity`,
  ator "Suporte da plataforma") e o webhook de saída `plan.period_changed`.

Antes da SPEC 078 isto era `UPDATE account_plans SET current_period_end = …`
no SQL Editor, sem trilha. **Não faça mais por SQL.**

### 5.6. Registrar um pagamento manual e desfazê-lo (SPEC 078)

Botão **"Registrar pagamento"** no cartão de plano: você recebeu o Pix ou o
boleto compensou, e quer avançar o vencimento sem `curl`. O CRM **não
cobra nem concilia** — a forma e o valor são só registro informativo.

| Campo | Regra |
| --- | --- |
| Data do pagamento | Hoje ou até 365 dias atrás. Não aceita futuro |
| Períodos pagos | 1 a 12. Um período = um **ciclo** da conta (mensal = 1 mês, anual = 1 ano) |
| Forma | Pix, boleto, cartão, transferência, dinheiro, outro |
| Valor (R$) | Opcional |
| Identificador | Opcional — ID Pix (E2E), nº do boleto, nota fiscal… |
| Observação | Opcional, até 500 caracteres |

O diálogo mostra "vencimento atual → resultante" antes de confirmar. O
vencimento avança a partir do **vencimento atual**, nunca de hoje (pagar
atrasado não encurta o que o cliente já tinha). É uma *estimativa*: o
servidor calcula a data final e, em fim de mês, pode diferir em um dia.

**Identificador e duplicidade.** Se você informar um identificador, ele vira
a chave de idempotência *literal* (sem prefixo): se o sistema de cobrança do
cliente também chamar `POST /api/admin/accounts/{id}/billing/renew` com o
mesmo ID, a segunda aplicação responde `already_applied` e o vencimento
avança uma vez só. O `already_applied` só vale quando o identificador já é um
pagamento **vigente desta mesma conta**: se ele pertence a **outra conta**, ou
a um pagamento que você **desfez**, o registro é recusado (o diálogo avisa) e
nada é aplicado — para registrar de novo um pagamento desfeito, use outro
identificador (por exemplo, acrescente `-2`). Em branco, o diálogo gera um `console:<uuid>` **quando
abre** — clique duplo ou nova tentativa reenviam o mesmo valor e não
registram duas vezes.

**Efeitos.** A conta `past_due` ou `trialing` passa a `active` (a carência é
limpa). **Pagamento não desbloqueia a conta** (o aviso aparece no diálogo e
no toast) e **não remove cancelamento agendado**. Rastro:
`platform_audit_log` (`billing.payment.manual`), atividade da conta
(`plan.renewed`, origem `console`), webhook `plan.renewed` com
`data.source = "console"` e o aviso do proprietário (§20).

**Cartão "Pagamentos".** Logo abaixo do plano: os 20 últimos pagamentos, com
data, forma, valor, períodos, vencimento anterior → novo, quem registrou
(`console:<email>` ou `api:billing-renew`), identificador e situação.

**Desfazer.** O botão vale só no **último pagamento não estornado** da
conta, e só se o vencimento atual ainda é o que ele gravou — senão desfazer
apagaria também uma alteração manual posterior. Desfazer restaura
vencimento, status e carência anteriores e **marca** a linha como
estornada (nunca apaga). Fora dessa regra o botão fica desabilitado com o
motivo:

| Motivo | O que fazer |
| --- | --- |
| Não é o último pagamento | Desfaça os mais novos primeiro, do último para o primeiro |
| O vencimento mudou depois do pagamento | Não há desfazer limpo; corrija com "Alterar vencimento" (§5.5) |
| Registrado antes da SPEC 078 | Esses pagamentos não guardam o status anterior — corrija com "Alterar vencimento" |

O **identificador continua ocupado** depois do estorno, de propósito, para
um sistema externo não reaplicar aquele pagamento. Para lançar o mesmo
pagamento em outra conta (você registrou na conta errada), use **outro**
identificador. O estorno não dispara webhook de saída.

### 5.7. Editar nome e e-mail de um usuário (SPEC 078)

Lápis na linha de cada membro (cartão "Membros"). Serve para o cliente que
perdeu acesso ao e-mail antigo ou digitou errado no cadastro — inclusive
quando é o **dono da conta**.

- **Nome** — 1 a 120 caracteres. Muda só o perfil da pessoa; o nome da
  conta (empresa) **não** muda junto.
- **E-mail** — a troca é **imediata e já confirmada** (sem link de
  confirmação): o novo e-mail passa a ser o login na hora, com a senha que a
  pessoa já tinha. Reenviar link seria reintroduzir exatamente o bloqueio que
  motiva a funcionalidade. `profiles.email` acompanha sozinho (trigger da
  migração 089).
- **Sessões abertas continuam ativas** até o próximo refresh do token (até
  1 hora). Para cortar acesso de uma credencial comprometida, **bloqueie o
  usuário** (§6.3) — corrija o e-mail depois e desbloqueie.
- **Usuário bloqueado pode ser editado.**
- O diálogo manda só o que mudou. O servidor recusa e-mail igual ao atual,
  e-mail já usado por outro usuário (`409`, nada é gravado — nem o nome
  enviado junto) e e-mail inválido.
- Se o e-mail mudar mas o nome falhar, a tela avisa e recarrega: o login já
  mudou. Confira o usuário e repita só o nome.

Rastro: `platform_audit_log` (`user.profile_update`, com e-mail/nome antigos
e novos) e a atividade da conta ("O suporte da plataforma atualizou o perfil
de …") — esta **sem** os endereços de e-mail, só quais campos mudaram.

**Aviso ao e-mail antigo (D-11).** Depois de trocar o e-mail, o sistema
manda um e-mail curto ao endereço **antigo**: "o e-mail de acesso da sua
conta no ZAP CRM BR foi alterado pelo suporte em dd/mm/aaaa; se você não
reconhece, responda a este e-mail". O corpo **não** traz o endereço novo, o
nome da conta nem link do console, e o *reply-to* é o seu
(`SYSTEM_NOTIFICATION_EMAIL`). Usa o mesmo SMTP do §20 — sem `SMTP_HOST` +
`SYSTEM_NOTIFICATION_EMAIL` o aviso simplesmente não sai (desfecho `skipped`).
É melhor esforço: **a troca nunca falha por causa do aviso**. O desfecho
(`sent` / `skipped` / `failed`) fica em `platform_audit_log`
(`payload.oldEmailNotice`); se for `failed`, a tela mostra um toast amarelo
e o erro SMTP vai para o log do servidor. Trocar só o nome não envia nada.

### 5.8. Como trocar o e-mail do proprietário da plataforma

O console **recusa** trocar o e-mail de quem está em `PLATFORM_OWNER_EMAILS`
(`cannot_edit_platform_owner_email`; o campo aparece travado) e recusa dar a
qualquer outro usuário um e-mail dessa lista
(`email_reserved_for_platform_owner`). Os dois casos são de segurança: trocar
o e-mail do proprietário pela tela o tira do console no clique seguinte, e
dar o e-mail dele a um cliente daria a ele o console inteiro assim que
confirmasse o login. O **nome** do proprietário pode ser editado normalmente.

Para trocar o e-mail do proprietário, na ordem:

1. Edite `PLATFORM_OWNER_EMAILS` no `.env` do host e **inclua o e-mail novo**
   (mantenha o antigo por enquanto, para você não se trancar fora).
2. Redeploy.
3. Troque o e-mail do usuário (pelo painel do Supabase, ou pelo próprio
   perfil — que exige confirmar nos dois endereços).
4. Entre com o e-mail novo, confira que `/admin` abre e só então remova o
   antigo da variável e redeploye de novo.

---

## 6. Bloquear e desbloquear

### 6.1. O que bloquear faz de verdade

Bloqueio **não é uma checagem espalhada pelo TypeScript** — é uma condição
a mais dentro de `is_account_member()`, a função SQL que já está no coração
de praticamente toda policy RLS do repositório (migração 069). Bloquear uma
conta ou uma pessoa vale, na mesma hora, para **toda tabela protegida por
RLS de uma vez**: contatos, conversas, mensagens, disparos, automações,
chaves de API, retenção — sem precisar reescrever nenhuma policy.

Três camadas, e nenhuma sozinha basta:

| Camada | Onde | O que garante |
| --- | --- | --- |
| **RLS** | `is_account_member()` | Dado nenhum sai do banco pela sessão do cliente, mesmo por um `insert` direto do navegador |
| **Sessão do dashboard** | `getCurrentAccount()` + layout `(dashboard)` | A pessoa bloqueada vê a página `/blocked` (§6.4), não um app vazio sem explicação |
| **Motores (`service_role`)** | Código explícito em 9 pontos (§4.3 da SPEC) | `service_role` não passa por RLS — sem checagem própria, uma conta bloqueada continuaria **enviando** campanha/automação |

Os 9 pontos onde `service_role` checa bloqueio explicitamente: disparo
agendado (`/api/broadcasts/cron`), motor de automações, motor de flows,
envio por canal (`src/lib/channels/send.ts` — o funil comum de disparo,
automação, flow e envio manual), auto-resposta de IA, API pública
(`account_blocked`, ver [`docs/public-api.md`](./public-api.md)), webhook de
entrada de terceiros (SPEC 055 — bloqueia, é integração, não mensagem de
cliente final). **Dois pontos que continuam funcionando mesmo bloqueados,
de propósito:**

- **Mensagem recebida** (D-9) — o WhatsApp da conta bloqueada continua
  recebendo e a mensagem entra no banco normalmente. Perder a mensagem de
  quem está tentando falar com um cliente bloqueado seria pior que a
  conta continuar "existindo" um pouco mais.
- **Varredura de retenção** (SPEC 060) — continua rodando; não apagar
  histórico seria acumular custo de armazenamento numa conta que não paga.

### 6.2. Bloquear/desbloquear uma conta

No cabeçalho do detalhe da conta, ou na lista (se você tiver acesso direto à
rota — a lista hoje **não tem** o switch inline que a SPEC original
desenhava, só o detalhe tem). **Bloquear pede confirmação** (diálogo com
campo de motivo opcional); **desbloquear não** — é um clique só. A
assimetria é proposital: bloquear tira o acesso de todo mundo de uma vez;
pedir confirmação para o lado inofensivo treinaria você a clicar
"confirmar" sem ler, o hábito que faz a confirmação do lado perigoso deixar
de funcionar.

`POST /api/platform/accounts/{id}/block` (`{ reason?: string }`) /
`DELETE` para desbloquear. Grava `accounts.blocked_at`/`blocked_reason`/
`blocked_by = 'console:<seu e-mail>'` — **nenhuma policy de escrita existe
para o cliente nessas colunas**, nem para o dono da própria conta.

### 6.3. Bloquear/desbloquear uma pessoa

Mesmo mecanismo, na tabela de membros do detalhe da conta.
`POST`/`DELETE /api/platform/users/{id}/block`. **Bloquear o dono
(`account_role = 'owner'`) de uma conta é permitido** — a UI mostra um aviso
extra ("esta conta ficará sem nenhum dono ativo") porque é o caminho normal
para credencial comprometida (ex.: a senha do dono vazou, mas a conta em si
deve continuar operando com os outros membros). O que **nunca** é permitido:
bloquear a conta inteira **ou** bloquear só o dono são dois botões
diferentes — o primeiro para "esta conta parou de pagar", o segundo para
"esta pessoa específica está comprometida".

### 6.4. O autobloqueio é sempre recusado

O proprietário **não consegue bloquear a própria conta nem o próprio
usuário** — nem clicando, nem chamando a rota direto. A UI desabilita o
switch com o motivo no `title`; a rota recusa com `400` de qualquer forma
(a UI é conveniência, a rota é a garantia — `src/lib/platform/guards.ts`,
`canBlockAccount`/`canBlockUser`). A comparação é por **id** (quando o
proprietário tem perfil neste banco) **e** por **e-mail normalizado**
(cobre o caso de o proprietário ser dono de OUTRA conta que não a dele
mesma — improvável, mas a checagem por e-mail existe para esse cenário).

Se você chegou a se bloquear por algum caminho que este guia não previu, a
saída documentada (SPEC 062 §11) é `UPDATE accounts SET blocked_at = NULL`
direto no banco — não existe tela para desfazer isso porque a tela mora
atrás da própria conta que acabou de ser bloqueada.

### 6.5. O que o cliente vê (`/blocked`)

Uma pessoa com sessão numa conta ou usuário bloqueado é redirecionada para
`/blocked` (fora do `(dashboard)`, para não formar um laço). A página:

- **Nunca diz qual dos dois bloqueios está ativo** — o texto é o mesmo se
  foi a conta inteira ou só aquela pessoa. Quem sabe é quem bloqueou.
- **Diz explicitamente que o dado continua lá** — "listas vazias são
  indistinguíveis de perda de dados" é a armadilha nº 1 desta SPEC; sem essa
  frase, o cliente bloqueado abre um chamado de pânico achando que perdeu
  tudo.
- Mostra o motivo (`blocked_reason`), se você preencheu um ao bloquear.
- Mostra `platform_settings.support_email` (§7 abaixo) para quem escrever —
  **sem essa variável preenchida em Configurações, o bloqueado não tem para
  quem reclamar**.
- Um botão de sair.

---

## 7. Catálogo de planos (`/admin/plans`)

Um `Card` por plano. Clicar num card abre o mesmo diálogo de edição; o
botão "New plan" abre em branco. Campos: código (`code`, imutável depois de
criado), nome, descrição, preço em centavos, moeda, período de cobrança
(`monthly`/`yearly`/`custom`/`none`), desconto anual próprio (opcional —
vazio usa o padrão da plataforma, calculado ao vivo abaixo do campo), ordem
de exibição, "público" (aparece no catálogo que o cliente vê) e "ativo".

**Quotas e recursos são campos gerados a partir de `QUOTA_KEYS`/
`FEATURE_KEYS`** (`src/lib/plans/types.ts`) — não uma lista escrita à mão
que fica desatualizada na próxima quota adicionada ao sistema. Cada quota
tem um campo numérico (vazio = ilimitada; `0` **bloqueia** o recurso por
completo, não é a mesma coisa que "ausente"); cada recurso é um checkbox.

Salvar chama `POST /api/platform/plans`, que faz **upsert por `code`** — o
mesmo comportamento de `POST /api/admin/plans` pela outra porta, e a mesma
validação (`validateCatalog()`: chave de quota/feature desconhecida é
rejeitada com erro claro antes de gravar).

**Não existe exclusão de plano, no console ou por API** — de propósito: uma
conta assinando aquele plano impediria o apagamento no banco de qualquer
jeito (`account_plans.plan_id` é `ON DELETE RESTRICT`). Para "aposentar" um
plano, desmarque "ativo" — ele some do catálogo público mas continua
funcionando para quem já está nele.

---

## 8. Retenção (`/admin/retention`)

A SPEC 060 entregou a política de retenção de mensagens como configuração
do **dono da conta**; a SPEC 062 §3.8 tirou isso do cliente e deu ao
proprietário da plataforma — nenhum dono de conta, nem admin, vê ou edita
essa política pela sessão dele mais. Duas telas:

### 8.1. Padrão global (`/admin/retention`)

O que o `.env` (`MESSAGE_RETENTION_WHATSAPP_*`) definia sozinho até aqui,
agora editável por tipo de canal (`whatsapp_qr` / `whatsapp_cloud`), acima
do `.env` na cadeia de precedência:

> linha da política da conta → **padrão global daqui** → padrão do `.env` → sem limite

Cada canal tem três campos (máximo de mensagens, dias de retenção, máximo de
favoritas) — vazio herda do `.env`; salvar um só campo **nunca** apaga os
outros dois (fusão dimensão a dimensão, não substituição do objeto
inteiro). A tela também mostra:

- O aviso do **piso de idade** — mensagens mais novas que
  `MESSAGE_RETENTION_MIN_AGE_HOURS` nunca são removidas, não importa o
  limite configurado.
- O estado da **última varredura** (quando rodou, quantas mensagens saíram).
- Um `Alert` vermelho quando `MESSAGE_RETENTION_ENABLED` está ausente:
  "a varredura não roda; os limites abaixo são registro, nada é apagado".
  Sem esse aviso, você configura tudo, nada acontece, e conclui que o
  sistema está quebrado.

**O interruptor da varredura (`MESSAGE_RETENTION_ENABLED`) continua só no
`.env`, não vai para a tela** — ligar limpeza automática de histórico por
clique é exatamente o acidente sem desfazer que a SPEC 060 existe para
impedir. A tela edita **números**, nunca o "ligar".

### 8.2. Retenção de uma conta (dentro de `/admin/accounts/{id}`)

Mesmos três campos por canal, agora resolvidos para **aquela conta**
específica, com a prévia ("Ver o que seria removido", `p_dry_run` na mesma
função SQL que a varredura de verdade usa) calculada sobre os dados reais
dela antes de salvar.

Veja [`docs/spec-060-retencao-e-limpeza-de-mensagens.md`](./spec-060-retencao-e-limpeza-de-mensagens.md)
para o desenho completo da varredura em si (o que conta como "favorita",
como o piso de idade funciona, o que acontece quando uma thread inteira é
esvaziada).

---

## 9. Solicitações de troca de plano (`/admin/requests`)

> ⚠️ Desde a SPEC 062 (D-3), isto só recebe algo quando o autosserviço está
> **desligado** (`self_service_enabled = FALSE`, §7 abaixo) ou o cliente
> pediu um plano **não público** (sob medida). Com autosserviço ligado — o
> padrão — a maioria das trocas acontece direto pela tela "Plano e uso" do
> cliente, sem passar por aqui (§10).

Lista com filtro "Pending" (padrão) / "All" (inclui aprovadas/rejeitadas/
canceladas). Cada linha: conta, plano pedido, mensagem do cliente (se
houver), data, status, e os botões **Approve**/**Reject** (com campo de nota
opcional).

**Aprovar já efetiva a troca** — chama a mesma `changeAccountPlan` que o
diálogo de "Trocar plano" usa (§5.3), com `status: 'active'`. **Os overrides
que já existiam na conta são preservados**, só plano/status mudam.
**Rejeitar** só marca a solicitação como recusada; o cliente vê o botão
"Escolher este plano" voltar a aparecer na tela dele. As duas ações gravam
`platform_audit_log` (`plan.request.approve`/`plan.request.reject`).

Uma solicitação pendente também pode ser cancelada pelo próprio admin da
conta, sem passar pelo console — botão "Cancelar solicitação" do lado dele.

---

## 10. O autosserviço do cliente (contexto — não é uma tela do console)

Vale entender o que o cliente vê em "Plano e uso" (`/plan`) para saber
quando uma solicitação chega até você (§9) e quando não chega:

- Com `self_service_enabled = TRUE` (padrão) e o plano escolhido
  **público e ativo**, clicar "Escolher este plano" abre um modal de ciclo
  (mensal/anual) e **troca na hora** — `POST /api/account/plan/change`,
  sem fila de aprovação. O período **recomeça hoje, sem pró-rata**.
  `account_plan_events` grava com `actor='self-service:<email do cliente>'`
  — é como você distingue essa troca de uma que você fez pelo console
  (`console:<seu e-mail>`) ou por automação (`api:<algo>`).
- O cliente também pode **agendar cancelamento** (mantém acesso até o fim
  do período atual) e **retomar** antes do vencimento —
  `POST`/`DELETE /api/account/plan/cancel`.
- Só cai na fila de `plan_change_requests` (§9) quando o plano **não é
  público** ou quando você desliga o autosserviço em Configurações (§7).

Você não precisa fazer nada para essas trocas acontecerem — elas já
aconteceram quando você olhar o histórico da conta. O papel do console aqui
é **auditoria** (ver quem trocou o quê) e **exceção** (planos sob medida,
deployments que preferem aprovar tudo manualmente).

---

## 11. Vencimento de plano — o que acontece sozinho

Toda conta com `current_period_end` preenchido é varrida automaticamente
pela **fase 5** de `/api/automations/cron` (o mesmo agendamento de 5 em 5
minutos que já roda automações e retenção — não existe um quarto cron para
configurar). Três coisas acontecem, sem nenhuma ação sua:

1. **Vencendo** (7 e 1 dia antes) — só um aviso, nada muda.
2. **Vencido** — se o cliente tinha agendado cancelamento, a conta desce
   sozinha para o plano padrão do deployment (`platform_settings.
   default_plan_code`, normalmente o `unlimited`/Grátis sem vencimento);
   senão, o status vira `past_due` e abre uma carência de
   `platform_settings.grace_days` dias.
3. **Carência encerrada** — outro aviso. **Nunca bloqueia sozinho** (D-7) —
   se você quiser parar a conta depois da carência, bloqueie pelo console
   (§6); o cron não faz isso por você.

Você pode ver esse histórico em `account_plan_events` (para as trocas de
plano) e em `platform_audit_log` (`action: 'plan.lifecycle_notice'`, para os
avisos de vencimento/carência — esses não mudam nada, só registram que o
aviso foi emitido, para não repetir a cada corrida do cron).

**Onde os avisos vão parar hoje:** não existe e-mail/SMTP ainda (planejado
na SPEC 063, não implementada). Os eventos (`plan.expiring`, `plan.expired`,
`plan.canceled_applied`, `plan.grace_ended`, `plan.renewed`, `plan.changed`)
são entregues pelo mecanismo de **webhook de saída por conta** que já existe
— uma conta só recebe algo se ela mesma registrar um endpoint assinando
esses eventos (`POST /api/v1/webhooks`, ver
[`docs/public-api.md`](./public-api.md#webhooks)). Sem endpoint registrado,
o evento acontece e não é visto por ninguém além de você, no
`platform_audit_log`.

### 11.1. Confirmar um pagamento e avançar o vencimento manualmente

**Pelo console** (SPEC 078): "Registrar pagamento" para avançar o vencimento
com um pagamento, e "Alterar vencimento" para ajustar a data sem pagamento —
ver §5.6 e §5.5. Não precisa de `curl` nem de SQL.

**Pela porta de automação** (um sistema de cobrança chamando a rota, ou um
script seu):

```bash
curl -X POST "$BASE_URL/api/admin/accounts/<ACCOUNT_ID>/billing/renew" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "paymentRef": "fatura-2026-09-1042", "periods": 1 }'
```

Detalhes completos (idempotência por `paymentRef`, o vencimento avança a
partir do vencimento **atual**, nunca de hoje) em
[guia de operação §7.5](./guia-operacao-planos-e-quotas.md#75-confirmar-um-pagamento-recebido-fora-do-sistema-renovação-spec-062-62).
É literalmente a forma que um webhook de gateway de pagamento assumiria no
futuro (`billing_source: 'gateway'`), sem migração nova quando esse dia
chegar. A rota e o botão do console chamam a **mesma** função do banco
(`apply_plan_renewal`): o mesmo identificador de pagamento nunca avança o
vencimento duas vezes, venha de onde vier. Desde a SPEC 078 uma renovação
também tira a conta de `trialing` (antes só `past_due` voltava a `active`).

---

## 12. Configurações da plataforma (`/admin/settings`)

### 12.1. Tabela de campos — o que cada um faz

| Campo | Tipo | Default | Visão | Efeito |
| --- | --- | --- | --- | --- |
| **Quotas** (switch) | BOOLEAN | FALSE | Tela | `platform_settings.quotas_enforced`. **Pede confirmação por diálogo, mostrando quantas contas seriam afetadas na hora** — é a ação de maior alcance do console inteiro. Com `FALSE`, nenhuma conta tem limite aplicado (comportamento de antes da SPEC 059). |
| **Self-service** (switch) | BOOLEAN | TRUE | Tela | `self_service_enabled`. Liga/desliga a troca imediata de plano pelo cliente (§10) — desligado, toda escolha de plano volta a cair na fila de `/admin/requests` (§9), sem diálogo de confirmação (efeito bem mais contido). |
| Plano padrão | TEXT | `'unlimited'` | Tela | `default_plan_code` — para onde uma conta cai quando o vencimento acaba com cancelamento agendado (§11), e quando `handle_new_user` atribui plano a uma conta nova. **Deve corresponder a um `code` existente em `plans`**, senão conta nova falha ao nascer. |
| Desconto anual padrão | INTEGER | 17 | Tela | `default_yearly_discount_percent` (0–100) — usado por todo plano cujo próprio `yearly_discount_percent` for `null` (D-5). Cálculo ao vivo embaixo do campo mostra o desconto efetivo. |
| Carência (dias) | INTEGER | 7 | Tela | `grace_days` — quantos dias depois do vencimento a conta fica `past_due` antes do aviso de "carência encerrada" (§11). Bloqueio automático por inadimplência **não existe** (D-7) — é sempre uma ação sua. |
| E-mail de suporte | TEXT | NULL | Tela | `support_email` — aparece na tela `/blocked` (§6.5) para quem foi bloqueado escrever. **Sem valor, bloqueado fica sem contato nenhum** — configure logo se você planeja usar bloqueio. |
| Contato de cobrança | TEXT | NULL | Tela | `billing_contact` — texto livre, uso interno/comercial. Não aparece em tela alguma do cliente. |
| Instruções de pagamento | TEXT | NULL | Tela | `payment_instructions` — texto livre (ex.: dados de Pix, banco, boleto). Superfície ainda não consumida em nenhuma tela do cliente hoje. |
| **Host SMTP** | TEXT | — | Leitura | Remetente de e-mail do sistema — vem do `.env` (`SMTP_HOST`), só leitura aqui. |
| **Porta SMTP** | INTEGER | — | Leitura | Vem do `.env` (`SMTP_PORT`), só leitura. |
| **Remetente** | TEXT | — | Leitura | Vem do `.env` (`SMTP_FROM`), só leitura. |
| **Destinatário (avisos)** | TEXT | — | Leitura | Vem do `.env` (`SYSTEM_NOTIFICATION_EMAIL`) — para onde os avisos do console (bloqueio, plano, vencimento) são enviados. Só leitura. |
| **URL do webhook** | TEXT | — | Leitura | Vem do `.env` (`SYSTEM_EVENT_WEBHOOK_URL`), mascarada. Recebe os mesmos eventos que o e-mail. Só leitura. |

### 12.2. Comportamento ao salvar

- **Quotas (switch):** é a única que **pede confirmação** — um diálogo mostra o número de contas que teriam limites ativados/desativados. Cancelar sai sem salvar; confirmar liga/desliga.
- **Todo outro campo:** salva **sozinho ao perder o foco**, sem diálogo. A tela não fica visualmente "com pendência".
- **Toda mudança:** grava em `platform_audit_log` com `action: 'settings.update'` e as chaves alteradas no `payload` — não o valor completo, só as que mudaram.

### 12.3. Fluxo de edição de `retention_defaults`

A tela de retenção global (`/admin/retention`, §8) é **a mesma interface** usada para editar `retention_defaults` da plataforma. Ver §8 abaixo para detalhes de como as três dimensões (máximo de mensagens, dias, máximo de favoritas) funcionam e como herança em cadeia escolhe qual valor usar.

### 12.4. Campos que vêm do `.env` (imutáveis aqui)

Nesta seção há um **card em modo leitura** mostrando:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` — configuração de e-mail
- `SYSTEM_NOTIFICATION_EMAIL` — destinatário dos avisos do sistema
- `SYSTEM_EVENT_WEBHOOK_URL` — URL do webhook (mascarada, nunca mostra a query string)

**Nenhum desses é editável pela tela** — são sempre `.env`, requerem redeploy para mudar. O motivo: credenciais sensíveis (`SMTP_PASSWORD`) nunca trafegam para o navegador, nem mascaradas. Se precisar mudar SMTP ou webhook, mexe no `.env`, redeploy, e a tela reflete sozinha na próxima recarga.

### 12.5. Impacto de cada campo — o que quebra se configurar errado

**🔴 Crítica (afeta enforcement):**
- `quotas_enforced = FALSE` mas quota está ativa → contas ilimitadas, plano não vale de verdade
- `default_plan_code` inválido (código que não existe) → conta nova falha ao nascer

**🟠 Alta (experiência degradada):**
- `support_email` vazio + bloqueio ativo → pessoa bloqueada fica sem saber onde reclamar
- `self_service_enabled = FALSE` + ninguém aprova `/admin/requests` → cliente meses em "pendente" invisível

**🟡 Média:**
- `grace_days` muito grande → conta permanece `past_due` por meses
- `.env` com `MESSAGE_RETENTION_ENABLED` absent + `retention_defaults` preenchido → limite é ignorado silenciosamente

**A rota fecha um buraco documentado:** antes da SPEC 062, ligar `quotas_enforced`
exigia `UPDATE platform_settings` por SQL direto — "não existe rota admin
para isto", como o guia de operação registrava. Agora existe, com a
confirmação que uma ação desse alcance merece.

---

## 13. Auditoria — de onde vem cada rastro

Duas tabelas, propósitos diferentes:

| Tabela | Quem escreve | Quem lê | Formato do `actor` |
| --- | --- | --- | --- |
| `account_plan_events` | Toda troca de plano/status/overrides, por qualquer porta | Console (detalhe da conta) + o próprio cliente (histórico dele, se exposto) | `console:<email>` / `api:<texto livre que o script passou>` / `self-service:<email do cliente>` |
| `platform_audit_log` | Toda ação do console e do cron automático — bloqueio, catálogo, configurações, retenção, avisos de vencimento, e (SPEC 078) `billing.period_end.set`, `billing.payment.manual`, `billing.payment.reverse` e `user.profile_update` | **Só o console** (RLS ligada, zero policies — nem o dono da conta enxerga) | `console:<email>` / `api:billing-renew` / `cron:lifecycle` |

A distinção entre `console:` e o `actor` livre da API/automação é o que
permite responder, meses depois, "isso foi um clique meu ou um script que
rodou sozinho?" — sem essa convenção, as duas portas produzindo o mesmo
efeito ficariam indistinguíveis no histórico.

---

## 14. Variáveis de ambiente relevantes

```bash
# Identidade do proprietário — sem ela, /admin e /api/platform/** são 404.
PLATFORM_OWNER_EMAILS=bruno@zapcrmbr.com

# A OUTRA porta (automação/scripts) — continua existindo em paralelo,
# nunca confundir as duas.
PLATFORM_ADMIN_SECRET=<openssl rand -hex 32>

# O mesmo agendamento que já drena automações também roda a varredura de
# retenção (fase 4) e o vencimento de plano (fase 5, §11) — sem isto,
# nenhum dos dois acontece, sem erro em lugar nenhum.
AUTOMATION_CRON_SECRET=<segredo das rotas de cron>

# Opcional — sem ela, a varredura de retenção nunca apaga nada, mesmo com
# tudo configurado em /admin/retention (§8).
MESSAGE_RETENTION_ENABLED=true

# Avisos do sistema (SPEC 063, §20). Sem SMTP_HOST/SYSTEM_NOTIFICATION_EMAIL
# o canal de e-mail é um no-op silencioso — o console mostra o alerta em
# /admin/notifications, nada quebra.
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USER=avisos@zapcrmbr.com
SMTP_PASSWORD=
SMTP_SECURE=false
SMTP_FROM="ZAP CRM BR <avisos@zapcrmbr.com>"
SYSTEM_NOTIFICATION_EMAIL=bruno@zapcrmbr.com

# Webhook dos mesmos avisos — PLAN_REQUEST_WEBHOOK_URL continua valendo
# (compat); se as duas existirem, SYSTEM_EVENT_WEBHOOK_URL vence.
SYSTEM_EVENT_WEBHOOK_URL=
SYSTEM_EVENT_WEBHOOK_SECRET=
```

Note que **carência, desconto anual padrão, plano padrão, autosserviço e os
números de retenção não são `.env`** — moram em `platform_settings`,
editáveis pelo console sem redeploy (§8, §12).

---

## 15. O que ainda não está no console (limitações honestas)

Registrado aqui para não ser redescoberto por tentativa e erro:

| Falta | Onde fazer hoje |
| --- | --- |
| Criar uma conta nova para um cliente sem ele se cadastrar sozinho | Criar o usuário direto no Supabase Auth (painel → Authentication → Users → Add user) — a trigger `handle_new_user()` cria a conta + owner sozinha (§5.4) |
| Editar o papel de um membro (promover/rebaixar) | Pelo próprio dashboard da conta (um admin/owner dela) |
| Recontar o uso de uma conta | `SELECT recount_account_usage('<id>')` por SQL |
| Conceder `limitOverrides` por um formulário | `PUT /api/admin/accounts/{id}/plan` (x-admin-secret) ou chamar `PUT /api/platform/accounts/{id}/plan` direto |
| Derrubar as sessões abertas de um usuário | Não existe — bloqueie o usuário (§6.3), que corta o acesso na hora pela RLS |
| Editar o nome da conta (empresa) | Pelo próprio dashboard da conta; o console edita o nome da *pessoa* (§5.7), não o da conta |
| Estornar um pagamento que não é o último, ou anterior à SPEC 078 | Não existe — corrija com "Alterar vencimento" (§5.5) |
| Impersonação ("ver como o cliente") | Não existe — deixado para depois na própria SPEC (exige trilha de consentimento) |
| Enxergar "over quota" por qualquer quota além de contatos, na visão geral/lista | Só no detalhe da conta (`/admin/accounts/{id}`), que calcula o uso real |
| Bloqueio automático por inadimplência | D-7 — vencimento nunca bloqueia sozinho; bloquear é sempre uma ação sua |

---

## 16. Armadilhas conhecidas

| Sintoma | Causa provável |
| --- | --- |
| `/admin` responde 404 mesmo para o e-mail certo | `PLATFORM_OWNER_EMAILS` não chegou ao host de produção (deploy não propagou a variável), ou o e-mail da sessão tem espaço/maiúscula que a comparação normaliza mas você não reparou que era diferente do que está no `.env` |
| `/admin` responde 404 e o e-mail está correto na variável | E-mail da conta **não confirmado** (`email_confirmed_at` nulo) — confirme o e-mail primeiro |
| Bloqueei uma conta e nada mudou pro cliente | Confira se ele já tinha uma sessão/token de longa duração em cache — a checagem é por RLS a cada request, então deveria refletir na próxima consulta; se persistir, confira `accounts.blocked_at` direto por SQL |
| Cliente reclama que "sumiram meus dados" depois de bloqueado | Ele não viu a página `/blocked` (deveria ter sido redirecionado) — confira se ele está usando uma rota fora do `(dashboard)` ou a API pública direto (que devolve `account_blocked`, não uma página) |
| Troquei o plano pelo diálogo e o vencimento não mudou | Esperado desde 2026-08-30 (decisão B, §5.3) — o diálogo **herda** o vencimento que já existia; ele só muda se a conta nunca tinha vencimento (calcula um novo) ou se o plano novo não vence (limpa) |
| Troquei o plano pelo diálogo e o vencimento continua `NULL` para sempre | Bug anterior a 2026-08-30 — antes disso `changeAccountPlan` nunca calculava vencimento nenhum. Se persistir depois dessa data, é regressão: confira se o plano de destino realmente é `billing_period IN ('monthly','yearly')` com preço > 0 |
| Configurei retenção em `/admin/retention` e nada foi apagado | `MESSAGE_RETENTION_ENABLED` ausente no `.env` — o `Alert` vermelho da tela avisa isso, confira se ele apareceu |
| Uma solicitação de troca nunca chega em `/admin/requests` | Autosserviço está ligado (padrão) e o plano é público — a troca já aconteceu na hora; confira `account_plan_events` com `actor='self-service:…'`, não a fila |
| Não encontro onde editar o papel de um membro | Não existe no console (§15) — é pelo dashboard da própria conta |
| "Alterar vencimento" / "Registrar pagamento" desabilitados | O plano da conta não tem ciclo de cobrança (Grátis, `unlimited`, sob medida): não há vencimento. Troque para um plano mensal/anual (§5.3) |
| Vencimento aparece com um dia a menos em outro lugar (consulta SQL, API) | `current_period_end` é 23:59:59 de São Paulo, ou seja, já é o dia seguinte em UTC. O console exibe sempre no fuso de São Paulo |
| Registrei um pagamento num cliente anual e o vencimento avançou 1 mês | O ciclo da conta ainda era `monthly` — mude para anual em "Alterar vencimento" (§5.5), desfaça o pagamento (§5.6) e registre de novo |
| "Desfazer" desabilitado num pagamento antigo | Esperado: pagamentos anteriores à SPEC 078 não guardam o status anterior (§5.6) |
| Troquei o e-mail de um usuário e a lista de membros mostra o antigo | A migração 089 (trigger `on_auth_user_email_updated`) não foi aplicada naquele projeto Supabase |
| Troca de e-mail respondeu `partial_update` | O e-mail mudou e o nome não — confira o usuário e repita só o nome (§5.7) |
| `email_reserved_for_platform_owner` ao editar um cliente | O e-mail novo está em `PLATFORM_OWNER_EMAILS`. Se você *queria* isso, é a §5.8; se não, é uma tentativa de dar o console a alguém — investigue |
| Cliente ganhou acesso ao `/admin` | **Incidente de segurança.** Remova o e-mail dele de `PLATFORM_OWNER_EMAILS` e revise `platform_audit_log` (`user.profile_update`) |
| Estranho descobre que existe um console | Alguma rota `/api/platform/**` respondendo 401/403/503 em vez de 404 — reporte como bug, é exatamente o que a §2.4 existe para impedir |

---

## 17. Checklist rápido

| Quero... | Faço |
| --- | --- |
| Dar acesso de console a alguém | Adicionar o e-mail em `PLATFORM_OWNER_EMAILS` e redeployar |
| Criar uma conta nova para um cliente (owner) sem ele se cadastrar | Authentication → Users → Add user no Supabase, a trigger cria a conta (§5.4) |
| Ver os números do deployment inteiro | `/admin` |
| Encontrar uma conta específica | `/admin/accounts?q=<nome>` |
| Bloquear uma conta inadimplente | `/admin/accounts/{id}` → switch de bloqueio no cabeçalho |
| Bloquear só uma pessoa (credencial comprometida) | `/admin/accounts/{id}` → seção Membros → switch daquela linha |
| Trocar o plano de uma conta na mão | `/admin/accounts/{id}` → "Trocar plano" |
| Conceder um limite negociado (override) | `PUT /api/admin/accounts/{id}/plan` com `limitOverrides` (sem UI ainda) |
| Criar/editar um plano do catálogo | `/admin/plans` |
| Aprovar/rejeitar um pedido de troca | `/admin/requests` |
| Ligar/desligar quotas | `/admin/settings` → switch "Quotas" |
| Ligar/desligar autosserviço de plano | `/admin/settings` → switch "Self-service" |
| Configurar o padrão global de retenção | `/admin/retention` |
| Registrar um Pix/boleto recebido | `/admin/accounts/{id}` → "Registrar pagamento" (§5.6) |
| Desfazer um pagamento registrado errado | `/admin/accounts/{id}` → cartão "Pagamentos" → "Desfazer" (§5.6) |
| Mudar a data de vencimento sem ser um pagamento | `/admin/accounts/{id}` → "Alterar vencimento" (§5.5) |
| Corrigir nome/e-mail de um usuário (inclusive o dono da conta) | `/admin/accounts/{id}` → Membros → lápis (§5.7) |
| Trocar o e-mail do próprio proprietário da plataforma | Primeiro `PLATFORM_OWNER_EMAILS`, depois o usuário (§5.8) |
| Confirmar um pagamento externo (sistema de cobrança) | `POST .../billing/renew` (x-admin-secret) |
| Saber quem fez o quê numa conta | `/admin/accounts/{id}` → seção Histórico |
| Ver se um aviso (troca de plano, bloqueio, vencimento…) chegou | `/admin/notifications` (§20) |
| Reenviar um aviso que falhou | `/admin/notifications` → botão "Reenviar" na linha |

---

## 18. Mapa de arquivos (para quem for mexer no console)

| O quê | Arquivo(s) |
| --- | --- |
| Identidade do proprietário | `src/lib/platform/owner.ts` |
| Guarda de autobloqueio | `src/lib/platform/guards.ts` |
| Bloquear/desbloquear (conta e usuário) | `src/lib/platform/block.ts`, rotas em `src/app/api/platform/{accounts,users}/[id]/block/route.ts` |
| Layout + navegação do console | `src/app/(platform)/admin/layout.tsx`, `src/components/platform/platform-nav.tsx` |
| Gate duplo no cliente | `src/components/platform/require-platform-owner.tsx` |
| Visão geral | `src/app/(platform)/admin/page.tsx`, `src/lib/platform/summary.ts` |
| Lista + detalhe de contas | `src/app/(platform)/admin/accounts/**`, `src/lib/platform/accounts.ts` |
| Trocar plano (ambas as portas) | `src/lib/platform/plan-actions.ts` (`changeAccountPlan`) |
| Autosserviço do cliente | `src/lib/plans/self-service.ts` |
| Catálogo de planos | `src/app/(platform)/admin/plans/page.tsx`, `src/app/api/platform/plans/route.ts` |
| Configurações da plataforma | `src/app/(platform)/admin/settings/page.tsx`, `src/app/api/platform/settings/route.ts`. **Detalhes técnicos de `platform_settings` (schema, RLS, variáveis `.env`, criticidade):** [§18.1 deste documento](./guia-console-do-proprietario.md#181-referência-técnica-platform_settings-no-supabase) (ou [guia de operação §13](./guia-operacao-planos-e-quotas.md#13-referência-técnica-platform_settings-no-supabase)). |
| Solicitações de troca | `src/app/(platform)/admin/requests/page.tsx`, `src/app/api/platform/requests/route.ts` |
| Retenção (global + por conta) | `src/app/(platform)/admin/retention/page.tsx`, `src/components/retention/*.tsx`, `src/lib/retention/global-defaults.ts`, `src/lib/platform/retention-defaults.ts` |
| Vencimento de plano (cron) | `src/lib/plans/lifecycle.ts`, fase 5 de `src/app/api/automations/cron/route.ts` |
| Renovação externa | `src/lib/plans/billing-renew.ts`, `src/app/api/admin/accounts/[accountId]/billing/renew/route.ts` |
| Vencimento e pagamento manual (SPEC 078) | `src/lib/plans/{manual-billing,period-end,payment-reversal,payments}.ts`, `src/lib/platform/billing-console.ts`, rotas `src/app/api/platform/accounts/[accountId]/billing/**`, UI `src/components/platform/{change-period-end-dialog,record-payment-dialog,payments-card}.tsx`, migração `089_console_billing_and_identity.sql` |
| Editar nome/e-mail de usuário (SPEC 078) | `src/lib/platform/{user-identity,user-identity-actions,user-identity-console}.ts`, rota `src/app/api/platform/users/[userId]/route.ts`, UI `src/components/platform/edit-user-identity-dialog.tsx` |
| Cálculo de ciclo/preço (compartilhado) | `src/lib/plans/billing.ts` |
| Auditoria do console | `src/lib/platform/audit.ts` (`platform_audit_log`) |
| Página do bloqueado | `src/app/blocked/page.tsx` |
| Notificações do sistema (outbox, SMTP, webhook) | `src/lib/notifications/**`, `src/lib/mailer/**`, `src/app/(platform)/admin/notifications/page.tsx`, `src/app/api/platform/notifications/**` (§20) |
| Migração de schema | `supabase/migrations/067_plans_and_quotas.sql` (cria `platform_settings` base + quotas), `supabase/migrations/069_platform_console.sql` (estende com ciclo/desconto/retenção/bloqueio), `supabase/migrations/070_system_notifications.sql` (outbox). **Referência técnica completa:** [guia de operação §13](./guia-operacao-planos-e-quotas.md#13-referência-técnica-platform_settings-no-supabase). |
| Testes | `*.test.ts` co-locados a cada arquivo acima |

---

## 18.1. Referência técnica: `platform_settings` no Supabase

Veja [guia de operação §13](./guia-operacao-planos-e-quotas.md#13-referência-técnica-platform_settings-no-supabase) para:
- Schema completo (11 colunas, 1 linha garantida)
- RLS (leitura pública, escrita só `service_role`)
- Trigger de `updated_at`
- Variáveis de `.env` que completam a configuração
- Referências cruzadas (soft FK para `plans(code)`, herança de `retention_defaults`, etc.)

---

## 19. Validação antes de entregar qualquer mudança nesta área

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

Igual a qualquer outra mudança no repositório — não há regra especial para
o console (ver `AGENTS.md`).

---

## 20. Notificações do sistema (`/admin/notifications`, SPEC 063)

Toda ação relevante que este console emite (troca de plano, bloqueio,
vencimento, quota estourada, primeiro acesso de uma conta) vira uma linha
numa outbox (`system_notifications`) entregue por **dois canais
independentes**: e-mail (SMTP, para o seu próprio e-mail —
`SYSTEM_NOTIFICATION_EMAIL`, não para o cliente) e webhook (a mesma URL que
já recebia só `plan_change_requested` antes da SPEC 063). Um canal sem
`.env` configurado é um no-op silencioso — nunca um erro que derruba a ação
que originou o aviso (SPEC 063 §1).

**A tela mostra as últimas 100 linhas**, com tipo, conta, o status de cada
canal (`pending`/`sent`/`failed`/`skipped`) e o erro quando houver. Filtro
"Mostrar só falhas" e botão **Reenviar** por linha — zera tentativas e
manda tentar de novo, sem reenviar um canal que já tinha chegado
(`sent`/`skipped` não é tocado, só `failed` volta a `pending`).

Dois `Alert`s aparecem no topo quando o canal correspondente está desligado
— o mesmo raciocínio do `Alert` de `MESSAGE_RETENTION_ENABLED` em
`/admin/retention` (§8): sem o aviso, a hipótese natural é "o sistema está
quebrado", quando é só o `.env` que está incompleto.

`/admin/settings` (§12) ganhou um card **em modo leitura** com host, porta,
remetente e destinatário do e-mail, e a URL do webhook mascarada — nenhum
desses valores é editável pela tela (são sempre `.env`), e a senha do SMTP
nunca trafega para o navegador, mascarada ou não.

**Entrega em duas portas**, nenhuma delas uma rota de cron nova (mesmo
argumento do §11 para o vencimento de plano): a porta 1 tenta entregar em
segundos, num `after()` na própria requisição que emitiu o evento; a porta
2 é a fase 6 do mesmo `/api/automations/cron` que já drena automações e
varre retenção/vencimento — a rede de segurança para tudo que a porta 1
perder (processo reiniciado, SMTP fora do ar por alguns minutos).

Reenvio, backoff e "desistência" depois de 6 tentativas (recuo
exponencial, teto de 6 horas) são os mesmos nas duas portas —
`src/lib/notifications/dispatch.ts`.

**Purga da própria outbox:** `purge_system_notifications(p_keep_days)` só
apaga linhas já resolvidas (nenhum canal `pending`) mais velhas que o
prazo — o bloco fica **comentado** em `supabase/setup/cron-jobs.sql`, no
mesmo formato da purga de mensagens (SPEC 060), porque agendar é uma
decisão de operador, não algo que uma migração liga sozinha.

| Sintoma | Causa provável |
| --- | --- |
| Aviso nunca chega, sem erro em lugar nenhum | Confira `/admin/notifications` primeiro — se a linha existe com `email_status`/`hook_status` = `skipped`, o canal está desligado por `.env`, não é bug |
| Mesmo aviso repetido (ex.: "vence em 7 dias" todo dia) | `dedupe_key` mal formado — reporte como bug, a SPEC exige uma chave por período/dia (SPEC 063 §9) |
| Workflow n8n do webhook de solicitação de plano parou de funcionar | `plan.requested` mantém o formato legado (`event: 'plan_change_requested'`, campos `accountId`/`planCode` na raiz) — confira `webhook.test.ts` se algo nessa forma mudou |
| `/admin/notifications` mostra tudo `failed` de repente | SMTP com credencial errada, ou `SYSTEM_EVENT_WEBHOOK_URL` apontando para um host que não resolve mais — o `last_error` da linha diz qual |

Mapa de arquivos: `src/lib/notifications/` (tipos, dedupe, emissão,
despacho, webhook), `src/lib/mailer/` (config, transporte `nodemailer`,
template do e-mail), `src/app/(platform)/admin/notifications/page.tsx`,
`src/app/api/platform/notifications/**`, migração
`supabase/migrations/070_system_notifications.sql`.
