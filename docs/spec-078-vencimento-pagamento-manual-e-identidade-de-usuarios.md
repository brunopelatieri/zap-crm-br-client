# SPEC 078 — Console do proprietário: vencimento manual, pagamento manual e edição de nome/e-mail de usuários

> **Status:** **F1–F6 implementadas** (migração 089 aplicada em `vn` e `rs`; gate local verde). **F7 pendente de execução** — o roteiro está em [`spec-078-teste-manual.md`](./spec-078-teste-manual.md) e nenhum item foi rodado ainda (a interface do console nunca foi aberta num navegador). D-1 a D-12 (§2) tratados como ratificados implicitamente pelo pedido de implementação de cada fase.
> **Data:** 2026-10-08
> **Migração:** `089_console_billing_and_identity.sql` (confira `ls supabase/migrations/` antes — a última hoje é a 088)
> **Depende de:** [SPEC 062](./spec-062-console-do-proprietario.md) (console `/admin`, `platform_audit_log`, ciclo de plano — implementada) · migração **071** (`account_plan_payments` + `apply_plan_renewal`) · [SPEC 075](./spec-075-registro-de-atividade-da-conta.md) (registro de atividade da conta)
> **Guia do operador afetado:** [guia-console-do-proprietario.md](./guia-console-do-proprietario.md)

---

## 1. O que esta SPEC entrega, e por que agora

O console da SPEC 062 sabe **trocar o plano**, **bloquear** e **excluir** — mas três operações do dia a dia de quem vende o SaaS sem gateway de pagamento ainda exigem SQL direto ou são impossíveis:

| # | Necessidade | Como é hoje | Problema |
| --- | --- | --- | --- |
| 1 | **Alterar a data de vencimento** do plano de uma conta | `UPDATE account_plans SET current_period_end = …` no SQL Editor | Sem trilha (`platform_audit_log` não vê), sem voltar `past_due` → `active`, sem fuso definido, e corre contra o cron de ciclo de vida |
| 2 | **Marcar pagamento manual** (Pix recebido, boleto compensado) | `curl` em `POST /api/admin/accounts/{id}/billing/renew` com `x-admin-secret` | O operador precisa do segredo no terminal, inventar um `paymentRef` e lembrar que o ciclo anual não existe pelo console (§3.3) |
| 3 | **Editar nome e e-mail** de qualquer usuário, inclusive o **dono (`owner`) da conta** | Impossível pelo console; o próprio usuário só consegue com confirmação nos dois e-mails | Cliente que perdeu acesso ao e-mail antigo, ou digitou errado no cadastro, fica preso sem saída de suporte |

O princípio da SPEC 062 §1 continua valendo palavra por palavra: **nenhuma linha de RLS é afrouxada**. Toda escrita acontece em rota `/api/platform/**`, atrás de `requirePlatformOwner()`, com `supabaseAdmin()`, gravando `platform_audit_log`.

### 1.1. Achado da investigação que muda o escopo do item 3

`src/components/settings/profile-form.tsx` (linhas ~148-152) afirma que, quando o usuário troca o próprio e-mail, *"Supabase will push the change there [profiles.email] after the user clicks the link (handled by the handle_new_user trigger pattern)"*. **Isso não existe.** Conferido no `vn` em 2026-10-08:

```text
auth.users — triggers: on_auth_user_created (AFTER INSERT), on_auth_user_deleted_reassign (BEFORE DELETE)
```

Não há trigger `AFTER UPDATE OF email`. Hoje `profiles.email` diverge **silenciosamente** de `auth.users.email` toda vez que alguém troca o e-mail pelo perfil — o `vn` tem 5 perfis e 0 divergentes só porque ninguém trocou ainda. Como o console exibe e usa `profiles.email` (lista de membros, guarda de autobloqueio em `/api/platform/users/[userId]/block`, confirmação de exclusão de conta), **a edição de e-mail pelo console não pode ser construída sobre uma cópia que já não se sincroniza**. A migração 089 fecha esse buraco para os dois caminhos (console e autosserviço) — §4.1.

---

## 2. Decisões a ratificar

