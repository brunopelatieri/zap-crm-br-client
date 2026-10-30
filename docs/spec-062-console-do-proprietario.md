# SPEC 062 — Console do Proprietário, bloqueio e ciclo de plano

> **Status:** **pronta para implementação** — todas as decisões do PRD (D-1 a D-14) ratificadas em 2026-08-26. Começar pela F1 (§10), após autorizar a migração projeto por projeto
> **Data:** 2026-08-26 (revisada no mesmo dia: §3.7 cobrança externa e §3.8/§7.5 retenção passam ao proprietário)
> **Migração:** `069_platform_console.sql` (confira `ls supabase/migrations/` antes — a última hoje é a 068)
> **Depende de:** [SPEC 059](./spec-059-motor-de-quotas.md) (motor de quotas, implementado) · [SPEC 060](./spec-060-retencao-e-limpeza-de-mensagens.md) (retenção, implementada — **esta SPEC muda o dono dela**) · [guia de operação](./guia-operacao-planos-e-quotas.md)
> **Irmã:** [SPEC 063](./spec-063-notificacoes-do-sistema-smtp.md) — os avisos que esta SPEC **emite** são entregues lá

---

## 1. Princípio que organiza tudo

> **O console lê tudo, e por isso ele é a única porta que enxerga além da
> própria conta. Nenhuma linha de RLS é afrouxada para que ele funcione.**

Toda leitura cross-account acontece em **rota de servidor com `service_role`,
atrás de uma guarda de sessão**. Nada de policy nova do tipo
`USING (is_platform_owner())` — seria conveniente (o navegador consultaria as
contas direto pelo `supabase-js`) e é exatamente o erro que transforma um bug de
sessão em vazamento entre clientes. A regra da casa continua: `supabase/admin.ts`
só em rota de servidor com autorização já validada.

O segundo princípio é herdado da SPEC 059 e vale igual aqui: **o banco decide, o
app explica.** O bloqueio de conta e de usuário **não** é uma checagem no
TypeScript — é uma linha a mais em `is_account_member()`, a função que já está
dentro de praticamente toda policy RLS do repositório. Bloquear passa a valer
para todas as tabelas de uma vez, inclusive para o `INSERT` direto do navegador
que a SPEC 059 §1 documenta.

---

## 2. Identidade do proprietário da plataforma — a decisão mais cara desta SPEC

### 2.1. O que existe hoje, e por que não basta

`src/lib/auth/platform-admin.ts` compara `x-admin-secret` com
`PLATFORM_ADMIN_SECRET` em tempo constante. É excelente para automação e
inutilizável para uma interface: o navegador teria de carregar o segredo, e um
segredo que chega ao browser deixa de ser segredo.

### 2.2. A decisão (D-1): `.env`, não tabela

```bash
# Lista separada por vírgula. Ausente = o console NÃO EXISTE (404 em tudo).
PLATFORM_OWNER_EMAILS=bruno@zapcrmbr.com
```

```ts
// src/lib/platform/owner.ts — server-only
export async function requirePlatformOwner(): Promise<PlatformOwnerContext>;
export function isPlatformOwnerEmail(email: string | null | undefined): boolean;
```

A guarda exige, nesta ordem, e **todas**:

1. `PLATFORM_OWNER_EMAILS` definida no servidor — ausente → trata como se a
   rota não existisse (§2.4);
2. sessão Supabase válida (`supabase.auth.getUser()`, nunca `getSession()` —
   `getUser()` valida no servidor de auth);
3. `user.email_confirmed_at` não nulo — um e-mail não confirmado não prova posse
   do endereço, e o endereço é a credencial aqui;
4. e-mail da sessão presente na lista, comparado **normalizado** (`trim` +
   `toLowerCase`) e com `timingSafeEqual` por item.

**Por que não uma tabela `platform_admins`.** Porque ela cria um caminho de
escalonamento de privilégio *dentro do banco*: qualquer falha que permita um
`INSERT` naquela tabela (uma policy errada numa migração futura, um script de
manutenção, um dump restaurado) promoveria alguém a operador de todas as contas.
Com o `.env`, promover exige acesso ao servidor — o mesmo nível de confiança que
`PLATFORM_ADMIN_SECRET` já exige hoje. O custo é real e aceito: adicionar um
operador pede redeploy. Com um operador, é o negócio certo.

### 2.3. As duas portas, uma lógica

| Porta | Autenticação | Para quem |
| --- | --- | --- |
| `/api/admin/**` (existe) | `x-admin-secret` | Automação, scripts, n8n. **Permanece** (D-2) |
| `/api/platform/**` (nova) | Sessão do proprietário | O console web |

Ambas chamam os **mesmos** módulos de `src/lib/platform/`. Nenhuma regra de
negócio mora dentro de uma rota — senão as duas portas divergem, e a que ninguém
testou é a que apaga o dado errado.

### 2.4. Sem a variável, o console não existe — e ele responde 404, não 503

As rotas de cron e `/api/admin/**` respondem `503` quando o segredo falta, e
isso é certo para elas: quem chama é o operador, que precisa saber que
esqueceu de configurar. Aqui é o oposto — quem bate em `/admin` sem ser o dono é
um estranho, e `503 "platform console not configured"` confirma para ele que o
console existe. **`/admin` e `/api/platform/**` devolvem `404` para qualquer
requisição não autorizada**, com o mesmo corpo genérico, seja porque a variável
não existe, porque não há sessão ou porque o e-mail não está na lista. O
diagnóstico do operador vem do log de servidor, não da resposta HTTP.

### 2.5. Trilha de auditoria

Toda ação do console grava `actor = 'console:<email do proprietário>'` nos
mesmos históricos que a API já usa (`account_plan_events`) e na nova
`platform_audit_log` (§3.5). A distinção entre `console:` e o `actor` livre da
API é o que permite responder "isso foi um clique meu ou um script?".

---

## 3. Modelo de dados — migração `069_platform_console.sql`

Idempotente (`IF NOT EXISTS`, `DROP … CREATE` para policies/funções/triggers) e
com bloco de asserções finais que falha alto, no padrão das 041/052/067/068.

### 3.1. Bloqueio de conta e de usuário

```sql
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS blocked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS blocked_by     TEXT;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS blocked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS blocked_by     TEXT;

-- Parciais: bloqueado é a exceção. O índice tem o tamanho do conjunto de
-- bloqueados, e é ele que faz a lista "contas bloqueadas" do console sair
-- barata sem varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_accounts_blocked ON accounts (blocked_at) WHERE blocked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_blocked ON profiles (blocked_at) WHERE blocked_at IS NOT NULL;
```

**Timestamp, não booleano.** `blocked_at` responde "desde quando", que é a
pergunta do suporte; um `is_blocked BOOLEAN` responde metade e exigiria uma
segunda coluna para a outra metade. `blocked_by` é texto (`console:<email>`) e
não FK para `auth.users`: o proprietário da plataforma pode não ter usuário
naquele banco no futuro, e a trilha não pode depender disso.

Escrita: **só `service_role`**. Nenhuma policy nova — nem para o dono da conta.
Um dono que pudesse limpar o próprio `blocked_at` tornaria o bloqueio decorativo.

### 3.2. `is_account_member()` passa a conhecer bloqueio — o coração do enforcement

```sql
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM profiles p
      JOIN accounts a ON a.id = p.account_id
     WHERE p.user_id      = auth.uid()
       AND p.account_id   = target_account_id
       AND p.blocked_at IS NULL          -- ← usuário bloqueado
       AND a.blocked_at IS NULL          -- ← conta bloqueada
       AND CASE p.account_role
             WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
             WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
         >=
           CASE min_role
             WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
             WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
  );
$$;
```

Duas condições novas, e o bloqueio passa a valer em **todas** as policies que
já chamam esta função — contatos, conversas, mensagens, disparos, automações,
chaves de API, retenção. Nenhuma policy precisa ser reescrita, e é justamente
por isso que esta é a forma certa: a alternativa (checar bloqueio em cada rota)
deixaria de fora o `supabase.from('contacts').insert(...)` que o navegador faz
direto, o mesmo furo que a SPEC 059 §1 descreve.

