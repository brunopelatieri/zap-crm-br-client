# SPEC 062 — Teste manual (F10)

Checklist executável do [§12 da SPEC 062](./spec-062-console-do-proprietario.md#12-teste-manual-f10--o-que-precisa-ser-verificado-contra-banco-real), no formato do [`docs/spec-056-teste-manual.md`](./spec-056-teste-manual.md). Não é um documento novo de decisão — é o §12 desdobrado em passo a passo, com o SQL/`curl` de conferência pronto para colar.

> **Ainda não executado.** F1–F9 estão implementadas e com suíte automatizada 100% verde (ver `docs/spec-062-console-do-proprietario.md` §10 e a memória do projeto), mas os 16 itens abaixo envolvem sessão real, RLS ou dinheiro — nenhum é verificável por teste unitário (§12). Rodar isto exige um navegador com login real do mantenedor, o que não estava disponível nas sessões que implementaram F1–F9. Marque cada item ao rodar de verdade; não preencha resultado sem ter rodado.
>
> Itens **1–3** têm a lógica subjacente já coberta por `src/lib/platform/owner.test.ts` (as quatro condições da guarda, normalização de e-mail, subdomínio que não casa) — a parte que falta aqui é confirmar o **efeito HTTP de ponta a ponta** (o 404 de verdade, numa sessão de navegador de verdade), não a lógica em si.

---

## 0. Preparação

Feito uma vez, antes dos 16 itens abaixo. **Nunca contra dado real de cliente** — use contas descartáveis, e reverta qualquer estado de teste ao final de cada item (cada item abaixo já tem seu próprio "reverter" quando aplica).

- [ ] **`PLATFORM_OWNER_EMAILS`** configurada no servidor que você vai testar, com o e-mail da sua própria sessão (`brunopelatieri@gmail.com` ou o e-mail que você usa para logar). Se for testar local (`npm run dev`) e a variável ainda não estiver em `.env.local`:

  ```bash
  # .env.local — TEMPORÁRIO, para este teste. Remova de novo ao final
  # (grep por "TEMPORÁRIO" em .env.local antes de começar, pra ver se
  # sobrou alguma de uma sessão anterior — seria inesperado).
  PLATFORM_OWNER_EMAILS=brunopelatieri@gmail.com  # TEMPORÁRIO — remover ao final
  ```

  Reinicie o `npm run dev` depois de editar (variável de ambiente só é lida no boot).

- [ ] **Duas contas de teste descartáveis**, além da sua própria conta real (a que talvez você já use no dia a dia):
  - **Conta A** ("vítima") — vai ser bloqueada, ter o plano trocado e o vencimento manipulado nos itens 4–12 e 16. Precisa de **dois membros**: um `owner` e um `agent` (ou `admin`) — para os itens 6–7 (bloquear só uma pessoa).
  - **Conta B** — só para o item 3 (comparação "outra conta", se você quiser, embora o item 3 seja majoritariamente coberto por teste automatizado) e para confirmar isolamento onde fizer sentido.

  Crie as duas pelo cadastro normal (`/signup`) — é o único jeito suportado de ter um `auth.users` de verdade com `email_confirmed_at` preenchido, e o `handle_new_user` já cuida de conta + perfil + plano padrão, igual a um cadastro real.

- [ ] Ache os ids que você vai usar nas consultas abaixo:

  ```sql
  select id, name, blocked_at from accounts
   where name in ('<nome da Conta A>', '<nome da Conta B>');

  select p.user_id, p.account_id, p.account_role, p.email, p.blocked_at
    from profiles p
    join accounts a on a.id = p.account_id
   where a.name = '<nome da Conta A>'
   order by p.account_role desc;
  ```

- [ ] Confirme em qual projeto Supabase você está testando (`vn`, `rs` ou `jh` — regra do `AGENTS.md`) antes de rodar qualquer SQL, mesmo sendo só `SELECT`. As sessões anteriores desta SPEC testaram contra `vn`, com autorização explícita do mantenedor para esse projeto especificamente.

- [ ] Para os itens que chamam `/api/admin/**` (12 e 16), exporte as variáveis que o [guia de operação](./guia-operacao-planos-e-quotas.md#2-autenticação-das-rotas-de-operador) já usa:

  ```bash
  export ADMIN_SECRET="cole-o-valor-de-PLATFORM_ADMIN_SECRET-aqui"
  export CRON_SECRET="cole-o-valor-de-AUTOMATION_CRON_SECRET-aqui"
  export BASE_URL="http://localhost:3000"   # ou o domínio de produção
  ```

- [ ] Confirme que `platform_settings.self_service_enabled = TRUE` (padrão) antes dos itens 9–11 — são especificamente sobre o autosserviço do cliente:

  ```sql
  select quotas_enforced, self_service_enabled, default_plan_code, grace_days
    from platform_settings;
  ```

---

## 1. Login comum em `/admin` → 404

**Por quê:** é a garantia central da §2.4 — um estranho batendo em `/admin` não pode diferenciar "não configurado" de "sessão errada" de "e-mail fora da lista". Todos os três têm que parecer "esta rota não existe".

1. Faça login com uma sessão que **não** está em `PLATFORM_OWNER_EMAILS` (a sua conta de cliente comum, se ela não for a mesma do proprietário; ou a Conta A/B de teste).
2. Abra `/admin` no navegador — espera-se a página **404** padrão do Next, idêntica à de qualquer rota inexistente.
3. Copie o cookie de sessão dessa mesma aba (DevTools → Application → Cookies) e chame a API diretamente:

   ```bash
   curl -i "$BASE_URL/api/platform/accounts" \
     -H "Cookie: <cole os cookies sb-*-auth-token aqui>"
   ```

   Espera-se `404`, corpo genérico — nunca `401`/`403`.

- [ ] Passou

---

## 2. `PLATFORM_OWNER_EMAILS` ausente → 404 mesmo para o proprietário de verdade

**Por quê:** sem a variável, o console **não existe** para ninguém — nem para quem estaria na lista se ela existisse.

1. Comente/remova `PLATFORM_OWNER_EMAILS` do `.env.local` e reinicie o `npm run dev`.
2. Com a SUA sessão real (a que está no e-mail que normalmente entraria), abra `/admin` — espera-se **404**.
3. Restaure a variável e reinicie de novo antes de continuar para os próximos itens.

- [ ] Passou

---

## 3. Normalização de e-mail (majoritariamente coberto por teste automatizado)

**Por quê:** a §2.2 exige `trim` + `toLowerCase` na comparação, e um subdomínio a mais não pode colar por engano.

`src/lib/platform/owner.test.ts` já cobre, na unidade, exatamente os casos do enunciado (espaço ao redor, maiúsculas/minúsculas, `bruno@zapcrmbr.com.br` não casando com `bruno@zapcrmbr.com`, prefixo a mais não casando). Rode para confirmar que ainda está verde:

```bash
npx vitest run src/lib/platform/owner.test.ts
```

- [ ] Testes automatizados verdes (comando acima)

A parte que só um navegador prova — o e-mail que o Supabase Auth te dá na sessão já normalmente vem exatamente como foi cadastrado, então o teste de ponta a ponta mais realista é: confirme que **o seu próprio login continua funcionando** independentemente de como você digitou o e-mail na tela de login (o Supabase geralmente já normaliza para minúsculas antes de gravar `auth.users.email`, então isto raramente é visível na prática — é por isso que a defesa em profundidade mora no código, não no comportamento observável do dia a dia).

- [ ] Login funciona normalmente, sem surpresa de caixa/espaço

---

## 4. Bloquear conta → membro recebe `0` linhas por SQL, e vê `/blocked`

**Por quê:** é a garantia central de toda a SPEC — bloqueio é RLS, não uma checagem de UI que dá pra contornar.

1. No console (`/admin/accounts/{id da Conta A}`), clique no switch de bloqueio do **cabeçalho** (bloqueia a conta inteira) — preencha um motivo, confirme.
2. Faça login como o `agent`/`admin` da Conta A (não o `owner`, para também confirmar que o bloqueio da CONTA vale para qualquer papel). Ele deve ser redirecionado para `/blocked` ao tentar abrir o dashboard.
3. **Sem passar pela tela** — confirme por SQL, com a sessão REAL dele (JWT simulado, mesmo padrão usado nas sessões de F1/F5 desta SPEC):

   ```sql
   BEGIN;
   SELECT set_config('request.jwt.claims',
     (SELECT json_build_object('sub', p.user_id::text, 'role', 'authenticated')::text
        FROM profiles p WHERE p.account_id = '<id da Conta A>' AND p.account_role != 'owner' LIMIT 1),
     true);
   SET LOCAL ROLE authenticated;
   SELECT count(*) FROM contacts    WHERE account_id = '<id da Conta A>';   -- espera-se 0
   SELECT count(*) FROM conversations WHERE account_id = '<id da Conta A>'; -- espera-se 0
   ROLLBACK;
   ```

- [ ] Passou — `/blocked` apareceu na tela **e** as duas contagens vieram `0`

---

## 5. Conta bloqueada recebendo mensagem entra no banco; campanha agendada não dispara

**Por quê:** são as duas exceções documentadas do bloqueio (D-9 e o oposto — SPEC 062 §4.3) — uma pessoa comum não sabe que "bloqueado" significa coisas diferentes em cada caminho, e é fácil implementar as duas ao contrário por engano.

### 5.1. Mensagem recebida (D-9) — continua entrando

1. Com a Conta A **ainda bloqueada** (item 4) e um canal WhatsApp real conectado nela, peça para alguém mandar uma mensagem de verdade para o número conectado.
2. Confirme por SQL (com `service_role`/MCP, não pela sessão do cliente — ela não vê nada bloqueada):

   ```sql
   select id, created_at, content_text from messages
    where conversation_id in (
      select id from conversations where account_id = '<id da Conta A>'
    )
    order by created_at desc limit 3;
   ```

   Espera-se a mensagem nova aparecendo — **nada é recusado** no caminho de entrada.

- [ ] Passou — mensagem inbound apareceu normalmente

### 5.2. Campanha agendada não dispara

1. **Antes** de bloquear (ou desbloqueie a Conta A temporariamente), crie uma campanha (Disparos → Nova campanha) com um template aprovado, agendada para um horário próximo, com pelo menos 1 destinatário.
2. Bloqueie a Conta A de novo.
3. Chame o cron manualmente (não espere o agendamento real):

   ```bash
   curl -i "$BASE_URL/api/broadcasts/cron" -H "x-cron-secret: $CRON_SECRET"
   ```

4. Confirme que a campanha **não avançou**:

   ```sql
   select id, status, sent_count, total_recipients from broadcasts
    where account_id = '<id da Conta A>'
    order by created_at desc limit 1;
   -- Espera-se: status ainda 'scheduled' (ou sent_count = 0), não 'sending'/'sent'.
   ```

- [ ] Passou — desbloqueie a Conta A antes de seguir para o item 6 (ele testa bloquear só uma pessoa, não a conta)

---

## 6. Bloquear um usuário → só ele cai; o colega segue trabalhando

1. No detalhe da Conta A (com a conta **desbloqueada**), bloqueie **só** o membro `agent`/`admin` (switch na linha dele, na seção Membros) — não o `owner`.
2. Confirme por SQL, com a sessão do membro BLOQUEADO:

   ```sql
   BEGIN;
   SELECT set_config('request.jwt.claims',
     (SELECT json_build_object('sub', user_id::text, 'role', 'authenticated')::text
        FROM profiles WHERE account_id = '<id da Conta A>' AND account_role != 'owner' LIMIT 1),
     true);
   SET LOCAL ROLE authenticated;
   SELECT count(*) FROM contacts WHERE account_id = '<id da Conta A>'; -- espera-se 0
   ROLLBACK;
   ```

3. Confirme, com a sessão do **`owner`** da mesma conta (que não foi tocado), que ele continua vendo os dados normalmente:

   ```sql
   BEGIN;
   SELECT set_config('request.jwt.claims',
     (SELECT json_build_object('sub', user_id::text, 'role', 'authenticated')::text
        FROM profiles WHERE account_id = '<id da Conta A>' AND account_role = 'owner' LIMIT 1),
     true);
   SET LOCAL ROLE authenticated;
   SELECT count(*) FROM contacts WHERE account_id = '<id da Conta A>'; -- espera-se > 0 (o real, não 0)
   ROLLBACK;
   ```

- [ ] Passou — o bloqueado vê `0`, o colega vê a contagem normal

---

## 7. Desbloquear → acesso volta idêntico, sem nada apagado

1. Antes de desbloquear, anote a contagem real de contatos/conversas da Conta A (por `service_role`).
2. Desbloqueie a conta (ou a pessoa, conforme o que ficou bloqueado no item anterior) pelo console.
3. Repita a consulta por SQL com a sessão do afetado — deve voltar a bater com a contagem real anotada no passo 1, exatamente.

- [ ] Passou — contagem pós-desbloqueio == contagem real, nenhuma perda

---

## 8. Proprietário tentando bloquear a própria conta → recusado

**Por quê:** sem esta guarda, um clique trancaria você para fora sem tela para desfazer (§4.4, §11 — a saída documentada é `UPDATE` por SQL).

> Só faça isto se a SUA sessão de proprietário também tiver uma conta de cliente comum neste banco. Se não tiver, este item já está coberto pelas quatro variações de `src/lib/platform/guards.test.ts` (mesma conta por id, mesmo usuário por id, e-mail com caixa diferente, e-mail com espaço) — marque como automatizado e siga em frente.

1. Abra `/admin/accounts/{a sua própria conta}` — o switch de bloqueio do cabeçalho deve aparecer **desabilitado**, com o motivo no `title` ao passar o mouse.
2. Confirme que a rota recusa mesmo chamada direto (contornando o botão desabilitado):

   ```bash
   curl -i -X POST "$BASE_URL/api/platform/accounts/<sua-account-id>/block" \
     -H "Cookie: <seus cookies de sessão>" \
     -H "Content-Type: application/json" \
     -d '{"reason":"teste"}'
   # Espera-se 400, nunca 200.
   ```

- [ ] Passou (ou automatizado — `guards.test.ts`)

---

## 9. Troca de plano pelo modal (mensal e anual)

**Por quê:** é o caminho novo do autosserviço (D-3) — precisa recalcular ciclo e vencimento na MESMA resposta, sem fila de aprovação.

1. Logado como `admin`/`owner` da Conta A, abra "Plano e uso" (`/plan`).
2. Escolha um plano diferente do atual (ex.: de Essencial para Profissional), ciclo **mensal** — confirme no modal.
3. Confira a resposta (Network tab ou repita via `fetch` no console do navegador):

   ```js
   await fetch('/api/account/plan/change', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ planId: '<id do plano professional>', billingCycle: 'monthly' }),
   }).then((r) => r.json());
   ```

   Espera-se `accountPlan` com `billingCycle: 'monthly'`, `startedAt` = agora, `currentPeriodEnd` = 1 mês a partir de agora, `status: 'active'`.

4. Repita escolhendo ciclo **anual** — `currentPeriodEnd` deve ser 1 **ano** a partir de agora (não de quando você trocou pela primeira vez).
5. Confirme o rastro:

   ```sql
   select actor, from_plan_code, to_plan_code, from_status, to_status, created_at
     from account_plan_events
    where account_id = '<id da Conta A>'
    order by created_at desc limit 2;
   -- Espera-se actor = 'self-service:<seu e-mail>' nas duas linhas.
   ```

- [ ] Passou — plano, ciclo e vencimento corretos na mesma resposta, `actor` com o prefixo certo

---

## 10. Downgrade com overage → nada apagado, barra vermelha, contato recusado

**Por quê:** é a garantia de D-4 (a mais cara comercialmente) — reduzir o plano nunca pode apagar dado do cliente, só bloquear a criação de dado NOVO.

**Pré-requisito:** `quotas_enforced = TRUE` (item de preparação) — sem isso, nada bloqueia e o teste não prova nada.

1. Na Conta A, garanta que ela está num plano com quota de contatos alta (ex.: Profissional, 10.000) e **crie/importe contatos até passar** a quota do plano MENOR para o qual você vai descer (ex.: mais de 2.000, se vai descer para o Essencial). Um jeito rápido sem criar 2.000 contatos de verdade: force o contador diretamente para o teste (⚠️ só em conta de teste, nunca em conta real):

   ```sql
   update account_usage_counters set value = 2500
    where account_id = '<id da Conta A>' and metric = 'contacts';
   ```

2. Troque a Conta A para o plano menor (Essencial, 2.000) pelo modal de "Plano e uso" ou pelo console (`/admin/accounts/{id}` → "Trocar plano").
3. Confirme que **nada foi apagado**:

   ```sql
   select value from account_usage_counters
    where account_id = '<id da Conta A>' and metric = 'contacts';
   -- Espera-se: ainda 2500 (ou o valor real, se você não usou o passo 1 sintético).
   ```

4. Na tela "Plano e uso" (ou no detalhe da conta no console), a barra de contatos aparece **em vermelho**, mostrando o excedente.
5. Tente criar um contato novo na Conta A — espera-se **recusa** (o motor da 059 continua valendo, sem nenhuma mudança desta SPEC):

   ```bash
   curl -i -X POST "$BASE_URL/api/v1/contacts" \
     -H "Authorization: Bearer <uma chave de API da Conta A com contacts:write>" \
     -H "Content-Type: application/json" \
     -d '{"phone":"+5511999990000"}'
   # Espera-se 403 quota_exceeded.
   ```

- [ ] Passou — reverta o contador sintético do passo 1 ao final:
  ```sql
  select recount_account_usage('<id da Conta A>'::uuid);
  ```

---

## 11. Cancelar → acesso mantido; vencimento aplica o downgrade uma única vez

**Por quê:** prova a ponta a ponta do ciclo de vencimento automático (§8) — o cron precisa agir sozinho, sem duplicar o evento em corridas repetidas.

1. Na Conta A (com um plano PAGO e `currentPeriodEnd` preenchido — troque pelo item 9 se precisar), agende o cancelamento:

   ```js
   await fetch('/api/account/plan/cancel', { method: 'POST' }).then((r) => r.json());
   // Espera-se { cancelAtPeriodEnd: true }
   ```

2. Confirme que o **acesso continua** normal (nada bloqueia por cancelamento agendado, D-7) — abra o dashboard normalmente.
3. Em vez de esperar o vencimento real, empurre-o para o passado (só em conta de teste):

   ```sql
   update account_plans set current_period_end = now() - interval '1 day'
    where account_id = '<id da Conta A>';
   ```

4. Rode o cron de vencimento **duas vezes seguidas** (a idempotência é o que este item prova):

   ```bash
   curl -s "$BASE_URL/api/plans/lifecycle/cron" -H "x-cron-secret: $CRON_SECRET" | head -c 500
   curl -s "$BASE_URL/api/plans/lifecycle/cron" -H "x-cron-secret: $CRON_SECRET" | head -c 500
   ```

5. Confirme: a conta desceu para o plano padrão **uma vez só**:

   ```sql
   select ap.plan_id, p.code, ap.status, ap.current_period_end, ap.cancel_at_period_end
     from account_plans ap join plans p on p.id = ap.plan_id
    where ap.account_id = '<id da Conta A>';
   -- Espera-se: code = platform_settings.default_plan_code, status='active',
   -- cancel_at_period_end = false, current_period_end conforme o plano padrão.

   select count(*) from account_plan_events
    where account_id = '<id da Conta A>' and reason = 'cancel_at_period_end reached';
   -- Espera-se 1, não 2 — a segunda corrida do cron não reprocessou
   -- (a conta já não bate mais no WHERE current_period_end IS NOT NULL
   -- se o plano padrão não vence, ou já não está mais active/trialing).
   ```

- [ ] Passou

---

## 12. Console × API: mesma troca de plano, mesmo evento, `actor` diferente

**Por quê:** é o critério que faz F6 "verificável por construção" — as duas portas chamam a MESMA função (`changeAccountPlan`), então o evento deveria ser idêntico exceto no `actor`.

1. Pela **API** (`x-admin-secret`), troque o plano da Conta A:

   ```bash
   curl -s -X PUT "$BASE_URL/api/admin/accounts/<id da Conta A>/plan" \
     -H "x-admin-secret: $ADMIN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"actor":"teste-f10","planCode":"essential","reason":"item 12 do teste manual"}'
   ```

2. Pelo **console**, no detalhe da mesma conta, clique "Trocar plano" e troque para `professional` (o outro plano) com o mesmo texto de motivo.
3. Compare as duas linhas mais recentes de `account_plan_events`:

   ```sql
   select actor, to_plan_code, to_status, reason, overrides_after
     from account_plan_events
    where account_id = '<id da Conta A>'
    order by created_at desc limit 2;
   ```

   Espera-se: mesma forma de linha nos dois casos (`to_plan_code` correspondente, `reason` igual, `overrides_after` consistente) — **só** o `actor` difere: `teste-f10` (o texto livre que o `curl` mandou) vs. `console:<seu e-mail>`.

- [ ] Passou

---

## 13. Retenção — o dono da conta perdeu o acesso

1. Logado como `owner` da Conta A, abra Configurações — a aba "Retention" **não aparece** na navegação lateral.
2. Acesse `/settings?tab=retention` direto pela URL — cai no Overview, não mostra nada de retenção.
3. As rotas antigas respondem 404 por não existirem mais:

   ```bash
   curl -i "$BASE_URL/api/account/retention" -H "Cookie: <cookies do owner da Conta A>"
   curl -i -X POST "$BASE_URL/api/account/retention/preview" -H "Cookie: <cookies do owner da Conta A>"
   ```

4. Confirme por SQL, com a sessão do `owner` da Conta A — **mesmo sendo `owner`**:

   ```sql
   BEGIN;
   SELECT set_config('request.jwt.claims',
     (SELECT json_build_object('sub', user_id::text, 'role', 'authenticated')::text
        FROM profiles WHERE account_id = '<id da Conta A>' AND account_role = 'owner' LIMIT 1),
     true);
   SET LOCAL ROLE authenticated;
   SELECT count(*) FROM channel_retention_policies WHERE account_id = '<id da Conta A>';
   -- Espera-se 0, mesmo que exista uma política de verdade (item 14).
   ROLLBACK;
   ```

- [ ] Passou

---

## 14. Retenção — nada se perdeu

1. Antes de mais nada, grave uma política de teste na Conta A **por `service_role`** (é o único jeito de gravar hoje):

   ```sql
   insert into channel_retention_policies (account_id, channel_type, max_messages, retention_days, max_favorites)
   values ('<id da Conta A>', 'whatsapp_cloud', 5000, 90, 100)
   on conflict (account_id, channel_type) do update
     set max_messages = excluded.max_messages,
         retention_days = excluded.retention_days,
         max_favorites = excluded.max_favorites;
   ```

2. Confirme, por `service_role`, que os três valores estão lá:

   ```sql
   select max_messages, retention_days, max_favorites
     from channel_retention_policies
    where account_id = '<id da Conta A>' and channel_type = 'whatsapp_cloud';
   -- Espera-se: 5000, 90, 100 — exatamente o que foi gravado no passo 1.
   ```

3. No console (`/admin/accounts/{id}` → seção Retenção), confirme que o proprietário **vê** esses mesmos três valores refletidos nos cartões.
4. Rode a varredura de retenção uma vez (com `MESSAGE_RETENTION_ENABLED=true` só nesta chamada de teste, nunca deixado ligado num ambiente com contas reais — ver o aviso de segurança em `docs/spec-060-teste-manual.md`):

   ```bash
   curl -s "$BASE_URL/api/messages/retention/cron" -H "x-cron-secret: $CRON_SECRET"
   ```

5. Confirme que ela apagou exatamente o que apagaria antes da 069 — compare com o comportamento documentado nos itens 3–13 de `docs/spec-060-teste-manual.md` (a função `purge_channel_messages` em si não mudou nesta SPEC).

- [ ] Passou — **desligue `MESSAGE_RETENTION_ENABLED` de novo** se você ligou só para este teste

---

## 15. Retenção — o elo novo funciona (console + `.env` juntos)

**Por quê:** é o item 12 do teste manual da SPEC 060, agora com um nível a mais na cadeia — prova que `padrão global do console` e `padrão do .env` se somam, em vez de um pisar no outro.

1. Confirme (ou defina) no `.env` do servidor: `MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS=365` (só `retentionDays`).
2. No console, `/admin/retention` → canal "Official WhatsApp" → preencha **só** o campo "Max messages" com `50`, deixe os outros dois em branco. Salve.
3. Confirme por SQL que o JSONB gravou só a dimensão que você preencheu:

   ```sql
   select retention_defaults from platform_settings;
   -- Espera-se: {"whatsapp_cloud": {"maxMessages": 50}} — sem retentionDays aqui,
   -- ele continua vindo do .env.
   ```

4. Na Conta A, remova qualquer política própria daquele canal (ou use uma conta sem política — a cadeia precisa cair até o padrão global):

   ```sql
   delete from channel_retention_policies
    where account_id = '<id da Conta A>' and channel_type = 'whatsapp_cloud';
   ```

5. Rode a prévia pelo console (`/admin/accounts/{id}` → Retenção → "See what would be removed" no canal Oficial) — anote o número previsto.
6. Rode a varredura de verdade (mesmo `curl` do item 14) e confirme que o número **apagado de fato bate com a prévia** — a cadeia respeitou os `50` do console **e** os `365` dias do `.env` ao mesmo tempo (nenhum dos dois "venceu" sozinho).

- [ ] Passou

---

## 16. Renovação externa — idempotente, avança a partir do vencimento anterior

1. Anote o `current_period_end` atual da Conta A:

   ```sql
   select current_period_end from account_plans where account_id = '<id da Conta A>';
   ```

2. Chame a renovação com um `paymentRef` novo:

   ```bash
   curl -s -X POST "$BASE_URL/api/admin/accounts/<id da Conta A>/billing/renew" \
     -H "x-admin-secret: $ADMIN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"paymentRef":"teste-f10-001","periods":1}'
   # Espera-se { "status": "applied", "accountPlan": { "currentPeriodEnd": "...", ... } }
   ```

3. Chame de novo, com o **mesmo** `paymentRef`:

   ```bash
   curl -s -X POST "$BASE_URL/api/admin/accounts/<id da Conta A>/billing/renew" \
     -H "x-admin-secret: $ADMIN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"paymentRef":"teste-f10-001","periods":1}'
   # Espera-se { "status": "already_applied" } — SEM accountPlan, e sem
   # avançar o vencimento de novo.
   ```

4. Confirme por SQL que o vencimento avançou **uma vez só** desde o passo 1 (1 mês/ano a mais, não 2).
5. Force o vencimento para o passado (como no item 11) e chame de novo com um `paymentRef` **diferente**:

   ```sql
   update account_plans set current_period_end = now() - interval '5 days'
    where account_id = '<id da Conta A>';
   ```

   ```bash
   curl -s -X POST "$BASE_URL/api/admin/accounts/<id da Conta A>/billing/renew" \
     -H "x-admin-secret: $ADMIN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"paymentRef":"teste-f10-002","periods":1}'
   ```

6. Confirme que o novo `current_period_end` é **1 ciclo a partir do vencimento anterior** (o que estava no banco antes desta chamada, já vencido há 5 dias) — **não** 1 ciclo a partir de agora. Se o ciclo é mensal, o novo vencimento deve estar ~5 dias no passado em relação a "hoje + 1 mês".

- [ ] Passou

---

## Definição de pronto (SPEC 062 §12)

Depois dos 16 itens acima, confira:

- [ ] Item 4 provou `0` linhas **por SQL com a sessão real do bloqueado**, não só a tela mostrando `/blocked` — é a distinção que separa RLS de UI.
- [ ] Item 5 confirmou as duas exceções em direções opostas (mensagem entra, campanha não sai) — errar qualquer uma das duas é a armadilha nomeada no §11 da SPEC.
- [ ] Item 8 confirmou o autobloqueio recusado **na rota**, não só no botão desabilitado.
- [ ] Item 11 provou idempotência de verdade (duas corridas do cron, um evento só) — não só "rodou uma vez e funcionou".
- [ ] Item 12 confirmou que console e API produzem a MESMA forma de evento — se divergirem em qualquer campo além do `actor`, é sinal de que uma das portas parou de chamar `changeAccountPlan`.
- [ ] Itens 13–15 substituem de vez o item 14 do teste manual da SPEC 060 (já marcado como obsoleto por lá).
- [ ] Todo estado de teste criado nesta sessão foi revertido: `PLATFORM_OWNER_EMAILS` temporária removida (se você adicionou uma), contas de teste descartadas ou deixadas claramente marcadas como teste, `MESSAGE_RETENTION_ENABLED` de volta ao estado original, contador de uso recontado (`recount_account_usage`) em qualquer conta onde você mexeu direto no `account_usage_counters`.
- [ ] `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build` — verde, na ordem (já validado nas sessões de F1–F9; rode de novo se algo mudou desde então).

Marcando os 16 itens + esta seção, a SPEC 062 está com todo o roteiro de F10 fechado.