| # | Decisão | Recomendação | Alternativa descartada (e por quê) |
| --- | --- | --- | --- |
| **D-1** | Vencimento manual só para planos **com ciclo** (`billing_period IN ('monthly','yearly')` e preço > 0) | **Sim** — mesma regra de `apply_plan_renewal` (`NO_BILLING_CYCLE`) e de `computePeriodEnd` | Permitir vencimento em plano "sob medida"/`unlimited`: o cron de ciclo de vida passaria a marcar `past_due` num plano que, por definição, não vence, e a renovação depois recusaria com `NO_BILLING_CYCLE` — um estado sem saída pela tela |
| **D-2** | Data informada é **dia**, não instante: vira **23:59:59 de `America/Sao_Paulo`** daquele dia | **Sim**, convertido **no Postgres** (`AT TIME ZONE`) | Converter no TypeScript: depende do fuso do servidor (a VPS pode estar em UTC) e o `date-fns` v4 do projeto não tem `@date-fns/tz` instalado |
| **D-3** | Faixa aceita para o vencimento: de **hoje (SP)** até **hoje + 3 anos** | **Sim** | Aceitar data passada: dispara `past_due` + carência já vencida no próximo cron. Para "este cliente já está inadimplente", o caminho é o diálogo de status que já existe |
| **D-4** | O diálogo de vencimento também permite trocar o **ciclo** (`monthly` ↔ `yearly`) | **Sim** | Sem isto, o console nunca grava `yearly` (SPEC 062 §3.3.1 força `'monthly'`) e o pagamento manual de um cliente anual avançaria **1 mês** em vez de 1 ano |
| **D-5** | Vencimento futuro em conta `past_due` volta para `active` e limpa `grace_until` | **Sim** — mesmo efeito da renovação (071) | Manter `past_due`: o cliente continuaria recebendo aviso de carência com vencimento já empurrado |
| **D-6** | Pagamento manual **reaproveita** `apply_plan_renewal` (mesmo log, mesma idempotência), com a função ampliada | **Sim** — uma lógica de renovação, duas portas (SPEC 062 §2.3) | Função nova "manual": dois caminhos que avançam o mesmo vencimento divergem no primeiro achado de code review que só um deles recebe |
| **D-7** | Registrar **forma** (`pix`, `boleto`, `card`, `transfer`, `cash`, `other`) e **valor** (opcional) do pagamento | **Sim, como registro informativo** — o CRM continua não conciliando nem emitindo cobrança (SPEC 062 §6.2) | Não guardar: o suporte não consegue responder "como esse cliente pagou em março?" sem abrir outro sistema |
| **D-8** | Pagamento em conta `trialing` também passa a `active` (hoje só `past_due` muda) | **Sim** — vale também para a rota da API (`/billing/renew`) | Manter: um cliente que pagou continua aparecendo "em teste" no console e em `GET /api/v1/me` |
| **D-9** | **Desfazer** pagamento manual: só o **último** pagamento não estornado da conta, e só se o vencimento atual ainda é o que ele gravou | **Sim** — o estorno restaura vencimento, status e carência anteriores, e **marca** a linha (nunca apaga) | Sem desfazer: o único conserto de um clique errado vira "alterar vencimento" à mão, e o histórico de pagamentos mente para sempre |
| **D-10** | Troca de e-mail pelo console é **imediata e já confirmada** (`auth.admin.updateUserById(..., { email, email_confirm: true })`) | **Sim** — o operador responde pela identidade, e o caso de uso principal é justamente "o cliente perdeu acesso ao e-mail antigo" | Mandar link de confirmação ao e-mail novo: reintroduz exatamente o bloqueio que motiva a funcionalidade, e o link pode cair num scanner de e-mail (o problema da SPEC 053) |
| **D-11** | Aviso informativo ao **e-mail antigo** depois da troca, via SMTP do sistema (SPEC 063), sem bloquear a operação | **Sim, em fase própria (F6) que pode ser cortada** | Nenhum aviso: troca de e-mail é a forma clássica de tomada de conta; o titular antigo precisa ter como perceber |
| **D-12** | As três ações aparecem no **Registro de atividade** do cliente (SPEC 075) e disparam **webhook de saída** | **Sim**: `plan.renewed` (já existe) também para pagamento manual, com campo `source`; evento novo `plan.period_changed` | Esconder do cliente: a conta vê o vencimento mudar sem explicação; integrações que provisionam acesso por vencimento ficam desatualizadas |

---

## 3. Funcionalidade 1 — Alterar a data de vencimento

### 3.1. Regras

1. Conta precisa ter linha em `account_plans` (invariante da 067) — senão `404`.
2. Plano atual precisa ter ciclo (D-1) — senão `400 no_billing_cycle`. O botão aparece **desabilitado** com o motivo no `title`.
3. Data entre hoje e hoje + 3 anos, no calendário de São Paulo (D-3) — senão `400 period_end_out_of_range`.
4. `billing_cycle` opcional; omitido mantém o atual (D-4).
5. Efeitos sobre a linha, **numa transação com a linha travada** (`FOR UPDATE`):

| Coluna | Efeito |
| --- | --- |
| `current_period_end` | `(data + 23:59:59) AT TIME ZONE 'America/Sao_Paulo'` (D-2) |
| `billing_cycle` | O novo, quando informado |
| `status` | `past_due` → `active` (D-5); qualquer outro status fica como está |
| `grace_until` | Limpo quando saiu de `past_due` |
| `started_at` | **Intocado** — é a data de adesão, não do período |
| `cancel_at_period_end` | **Intocado** — o cancelamento agendado acompanha a nova data; a UI avisa |
| `updated_by` / `updated_at` | `console:<email>` / `now()` |

6. **Não** grava `account_plan_payments`: mudar a data **não** é pagamento. O histórico de pagamentos só registra dinheiro que entrou (§4).

### 3.2. Por que uma função no banco e não um `UPDATE` pelo `supabase-js`

Três coisas precisam acontecer juntas: ler o vencimento **anterior** (para a auditoria e para decidir `past_due` → `active`), validar a faixa de datas no fuso certo e gravar. Com `select` + `update` pelo TypeScript, uma renovação de `apply_plan_renewal` chegando entre os dois passos (ela trava a linha com `FOR UPDATE`) teria seu avanço sobrescrito e a auditoria registraria um "valor anterior" que já não era o anterior. Mesmo raciocínio que levou a 071 a mover a renovação para dentro do banco.

### 3.3. Corrida com o cron de ciclo de vida — ajuste em `lifecycle.ts`

`src/lib/plans/lifecycle.ts` lê o lote de `account_plans` e, por conta, faz `UPDATE … SET status = 'past_due'` **sem** checar se o vencimento mudou depois da leitura. Se o operador empurrar a data entre a leitura e a escrita do cron, a conta cai em `past_due` com vencimento futuro.

Correção (concorrência otimista, sem lock longo no cron): os dois `update` de `lifecycle.ts` (rebaixamento por cancelamento e `past_due`) ganham `.eq('current_period_end', row.current_period_end)`. Zero linhas afetadas = alguém mexeu na conta; o cron **pula** e a próxima corrida reavalia com o valor novo. Teste em `lifecycle.test.ts`: update que não afeta linha não emite evento nem grava `account_plan_events`.

---

## 4. Funcionalidade 2 — Marcar pagamento manual

### 4.1. O que o operador informa