Três consequências que a implementação **não pode errar**:

- **O `JOIN accounts` roda em toda avaliação de policy.** É um acesso por chave
  primária, com a linha quentíssima no cache — mas a função precisa continuar
  `STABLE` para o planejador reaproveitá-la dentro do mesmo comando. Perder o
  `STABLE` aqui degrada consulta em toda a aplicação.
- **`service_role` não passa por RLS**, então o console, os motores e as rotas
  de cron continuam enxergando conta bloqueada. Quem precisa parar de agir sobre
  ela é código explícito (§4.3), não a RLS.
- **A função é `SECURITY DEFINER` e `OWNER TO postgres`** — a migração precisa
  repetir o `ALTER FUNCTION … OWNER TO postgres` depois do `CREATE OR REPLACE`,
  ou a função passa a rodar com o dono errado.

### 3.3. Ciclo de vida em `account_plans`

```sql
ALTER TABLE account_plans
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly','yearly')),
  ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS canceled_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_until   TIMESTAMPTZ;

-- O cron de vencimento (§8) varre por data. Sem este índice ele vira
-- varredura da tabela inteira a cada 6 horas.
CREATE INDEX IF NOT EXISTS idx_account_plans_period_end
  ON account_plans (current_period_end)
  WHERE current_period_end IS NOT NULL;
```

`current_period_end` já existe desde a 067 e passa a ser **derivado**:
`started_at + 1 mês` ou `started_at + 1 ano`, calculado em TypeScript (§5.1) e
gravado — não é coluna computada, porque a regra de fim de mês (adesão em 31/01)
é uma decisão de produto, não de banco, e precisa de teste unitário.

Backfill da migração: `started_at = COALESCE(created_at, NOW())`,
`billing_cycle = 'monthly'`, e `current_period_end` permanece **NULL** para todo
mundo — toda conta existente está no plano `unlimited` (`billing_period='none'`),
que por definição não vence (§5.1). **Uma migração nunca inventa vencimento para
quem já é cliente.**

#### 3.3.1. Troca de plano pelo console e o vencimento (decisão B, 2026-08-30)

A primeira versão desta SPEC deixava `changeAccountPlan` (`plan-actions.ts`,
§5.2) **sem tocar em ciclo/vencimento** — só a rota de autosserviço do cliente
(`applyPlanChange`, §6.1) calculava `current_period_end`. Na prática isso
deixava toda conta trocada pelo console (o caminho mais comum enquanto não há
gateway de pagamento) com `current_period_end` **permanentemente `NULL`**, mesmo
num plano pago mensal/anual — o bloco de ciclo/adesão/vencimento da tela "Plano
e uso" (`plan-panel.tsx`) nunca aparecia, porque ele só renderiza quando
`currentPeriodEnd` não é nulo.

A correção (decisão B) faz `changeAccountPlan` participar do vencimento sem
nunca **resetar** um ciclo que já está correndo — ao contrário do autosserviço,
que sempre recomeça o período (§6.1, "sem pró-rata"), o console deve ser
neutro por padrão:

1. **A conta já tinha vencimento e o plano novo também vence** (`billing_period
   IN ('monthly','yearly')` e preço > 0) → **herda**: `started_at`,
   `billing_cycle` e `current_period_end` permanecem exatamente como estavam.
   Um admin trocando o Essencial pelo Profissional no dia 15 não empurra o
   vencimento — ele continua no mesmo dia do mês que já valia antes.
2. **A conta nunca teve vencimento** (backfill da migração, ou uma conta que
   nasceu no `unlimited`) **e o plano novo vence** → calcula um vencimento
   **novo, a partir da data desta troca** (nunca retroativo), reaproveitando o
   mesmo `computePeriodEnd()` (`@/lib/plans/billing.ts`) que o autosserviço já
   usa — mesma regra de fim de mês, sem duplicar lógica. `started_at` também é
   gravado como a data da troca, porque é literalmente a primeira vez que a
   conta passa a ter um ciclo de cobrança. **O console nunca oferece escolha de
   ciclo** (isso é autosserviço) — `billing_cycle` é sempre gravado como
   `'monthly'` aqui, **inclusive sobrescrevendo** um valor que a conta já
   tivesse: um `billing_cycle` órfão de uma assinatura anterior (ex.: `'yearly'`
   de um plano cancelado) nunca pode influenciar o cálculo de um vencimento
   novo que não tem relação nenhuma com aquele ciclo antigo (achado de code
   review, 2026-08-30 — antes dessa correção, uma conta nessa sequência exata
   recebia vencimento de 1 ano em vez de 1 mês).
3. **O plano novo não vence** (Grátis, `unlimited`, "sob medida" com
   `billing_period` `'none'`/`'custom'`) → limpa `current_period_end` (mesmo que
   a conta viesse de um plano que vencia), e também `cancel_at_period_end`,
   `canceled_at`, `grace_until` — nenhum desses três faz sentido numa conta sem
   vencimento.

Esta lógica só roda quando o `plan_id` efetivamente muda nesta chamada — trocar
só `status` ou `limitOverrides` (sem `planCode`, ou com `planCode` igual ao
atual) nunca toca em nenhuma das colunas de ciclo.

**Status `'canceled'` na mesma chamada que troca o plano** (achado de code
review, 2026-08-30): se o admin muda `planCode` e `status: 'canceled'` juntos,
e o resultado (herdado ou recém-calculado pelos casos 1/2 acima) deixa a conta
com `current_period_end` não nulo, `canceled_at` é gravado com a data desta
troca e `cancel_at_period_end` com `false` — sem isso, a linha ficaria com
`status='canceled'` e um vencimento futuro "ativo" sem nenhum registro de
quando foi cancelada, um estado confuso em `/admin/accounts/{id}`. O caso 3
(plano não vence) já cobre isso por conta própria — `canceled_at` já é limpo
ali independentemente do `status`.

A regra completa dos três casos vive como função pura em
`resolveExpiryOnPlanChange()` (`@/lib/plans/billing.ts`) — `changeAccountPlan`
só traduz o resultado (`'inherit'` / `'cleared'` / `'started'`) em colunas do
`update`, nunca reimplementa a lógica. Isso também elimina a duplicação que
existia entre a regra "o que vence" daqui e a mesma regra já embutida em
`computePeriodEnd()` (a função é chamada incondicionalmente e o resultado dela
— `null` ou não — decide o caso, em vez de recalcular `billingPeriod`/
`priceCents` em paralelo).

### 3.4. Desconto anual

```sql
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS yearly_discount_percent INTEGER
    CHECK (yearly_discount_percent IS NULL
           OR (yearly_discount_percent >= 0 AND yearly_discount_percent <= 100));

ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS default_yearly_discount_percent INTEGER NOT NULL DEFAULT 17
    CHECK (default_yearly_discount_percent >= 0 AND default_yearly_discount_percent <= 100),
  ADD COLUMN IF NOT EXISTS support_email TEXT,
  ADD COLUMN IF NOT EXISTS grace_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_days >= 0),
  ADD COLUMN IF NOT EXISTS self_service_enabled BOOLEAN NOT NULL DEFAULT TRUE;
```

`NULL` no plano = usa o padrão da plataforma (D-5). O `CHECK` de 0–100 existe
porque um desconto de 150% viraria preço negativo, e o lugar de barrar isso é o
banco — a validação de rota é a segunda camada, não a única.

`self_service_enabled` é o interruptor da §7.1: permite voltar ao fluxo de
aprovação sem redeploy se a troca imediata se mostrar um problema comercial.
`support_email` aparece na tela de bloqueio (§4.4) — sem ele, o bloqueado não
tem para quem escrever.

