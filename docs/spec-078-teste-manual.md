# SPEC 078 — Teste manual (F7)

Checklist executável do [§13 da SPEC 078](./spec-078-vencimento-pagamento-manual-e-identidade-de-usuarios.md#13-teste-manual-f7--contra-banco-real), no formato do [`docs/spec-062-teste-manual.md`](./spec-062-teste-manual.md). Não é um documento novo de decisão — é o §13 desdobrado em passo a passo, com o SQL/`curl` de conferência pronto para colar.

> **Ainda não executado.** F1–F6 estão implementadas e com suíte automatizada verde, mas **a interface do console (F4) nunca foi aberta num navegador** — `/admin` exige login real do proprietário, e nenhuma das sessões que implementaram as fases tinha um. Os 19 itens abaixo envolvem sessão real, RLS, fuso horário, SMTP e dinheiro; nenhum é verificável por teste unitário. **Marque cada item ao rodar de verdade; não preencha resultado sem ter rodado.**
>
> O que o teste automatizado já prova (e que este roteiro NÃO repete): a validação de datas/valores, as guardas de e-mail, a ordem das escritas, o mapeamento de erros das RPCs e que as rotas respondem 404 sem sessão de proprietário. O que só aqui se prova: o **efeito de ponta a ponta** — a tela, a RPC no banco real, o Auth do Supabase, o SMTP e o webhook.

---

## 0. Preparação

Feita uma vez, antes dos itens. **Nunca contra dado real de cliente** — use contas descartáveis e reverta o estado ao final de cada item (cada item tem seu "reverter" quando se aplica).

- [ ] **Projeto Supabase certo.** Confirme em qual projeto você está (`vn` ou `rs` — regra do `AGENTS.md`) antes de rodar qualquer SQL, mesmo `SELECT`. A migração `089_console_billing_and_identity.sql` precisa estar aplicada nele:

  ```sql
  -- Esperado: 1 linha em cada
  select tgname from pg_trigger
   where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_email_updated';

  select proname, pronargs from pg_proc
   where proname in ('apply_plan_renewal','set_plan_period_end','reverse_plan_payment');
  -- apply_plan_renewal deve aparecer UMA vez, com pronargs = 9
  ```

- [ ] **`PLATFORM_OWNER_EMAILS`** configurada no servidor de teste com o e-mail da sua sessão (`dono@exemplo.com` ou o que você usa). Local: `.env.local` + reiniciar o `npm run dev`.

- [ ] **Conta A ("vítima")** criada por `/signup`, num plano **mensal pago com ciclo** (ex.: Essencial), com **dois membros**: um `owner` e um `agent`/`admin`. Os dois precisam ter e-mail **seu e acessível** (use aliases `seu+a1@gmail.com`, `seu+a2@gmail.com`) — os itens 12 a 16 e 18 dependem de receber/entrar com eles.
- [ ] **Conta B** em plano **sem ciclo** (Grátis/`unlimited`) — só para o item 3.
- [ ] **Um endpoint de webhook na Conta A** assinando `plan.renewed` e `plan.period_changed`, apontando para um receptor que você consegue olhar (ex.: webhook.site). Crie com uma chave de API da Conta A (Configurações → Chaves de API):

  ```bash
  curl -X POST "$BASE_URL/api/v1/webhooks" \
    -H "Authorization: Bearer $API_KEY_A" -H "Content-Type: application/json" \
    -d '{ "url": "https://webhook.site/<seu-id>", "events": ["plan.renewed","plan.period_changed"] }'
  ```

- [ ] **Variáveis de shell** para os `curl` (cookie copiado do DevTools → Application → Cookies da aba do `/admin`, todos os `sb-*-auth-token`):

  ```bash
  export BASE_URL="http://localhost:3000"       # ou o domínio de produção
  export COOKIE='sb-xxx-auth-token=...'          # sessão do PROPRIETÁRIO
  export ADMIN_SECRET="valor-de-PLATFORM_ADMIN_SECRET"
  export ACC="<id da Conta A>"
  ```

- [ ] **Ids das contas e usuários:**

  ```sql
  select id, name, blocked_at from accounts where name in ('<Conta A>','<Conta B>');

  select p.user_id, p.account_role, p.full_name, p.email, p.blocked_at
    from profiles p where p.account_id = '<id da Conta A>' order by p.account_role desc;
  ```

- [ ] **Consulta-base** para colar depois de cada passo (estado do plano da Conta A):

  ```sql
  select status, billing_cycle,
         current_period_end at time zone 'America/Sao_Paulo' as vence_sp,
         grace_until, cancel_at_period_end, last_payment_ref, updated_by
    from account_plans where account_id = '<id da Conta A>';
  ```

- [ ] **SMTP** (só para o item 18): `SMTP_HOST`, `SYSTEM_NOTIFICATION_EMAIL` (e `SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM` se o provedor exigir) no servidor de teste.

---

## 1. Vencimento — caminho feliz

**Por quê:** é o coração da funcionalidade 1 — e o único lugar onde o fuso (D-2) pode errar silenciosamente.

1. `/admin/accounts/{Conta A}` → **Alterar vencimento**. Anote o vencimento atual exibido.
2. Escolha uma data futura (ex.: `20/12` do ano corrente), deixe o ciclo, motivo "teste F7", confirme.
3. A tela deve mostrar o novo vencimento (`20/12`, **não** `21/12`) e o toast de sucesso.
4. Conferência:

   ```sql
   -- vence_sp deve ser 23:59:59 do dia escolhido (SP); em UTC já é o dia seguinte
   select current_period_end, current_period_end at time zone 'America/Sao_Paulo' as vence_sp
     from account_plans where account_id = '<Conta A>';

   -- anterior/novo/status/ciclo + motivo
   select actor, action, payload, created_at from platform_audit_log
    where account_id = '<Conta A>' and action = 'billing.period_end.set'
    order by created_at desc limit 1;
   ```
5. O card **Histórico** mostra a linha "Vencimento alterado: … → …" com `console:<seu e-mail>`.
6. Receptor do webhook: chegou `plan.period_changed` com `previousPeriodEnd`, `currentPeriodEnd`, `billingCycle`, `status`.
7. Entre como o dono da Conta A → `/activity`: "O vencimento do plano foi alterado", ator **Suporte da plataforma**.

**Reverter:** altere o vencimento de volta (mesmo diálogo).

- [ ] Passou

---

## 2. Vencimento — faixa de datas

**Por quê:** data passada dispararia `past_due` + carência já vencida no próximo cron (D-3).

1. No diálogo, o `<input type="date">` não deve deixar escolher ontem nem hoje + 3 anos + 1 dia (calendário bloqueado). Digitando na mão, o botão **Salvar** fica desabilitado e aparece a mensagem de erro.
2. Pela API (burlando a UI):

   ```bash
   ONTEM=$(date -d '-1 day' +%F); LONGE=$(date -d '+3 years +1 day' +%F)
   for D in "$ONTEM" "$LONGE"; do
     curl -s -X PUT "$BASE_URL/api/platform/accounts/$ACC/billing/period-end" \
       -H "Cookie: $COOKIE" -H "Content-Type: application/json" \
       -d "{\"date\":\"$D\"}"; echo
   done
   # Esperado nas duas: {"error":"…","code":"period_end_out_of_range"}  (HTTP 400)
   ```
3. Hoje e hoje + 3 anos exatos **passam** (confira o limite de cima e reverta).

- [ ] Passou

---

## 3. Vencimento — plano sem ciclo

**Por quê:** vencimento num plano que não vence deixaria o cron e a renovação brigando (D-1).

1. `/admin/accounts/{Conta B}`: os botões **Alterar vencimento** e **Registrar pagamento** estão **desabilitados**; passar o mouse sobre eles mostra "Este plano não tem ciclo de cobrança…". O card **Pagamentos** nem aparece.
2. Pela API:

   ```bash
   curl -s -X PUT "$BASE_URL/api/platform/accounts/<Conta B>/billing/period-end" \
     -H "Cookie: $COOKIE" -H "Content-Type: application/json" \
     -d "{\"date\":\"$(date -d '+10 days' +%F)\"}"
   # Esperado: HTTP 400, code "no_billing_cycle"
   ```

- [ ] Passou

---

## 4. Vencimento — reativação de conta em atraso

**Por quê:** vencimento futuro tira a conta do atraso (D-5) — e a carência não pode ficar para trás.

1. Prepare o estado (Conta A de teste):

   ```sql
   update account_plans
      set status = 'past_due', grace_until = now() + interval '3 days'
    where account_id = '<Conta A>';
   ```
2. Recarregue o detalhe: status **Em atraso** + "Carência até …". Abra **Alterar vencimento**: o diálogo mostra o aviso "A conta sai de em atraso e volta a ativa".
3. Salve uma data futura. Conferência (consulta-base): `status = 'active'` e `grace_until` **nulo**.

- [ ] Passou

---

## 5. Vencimento — ciclo anual

**Por quê:** é o único lugar do console que grava `yearly`; sem isso o pagamento de um cliente anual avançaria 1 mês (D-4).

1. **Alterar vencimento** → ciclo **Anual**, uma data futura → salvar. Consulta-base: `billing_cycle = 'yearly'`.
2. **Registrar pagamento** → 1 período: o diálogo mostra "1 período = 1 ano". Confirme.
3. Consulta-base: o vencimento avançou **1 ano** a partir do vencimento anterior (não 1 mês).

**Reverter:** desfaça o pagamento (item 10) e volte o ciclo para mensal.

- [ ] Passou

---

## 6. Pagamento — caminho feliz

1. **Registrar pagamento**: data de hoje, 1 período, **Pix**, valor `349,00`, identificador `E2E-F7-0001`, observação "teste". Confira a prévia "Vencimento: … → …" antes de confirmar.
2. Após confirmar: toast com o novo vencimento; o vencimento avançou **1 ciclo a partir do vencimento atual** (não de hoje).
3. Conferência:

   ```sql
   select payment_ref, method, amount_cents, periods, recorded_by,
          previous_status, previous_grace_until, reversed_at,
          previous_period_end at time zone 'America/Sao_Paulo' as de,
          new_period_end      at time zone 'America/Sao_Paulo' as para
     from account_plan_payments where account_id = '<Conta A>'
    order by created_at desc limit 3;
   -- Esperado: method='pix', amount_cents=34900, recorded_by='console:<seu e-mail>',
   --           previous_status preenchido (é o que torna estornável)
   ```
4. Card **Pagamentos** mostra a linha (forma "Pix", `R$ 349,00`, "de → para").
5. Webhook: `plan.renewed` com `paymentRef: "E2E-F7-0001"` e `source: "console"`.
6. Cliente (`/activity`): "O plano foi renovado", ator **Suporte da plataforma**.
7. `/admin/notifications`: apareceu o aviso `plan.renewed` da Conta A.

- [ ] Passou

---

## 7. Pagamento — idempotência

**Por quê:** o mesmo dinheiro nunca pode avançar o vencimento duas vezes, venha de onde vier (§4.2).

1. **Mesmo identificador pelo console:** registre de novo `E2E-F7-0001` → toast "Este pagamento já estava registrado". Consulta-base: vencimento **igual** ao do item 6.
2. **Mesmo identificador pela rota de máquina:**

   ```bash
   curl -s -X POST "$BASE_URL/api/admin/accounts/$ACC/billing/renew" \
     -H "x-admin-secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
     -d '{"paymentRef":"E2E-F7-0001","periods":1}'
   # Esperado: {"status":"already_applied"} — vencimento NÃO mexe
   ```
3. **Clique duplo sem identificador:** abra **Registrar pagamento**, deixe o identificador em branco e clique **duas vezes seguidas** em "Registrar pagamento".

   ```sql
   -- Esperado: exatamente UMA linha com payment_ref like 'console:%' criada agora
   select payment_ref, created_at from account_plan_payments
    where account_id = '<Conta A>' and payment_ref like 'console:%'
    order by created_at desc limit 3;
   ```
4. Nenhuma das repetições gerou novo `plan.renewed` no receptor, nova linha em `platform_audit_log` (`billing.payment.manual`) nem nova atividade.

- [ ] Passou

---

## 8. Pagamento — conta em teste (`trialing`)

1. `update account_plans set status = 'trialing' where account_id = '<Conta A>';`
2. Registre um pagamento (identificador novo). Consulta-base: `status = 'active'`. (Vale também para a rota de máquina — D-8.)

- [ ] Passou

---

## 9. Pagamento — conta bloqueada

**Por quê:** pagamento não desbloqueia a conta (PRD 061 D-7).

1. Bloqueie a Conta A pelo switch do cabeçalho.
2. Abra **Registrar pagamento**: aparece o aviso âmbar "Esta conta está bloqueada. Pagar não a desbloqueia…".
3. Confirme o pagamento: toast de sucesso **e** um segundo toast "A conta continua bloqueada".
4. `select blocked_at from accounts where id = '<Conta A>';` → **continua preenchido**.

**Reverter:** desbloqueie a conta.

- [ ] Passou

---

## 10. Estorno

1. Tenha 2 pagamentos recentes (A mais antigo, B mais novo). No card **Pagamentos**: só **B** tem "Desfazer" habilitado; A está desabilitado e o mouse mostra "Só o último pagamento pode ser desfeito…".
2. Pela API, tente desfazer A antes de B:

   ```bash
   curl -s -X POST "$BASE_URL/api/platform/accounts/$ACC/billing/payments/<id de A>/reverse" \
     -H "Cookie: $COOKIE" -H "Content-Type: application/json" -d '{}'
   # Esperado: HTTP 409, code "payment_not_latest"
   ```
3. Desfaça **B** pela tela (motivo "teste F7"). Consulta-base: vencimento, status e carência **voltaram** ao que eram antes de B.
4. Linha de B continua na lista com o selo **"Estornado em …"** (não foi apagada):

   ```sql
   select payment_ref, reversed_at, reversed_by, reversal_reason from account_plan_payments
    where account_id = '<Conta A>' order by created_at desc limit 3;
   ```
5. O identificador de B **continua ocupado**: registrar de novo o mesmo `payment_ref` responde "já estava registrado" (e não reaplica).
6. **Vencimento mexido à mão:** com A (agora o último) elegível, altere o vencimento pelo diálogo e tente desfazer A → "Desfazer" aparece desabilitado ("O vencimento foi alterado depois deste pagamento…"); pela API, `409 period_changed_since_payment`.
7. **Pagamento anterior à 089:** se a conta tiver algum (linha com `previous_status` nulo), "Desfazer" fica desabilitado com "Registrado antes de existir o desfazer".

**Reverter:** corrija o vencimento com **Alterar vencimento**.

- [ ] Passou

---

## 11. Editar nome

1. Detalhe da Conta A → Membros → lápis no `agent` → mude o nome → salvar.
2. Entre como esse usuário: o novo nome aparece no inbox/atribuição.
3. **O nome da conta (empresa) NÃO mudou:**

   ```sql
   select a.name as conta, p.full_name as pessoa
     from profiles p join accounts a on a.id = p.account_id
    where p.user_id = '<id do agent>';
   select raw_user_meta_data->>'full_name' from auth.users where id = '<id do agent>';
   -- os dois nomes de pessoa devem bater; "conta" continua como antes
   ```
4. Atividade do cliente (`/activity`, como owner da conta): "O suporte da plataforma atualizou o perfil de …".

- [ ] Passou

---

## 12. Editar e-mail de um membro

1. Lápis no `agent` → e-mail novo (outro alias seu, ex.: `seu+a3@gmail.com`) → o diálogo mostra os avisos de troca imediata e de sessões abertas → salvar.
2. **Login com o e-mail novo + a senha antiga funciona imediatamente.** Login com o e-mail antigo **não** funciona.
3. Conferência:

   ```sql
   select email from profiles where user_id = '<id do agent>';
   select email, email_confirmed_at from auth.users where id = '<id do agent>';
   -- os dois = e-mail novo (profiles acompanhou pelo trigger da 089)
   ```
4. Redefinição de senha pelo e-mail novo (`/forgot-password`) chega e funciona — isto prova que o Auth atualizou também a identidade do provedor `email`. **Se não chegar/funcionar, anote**: a troca precisaria ir pela identidade (armadilha do §12 da SPEC).
5. Auditoria sem endereços na atividade, com endereços no console:

   ```sql
   select payload from platform_audit_log
    where target_user_id = '<id do agent>' and action = 'user.profile_update'
    order by created_at desc limit 1;     -- tem previousEmail/newEmail
   select metadata from account_activity_log
    where action = 'member.profile_updated' order by created_at desc limit 1;
    -- só {"fields":["email"]}, NENHUM endereço
   ```

- [ ] Passou

---

## 13. Editar e-mail do dono da conta

Repita o item 12 no `owner` da Conta A. O diálogo deve exibir, além dos avisos, **"Este é o dono da conta. O novo e-mail passa a ser o login dele imediatamente."**. Mesmo resultado do 12 (login imediato, `profiles.email` sincronizado).

- [ ] Passou

---

## 14. E-mail duplicado

1. Tente trocar o e-mail do `agent` para o e-mail **do owner** (já usado), e **altere também o nome** no mesmo envio.
2. Esperado: erro "Outro usuário já usa este e-mail" (`409 email_taken`) e **nada gravado — nem o nome**:

   ```sql
   select full_name, email from profiles where user_id = '<id do agent>';  -- inalterado
   ```

- [ ] Passou

---

## 15. Guardas do proprietário da plataforma

1. Se o seu usuário de proprietário tem perfil neste banco: abra o detalhe da conta dele → lápis na sua linha → o campo **E-mail está travado** com a explicação de `PLATFORM_OWNER_EMAILS`; o **nome** é editável.
2. Pela API, tente trocar o e-mail do proprietário:

   ```bash
   curl -s -X PATCH "$BASE_URL/api/platform/users/<seu user_id>" \
     -H "Cookie: $COOKIE" -H "Content-Type: application/json" \
     -d '{"email":"qualquer@exemplo.com"}'
   # Esperado: HTTP 400, code "cannot_edit_platform_owner_email"
   ```
3. Tente dar a um cliente um e-mail da lista:

   ```bash
   curl -s -X PATCH "$BASE_URL/api/platform/users/<id do agent>" \
     -H "Cookie: $COOKIE" -H "Content-Type: application/json" \
     -d '{"email":"dono@exemplo.com"}'     # um e-mail de PLATFORM_OWNER_EMAILS
   # Esperado: HTTP 400, code "email_reserved_for_platform_owner"
   ```

- [ ] Passou

---

## 16. Autosserviço consertado (o buraco da §1.1)

**Por quê:** antes da 089, `profiles.email` divergia em silêncio sempre que alguém trocava o próprio e-mail.

1. Como o `agent` da Conta A: Configurações → Perfil → troque o e-mail para outro alias → salvar.
2. Confirme pelo(s) link(s) que o Supabase enviar (a troca só vale após a confirmação).
3. Depois da confirmação:

   ```sql
   select p.email as perfil, u.email as auth
     from profiles p join auth.users u on u.id = p.user_id
    where p.user_id = '<id do agent>';
   -- Esperado: os dois iguais, sem nenhuma intervenção
   ```
4. Divergência global (deve ser vazia):

   ```sql
   select p.user_id, p.email, u.email from profiles p
     join auth.users u on u.id = p.user_id
    where u.email is not null and p.email is distinct from u.email;
   ```

- [ ] Passou

---

## 17. Porta fechada

**Por quê:** estranho não pode distinguir "console existe" de "não existe" — tudo é 404 (SPEC 062 §2.4).

Com a sessão de um usuário **comum** (copie o cookie da Conta B ou do `agent`), chame as cinco rotas e confirme `404` em todas, e o mesmo **sem nenhum cookie**:

```bash
export CK='<cookie de um usuário COMUM>'   # troque por '' para o teste sem sessão
PAY=00000000-0000-4000-8000-000000000000
req() { curl -s -o /dev/null -w "%{http_code}  $1 $2\n" -X "$1" "$BASE_URL$2" \
          -H "Cookie: $CK" -H "Content-Type: application/json" -d '{}'; }
req PUT   /api/platform/accounts/$ACC/billing/period-end
req GET   /api/platform/accounts/$ACC/billing/payments
req POST  /api/platform/accounts/$ACC/billing/payments
req POST  /api/platform/accounts/$ACC/billing/payments/$PAY/reverse
req PATCH /api/platform/users/$PAY
# Esperado: 404 nas cinco linhas (nunca 401/403/500)
```

- [ ] Passou

---

## 18. Aviso ao e-mail antigo (F6)

**Por quê:** troca de e-mail é a forma clássica de tomada de conta — o titular antigo precisa perceber (D-11). O aviso é melhor esforço e **nunca** pode falhar a troca.

**18a — com SMTP configurado.** Repita a troca de e-mail do item 12 (ou use outra) e confira na caixa do **endereço antigo**:

- Chegou `[ZAP CRM BR] O e-mail de acesso da sua conta foi alterado`, com "…alterado pelo suporte em dd/mm/aaaa" (data de São Paulo) e "responda a este e-mail".
- O corpo **não** contém o endereço novo, o nome da conta nem link do console.
- Responder ao e-mail vai para `SYSTEM_NOTIFICATION_EMAIL` (reply-to).
- Auditoria registra o desfecho:

  ```sql
  select payload->>'oldEmailNotice' from platform_audit_log
   where action = 'user.profile_update' order by created_at desc limit 1;   -- 'sent'
  ```
- Trocar **só o nome** não envia nada (`oldEmailNotice` ausente).

**18b — sem SMTP.** Remova `SMTP_HOST` do ambiente, reinicie e troque um e-mail: a troca **funciona normalmente**, sem toast de erro; `oldEmailNotice = 'skipped'` na auditoria; o log do servidor mostra o aviso único de canal desligado.

**18c — SMTP com erro.** Ponha um `SMTP_HOST` que não resolve, reinicie e troque um e-mail: a troca **funciona**, aparece o toast amarelo "o aviso ao endereço antigo não pôde ser enviado", e a auditoria grava `'failed'` (o erro vai para o log do servidor).

**Reverter:** restaure o `.env` do SMTP e reinicie.

- [ ] 18a passou
- [ ] 18b passou
- [ ] 18c passou

---

## 19. Histórico e fuso (fechamento)

1. Card **Histórico** da Conta A, depois dos itens acima: aparecem intercalados, por data, as linhas de plano e as ações do console (vencimento alterado, pagamento registrado, pagamento desfeito, perfil atualizado), cada uma com `console:<seu e-mail>`.
2. Todo vencimento exibido no console bate com `vence_sp` do SQL (calendário de São Paulo) — inclusive o "Expira em …" do cabeçalho do plano. Se você tiver como abrir o console com o relógio/fuso do sistema fora do Brasil, confirme que o dia **não** desloca.
3. O cron de ciclo de vida não desfez nada: depois de empurrar o vencimento, rode a varredura e confira que a conta **não** voltou a `past_due`:

   ```bash
   curl -s "$BASE_URL/api/automations/cron" -H "x-cron-secret: $CRON_SECRET"
   ```
   (consulta-base antes e depois: `status` e `grace_until` iguais).

- [ ] Passou

---

## Resultado

| Item | Resultado | Observação |
| --- | --- | --- |
| 1 Vencimento — caminho feliz | ☐ | |
| 2 Faixa de datas | ☐ | |
| 3 Plano sem ciclo | ☐ | |
| 4 Reativação | ☐ | |
| 5 Ciclo anual | ☐ | |
| 6 Pagamento — caminho feliz | ☐ | |
| 7 Idempotência | ☐ | |
| 8 `trialing` | ☐ | |
| 9 Conta bloqueada | ☐ | |
| 10 Estorno | ☐ | |
| 11 Nome | ☐ | |
| 12 E-mail de membro | ☐ | |
| 13 E-mail do dono | ☐ | |
| 14 E-mail duplicado | ☐ | |
| 15 Guardas do proprietário | ☐ | |
| 16 Autosserviço | ☐ | |
| 17 Porta fechada | ☐ | |
| 18 Aviso ao e-mail antigo (a/b/c) | ☐ | |
| 19 Histórico e fuso | ☐ | |

Qualquer falha: não corrija "de cabeça" — anote o item, o SQL/`curl` que divergiu e o resultado obtido, e abra uma correção com essa evidência (a armadilha mais provável está no §12 da SPEC).