| Campo | Obrigatório | Regra |
| --- | --- | --- |
| Data do pagamento | sim | Padrão hoje; entre hoje − 365 dias e hoje (não aceita futuro) |
| Períodos pagos | sim | Inteiro 1–12, padrão 1. Avança **ciclos do `billing_cycle` atual** (mensal = meses, anual = anos) — a UI mostra "1 período = 1 ano" quando anual |
| Forma | sim | `pix` · `boleto` · `card` · `transfer` · `cash` · `other` (D-7) |
| Valor (R$) | não | Centavos ≥ 0, só registro (D-7) |
| Identificador do pagamento | não | ID Pix (E2E), nº do boleto, nota fiscal… (§4.2) |
| Observação | não | Até 500 caracteres |

O diálogo mostra, **antes de confirmar**, o vencimento atual → o vencimento resultante, calculado com o mesmo `advancePeriod()` de `src/lib/plans/billing.ts` a partir do **vencimento atual, não de hoje** (SPEC 062 §6.2 passo 2 — renovar atrasado não pode encurtar o período do cliente).

### 4.2. Idempotência — o `paymentRef`

`account_plan_payments.payment_ref` é `UNIQUE` (071) e é a fonte de verdade de "esse pagamento já foi aplicado". Duas regras:

1. **Identificador informado → vira o `payment_ref` literal, sem prefixo.** Se o sistema externo de cobrança também chamar `/billing/renew` com o mesmo ID Pix, a segunda aplicação bate na constraint e responde `already_applied`. Prefixar (`manual:E2E…`) criaria duas chaves diferentes para o mesmo dinheiro — e o vencimento avançaria duas vezes.
2. **Sem identificador → `console:<uuid>`, gerado quando o diálogo abre** (não no clique). Clique duplo, retentativa por rede lenta ou F5 no meio enviam o **mesmo** `uuid`, e a constraint absorve. Gerar no clique tornaria cada clique um pagamento novo.

A resposta `already_applied` vira um `toast` neutro ("este pagamento já estava registrado"), não erro.

### 4.3. Efeitos — `apply_plan_renewal` ampliada (D-6, D-8)

Mesma função da 071, com parâmetros novos todos `DEFAULT NULL` (a rota `/api/admin/.../billing/renew` continua funcionando sem mudança de contrato):

| Parâmetro novo | Uso |
| --- | --- |
| `p_actor TEXT` | Vai para `account_plans.updated_by` e `account_plan_payments.recorded_by`. Hoje está fixo `'api:billing-renew'` dentro da função; `NULL` mantém esse valor |
| `p_method TEXT` | Forma (D-7) |
| `p_amount_cents INTEGER` | Valor (D-7) |

E duas mudanças de comportamento:

- **`trialing` também vira `active`** (D-8), além de `past_due`.
- A linha de `account_plan_payments` passa a guardar **`previous_status`** e **`previous_grace_until`** — sem eles o estorno (§4.5) não sabe para onde voltar.

Pagamento **não desbloqueia** a conta: bloqueio é decisão manual (PRD 061 D-7). Se a conta estiver bloqueada, o `toast` de sucesso traz o aviso "a conta continua bloqueada" com link para o switch.

Pagamento **não** remove cancelamento agendado (`cancel_at_period_end`): um cliente pode pagar o último mês antes de sair. A UI mostra o aviso no diálogo quando o cancelamento está agendado.

### 4.4. Histórico de pagamentos na tela

Card novo **"Pagamentos"** em `/admin/accounts/[accountId]`, logo abaixo de "Plano": os 20 últimos de `account_plan_payments` — data, forma, valor, períodos, vencimento anterior → novo, quem registrou (`console:…` ou `api:billing-renew`), identificador, observação, e o selo **"Estornado em …"** quando for o caso.

### 4.5. Desfazer (estorno) — D-9

`reverse_plan_payment(p_payment_id, p_actor, p_reason)`, com a linha de `account_plans` travada:

1. O pagamento precisa ser o **último não estornado** da conta — senão `409 payment_not_latest`. Estornar um do meio exigiria recalcular toda a cadeia posterior; o operador estorna do mais novo para o mais antigo.
2. `account_plans.current_period_end` precisa ser **igual** ao `new_period_end` que esse pagamento gravou — senão `409 period_changed_since_payment`. Se alguém alterou o vencimento à mão depois, "voltar ao anterior" desfaria também essa outra mudança sem ninguém ver.
3. Restaura `current_period_end = previous_period_end`, `status = previous_status`, `grace_until = previous_grace_until`.
4. **Marca** a linha (`reversed_at`, `reversed_by`, `reversal_reason`) — nunca apaga. O `payment_ref` continua ocupado de propósito: se o sistema externo reenviar aquele pagamento, ele **não** é reaplicado. Pagamento registrado na conta errada é estornado e lançado de novo na conta certa **com outro identificador** (a UI explica isso no diálogo de estorno).
5. Pagamentos gravados antes da 089 (sem `previous_status`) **não** são estornáveis — botão desabilitado com o motivo. Não há como saber para que status voltar.

O estorno não emite webhook de saída (o cliente nunca foi "desrenovado" pelo sistema dele); entra no registro de atividade como `plan.payment_reversed`.

---

## 5. Funcionalidade 3 — Editar nome e e-mail de usuários (inclusive `owner`)

### 5.1. Onde vive cada dado

| Dado | Fonte de verdade | Cópias que precisam acompanhar |
| --- | --- | --- |
| Nome | `profiles.full_name` | `auth.users.raw_user_meta_data.full_name` (só lida no cadastro por `handle_new_user`, mas é o que o painel do Supabase mostra) |
| E-mail | `auth.users.email` (é o login) | `profiles.email` — **sincronizada pelo trigger novo da 089** (§6.1) |

`accounts.name` **não** muda junto: ele nasce do nome do dono no cadastro (017), mas depois é o nome da empresa. Trocar o nome da Ana não pode renomear a "Beta Comércio".