**O catálogo comercial não precisa de preço novo.** `supabase/setup/plans-seed.sql`
já traz os quatro planos com valor mensal (Grátis, Essencial R$ 149, Profissional
R$ 349, Empresarial R$ 799) e é idempotente. Com D-5/D-6 ratificados, **o anual é
derivado** — o seed ganha apenas `yearly_discount_percent` como coluna opcional,
deixada `NULL` nos quatro (todos herdam os 17% da plataforma). Um plano com
promoção própria é uma edição pela tela, não uma linha nova de seed.

### 3.5. `platform_audit_log` — o que o console fez

```sql
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor        TEXT NOT NULL,                    -- 'console:bruno@…' | 'api:<actor>'
  action       TEXT NOT NULL,                    -- 'account.block' | 'plan.change' | …
  account_id   UUID REFERENCES accounts(id) ON DELETE SET NULL,
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_account ON platform_audit_log (account_id, created_at DESC);
```

`ON DELETE SET NULL` no `account_id`: a auditoria precisa **sobreviver** à conta
apagada — é justamente o registro de que ela existiu (mesma razão de
`account_plan_events` guardar `code` e não `plan_id`).

RLS ligada **sem nenhuma policy**: ninguém lê pelo `supabase-js`, nem o dono da
conta, nem o proprietário. O console lê por `service_role`. Uma tabela com RLS
ligada e zero policies é a forma mais curta de dizer "só service_role" — e a
asserção final confere que ela continua assim.

### 3.7. Cobrança externa — os três campos que evitam retrabalho (PRD §5.2)

A cobrança é emitida por outro sistema. O CRM não cobra, mas precisa **saber a
qual cobrança cada conta corresponde** e ter por onde ser avisado de que o
período foi pago:

```sql
ALTER TABLE account_plans
  ADD COLUMN IF NOT EXISTS billing_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (billing_source IN ('manual','external','gateway')),
  ADD COLUMN IF NOT EXISTS external_billing_ref TEXT,
  ADD COLUMN IF NOT EXISTS last_payment_ref TEXT,
  ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMPTZ;

-- Idempotência da renovação (§6.2): o mesmo pagamento chegando duas vezes
-- (retentativa do sistema externo, clique duplo) não avança o vencimento
-- duas vezes. Parcial porque a esmagadora maioria das contas é NULL aqui.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_plans_last_payment
  ON account_plans (last_payment_ref) WHERE last_payment_ref IS NOT NULL;
```

`billing_source` já prevê `gateway` **sem** nada implementado — é uma linha de
`CHECK` hoje e a diferença entre uma migração e nenhuma no dia em que o gateway
entrar. `external_billing_ref` é o identificador do cliente/assinatura no
sistema de cobrança; `last_payment_ref` é o identificador do **último pagamento
aplicado**, e é ele que dá a idempotência.

**Por que a idempotência mora num índice único e não numa checagem na rota.**
Duas chamadas simultâneas do sistema externo passariam as duas por um
`SELECT … WHERE ref = ?` que não encontrou nada, e as duas avançariam o
vencimento. O índice é o único ponto que serializa isso de verdade — mesma
lógica do `idx_plan_requests_one_pending` (067) e do
`idx_channels_one_default_per_account` (055).

### 3.8. Retenção passa ao proprietário da plataforma (PRD §4.1)

A SPEC 060 entregou a política de retenção como configuração do **dono da
conta**. Ela passa a ser do proprietário da plataforma, e a 069 executa a
virada em três movimentos.

**1. As policies do cliente somem.** `channel_retention_policies` e
`message_retention_state` ficam com RLS ligada e **zero policies** — o mesmo
padrão de `platform_audit_log` (§3.5), que é a forma mais curta de dizer "só
`service_role`":

```sql
DROP POLICY IF EXISTS channel_retention_select ON channel_retention_policies;
DROP POLICY IF EXISTS channel_retention_insert ON channel_retention_policies;
DROP POLICY IF EXISTS channel_retention_update ON channel_retention_policies;
DROP POLICY IF EXISTS channel_retention_delete ON channel_retention_policies;
DROP POLICY IF EXISTS message_retention_state_select ON message_retention_state;
```

**Nenhuma linha é apagada.** Uma conta que já configurou política continua com
ela valendo exatamente igual — só deixa de conseguir vê-la e mudá-la. A
varredura roda com `service_role` e não é afetada em nada.

**2. O padrão global ganha uma fonte editável** (D-13), acima do `.env`:

```sql
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS retention_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Formato, validado por `validateRetentionDefaults()` no mesmo espírito de
`validateCatalog()`:

```jsonc
{
  "whatsapp_qr":    { "maxMessages": 5000,  "retentionDays": 30,  "maxFavorites": 200 },
  "whatsapp_cloud": { "maxMessages": 50000, "retentionDays": 365, "maxFavorites": 2000 }
}
```

A cadeia de precedência da SPEC 060 §3.4 ganha **um elo**, e o furo que ela
deixou reservado é preenchido pelo lado certo:

> linha da política da conta → **padrão global do console** → padrão do `.env` → sem limite

Chave ausente em qualquer nível cai para o próximo; `0` continua significando
"sem limite" e **nunca** "apagar tudo" — a regra que o `policy.test.ts` da 060
já protege e que segue valendo palavra por palavra.

**3. O interruptor não vai para a tela.** `MESSAGE_RETENTION_ENABLED` continua
**só** no `.env` (D-13). Ligar limpeza de histórico por clique é precisamente o
tipo de acidente sem desfazer que a SPEC 060 §1 existe para impedir; os
*números* podem ser editados na tela porque a prévia (`p_dry_run`) mostra o
impacto antes de salvar, mas o *ligar* exige acesso ao servidor.

**O que NÃO muda, e a implementação não pode encostar:**

| Item | Estado |
| --- | --- |
| Favoritar mensagem (`is_favorite`, estrela na bolha) | Continua `agent+`, policy `messages_update` da 017 intacta |
| Aviso de thread esvaziada (SPEC 060 §8.3) | Continua, neutro e sem números |
| `purge_channel_messages` e o `REVOKE` dela | Intactos — a função já era `service_role` only |
| O piso de idade e as três fases da varredura | Intactos |
| `sweep.ts` | Só passa a resolver o padrão global pela nova cadeia (§5.3) |

### 3.9. Asserções finais da migração

- `is_account_member` existe, é `SECURITY DEFINER`, pertence a `postgres` e o
  corpo contém `blocked_at` (senão a 069 rodou depois de algo que a reescreveu);
- toda conta continua com linha em `account_plans` (invariante da 067);
- nenhuma conta ou perfil sai bloqueado da migração
  (`count(*) WHERE blocked_at IS NOT NULL` = 0);
- nenhuma conta sai com `current_period_end` preenchido (§3.3 — a migração não
  inventa vencimento);
- `platform_audit_log` tem RLS ligada e **zero** policies;
- **`channel_retention_policies` e `message_retention_state` têm RLS ligada e
  zero policies** (§3.8), e a contagem de linhas de
  `channel_retention_policies` é **idêntica** à de antes da migração — a virada
  de dono não apaga política de ninguém;
- `purge_channel_messages` continua sem `EXECUTE` para `anon`/`authenticated`
  (a 069 não pode ter afrouxado o `REVOKE` da 068);
- nenhuma policy de escrita pelo cliente em `accounts.blocked_at` /
  `profiles.blocked_at` (conferido pela ausência de policy de `UPDATE` nova);
- `platform_settings.self_service_enabled` = `TRUE`,
  `default_yearly_discount_percent` dentro de 0–100 e `retention_defaults` =
  `'{}'::jsonb` (uma migração nunca semeia limite de retenção — §3.8).

---

## 4. Enforcement do bloqueio — três camadas, e nenhuma delas sozinha

| Camada | Onde | O que garante |
| --- | --- | --- |
| **1. RLS** | `is_account_member()` (§3.2) | Dado nenhum sai do banco, inclusive para o `insert` direto do navegador |
| **2. Sessão** | `getCurrentAccount()` + layout do dashboard | A pessoa vê uma **explicação**, não um app vazio |
| **3. Motores** | Código com `service_role` (§4.3) | A conta bloqueada para de **enviar** (a RLS não protege quem ignora RLS) |

### 4.1. Camada 2 — `getCurrentAccount()` e a tela de bloqueio

`src/lib/auth/account.ts` passa a ler `blocked_at` do perfil **e** da conta na
mesma consulta que já faz (é um `select` a mais no join, não uma ida extra), e
ganha um erro tipado:

```ts
export class AccountBlockedError extends Error {
  readonly status = 403 as const;
  readonly code = 'account_blocked' as const;  // ou 'user_blocked'
}
```

`toErrorResponse()` mapeia para `403 { error, code }` — código estável para a UI
distinguir "bloqueado" de "sem permissão", que são coisas diferentes para quem
está do outro lado.

`src/app/(dashboard)/layout.tsx` (server component) redireciona para `/blocked`
quando o contexto vem bloqueado. **O gate não vai para o `middleware.ts`**: ele
roda em toda requisição, inclusive assets e rotas de webhook, e uma consulta ao
banco ali é custo por request em troca de nada — a camada 1 já impede o
vazamento, e a camada 2 existe só para explicar.

### 4.2. `/blocked` — a página que evita o chamado errado

Rota pública para quem tem sessão, fora do grupo `(dashboard)`: título neutro,
o motivo quando `blocked_reason` está preenchido, `support_email` de
`platform_settings` e o botão de sair. **Nunca diz qual dos dois bloqueios está
ativo** — a pessoa não precisa saber se foi ela ou a empresa dela; quem sabe é
quem bloqueou.

### 4.3. Inventário: onde o `service_role` precisa checar bloqueio

A RLS não protege quem a ignora. **É esta tabela que define "pronto"** para a
camada 3 — uma linha esquecida é uma conta bloqueada que continua disparando
campanha.

| # | Caminho | Arquivo | Tratamento |
| --- | --- | --- | --- |
| 1 | Disparo agendado | `/api/broadcasts/cron` → `src/lib/whatsapp/broadcast-dispatch.ts` | Pula contas com `blocked_at` |
| 2 | Motor de automações | `src/lib/automations/engine.ts` (+ `schedule-scan`, `window-scan`) | Pula contas bloqueadas na enumeração |
| 3 | Motor de flows | `/api/flows/cron` | idem |
| 4 | Envio por canal | `src/lib/channels/send.ts` | Recusa com `account_blocked` — é o funil por onde todo envio passa |
| 5 | Auto-resposta de IA | `src/lib/ai/auto-reply.ts` | Não responde por conta bloqueada |
| 6 | API pública `/api/v1` | `src/lib/auth/api-context.ts` | Chave de conta bloqueada → `403 account_blocked` |
| 7 | Webhook de entrada (SPEC 055) | `src/app/api/v1/ingest/contact/route.ts` | **Bloqueia** — é integração de terceiro, não mensagem de cliente final |
| 8 | Ingestão inbound | `src/lib/channels/ingest.ts`, `src/lib/whatsapp/resolve-conversation.ts` | **NÃO bloqueia** (D-9 do PRD) — a mensagem entra e fica guardada |
| 9 | Retenção (SPEC 060) | `src/lib/retention/sweep.ts` | **Continua rodando** — não apagar seria acumular custo em conta que não paga |

O ponto 4 é o que dá economia real: `channels/send.ts` é o funil comum de
disparo, automação, flow e envio manual. Checar ali cobre os quatro de uma vez;
checar 1–3 além disso evita gastar o ciclo do cron para descobrir no fim que
não pode enviar.

### 4.4. Bloquear o dono de uma conta

Permitido, e a UI avisa: "esta conta ficará sem nenhum dono ativo". Bloquear a
conta inteira é o caminho normal; bloquear só o dono é para o caso específico de
credencial comprometida. O que o console **impede**, com 400 e sem discussão:
o proprietário da plataforma bloquear a si mesmo ou à conta em que o próprio
usuário dele está (§7.3).

---

## 5. Núcleo TypeScript

Puro, sem I/O, com teste co-locado — no padrão de `src/lib/plans/` e
`src/lib/retention/`.

### 5.1. `src/lib/plans/billing.ts` — o cálculo de ciclo e preço

| Função | Responsabilidade |
| --- | --- |
| `computePeriodEnd(startedAt, cycle, plan)` | `null` quando `billing_period ∈ ('none','custom')` ou `priceCents === 0`; senão `addMonths(startedAt, 1)` / `addYears(startedAt, 1)` via `date-fns` (já é dependência) |
| `yearlyPriceCents(plan, defaultDiscount)` | `round(priceCents * 12 * (100 - d) / 100)`, com `d = plan.yearlyDiscountPercent ?? defaultDiscount` |
| `yearlySavingsCents(plan, d)` | `priceCents * 12 − yearlyPriceCents` — o número que o modal mostra |
| `effectiveMonthlyCents(plan, d)` | Preço anual ÷ 12, para o "equivale a R$ X/mês" |
| `isExpired(periodEnd, now)` / `daysUntil(periodEnd, now)` | Puros, sem `Date.now()` por dentro — o teste precisa injetar o agora |
| `graceEnd(periodEnd, graceDays)` | `periodEnd + graceDays` |
| `describeCycleChange(current, next, now)` | O texto do modal: novo vencimento, e o alerta de overage quando o plano destino tem quota menor que o uso atual |

**Testes obrigatórios** (`billing.test.ts`):

- adesão em **31/01** com ciclo mensal → **28/02** (ou 29 em bissexto). É a
  armadilha clássica; `date-fns/addMonths` já resolve, o teste é o que impede
  alguém "otimizar" para `setMonth(+1)` depois;
- ciclo anual sobre **29/02** → 28/02 do ano seguinte;
- plano com `billing_period = 'none'` → `periodEnd` **null**, e nunca "vencido";
- plano de preço zero → null (o Grátis não vence);
- desconto `0` → preço anual é exatamente 12×; desconto `100` → zero;
- arredondamento: `29900 × 12 × 0,83` não pode gerar centavo fracionário;
- `daysUntil` exatamente na borda (mesmo instante → 0, não −0 nem 1).

### 5.2. `src/lib/platform/` — o que o console faz

| Arquivo | Responsabilidade |
| --- | --- |
| `owner.ts` | **Server-only.** `requirePlatformOwner()`, `isPlatformOwnerEmail()` (§2.2) |
| `accounts.ts` | **Server-only.** `listAccounts(filters)` — a consulta agregada da §7.2; `getAccountDetail(accountId)` |
| `block.ts` | `blockAccount`, `unblockAccount`, `blockUser`, `unblockUser` — cada uma grava `platform_audit_log` e emite o evento (SPEC 063) |
| `plan-actions.ts` | `changeAccountPlan`, `setOverrides`, `setStatus` — a lógica que hoje vive dentro de `/api/admin/accounts/[id]/plan/route.ts`, **extraída** para as duas portas usarem. Desde a decisão B (§3.3), também herda/calcula `current_period_end` quando o plano muda — não é mais só `plan_id`/`status`/`limit_overrides` |
| `guards.ts` | Puro: `canBlockAccount({ ownerEmail, ownerAccountId, target })` → recusa autobloqueio (§4.4); `assertNotSelf` |
| `summary.ts` | Puro: agrega a visão geral (contas por status, vencendo em N dias, em overage) a partir de linhas já lidas |

**Testes obrigatórios:** `owner.test.ts` (lista vazia, espaços, maiúsculas,
e-mail não confirmado, e-mail parcialmente igual — `bruno@zapcrmbr.com.br` não
casa com `bruno@zapcrmbr.com`), `guards.test.ts` (autobloqueio recusado nas
quatro formas: mesma conta, mesmo usuário, e-mail com caixa diferente, e-mail
com espaço), `summary.test.ts` (janela de vencimento na borda, conta sem
vencimento não entra em "vencendo").

**A extração do `plan-actions.ts` é pré-requisito, não faxina.** Enquanto a
lógica de troca de plano viver dentro da rota `/api/admin/**`, o console
precisaria reimplementá-la — e o critério 3 do PRD ("as mesmas linhas em
`account_plan_events`") deixaria de ser verificável por construção.

### 5.3. O elo novo na cadeia de retenção

`src/lib/retention/defaults.ts` continua lendo o `.env` **sem mudança nenhuma**
— é código testado que faz uma coisa. O elo do console entra **acima** dele,
num módulo puro novo:

```ts
// src/lib/retention/global-defaults.ts
export function mergeGlobalDefaults(
  fromConsole: unknown,          // platform_settings.retention_defaults (JSONB cru)
  fromEnv: RetentionDefaults     // o que readRetentionDefaults() já devolve
): RetentionDefaults;

export function validateRetentionDefaults(raw: unknown):
  { ok: true; value: RetentionDefaultsInput } | { ok: false; error: string };
```

Duas regras que o teste (`global-defaults.test.ts`) precisa fixar:

1. **Dimensão a dimensão, não objeto a objeto.** Definir só `retentionDays` no
   console mantém `maxMessages` vindo do `.env`. Substituir o objeto inteiro
   faria "editei um campo na tela" apagar silenciosamente dois limites — o tipo
   de regressão que só aparece meses depois, como histórico que sumiu.
2. **JSONB inválido não derruba a varredura.** Chave desconhecida, tipo errado
   ou JSON corrompido → ignora aquele pedaço, `console.warn`, e segue com o
   `.env`. Mesma postura de `defaults.ts`: um valor torto **nunca** pode virar
   "sem limite" acidental em uma direção nem "apagar tudo" na outra.

`sweep.ts` passa a ler `platform_settings.retention_defaults` uma vez por ciclo
(uma linha, com `service_role`, que ele já lê para o claim) e a chamar
`mergeGlobalDefaults` antes de resolver cada par conta × canal. `policy.ts` —
o arquivo mais importante da SPEC 060 — **não muda**: ele continua recebendo
`defaults` já resolvidos e aplicando a mesma tabela de precedência.

---

## 6. Rotas de API

Todas com `requirePlatformOwner()`, todas com `supabaseAdmin()`, todas gravando
`platform_audit_log`.

| Rota | Método | O quê |
| --- | --- | --- |
| `/api/platform/summary` | GET | Números da visão geral (§7.1) |
| `/api/platform/accounts` | GET | Lista paginada + filtros (`q`, `plan`, `status`, `blocked`, `expiringInDays`) |
| `/api/platform/accounts/[accountId]` | GET | Detalhe: conta, plano, ciclo, uso × quota, membros, últimos eventos |
| `/api/platform/accounts/[accountId]/plan` | PUT | Trocar plano/status/overrides/ciclo — chama `plan-actions.ts` |
| `/api/platform/accounts/[accountId]/block` | POST/DELETE | Bloquear/desbloquear a conta (corpo: `reason`) |
| `/api/platform/accounts/[accountId]/recount` | POST | `recount_account_usage()` (guia §8) pela tela |
| `/api/platform/users/[userId]/block` | POST/DELETE | Bloquear/desbloquear a pessoa |
| `/api/platform/users/[userId]/role` | PUT | Mudar o papel de um membro (inclusive promover admin) |
| `/api/platform/plans` | GET/POST | Catálogo, agora com `yearlyDiscountPercent` |
| `/api/platform/settings` | GET/PUT | `platform_settings`: quotas ligadas, plano padrão, desconto padrão, carência, autosserviço, e-mail de suporte, **padrão global de retenção** (§3.8) |
| `/api/platform/requests` | GET/PATCH | Solicitações de plano sob medida |
| `/api/platform/retention` | GET/PUT | Padrão global de retenção por tipo de canal + estado da última varredura |
| `/api/platform/accounts/[accountId]/retention` | GET/PUT | A política daquela conta, por tipo de canal |
| `/api/platform/accounts/[accountId]/retention/preview` | POST | Prévia (`p_dry_run`) sobre os limites **enviados no corpo**, para a conta escolhida |

**As três rotas de retenção substituem `/api/account/retention`,
`/api/account/retention/preview` e a aba de Configurações** (§7.6). As antigas
são **removidas**, não deixadas respondendo 403: uma rota que existe e recusa
sempre é código morto que alguém vai "consertar" um dia devolvendo o acesso ao
dono da conta.

**`/api/platform/settings` é a rota que fecha um buraco documentado:** o guia de
operação §3 diz hoje que ligar as quotas exige `UPDATE platform_settings` por
SQL direto, "não existe rota admin para isto". Passa a existir — com uma
confirmação explícita na UI, porque ligar o interruptor muda o comportamento de
todos os clientes de uma vez.

### 6.1. Rotas do cliente que mudam

| Rota | Mudança |
| --- | --- |
| `/api/account/plan/change` (nova) | POST `{ planId, billingCycle }` — **aplica na hora** para plano público e ativo, com `self_service_enabled` ligado. Grava `account_plan_events` com `actor='self-service:<email>'`, recalcula `started_at`/`current_period_end`, emite o evento |
| `/api/account/plan/cancel` (nova) | POST agenda (`cancel_at_period_end = true`); DELETE reverte |
| `/api/account/plan/request` (existe) | **Permanece**, só para plano **não público** (D-3) e para quando `self_service_enabled` estiver desligado |
| `/api/account/plan` (existe) | GET passa a devolver `billingCycle`, `startedAt`, `currentPeriodEnd`, `cancelAtPeriodEnd`, e o preço anual calculado de cada plano do catálogo |

Guarda de papel: `requireRole('admin')` — o mesmo `admin+` que já podia
solicitar (SPEC 059 §6). Trocar plano é decisão de quem administra a conta.

### 6.2. A porta do sistema externo de cobrança (PRD §5.2, D-14)

```http
POST /api/admin/accounts/{accountId}/billing/renew
x-admin-secret: <PLATFORM_ADMIN_SECRET>

{ "paymentRef": "fatura-2026-08-1042", "paidAt": "2026-08-26T12:00:00Z",
  "periods": 1, "externalRef": "cli-8891", "note": "Pix conciliado" }
```

Fica em `/api/admin/**` e não em `/api/platform/**` de propósito: quem chama é
**máquina**, não navegador — e a autenticação por segredo de servidor é
exatamente o que D-2 preservou.

O que faz, nesta ordem:

1. `INSERT` do `paymentRef` em `last_payment_ref` — **é o índice único da §3.7
   que decide**. Colisão (`23505`) → responde `200 { "status": "already_applied" }`,
   não 409: a retentativa do sistema externo é comportamento esperado, não erro;
2. avança `current_period_end` em `periods` ciclos **a partir do vencimento
   atual** (não de hoje) — renovar no dia 3 um plano que venceu no dia 1 não
   pode empurrar o vencimento para o dia 3 do mês seguinte, senão o cliente
   perde dois dias a cada renovação;
3. se o status era `past_due`, volta para `active` e limpa `grace_until`;
4. grava `platform_audit_log` (`billing.renew`) e emite `plan.renewed`.

**Esta é a rota que o gateway chamaria no futuro** — é literalmente a forma de
um webhook de pagamento. Implementá-la agora custa uma rota e resolve a
integração com o sistema de cobrança que já existe; deixá-la para depois
significaria migração e retrabalho nas telas.

Continua **sem** emitir cobrança, sem guardar valor pago e sem conciliar: o CRM
registra que um período foi honrado, não quanto entrou no caixa.

---

## 7. Interface do console

Rota base `/admin`, em route group próprio `src/app/(platform)/admin/**`, com
layout independente do `(dashboard)` — o console não tem sidebar de inbox nem
seletor de conta, e misturá-los criaria estados impossíveis ("qual conta está
selecionada?").

**Padrão visual: o mesmo de `src/components/retention/retention-panel.tsx`** —
`SettingsPanelHead` para título+descrição, `Alert` para o que o operador
precisa saber antes de agir, `Card` em grid para os itens, `Loader2` centralizado
no carregamento, `toast` do `sonner` para o desfecho, e **gate duplo**: o layout
server-side barra por `requirePlatformOwner()` e o componente barra de novo no
cliente. O `retention-panel` faz isso com `<RequireRole min="owner">`; aqui o
equivalente é `<RequirePlatformOwner>`, alimentado por
`GET /api/platform/summary` — nunca por uma flag em `localStorage`.

### 7.1. `/admin` — visão geral

Cards com: contas ativas · bloqueadas · vencendo em 7 dias · vencidas ·
solicitações abertas · contas em overage. Cada card é um link que já leva à
lista **com o filtro aplicado** — um número que não leva a lugar nenhum vira
enfeite na segunda semana.

Um `Alert` no topo quando `quotas_enforced = false`: "as quotas estão
desligadas; nenhum limite é aplicado". Sem isso, o operador configura planos por
uma hora e conclui que o sistema está quebrado (é literalmente a armadilha
"Liguei o interruptor e nada mudou" do guia §10, do outro lado).

### 7.2. `/admin/accounts` — a lista agrupada

Uma linha por **conta** (nunca por usuário — §4 do PRD), expansível:

```
▸ Acme Ltda            Profissional · Anual   vence 12/03/2027   5 usuários   ●ativa
▾ Beta Comércio        Essencial · Mensal     vence 02/09/2026   3 usuários   ●bloqueada
    Ana Souza      ana@beta.com      Proprietário   ativo      [switch]
    Carlos Lima    carlos@beta.com   Admin          bloqueado  [switch]
    Rita Alves     rita@beta.com     Agente         ativo      [switch]
    ─────────────────────────────────────────────────────────
    Contatos 1.842/2.000 · Usuários 3/5 · QRCode 1/1
    [ Abrir conta ]   [ Bloquear conta ●━ ]
```

A consulta é **uma** ida ao banco por bloco de contas com `service_role`
(`accounts` + `account_plans` + `plans` + `profiles` + `account_usage_counters`),
paginada em 25 — não uma consulta por conta dentro de um laço, que é como uma
tela dessas costuma nascer e como ela costuma morrer com 200 clientes.

Switches: um por usuário (bloquear a pessoa) e um por conta (bloquear a conta).
Ambos com **confirmação por diálogo** e campo de motivo opcional — o motivo é o
que aparece na tela do bloqueado (§4.2). Estado otimista revertido no erro, como
o `handleReact` do inbox.

### 7.3. `/admin/accounts/[accountId]` — o detalhe

Seções, na ordem: **cabeçalho** (nome, dono, criada em, switch de bloqueio) ·
**plano** (plano, ciclo, adesão, vencimento, status, cancelamento agendado, e os
botões trocar plano / conceder exceção / mudar status) · **uso** (as barras de
`plan-usage-bars.tsx` reaproveitadas — mesmo componente do cliente, com os
números desta conta) · **membros** (papel editável, switch de bloqueio) ·
**histórico** (`account_plan_events` + `platform_audit_log` intercalados por
data).

Reaproveitar `plan-usage-bars.tsx` não é economia de código: é a garantia de que
o proprietário vê **exatamente** a mesma barra que o cliente vê quando liga para
reclamar dela.

O autobloqueio é barrado **na UI e na rota** (`guards.ts`): o switch da própria
conta do proprietário aparece desabilitado com o motivo no `title`.

### 7.4. `/admin/plans` e `/admin/settings`

`/admin/plans`: um `Card` por plano com preço mensal, preço anual **calculado
ao vivo** enquanto o desconto é digitado, quotas por chave (`QUOTA_KEYS`) e
recursos (`FEATURE_KEYS`) como campos gerados a partir de
`src/lib/plans/types.ts` — não uma lista escrita à mão que fica velha na próxima
quota. Chave desconhecida continua rejeitada por `validateCatalog()`.

`/admin/settings`: o interruptor de quotas com um diálogo de confirmação que
diz, em texto, quantas contas passariam a ter limite aplicado **naquele
instante** — ligar quota é a ação de maior alcance do sistema inteiro.

### 7.5. Retenção no console — reaproveitando o painel que já existe

A SPEC 060 entregou quatro componentes bons em `src/components/retention/`. Eles
**mudam de casa e de fonte de dados, não de forma**:

| Componente | Destino |
| --- | --- |
| `retention-channel-card.tsx` | Reaproveitado inteiro — os três campos, o placeholder cinza de "herdado" e a origem por dimensão (`formatRetentionSource`) continuam valendo, agora com um nível a mais na cadeia (§5.3) |
| `retention-preview.tsx` | Reaproveitado — a prévia antes de salvar é o item nº 1 da §8.2 da SPEC 060 e não pode se perder na mudança |
| `retention-usage.tsx` | Reaproveitado — "12.480 de 50.000 mensagens · 37 de 200 favoritas" |
| `retention-panel.tsx` | **Reescrito** o invólucro: sai `<RequireRole min="owner">`, entra `<RequirePlatformOwner>`; entram o seletor de conta e a aba "Padrão global" |

Duas telas no console:

- **`/admin/retention`** — o padrão global por tipo de canal (o que a `.env`
  definia sozinha até agora), com o aviso do piso de idade, o estado da última
  varredura (`message_retention_state`) e um `Alert` destacado quando
  `MESSAGE_RETENTION_ENABLED` está ausente: "a varredura não roda; os limites
  abaixo são registro, nada é apagado". Sem isso, o proprietário configura tudo
  e conclui que o sistema está quebrado.
- **Bloco "Retenção" em `/admin/accounts/[accountId]`** — a política daquela
  conta, com os mesmos cartões e a prévia calculada **sobre os dados reais dela**.

O que sai do app do cliente, na mesma fase, sem sobra:

1. `settings-sections.ts`: a seção `'retention'` sai de `SETTINGS_SECTIONS`, de
   `SECTION_META` e o ícone `Archive` sai do import;
2. `/api/account/retention` e `/api/account/retention/preview`: **apagadas**;
3. as chaves `Settings.retention.*` migram para `Platform.retention.*` nos dois
   dicionários — mover, não duplicar, senão `i18n:check` passa e a tela do
   cliente fica com string órfã.

**O `minRole` de `SectionMeta` continua existindo** mesmo sem usuário: ele é o
mecanismo de gating do rail e será usado de novo. Removê-lo junto com a seção
seria desfazer trabalho por engano.

### 7.6. Interface do cliente (o que muda em `/plan`)

- `plan-catalog.tsx`: cada plano mostra os dois preços (mensal e "ou R$ X/ano,
  economize Y").
- **`plan-cycle-dialog.tsx` (novo)** — o modal do PRD §3.2: escolha do ciclo,
  data de vencimento resultante, aviso de overage no downgrade e o texto de que
  **o período recomeça hoje, sem pró-rata**.
- `plan-panel.tsx`: bloco novo de assinatura (ciclo, adesão, vencimento,
  "cancelamento agendado para …"), botão **Cancelar plano** (`admin+`) e
  **Retomar plano** quando já agendado.
- `plan-request-state.tsx`: passa a aparecer **só** para plano sob medida — no
  autosserviço não existe estado "em análise".

### 7.7. i18n

Chaves novas em `messages/en.json` (fonte) e `messages/pt-BR.json` (espelho):
`Platform.*` (console inteiro: visão geral, contas, membros, planos,
configurações, bloqueio), `Plan.cycle.*` (modal, ciclos, economia, vencimento),
`Plan.cancel.*`, `Blocked.*` (a página da §4.2). Mensagens de `/api/**`
permanecem **em inglês**; a UI traduz pelo `code` (`account_blocked`,
`user_blocked`, `self_service_disabled`, `plan_not_available`).

`npm run i18n:check` entra no gate de conclusão de toda fase que toca UI.

---

## 8. Vencimento — quem roda e o que faz

A varredura de ciclo é **fase 5 de `/api/automations/cron`**, no mesmo `after()`
onde a retenção (SPEC 060 §6) já é a fase 4, e pelo mesmo motivo: rota nova
exigiria um quarto `cron.schedule` de todo operador em produção — e quem não o
fizesse teria vencimentos que nunca acontecem, sem erro em lugar nenhum.
(A memória do projeto registra que o `pg_cron` **não está instalado** em todo
projeto Supabase deste app — mais uma razão.)

`src/lib/plans/lifecycle.ts` (server-only), por conta com
`current_period_end` não nulo:

1. **Vencendo** (7 e 1 dia) → emite `plan.expiring`;
2. **Vencido** (`now > period_end`) → se `cancel_at_period_end`, troca para
   `platform_settings.default_plan_code`, limpa o agendamento e emite
   `plan.canceled_applied`; senão marca `status='past_due'`, grava
   `grace_until = period_end + grace_days` e emite `plan.expired`;
3. **Carência encerrada** (`now > grace_until`) → emite `plan.grace_ended`.
   **Não bloqueia** (D-7) — quem bloqueia é o proprietário, pelo console.

Idempotência é responsabilidade do `dedupe_key` da outbox (SPEC 063 §2), não de
uma coluna de "já avisei": a chave
`plan.expiring:<account_id>:<period_end>:<7>` só entra uma vez, e o cron pode
rodar mil vezes.

Rota explícita opcional `/api/plans/lifecycle/cron` com o mesmo `x-cron-secret`,
para quem quer horário próprio e para o teste manual da F9 — bloco **comentado**
em `supabase/setup/cron-jobs.sql`, no formato que a retenção já usa.

---

## 9. Impacto na API pública `/api/v1`

Uma mudança de contrato, e a regra do `AGENTS.md` vale integralmente: as **três**
edições saem juntas (`docs/public-api.md`, `public/openapi.json`,
`public/openapi.pt-BR.json`), com `npx @redocly/cli lint` nos dois JSON e
conferência de paridade estrutural depois.

1. **`GET /api/v1/me`** — o bloco `plan` (que a SPEC 059 §8 já adicionou) ganha
   `billingCycle`, `startedAt`, `currentPeriodEnd` e `cancelAtPeriodEnd`. Uma
   integração que provisiona recursos precisa saber quando o acesso vence.
2. **Erro novo:** qualquer endpoint pode responder **403** com código
   `account_blocked` — acrescentar à união de `src/lib/api/v1/respond.ts` e
   documentar em prosa que uma chave válida de conta bloqueada para de
   funcionar sem ser revogada.

---

## 10. Fases

Cada fase é implementável, testável e commitável isolada. **Nenhuma bloqueia
ninguém enquanto nenhum switch for acionado**, e o console não existe até a F3
(sem `PLATFORM_OWNER_EMAILS`, `/admin` é 404).

| Fase | Entrega | Pronto quando |
| --- | --- | --- |
| **F1** | Migração 069: bloqueio, `is_account_member` reescrita, ciclo e cobrança externa em `account_plans` (§3.3, §3.7), desconto, `platform_settings` (inclusive `retention_defaults`), `platform_audit_log`, **drop das policies de retenção** (§3.8), asserções | Suíte verde; asserções passam; app se comporta exatamente como antes (nada bloqueado, nenhum vencimento inventado, nenhuma política de retenção perdida) |
| **F2** | `src/lib/plans/billing.ts` + `src/lib/platform/{owner,guards,summary}.ts` + `src/lib/retention/global-defaults.ts` + testes (§5) | `npm run test` verde, incluindo o caso 31/01 → 28/02 e a fusão dimensão a dimensão (§5.3) |
| **F3** | Guarda de identidade, layout `(platform)/admin`, `/admin` (visão geral), `GET /api/platform/summary` | Login não-proprietário recebe **404**; proprietário vê os números |
| **F4** | `/admin/accounts` (lista agrupada + detalhe), rotas de leitura | Uma consulta por página, não uma por conta (conferido no log de queries) |
| **F5** | Bloqueio: rotas, switches, `AccountBlockedError`, página `/blocked`, camada 3 nos 9 pontos da §4.3 | Conta bloqueada: membro não lê nada **por SQL**, vê a tela de bloqueio, e mensagem recebida continua entrando |
| **F6** | Extração de `plan-actions.ts` + `/api/platform/accounts/[id]/plan`, `/plans`, `/settings`, `/requests` no console | `/api/admin/**` e o console produzem eventos idênticos para a mesma ação |
| **F7** | **Retenção muda de dono** (§3.8, §5.3, §7.5): telas no console, `sweep.ts` lendo o padrão global, remoção da aba e das rotas do cliente, chaves i18n **movidas** | Dono da conta: aba ausente, rotas antigas 404, `0` linhas na política por SQL. Proprietário: prévia e salvamento funcionando por conta. Estrela e aviso da thread **intactos** |
| **F8** | Ciclo no cliente: modal mensal/anual, `/api/account/plan/change`, cancelar/retomar, painel atualizado, i18n | Troca vale na mesma requisição; vencimento correto; `i18n:check` verde |
| **F9** | `lifecycle.ts`, fase 5 do cron, rota opcional, rota de renovação externa (§6.2), `cron-jobs.sql`, docs (`guia-operacao-planos-e-quotas.md` §2/§3/§7 + guia de retenção), API pública (§9) | `redocly lint` verde nos dois JSON; renovação idempotente conferida; guia sem instrução obsoleta |
| **F10** | Teste manual ponta a ponta (§12), roteiro em `docs/spec-062-teste-manual.md` | Os 16 itens verificados contra banco real |

**Migração:** a F1 aplica a 069 — e, pela regra do `AGENTS.md`, **só depois de
confirmar com o mantenedor**, projeto por projeto (`vn`, `rs`, `jh`).

---

## 11. Armadilhas específicas desta SPEC

| Sintoma | Causa provável |
| --- | --- |
| Todo mundo perdeu acesso depois da 069 | `is_account_member` reescrita com `blocked_at IS NOT NULL` invertido, ou `JOIN accounts` virando `INNER` sobre conta ausente — a asserção de "zero bloqueados" não pega isso; o teste de leitura com sessão real pega |
| App inteiro ficou lento após a 069 | `is_account_member` perdeu o `STABLE` no `CREATE OR REPLACE` |
| Função passou a falhar com "permission denied" | Faltou repetir `ALTER FUNCTION … OWNER TO postgres` depois do replace (§3.2) |
| Conta bloqueada continua disparando campanha | Um dos 9 pontos da §4.3 ficou de fora — a RLS não protege quem usa `service_role` |
| Cliente bloqueado abre chamado dizendo "sumiram meus dados" | Falta a página `/blocked` (§4.2): listas vazias são indistinguíveis de perda de dados |
| Vencimento caiu no dia errado | `setMonth(+1)` no lugar de `addMonths` — adesão em 31/01 vira 03/03 |
| Conta antiga apareceu como "vencida" no dia do deploy | Backfill preencheu `current_period_end` (§3.3): migração não inventa vencimento |
| Troquei o plano pelo console e o vencimento continua `NULL` para sempre | Bug corrigido em 2026-08-30 (§3.3.1, decisão B) — antes disso `changeAccountPlan` nunca calculava `current_period_end` numa conta que nunca teve vencimento; hoje calcula, a partir da data da troca |
| Troquei o plano pelo console e o vencimento MUDOU (empurrou pra frente) | Não deveria — decisão B é herdar, não recomeçar. Se aconteceu depois de 2026-08-30, é regressão: confira se `current.current_period_end` realmente não era `null` antes da troca |
| Preço anual com centavo fracionário | `round` faltando em `yearlyPriceCents` |
| Proprietário se trancou fora | Autobloqueio não barrado em `guards.ts` (§4.4). Saída: `UPDATE accounts SET blocked_at = NULL` por SQL |
| Console some depois de um deploy | `PLATFORM_OWNER_EMAILS` não replicada para o host de produção — e, por decisão da §2.4, ele responde 404 em vez de dizer isso |
| Política de retenção "sumiu" depois da 069 | Ela continua lá e valendo — só o dono da conta deixou de enxergá-la (§3.8). Conferir por `service_role`, não pela sessão do cliente |
| Limite de retenção virou "sem limite" depois de editar um campo no console | `mergeGlobalDefaults` substituindo o objeto inteiro em vez de dimensão a dimensão (§5.3, regra 1) |
| Varredura de retenção parou de rodar | `sweep.ts` passou a depender de `platform_settings` e a leitura falhou — precisa cair no `.env`, nunca abortar o ciclo |
| Chave `Settings.retention.*` órfã | Foi **copiada** para `Platform.retention.*` em vez de movida (§7.5) — `i18n:check` passa e a tela do cliente fica com string morta |
| Renovação externa avançou o vencimento duas vezes | `paymentRef` ausente no corpo, ou índice único da §3.7 não criado |
| Renovação atrasada encurtando o período do cliente | Vencimento recalculado a partir de *hoje* e não do vencimento anterior (§6.2, passo 2) |
| Estranho descobre que existe um console | Alguma rota `/api/platform/**` respondendo 401/503 em vez de 404 |
| Aviso de vencimento chegando todo dia | `dedupe_key` sem a data do período na composição (§8) |
| Tela quebrada só em pt-BR | Chave nova em um dicionário só — `npm run i18n:check` |

---

## 12. Teste manual (F10) — o que precisa ser verificado contra banco real

Nenhum destes é verificável por teste unitário; todos envolvem sessão real, RLS
ou dinheiro. Roteiro executável em `docs/spec-062-teste-manual.md`, no formato
do `docs/spec-056-teste-manual.md`.

1. Login comum em `/admin` → **404**. Mesmo resultado em `/api/platform/accounts`
   via `curl` com o cookie de sessão dele.
2. `PLATFORM_OWNER_EMAILS` ausente → 404 para o próprio proprietário.
3. E-mail com caixa/espaço diferente (` Bruno@ZapCrmBr.com `) → **entra** (a
   normalização da §2.2); `bruno@zapcrmbr.com.br` → **não entra**.
4. Bloquear conta → membro dela recebe `0` linhas em `contacts`/`conversations`
   **por SQL com a sessão dele** (não só pela tela), e vê `/blocked`.
5. Conta bloqueada recebendo mensagem → a mensagem **entra** no banco (D-9);
   uma campanha agendada dela **não** dispara.
6. Bloquear um usuário → só ele cai; o colega segue trabalhando na mesma conta.
7. Desbloquear → acesso volta idêntico, sem nada apagado.
8. Proprietário tentando bloquear a própria conta → recusado na UI **e** na rota.
9. Troca de plano pelo modal (mensal e anual) → plano, ciclo e vencimento
   corretos na mesma resposta; `account_plan_events` com `actor='self-service:…'`.
10. Downgrade com overage → nada é apagado, barra em vermelho, criação de
    contato recusada (motor da 059 continua valendo).
11. Cancelar → acesso mantido; com o relógio adiantado além do vencimento, o
    cron rebaixa para o plano padrão e emite o evento uma única vez.
12. Console × API: a mesma troca de plano feita pelas duas portas gera linhas
    equivalentes em `account_plan_events`, diferindo só no `actor`.
13. **Retenção — o dono da conta perdeu o acesso:** a aba não aparece em
    Configurações, `/settings?tab=retention` cai no Overview, as rotas antigas
    respondem 404 e um `SELECT` em `channel_retention_policies` com a sessão
    dele devolve `0` linhas — **mesmo sendo `account_role = 'owner'`**.
14. **Retenção — nada se perdeu:** uma conta que já tinha política configurada
    antes da 069 continua com os mesmos três valores (conferido por
    `service_role`), e a varredura seguinte apaga exatamente o que apagaria
    antes.
15. **Retenção — o elo novo funciona:** com `.env` definindo `retentionDays` e o
    console definindo só `maxMessages`, a varredura respeita **os dois**; a
    prévia do console bate com o que a execução real apaga em seguida (é o item
    12 do teste manual da SPEC 060, agora pelo console).
16. **Renovação externa:** chamar `/billing/renew` duas vezes com o mesmo
    `paymentRef` avança o vencimento **uma vez** e responde `already_applied` na
    segunda; chamar com `paymentRef` novo depois do vencimento estende a partir
    do vencimento anterior, não de hoje.

> O item 14 do teste manual da SPEC 060 ("agente e admin não veem a aba e
> recebem 403; owner de outra conta recebe 0 linhas") é **substituído** pelos
> itens 13–15 acima. Atualizar `docs/spec-060-teste-manual.md` faz parte da F7.

---

## 13. Variáveis de ambiente

```bash
# Identidade do proprietário da plataforma. Ausente = console não existe (404).
PLATFORM_OWNER_EMAILS=bruno@zapcrmbr.com

# Continua valendo para /api/admin/** (automação) — D-2.
PLATFORM_ADMIN_SECRET=<openssl rand -hex 32>

# Já existente; a fase 5 do ciclo de plano roda dentro do mesmo cron.
AUTOMATION_CRON_SECRET=<segredo das rotas de cron>
```

Carência, desconto anual padrão, plano padrão, autosserviço e **os números da
retenção** não são `.env`: moram em `platform_settings` (§3.4, §3.8), editáveis
pelo console sem redeploy — a mesma razão pela qual `quotas_enforced` já mora lá
(SPEC 059 §2.1).

As variáveis de retenção da SPEC 060 §15 **continuam todas válidas** e viram a
camada de base da cadeia (§5.3). Uma delas nunca sobe para a tela:

```bash
# Interruptor da varredura. Continua SÓ no .env — ligar limpeza de histórico
# por clique é o acidente sem desfazer que a SPEC 060 §1 existe para impedir.
MESSAGE_RETENTION_ENABLED=true
```

---

## 14. Deixado para depois

- **Impersonação** ("ver como o cliente") — a ferramenta de suporte mais útil e
  mais perigosa; exige trilha obrigatória e consentimento registrado.
- **Operadores múltiplos com papéis** (leitura × escrita no console) — só quando
  houver time; hoje multiplicaria a superfície da §2 sem ganho.
- **Exclusão de conta pelo console** — hoje é SQL manual, deliberadamente. Uma
  tela para a operação sem desfazer precisa de confirmação por digitação do nome,
  exportação prévia e carência.
- **Relatórios comerciais** (MRR, churn, coorte) — só com pagamento confirmado
  dentro do sistema.
- **Bloqueio automático por inadimplência** — D-7 do PRD. Revisitar quando o
  sistema externo estiver confirmando pagamento pela rota da §6.2: aí o CRM
  passa a **saber** que não foi pago, em vez de só saber que a data passou.
- **Gateway de pagamento** — os três pontos de extensão já estão de pé (§3.7 e
  §6.2). O que falta é o que o gateway traz consigo: valor efetivamente pago,
  retentativa, tokenização, recibo ao cliente e pró-rata. Quando entrar,
  `billing_source` vira `'gateway'` e a rota de renovação passa a ser chamada
  pelo webhook dele — sem migração nova.
- **Retenção como chave de plano** — o furo que a SPEC 060 §3.4 deixou
  reservado. Agora que a política é do operador (§3.8), amarrá-la a
  `plans.limits` é evolução natural: `retention_days` viraria mais uma chave em
  `QUOTA_KEYS`, entre a política da conta e o padrão global na cadeia de
  precedência.

---

## 15. Validação antes de entregar cada fase

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```