### 5.2. Guardas — o que o console recusa, com `400` e código estável

| Código | Situação | Por quê |
| --- | --- | --- |
| `name_invalid` | Nome vazio após `trim`, > 120 caracteres ou com caractere de controle | Nome aparece no inbox, no PDF de exportação (SPEC 067) e em e-mails |
| `email_invalid` | Não passa no mesmo `EMAIL_RE` de `profile-form.tsx` (extrair para `src/lib/auth/email.ts` e reusar nos dois) | Uma regra só de "e-mail válido" no app |
| `email_unchanged` | Novo e-mail = atual (normalizado: `trim` + `toLowerCase`) | Evita gravação e auditoria vazias |
| `email_taken` | Supabase Auth recusa por e-mail já cadastrado (mapear o erro `email_exists`/422 do GoTrue) → **`409`** | Login é único por banco |
| `cannot_edit_platform_owner_email` | O usuário-alvo tem e-mail em `PLATFORM_OWNER_EMAILS` | Trocar o e-mail do proprietário pela tela tira ele do console no clique seguinte (a guarda da SPEC 062 §2.2 compara a lista do `.env`). O caminho é editar o `.env` primeiro, redeploy, e só então trocar — documentado no guia |
| `email_reserved_for_platform_owner` | O **novo** e-mail está em `PLATFORM_OWNER_EMAILS` | **Escalonamento de privilégio:** se o proprietário não tem usuário neste banco, dar o e-mail dele a um cliente daria ao cliente o console inteiro assim que confirmasse o login |

O **nome** do proprietário pode ser editado normalmente — só o e-mail dele é protegido.

Editar o **dono da conta** é permitido sem tratamento especial (é o pedido explícito desta SPEC); a UI só destaca no diálogo "este é o dono da conta — o novo e-mail passa a ser o login dele imediatamente". Usuário **bloqueado** também pode ser editado (é comum: credencial comprometida → bloqueia → corrige o e-mail → desbloqueia).

### 5.3. Ordem das escritas e falha parcial

`PATCH /api/platform/users/[userId]` com `{ fullName?, email?, reason? }`:

1. Guardas da §5.2 (puras, sem I/O além de ler o perfil-alvo).
2. **E-mail primeiro**, se veio: `auth.admin.updateUserById(userId, { email, email_confirm: true })`. É a escrita que pode falhar por regra de negócio (`email_taken`); se falhar, nada foi gravado.
3. **Nome depois**, se veio: `profiles.full_name` + `auth.admin.updateUserById(userId, { user_metadata: { full_name } })`.
4. Se o passo 3 falhar depois do 2 ter dado certo → `500 { error, code: 'partial_update', emailUpdated: true }`. A UI recarrega e mostra o que de fato ficou gravado. (Não há transação entre Auth e Postgres; ordenar pela escrita mais provável de falhar é o que minimiza o estado parcial.)
5. `platform_audit_log` com `action = 'user.profile_update'`, `target_user_id`, `payload = { fields: ['email','fullName'], previousEmail, newEmail, previousName, newName, reason }`.

### 5.4. Sessões abertas

Trocar o e-mail **não** derruba as sessões do usuário: a senha não mudou, e o JWT carrega o e-mail antigo só até o próximo refresh (≤ 1 h). Derrubar sessão por `user_id` exigiria função `SECURITY DEFINER` mexendo em `auth.sessions`/`auth.refresh_tokens` — superfície nova sobre o schema do Auth, fora do escopo. Para o caso "credencial comprometida", o caminho continua sendo **bloquear o usuário** (SPEC 062 §4.4), que corta o acesso pela RLS na hora.

### 5.5. Aviso ao e-mail antigo (D-11, F6 — cortável)

Depois de trocar o e-mail com sucesso, um e-mail curto e neutro para o endereço **antigo**: "o e-mail de acesso da sua conta no {produto} foi alterado pelo suporte em {data}. Se você não reconhece esta alteração, responda para {support_email}." Sem o endereço novo no corpo.

Hoje o mailer da SPEC 063 (`src/lib/mailer/send.ts`) envia sempre para `config.to` (o operador). A F6 acrescenta um envio direto com destinatário explícito, reaproveitando transporte e template; SMTP não configurado = `console.warn` e segue (a troca **nunca** falha por causa do aviso).

---

## 6. Migração `089_console_billing_and_identity.sql`

Idempotente (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF EXISTS`), com bloco de asserções finais que falha alto, no padrão das 069/071.

### 6.1. Sincronização `auth.users.email` → `profiles.email` (§1.1)

```sql
CREATE OR REPLACE FUNCTION public.sync_profile_email()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.profiles SET email = NEW.email WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sync_profile_email() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_auth_user_email_updated ON auth.users;
CREATE TRIGGER on_auth_user_email_updated
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW WHEN (NEW.email IS DISTINCT FROM OLD.email)
  EXECUTE FUNCTION public.sync_profile_email();

-- Backfill: conserta qualquer divergência que já exista (no vn eram 0 em 2026-10-08).
UPDATE public.profiles p SET email = u.email
  FROM auth.users u
 WHERE u.id = p.user_id AND p.email IS DISTINCT FROM u.email;
```

- Dispara também no autosserviço: o GoTrue só grava `auth.users.email` **depois** da confirmação, então `profiles.email` muda exatamente quando o login muda — nem antes, nem nunca.
- O `UPDATE` em `profiles` passa pelo trigger `enforce_profile_privilege_columns` (034) sem problema: ele só barra `account_role`/`account_id`.
- Corrigir o comentário de `profile-form.tsx` na mesma fase — ele passa a ser verdade.

### 6.2. `account_plan_payments` — colunas novas

```sql
ALTER TABLE account_plan_payments
  ADD COLUMN IF NOT EXISTS method TEXT
    CHECK (method IS NULL OR method IN ('pix','boleto','card','transfer','cash','other')),
  ADD COLUMN IF NOT EXISTS amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS recorded_by TEXT,
  ADD COLUMN IF NOT EXISTS previous_status TEXT,
  ADD COLUMN IF NOT EXISTS previous_grace_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by TEXT,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

UPDATE account_plan_payments SET recorded_by = 'api:billing-renew' WHERE recorded_by IS NULL;
```

Tudo `NULL`-ável: as linhas antigas continuam válidas, e `previous_status IS NULL` é justamente o que marca "não estornável" (§4.5 item 5). RLS segue ligada com **zero policies** (071).

### 6.3. `apply_plan_renewal` v2

Assinatura nova = função nova para o Postgres. Por isso **`DROP FUNCTION` da assinatura antiga (6 parâmetros) antes do `CREATE`** — senão as duas versões coexistem como sobrecarga e a chamada por parâmetros nomeados do `supabase-js` fica ambígua.

```sql
DROP FUNCTION IF EXISTS public.apply_plan_renewal(UUID, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.apply_plan_renewal(
  p_account_id UUID, p_payment_ref TEXT, p_paid_at TIMESTAMPTZ, p_periods INTEGER,
  p_external_ref TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL,
  p_actor TEXT DEFAULT NULL, p_method TEXT DEFAULT NULL, p_amount_cents INTEGER DEFAULT NULL
) RETURNS TABLE (applied BOOLEAN, current_period_end TIMESTAMPTZ, status TEXT) …
```

Corpo idêntico ao da 071, com: `previous_status`/`previous_grace_until`/`method`/`amount_cents`/`recorded_by` no `INSERT` do log; `updated_by = COALESCE(p_actor, 'api:billing-renew')`; e a condição de reativação passando a `v_account.status IN ('past_due','trialing')` (D-8). Repetir `OWNER TO postgres`, `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`.

### 6.4. `set_plan_period_end` (funcionalidade 1)

```sql
CREATE OR REPLACE FUNCTION public.set_plan_period_end(
  p_account_id UUID, p_date DATE, p_billing_cycle TEXT DEFAULT NULL, p_actor TEXT DEFAULT NULL
) RETURNS TABLE (
  previous_period_end TIMESTAMPTZ, new_period_end TIMESTAMPTZ,
  previous_status TEXT, new_status TEXT, billing_cycle TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ … $$;
```

Sequência: valida `p_billing_cycle IN ('monthly','yearly')` quando informado → `SELECT … FOR UPDATE` em `account_plans` (`ACCOUNT_NOT_FOUND`) → `billing_period`/`price_cents` do plano (`NO_BILLING_CYCLE`, D-1) → `v_today := (now() AT TIME ZONE 'America/Sao_Paulo')::date`; recusa `p_date < v_today` ou `p_date > v_today + INTERVAL '3 years'` com `PERIOD_END_OUT_OF_RANGE` (D-3) → grava conforme a tabela da §3.1, com `current_period_end = (p_date + TIME '23:59:59') AT TIME ZONE 'America/Sao_Paulo'` (D-2).

Erros de negócio sinalizados pelo **texto** da exceção (`ACCOUNT_NOT_FOUND`, `NO_BILLING_CYCLE`, `PERIOD_END_OUT_OF_RANGE`), no mesmo padrão de `billing-renew.ts` — o PostgREST só expõe `.message`.

### 6.5. `reverse_plan_payment` (§4.5)

```sql
CREATE OR REPLACE FUNCTION public.reverse_plan_payment(
  p_payment_id UUID, p_actor TEXT, p_reason TEXT DEFAULT NULL
) RETURNS TABLE (restored_period_end TIMESTAMPTZ, restored_status TEXT) …
```

Erros: `PAYMENT_NOT_FOUND`, `PAYMENT_ALREADY_REVERSED`, `PAYMENT_NOT_REVERSIBLE` (sem `previous_status`), `PAYMENT_NOT_LATEST`, `PERIOD_CHANGED_SINCE_PAYMENT`.

### 6.6. Asserções finais

- trigger `on_auth_user_email_updated` existe em `auth.users`; `sync_profile_email` é `SECURITY DEFINER` e pertence a `postgres`;
- **zero** perfis com `email` divergente de `auth.users.email` depois do backfill;
- existe **exatamente uma** `apply_plan_renewal` (a de 9 parâmetros) — nenhuma sobrecarga sobrou;
- `apply_plan_renewal`, `set_plan_period_end` e `reverse_plan_payment`: `SECURITY DEFINER`, dono `postgres`, **sem** `EXECUTE` para `anon`/`authenticated`;
- `account_plan_payments`: RLS ligada, zero policies, constraint `account_plan_payments_ref_unique` intacta;
- nenhuma linha antiga de `account_plan_payments` com `recorded_by` nulo.

> ⚠️ Pela regra do `AGENTS.md`, a 089 só é aplicada **depois de confirmar com o mantenedor**, projeto por projeto (`vn`, `rs`).

---

## 7. Núcleo TypeScript

Puro onde dá, com teste co-locado — padrão de `src/lib/plans/` e `src/lib/platform/`.

| Arquivo | Conteúdo |
| --- | --- |
| `src/lib/plans/manual-billing.ts` | **Puro.** `validatePeriodEndInput({ date, billingCycle, todaySp })`, `validateManualPaymentInput({ paidAt, periods, method, amountCents, paymentRef, note, todaySp })`, `previewManualPayment(currentPeriodEnd, cycle, periods, now)` (usa `advancePeriod`), `newConsolePaymentRef(uuid)` → `console:<uuid>`, `PAYMENT_METHODS` |
| `src/lib/plans/period-end.ts` | `setPlanPeriodEnd(db, input)` → RPC `set_plan_period_end`, tradução dos erros por texto (espelha `billing-renew.ts`) |
| `src/lib/plans/billing-renew.ts` | `RenewInput` ganha `actor?`, `method?`, `amountCents?`; repassa à RPC. **Sem mudança** de comportamento para quem não passa os campos |
| `src/lib/plans/payment-reversal.ts` | `reversePlanPayment(db, input)` → RPC, mapeia os 5 erros |
| `src/lib/plans/payments.ts` | `listAccountPayments(db, accountId, limit = 20)` — leitura para o card (§4.4) |
| `src/lib/auth/email.ts` | `EMAIL_RE` + `normalizeEmail()` extraídos de `profile-form.tsx` (que passa a importar daqui) |
| `src/lib/platform/user-identity.ts` | **Puro.** `validateFullName()`, `canEditUserIdentity({ ownerEmails, targetCurrentEmail, nextEmail })` → códigos da §5.2 |
| `src/lib/platform/user-identity-actions.ts` | **Server-only.** `updateUserIdentity(db, input)` — a ordem da §5.3, mapeia `email_exists` → `email_taken` |
| `src/lib/plans/lifecycle.ts` | Concorrência otimista da §3.3 |

**Testes obrigatórios:**

- `manual-billing.test.ts`: data de hoje aceita, ontem recusada, hoje + 3 anos aceita e + 3 anos + 1 dia recusada (D-3); `paidAt` futuro recusado; `periods` 0, 13 e 1,5 recusados; método fora da lista recusado; valor negativo recusado; prévia mensal sobre **31/01 → 28/02** e anual sobre **29/02** (as armadilhas da SPEC 062 §5.1, de novo); prévia parte do vencimento atual e não de hoje; vencimento nulo → base hoje.
- `user-identity.test.ts`: nome só com espaços, 121 caracteres, com `\u0000`; e-mail do alvo na lista do proprietário (com caixa e espaço diferentes) → `cannot_edit_platform_owner_email`; e-mail **novo** na lista → `email_reserved_for_platform_owner`; `dono@exemplo.com.br` **não** casa com `dono@exemplo.com` (mesma armadilha do `owner.test.ts`); mesmo e-mail com caixa diferente → `email_unchanged`.
- `user-identity-actions.test.ts` (com `db` falso): falha do e-mail não chama a escrita do nome; falha do nome depois do e-mail devolve `partial_update` com `emailUpdated: true`.
- `lifecycle.test.ts`: update com zero linhas não emite evento.
- `billing-renew.test.ts`: os campos novos chegam à RPC com os nomes certos (`p_actor`, `p_method`, `p_amount_cents`).

---

## 8. Rotas de API

Todas em `/api/platform/**`: `requirePlatformOwner()` (qualquer falha → **404**, SPEC 062 §2.4), `supabaseAdmin()`, `platform_audit_log`. Mensagens de erro em **inglês** com `code` estável; a UI traduz pelo `code`.

| Rota | Método | Corpo | Auditoria (`action`) |
| --- | --- | --- | --- |
| `/api/platform/accounts/[accountId]/billing/period-end` | PUT | `{ date: 'YYYY-MM-DD', billingCycle?, reason? }` | `billing.period_end.set` — payload com anterior/novo vencimento, status e ciclo |
| `/api/platform/accounts/[accountId]/billing/payments` | GET | — | — |
| `/api/platform/accounts/[accountId]/billing/payments` | POST | `{ paymentRef?, paidAt, periods, method, amountCents?, note? }` | `billing.payment.manual` |
| `/api/platform/accounts/[accountId]/billing/payments/[paymentId]/reverse` | POST | `{ reason? }` | `billing.payment.reverse` |
| `/api/platform/users/[userId]` | PATCH | `{ fullName?, email?, reason? }` | `user.profile_update` |

`PlatformAuditAction` (`src/lib/platform/audit.ts`) ganha as quatro ações novas.

No `POST …/payments`, quando `paymentRef` não vem, a rota recusa com `400 payment_ref_required` — quem gera `console:<uuid>` é o **diálogo ao abrir** (§4.2). Gerar na rota destruiria a idempotência contra clique duplo.

O `actor` de toda chamada é `consoleActorTag(ownerEmail)` (`console:<email>`) — é o que separa no histórico de pagamentos "registrei à mão" de "o sistema externo renovou" (`api:billing-renew`).

**A rota de máquina `/api/admin/accounts/{id}/billing/renew` não muda de contrato.** Só passa a herdar o D-8 (`trialing` → `active`) por ser a mesma função — registrar isso na prosa de `docs/public-api.md`, já que a seção de webhooks documenta o efeito.

### 8.1. Efeitos colaterais por ação

| Ação | Registro de atividade (SPEC 075) | Webhook de saída | Evento do sistema (SPEC 063) |
| --- | --- | --- | --- |
| Alterar vencimento | `plan.period_changed` (novo) | `plan.period_changed` (novo) — `{ previousPeriodEnd, currentPeriodEnd, billingCycle, status }` | — |
| Pagamento manual aplicado | `plan.renewed` (já existe), `metadata.source = 'console'` | `plan.renewed` (já existe) + campo novo `source: 'console' \| 'api'` | `plan.renewed` (já existe) |
| Pagamento já aplicado | — | — | — |
| Estorno | `plan.payment_reversed` (novo) | — (§4.5) | — |
| Editar nome/e-mail | `member.profile_updated` (novo) — **sem** os endereços no `metadata`, só quais campos mudaram | — | — |

Ator no registro de atividade: `{ kind: 'system', name: 'platform' }`, e o `feed.ts` ganha o rótulo i18n "Suporte da plataforma" para `name = 'platform'` — o cliente vê que a mudança veio do fornecedor, não de um colega.

Ações novas entram em `ACTIVITY_CATALOG` (`src/lib/activity/types.ts`) e nas chaves i18n do feed; `messages-icu.test.ts` já protege a sintaxe ICU delas.

---

## 9. Interface do console

Padrão visual da SPEC 062 §7 (`Card`, `Alert`, `Dialog`, `toast` do `sonner`, `Loader2`).

### 9.1. `/admin/accounts/[accountId]` — card "Plano"

Dois botões novos ao lado de "Trocar plano":

- **Alterar vencimento** → `change-period-end-dialog.tsx`: seletor de data (mínimo hoje, máximo + 3 anos), seletor de ciclo, motivo opcional. Mostra "vencimento atual → novo" e, quando for o caso: `Alert` "a conta sairá de *em atraso* para *ativa*" (D-5) e "há cancelamento agendado; ele passa a valer na nova data". Desabilitado com `title` quando o plano não tem ciclo (D-1).
- **Registrar pagamento** → `record-payment-dialog.tsx`: campos da §4.1, `paymentRef` gerado ao abrir (§4.2), prévia do vencimento resultante, avisos de conta bloqueada e de cancelamento agendado (§4.3). Mesma regra de desabilitação.

### 9.2. Card "Pagamentos" (novo, §4.4)

Tabela com os 20 últimos; ação **Desfazer** só na linha elegível (§4.5), com diálogo de confirmação, motivo opcional e o texto "o identificador continuará ocupado; para lançar em outra conta, use outro identificador". Linhas antigas sem `previous_status`: botão desabilitado com o motivo.

### 9.3. Card "Membros"

Coluna nova com botão de ícone **Editar** (lápis) → `edit-user-identity-dialog.tsx`: nome, e-mail, motivo. Avisos no diálogo: dono da conta (§5.2), "o novo e-mail passa a ser o login imediatamente, sem confirmação" (D-10), e "as sessões abertas continuam ativas; para cortar acesso, bloqueie o usuário" (§5.4). Campo de e-mail **somente leitura** com explicação quando o alvo é o proprietário da plataforma.

### 9.4. Card "Histórico"

Passa a intercalar por data `account_plan_events` **e** as linhas de `platform_audit_log` desta conta com as ações novas (`billing.*`, `user.profile_update`) — a SPEC 062 §7.3 já previa os dois intercalados, e a rota de detalhe hoje só devolve o primeiro. `GET /api/platform/accounts/[accountId]` ganha `auditEvents` (últimos 50).

### 9.5. i18n

Chaves novas em `messages/en.json` (fonte) e espelho em `messages/pt-BR.json`: `Platform.periodEnd.*`, `Platform.payments.*` (inclusive os seis métodos), `Platform.userIdentity.*`, os códigos de erro da §5.2/§6, e os rótulos do feed (`Activity.*`) para as ações novas e o ator "Suporte da plataforma". `npm run i18n:check` no gate de toda fase que toca UI.

---

## 10. Impacto na API pública e nos webhooks

Mudança de contrato de **webhook de saída** — a regra do `AGENTS.md` vale integralmente: `docs/public-api.md`, `public/openapi.json` e `public/openapi.pt-BR.json` na mesma alteração, `npx @redocly/cli lint` nos dois JSON e conferência de paridade estrutural.

1. `src/lib/webhooks/events.ts`: evento novo `plan.period_changed` em `WEBHOOK_EVENTS` + `WEBHOOK_EVENT_DESCRIPTIONS`; descrição de `plan.renewed` passa de "An external payment…" para "A payment (external system or platform console) renewed the account plan period".
2. Payload de `plan.renewed` ganha `source` (`'api' | 'console'`). Campo **adicionado**, não alterado — integrações existentes não quebram.
3. Prosa de `/billing/renew` registra o D-8 (`trialing` também reativa).
4. `GET /api/v1/me`: **sem mudança** — `currentPeriodEnd`/`billingCycle` já são expostos (SPEC 062 §9) e passam a refletir as edições naturalmente.

---

## 11. Fases

| Fase | Entrega | Pronto quando | Modelo sugerido |
| --- | --- | --- | --- |
| **F1** | Migração 089 (§6) + correção do comentário de `profile-form.tsx` | Asserções passam no `vn`; troca de e-mail pelo perfil atualiza `profiles.email` após a confirmação; `/billing/renew` antigo responde igual | **Opus** — concorrência e `SECURITY DEFINER` |
| **F2** | Núcleo TS (§7) + `lifecycle.ts` otimista + testes | `npm run test` verde com todos os casos da §7 | Sonnet |
| **F3** | Rotas da §8 + auditoria + atividade + webhooks (§8.1) | `curl` com sessão de não-proprietário → 404 em todas; pagamento duplicado → `already_applied` | Sonnet |
| **F4** | UI da §9 + i18n | Os três diálogos e o card de pagamentos funcionando; `i18n:check` verde | Sonnet |
| **F5** | Docs: §10 (três arquivos + lint + paridade), `guia-console-do-proprietario.md` (seções novas + "como trocar o e-mail do proprietário"), `guia-operacao-planos-e-quotas.md` (vencimento deixa de ser SQL) | `redocly lint` verde nos dois JSON; guia sem instrução de SQL para vencimento | Sonnet |
| **F6** | Aviso ao e-mail antigo (§5.5, D-11) — **cortável** | Troca com SMTP configurado entrega o aviso; sem SMTP, a troca funciona igual | Sonnet |
| **F7** | Teste manual (§13), roteiro em `docs/spec-078-teste-manual.md` | Todos os itens verificados contra banco real | Humano (Bruno) |

Gate de toda fase (sem CI no repositório):

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

---

## 12. Armadilhas específicas desta SPEC

| Sintoma | Causa provável |
| --- | --- |
| `/billing/renew` passou a responder 500 depois da 089 | Sobrecarga de `apply_plan_renewal` (a assinatura antiga não foi dropada) — a asserção de "exatamente uma" pega |
| Vencimento caiu um dia antes na tela | Data convertida no TypeScript/servidor UTC em vez de `AT TIME ZONE 'America/Sao_Paulo'` no banco (D-2) |
| Empurrei o vencimento e a conta virou "em atraso" minutos depois | `lifecycle.ts` sem o `.eq('current_period_end', …)` da §3.3 |
| Pagamento manual avançou 1 mês num cliente anual | `billing_cycle` ainda `'monthly'` — ajustar o ciclo pelo diálogo de vencimento (D-4) antes de registrar |
| Mesmo Pix aplicado duas vezes (console + sistema externo) | Identificador prefixado na rota (`manual:…`) em vez de usado literalmente (§4.2) |
| Clique duplo registrou dois pagamentos | `console:<uuid>` gerado no clique ou na rota, não ao abrir o diálogo (§4.2) |
| "Desfazer" não aparece num pagamento antigo | Esperado: linhas anteriores à 089 não têm `previous_status` (§4.5 item 5) |
| Troquei o e-mail e a lista de membros mostra o antigo | Trigger `on_auth_user_email_updated` ausente — a 089 não foi aplicada naquele projeto |
| Proprietário perdeu o console depois de editar o próprio e-mail | Guarda `cannot_edit_platform_owner_email` faltando na rota (§5.2). Saída: incluir o e-mail novo em `PLATFORM_OWNER_EMAILS` e redeploy |
| Cliente ganhou acesso ao `/admin` | Guarda `email_reserved_for_platform_owner` faltando (§5.2) — **incidente de segurança**: remover o e-mail do usuário, revisar `platform_audit_log` |
| Usuário com e-mail novo não consegue redefinir senha | Conferir na F7 que o GoTrue atualizou também `auth.identities` do provedor `email`; se não, a troca precisa ir pela identidade |
| Tela quebrada só em pt-BR | Chave nova em um dicionário só — `npm run i18n:check` |

---

## 13. Teste manual (F7) — contra banco real

1. **Vencimento — caminho feliz:** conta Essencial mensal, vencimento 10/11 → alterar para 20/12 → detalhe mostra 20/12; `SELECT current_period_end` = `2026-12-20 23:59:59-03`; `platform_audit_log` com anterior/novo.
2. **Vencimento — faixa:** ontem e hoje + 3 anos + 1 dia → recusados na UI **e** via `curl` (`period_end_out_of_range`).
3. **Vencimento — sem ciclo:** conta no Grátis/`unlimited` → botão desabilitado; `curl` → `400 no_billing_cycle`.
4. **Vencimento — reativação:** conta `past_due` com `grace_until` → nova data futura → `active`, `grace_until` nulo.
5. **Vencimento — ciclo:** trocar para anual → registrar 1 período → vencimento avança **1 ano**.
6. **Pagamento — caminho feliz:** Pix com E2E informado → vencimento avança 1 ciclo **a partir do vencimento atual**; linha em `account_plan_payments` com `method='pix'`, `recorded_by='console:…'`, `previous_status`; webhook `plan.renewed` com `source='console'`; item no `/activity` do cliente.
7. **Pagamento — idempotência:** repetir o mesmo E2E pelo console **e** via `/api/admin/.../billing/renew` → as duas respostas `already_applied`, vencimento avançou uma vez só. Clique duplo sem identificador → um pagamento.
8. **Pagamento — trial:** conta `trialing` → pagamento → `active` (D-8).
9. **Pagamento — conta bloqueada:** continua bloqueada; aviso no `toast`.
10. **Estorno:** desfazer o último → vencimento, status e carência voltam; linha marcada, não apagada; desfazer o penúltimo antes do último → `payment_not_latest`; alterar o vencimento à mão e tentar desfazer → `period_changed_since_payment`.
11. **Nome:** editar nome de um agente → aparece no inbox/atribuição; `accounts.name` **não** mudou.
12. **E-mail de membro:** trocar → login com o e-mail novo + senha antiga funciona **imediatamente**; o antigo não loga mais; `profiles.email` atualizado pelo trigger; redefinição de senha pelo e-mail novo funciona.
13. **E-mail do dono da conta:** mesmo resultado do item 12, com o aviso de "dono" exibido.
14. **E-mail duplicado:** e-mail de outro usuário → `409 email_taken`, nada gravado (nem o nome enviado junto).
15. **Guardas do proprietário:** editar e-mail do próprio proprietário → recusado; dar a um cliente um e-mail da lista `PLATFORM_OWNER_EMAILS` → recusado.
16. **Autosserviço consertado:** usuário troca o próprio e-mail pelo perfil e confirma → `profiles.email` acompanha sem intervenção (§1.1).
17. **Porta fechada:** as cinco rotas da §8 com sessão de usuário comum → **404**.
18. **(F6)** Aviso chega ao e-mail antigo, sem o endereço novo no corpo.

---

## 14. Deixado para depois

- **Rota de máquina para vencimento** (`PUT /api/admin/accounts/{id}/billing/period-end`) — o núcleo (`period-end.ts`) já serve às duas portas; só falta a rota quando uma automação precisar.
- **Derrubar sessões de um usuário pelo console** (§5.4) — exige função sobre `auth.sessions`/`auth.refresh_tokens`; hoje o bloqueio cobre o caso de risco.
- **Editar o nome da conta (`accounts.name`) pelo console** — pedido natural em seguida, fora do escopo pedido.
- **Estorno fora de ordem / recálculo da cadeia de pagamentos** (§4.5 item 1).
- **Relatórios de recebimento** a partir de `method`/`amount_cents` — só quando houver conciliação de verdade (SPEC 062 §14, gateway).
