# PRD 077 — Supabase dedicado por cliente: viabilidade e decisão

> **PRD de viabilidade, não de construção.** O ponto de partida foi o prompt
> [`docs/prompt/prompt-prd-supabase-por-cliente-owner.md`](./prompt/prompt-prd-supabase-por-cliente-owner.md),
> que pede um resolver em tempo de execução `usuário → account_id →
> supabase_url`, com fallback para o `.env`. Este documento conclui que **essa
> arquitetura não fecha** no código atual (§3), que **o caso concreto que
> motivou o pedido — o `rs` — não precisa dela** (§4, Opção A), e deixa a
> decisão de produto de fundo explícita para ratificação (§6).
>
> **Por que PRD e não SPEC direto:** a dúvida que trava tudo não é técnica, é de
> produto — _"banco dedicado por cliente é algo que vendemos, ou só um estado
> histórico do `rs` que queremos desfazer?"_. As duas respostas levam a SPECs
> completamente diferentes (um runbook de consolidação de ~1 semana vs. uma
> reescrita do acesso a dados em ~170 arquivos). Escrever a SPEC antes dessa
> resposta seria escolher no escuro.

**Status:** aguardando ratificação de D-1…D-6 (§6).
**Data:** 2026-10-02.
**Numeração:** documento 077 (sequência de `docs/`). O prompt sugeria
`prd-088` — 088 é o próximo número livre de **migração**, que é uma sequência
separada (a SPEC 076 usou as migrações 086/087). Nenhuma migração é proposta
por este PRD.

---

## 0. Veredito em uma tela

| Pergunta                                                          | Resposta                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A arquitetura do prompt (resolver por `user_id`, fallback `.env`) é viável? | **Não como escrita.** Tem um ovo-e-galinha de autenticação (B-1), ignora que o navegador fala direto com o banco (B-2), e o fallback grava dado do cliente no banco errado (B-4).                            |
| Existe versão corrigida viável?                                   | Sim (Opção D): tenant por **host/subdomínio**, resolvido **antes** do login, **fail-closed**, com diretório central para webhooks e crons. Custo: toca os ~170 pontos de acesso ao Supabase e todo SPEC futuro. |
| O caso `rs` precisa disso?                                        | **Não.** O próprio prompt descreve o objetivo como _unificar_ `rs` em `vn`. O `rs` é pequeno (1 conta, 3 usuários, 1.369 contatos, 3.407 mensagens, 16 MB de Storage): consolidação única resolve.          |
| Recomendação                                                      | **Opção A agora** (consolidar `rs` → `vn`, sem feature nova). **Opção B como política** para cliente que exigir banco próprio (instalação dedicada = deploy + Supabase próprios, como o `rs` já é hoje). **D descartada** até haver demanda comercial real. |

---

## 1. O que o prompt pede — e a contradição de objetivo

O prompt pede, resumidamente:

1. Tabela `clients` (`account_id → supabase_url + supabase_key_encrypted`) no banco padrão.
2. CRUD no `/admin`, validação de credencial e **aplicação automática de migrações** no banco do cliente.
3. Resolver dinâmico `user → account_id → supabase_url`, cache de 10–15 min.
4. **Fallback para o `.env`** se o banco dedicado cair.

E, na seção "Processo de unificação rs → vn":

> pré-requisito: dados de `rs` copiados para `vn` → cria `clients` apontando
> para `rs_url` → … → "quando pronto: atualizar `supabase_url` para apontar
> para `vn`" → desativar `rs`.

Os dois blocos se contradizem. Se os dados do `rs` já estão em `vn` (pré-requisito),
a conta do `rs` **já é uma conta comum de `vn`** e o resolver não tem o que
resolver. Se o destino final é `vn`, a feature é um andaime que é montado e
desmontado no mesmo projeto. A única leitura em que a feature faz sentido
é: **banco dedicado como oferta permanente para clientes futuros** — e
essa leitura não aparece no prompt. É a decisão D-2.

---

## 2. Fatos levantados (2026-10-02, só leitura)

### 2.1. Os dois bancos

| Métrica                          | `vn` (padrão)          | `rs`                               |
| -------------------------------- | ---------------------- | ---------------------------------- |
| Contas                           | 2                      | 1                                  |
| Usuários (`auth.users`)          | 7                      | 3 (1 owner, 1 admin, 1 agent)      |
| Contatos                         | 2.181                  | 1.369                              |
| Mensagens                        | 5.168                  | 3.407                              |
| Tamanho do banco                 | 43 MB                  | 37 MB                              |
| Storage                          | ~257 MB                | ~16 MB                             |
| Canais                           | —                      | 4 (`whatsapp_cloud` + `whatsapp_qr`), 3 `whatsapp_config` |
| Chaves de API / webhooks de saída | —                     | 0 / 0                              |

**Achado que afeta qualquer caminho:** **um mesmo e-mail é `owner` de uma conta
em `vn` e `owner` da conta do `rs`** (conferido por hash MD5 do e-mail, sem
expor o endereço). O modelo do app é de **associação única**:
`profiles.account_id` é a fonte de verdade da membership e
`idx_accounts_one_per_owner` impede um usuário de ser dono de duas contas
(migração 017). Consolidar o `rs` em `vn` exige decidir o destino desse
usuário (D-3). Provavelmente é o e-mail do próprio proprietário da plataforma,
que criou a conta do `rs`.

**Achado menor:** 7 linhas de `messages.media_url` no `rs` guardam URL
**absoluta** do Storage do `rs` (`lmmbhwvtxukgomezmilp.supabase.co/...`).
Desligado o `rs`, essas mídias quebram se não forem reescritas.

### 2.2. Como o código fala com o Supabase hoje

| Ponto de acesso                                   | Quantidade (fora testes) | Como obtém URL/chave                                               |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `supabaseAdmin()` (service_role, singleton)       | **87 arquivos**          | `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, uma vez por processo |
| `createClient()` de `lib/supabase/client.ts` (navegador, singleton) | **65 arquivos** | `NEXT_PUBLIC_*` — **embutido no bundle no build**                  |
| `createClient()` de `lib/supabase/server.ts` (SSR) | 23 arquivos             | `NEXT_PUBLIC_*` + cookies da sessão                                |
| `middleware.ts`                                   | 1 (toda request)         | `NEXT_PUBLIC_*`                                                    |
| Realtime (`.channel()` / `postgres_changes`)      | 7 arquivos               | cliente do navegador                                               |
| Rotas de cron com `x-cron-secret`                 | 7                        | `supabaseAdmin()`                                                  |
| Webhooks de entrada (Meta, Evolution)             | 2                        | `supabaseAdmin()`; Meta resolve por `phone_number_id`, Evolution por segredo no path |

Identidade do proprietário da plataforma: **`PLATFORM_OWNER_EMAILS` no `.env`**,
de propósito sem tabela (SPEC 062 §2.2). O console `/admin`, planos, quotas,
bloqueio, auditoria (`platform_audit_log`), outbox de notificações (SPEC 063)
e retenção vivem **no mesmo banco** que os dados das contas.

---

## 3. Por que a arquitetura do prompt não fecha

### B-1. Ovo e galinha na autenticação

O resolver proposto parte do `user_id` para descobrir o banco. Mas o `user_id`
**só existe no `auth.users` do banco onde o usuário foi criado**. Um usuário do
`rs` que digita e-mail e senha em `/login` bate no GoTrue do `vn` (o do `.env`) e
recebe "credenciais inválidas" — não há `user_id` para resolver. O cookie de
sessão do `@supabase/ssr` ainda é nomeado pelo project ref
(`sb-<ref>-auth-token`), então uma sessão de um projeto não é lida pelo cliente
do outro.

O tenant precisa ser conhecido **antes** do login. As únicas fontes possíveis
são: o **host** (`cliente.zapcrm.com.br`), ou um **diretório central de
e-mails** consultado antes de autenticar (que vira um segundo cadastro de
usuários a manter sincronizado, e vaza se um e-mail existe ou não). A
recomendação do prompt para D-1 (`user_id → account_id`) é justamente a
que não funciona.

### B-2. O navegador fala direto com o banco

65 arquivos usam o cliente do navegador — inclusive para escrita (inserção de
contato vai direto do browser, protegida por RLS; é por isso que a quota da
SPEC 059 precisou ser trigger). O Realtime do inbox também. Esse cliente é um
**singleton criado com `NEXT_PUBLIC_*`, que o Next embute no bundle no build**.
Para um cliente dedicado, o navegador precisaria receber em tempo de execução a
URL e a **chave anon/publishable** do outro projeto. O prompt prevê só **uma**
chave (`supabase_key`): na prática são duas, com níveis de confiança opostos — a
anon vai para o navegador, a service_role nunca pode ir.

### B-3. Todo trabalho sem usuário logado fica sem tenant

O resolver depende de usuário logado. Mas 87 arquivos usam `supabaseAdmin()`
justamente porque rodam **sem** usuário: webhooks da Meta e da Evolution,
motores de automação e fluxo, fan-out de disparo em `after()`, os 7 crons,
API pública `/api/v1` (chave de API, não sessão), aceite de convite
`/join/[token]`, cadastro. Cada um precisaria de um caminho próprio de
descoberta de tenant:

- Webhook da Meta chega com `phone_number_id` → precisa de um **diretório
  central** `phone_number_id → tenant` antes de abrir qualquer banco.
- Webhook da Evolution chega com segredo no path → diretório `segredo → tenant`.
- Crons precisam **iterar todos os bancos**, com falha de um isolada dos outros.
- `/api/v1` recebe uma chave de API → diretório `hash da chave → tenant`.

Isso não é um "middleware de resolução"; é um plano de controle inteiro.

### B-4. Fallback para o `.env` grava dado do cliente no banco errado

"Se o cliente dedicado cair, voltar para o Supabase padrão" significa: a
mensagem que chegou pelo webhook do `rs` é gravada no `vn`, sem a conta, o canal
e o contato correspondentes — ou pior, casando por coincidência com dados de
outra conta. Para o usuário logado, nem funciona (B-1: ele não existe no `vn`).
O resultado é **split-brain** sem caminho de reconciliação, e um risco real de
dado de um cliente aparecer na base de outro. **Banco dedicado indisponível
tem que falhar fechado** (503 + página de indisponibilidade), nunca degradar
para outro banco. A recomendação do prompt para D-4 ("silencioso") é a
mais perigosa das três.

### B-5. Aplicar migração com a chave REST não é possível

A `service_role` key dá acesso à API REST (PostgREST), que **não executa DDL**.
Aplicar `supabase/migrations/*.sql` exige a **connection string do Postgres**
(senha do banco) ou um **token pessoal da Management API** do Supabase. Guardar
isso no banco padrão e deixar o app web executar DDL em banco de cliente ao
"criar/editar" um registro é a maior superfície de ataque que o projeto teria:
um bug no `/admin` vira `DROP` em produção de terceiro. E é exatamente o tipo de
operação que este repositório decidiu manter manual e confirmada (`AGENTS.md`:
"sempre confirmar com o mantenedor antes de aplicar migração").

### B-6. A política RLS proposta expõe a chave à conta errada

`USING (is_account_member(account_id, 'admin'))` deixa o **admin da conta
cliente** ler a linha dele em `clients`, com a chave cifrada e a URL. Quem deve
ver isso é o proprietário da plataforma — e o console não usa RLS para isso:
ele é guardado por `PLATFORM_OWNER_EMAILS` no servidor (SPEC 062 §2.2). Tabela
desse tipo seria `service_role`-only, sem policy para `authenticated`.

### B-7. O console do proprietário enxergaria só metade da plataforma

Planos, quotas, bloqueio de conta/usuário, `platform_audit_log`, outbox de
notificações, retenção e o resumo do `/admin` são consultas a **um** banco.
Com contas em N bancos, cada uma dessas telas precisa agregar N fontes — ou o
`/admin` passa a mentir por omissão (o `rs` some da lista de contas, das
quotas, do faturamento).

### B-8. O imposto permanente

Toda SPEC futura que trouxer migração passaria a ser aplicada em N bancos, com
N chances de esquecer uma. A memória do projeto já registra o `rs` ficando
defasado (066→071) sem ninguém perceber até uma conferência manual. Hoje são
2 bancos e isso já aconteceu.

---

## 4. Opções

### Opção A — Consolidar o `rs` em `vn` (sem feature nova)

O `rs` vira uma conta comum do `vn`, como as outras. Um runbook de corte
único, executado uma vez:

1. **Congelar** o `rs` (janela combinada; inbox parado ou modo leitura).
2. **Exportar/importar** as tabelas da conta preservando os UUIDs (colisão de
   `gen_random_uuid` entre os dois bancos é desprezível, mas o script confere).
   Script em `supabase/setup/` ou `scripts/`, **não** migração (mesma regra
   do `cron-jobs.sql`).
3. **Usuários:** copiar `auth.users` + `auth.identities` com o hash de senha
   (`encrypted_password`) — o login continua com a mesma senha. Resolver antes o
   e-mail que é owner nas duas bases (D-3).
4. **Storage:** copiar os ~16 MB de `chat-media`/`avatars` e reescrever as 7
   URLs absolutas de `messages.media_url`.
5. **Segredos cifrados:** tokens da Cloud API e de IA são cifrados com
   `ENCRYPTION_KEY` (AES-256-GCM, `src/lib/whatsapp/encryption.ts`). Se a chave
   do deploy do `rs` for diferente da do `vn`, **decifrar com uma e recifrar com
   a outra** durante a cópia (D-5).
6. **Webhooks de entrada:** apontar o callback do app da Meta usado pelos 3
   números do `rs` e os webhooks das instâncias Evolution para o domínio do
   deploy do `vn`.
7. **Validação:** SQL de conferência de contagens por tabela (origem × destino),
   login dos 3 usuários, envio e recebimento nos dois tipos de canal.
8. **Desligar** o deploy do `rs`; manter o projeto Supabase pausado como backup
   por um prazo definido, depois excluir.

- **Custo:** baixo e único (runbook + script + 1 janela de corte).
- **Risco:** concentrado num evento só, reversível enquanto o `rs` estiver
  pausado e não excluído.
- **Ganho:** o `rs` passa a aparecer no `/admin`, em planos, quotas e auditoria;
  uma migração por SPEC, não duas.

### Opção B — "Instalação dedicada" como oferta (o que o `rs` já é hoje)

Para o cliente que exigir banco próprio (contrato, LGPD, volume, dado
sob controle dele): **um deploy do app + um projeto Supabase só dele**, cada
um com seu `.env`, seu `/admin` e seu `PLATFORM_OWNER_EMAILS`. Zero mudança de
código. É o modelo que o `rs` já usa e já funciona.

- **Custo de código:** zero. **Custo operacional:** N deploys, N aplicações de
  migração, N crons.
- Um utilitário barato reduz o imposto de B-8: um script em `supabase/setup/`
  que, dado o project ref, compara `supabase_migrations.schema_migrations` com
  `supabase/migrations/` e lista o que falta — **leitura apenas**, a aplicação
  continua manual e confirmada.

### Opção C — Registro central de instalações (B com visibilidade)

Se houver ≥ 2 instalações dedicadas ativas: o `/admin` da instalação padrão
ganha uma lista de instalações dedicadas (nome, URL do app, versão de schema,
última checagem de saúde). Cada instalação expõe um endpoint de saúde
protegido por segredo compartilhado que devolve a última migração aplicada.

- **Não guarda chave de banco de ninguém** — a instalação padrão só conhece a
  URL pública do app e um segredo de leitura de saúde. Elimina B-5 e B-6.
- **Não roteia dados** — cada instalação continua isolada. Elimina B-1 a B-4.
- É a versão honesta de "cadastrar o Supabase do cliente no admin": o admin
  **acompanha** as instalações, não **opera dentro** delas.

### Opção D — Roteamento por tenant num único deploy (o prompt, corrigido)

A versão viável do que o prompt descreve exige, no mínimo:

1. Tenant resolvido por **host** no middleware, **antes** do auth (D-1 original → subdomínio).
2. Os três singletons (`admin`, `server`, `client`) viram **fábricas por tenant**;
   o navegador recebe URL + chave anon em tempo de execução (não no build).
3. **Diretório central** no banco padrão: `host → tenant`, `phone_number_id →
   tenant`, `segredo Evolution → tenant`, `hash de chave de API → tenant`.
4. Crons iterando tenants com isolamento de falha.
5. **Fail-closed** sem exceção.
6. `/admin`, planos, quotas, auditoria e notificações agregando N bancos.
7. Migração de schema por pipeline operado fora do app (nunca DDL disparado
   pelo `/admin`).

- **Custo:** toca os ~170 pontos de acesso (§2.2) e a camada de autenticação;
  na ordem de várias SPECs, com regressão possível em tudo. E todo SPEC futuro
  paga o imposto de B-8.
- **Só se justifica** com demanda comercial de vários clientes dedicados que
  não aceitam o modelo B (por exemplo, querem a mesma URL/marca do app
  compartilhado, mas banco próprio).

### Comparação

| Critério                         | A — consolidar | B — instalação dedicada | C — registro central | D — roteamento |
| -------------------------------- | -------------- | ----------------------- | -------------------- | -------------- |
| Resolve o caso `rs`              | ✅ definitivo   | ✅ (estado atual)        | ✅ (estado atual + visão) | ✅          |
| Mudança de código                | nenhuma (script) | nenhuma               | pequena (1 SPEC)     | muito grande   |
| Guarda chave de banco de cliente | não            | não                     | não                  | **sim**        |
| Risco de dado no banco errado    | só na janela de corte | nenhum           | nenhum               | permanente     |
| Imposto em toda migração futura  | **some** (1 banco) | N bancos            | N bancos, com alerta | N bancos       |
| `/admin` enxerga tudo            | ✅              | ❌ (um por instalação)   | parcial (saúde/versão) | ✅ (se agregado) |

---

## 5. Recomendação

1. **Agora:** Opção A para o `rs`. É o objetivo declarado do próprio prompt
   ("unificar"), o volume é pequeno e o ganho é permanente.
2. **Política:** se um cliente futuro exigir banco próprio, Opção B, com o
   script de conferência de versão. Opção C quando houver duas ou mais
   instalações dedicadas ao mesmo tempo.
3. **Opção D:** não iniciar. Reabrir este PRD só com demanda comercial concreta
   que B não atenda.

---

## 6. Decisões para ratificar

| #   | Decisão | Opções | Recomendação |
| --- | ------- | ------ | ------------ |
| D-1 | Destino do `rs` | (a) consolidar em `vn` · (b) manter dedicado | **(a)** |
| D-2 | Banco dedicado é oferta de produto? | (a) não por enquanto · (b) sim, como instalação dedicada (B/C) · (c) sim, com roteamento (D) | **(a)**, com (b) como resposta padrão se surgir pedido |
| D-3 | E-mail que é `owner` em `vn` **e** no `rs` | (a) transferir a titularidade do `rs` para o admin atual do `rs` antes da cópia · (b) o titular do `rs` passa a ser outro e-mail · (c) o usuário fica só no `rs` e a conta dele em `vn` é desligada | **(a)** se o admin do `rs` é o responsável real pelo cliente; confirmar quem é |
| D-4 | Comportamento quando um banco dedicado cai (só se D-2 = b/c) | — | **Fail-closed, não negociável.** Substitui o D-4 do prompt |
| D-5 | `ENCRYPTION_KEY` do deploy do `rs` é igual à do `vn`? | conferir no `.env` da VPS do `rs` | Se diferente: recifrar na cópia (§4, passo 5) |
| D-6 | Janela de corte e prazo do backup | data/hora + dias com o projeto `rs` pausado | definir com o cliente; sugestão: fora do horário comercial, backup por 30 dias |

**Mapeamento das decisões do prompt:** D-1 (identificação) → só existe na
Opção D, e a resposta seria subdomínio, não `user_id` (B-1). D-2 (cache) → só
existe na Opção D. D-3 (migração de dados) → manual com script, é a Opção A.
D-4 (fallback) → fail-closed (B-4). D-5 (criptografia) → na Opção A vira a
pergunta D-5 acima; nas opções B/C não há chave de banco a cifrar.

---

## 7. Fora de escopo

- Qualquer código de roteamento por tenant (Opção D).
- Migração automática de schema disparada pelo app.
- Sincronização contínua de dados entre bancos.
- Mudar o modelo de associação única (`profiles.account_id`) para permitir um
  usuário em várias contas — seria a outra saída para D-3, mas é uma mudança
  de produto própria.

---

## 8. Próximo passo, por decisão

- **D-1 = (a):** escrever o **runbook de consolidação** (`docs/spec-078-consolidacao-rs-em-vn.md`)
  com o script de export/import, o SQL de conferência e o checklist de corte. Fases sugeridas:

  | Fase | Entrega | Modelo sugerido |
  | ---- | ------- | --------------- |
  | F0 | Ratificar D-1, D-3, D-5, D-6; inventário de tabelas com `account_id` e das sem (`auth.*`, `storage.*`) | manual |
  | F1 | Script de export/import por conta preservando UUIDs, com dry-run e contagens | Opus (ordem de FKs e triggers de quota/atividade que disparam no insert) |
  | F2 | Cópia de `auth.users`/`auth.identities` + Storage + reescrita das 7 URLs + recifragem | Opus |
  | F3 | Ensaio completo num projeto Supabase descartável (branch) | Sonnet |
  | F4 | Corte real: congelar, copiar, repontar webhooks Meta/Evolution, validar | manual (Bruno) |
  | F5 | Desligar deploy do `rs`, pausar projeto, registrar prazo do backup | manual |

  Ponto de atenção para F1: os triggers de quota (SPEC 059) e de registro de
  atividade (SPEC 075) **disparam no INSERT** — a cópia precisa desligá-los na
  sessão ou rodar com papel que os contorne, senão o histórico importado conta
  como atividade nova e pode estourar a quota do plano no meio da cópia.

- **D-1 = (b) e D-2 = (b):** nada a codar agora; só o script de conferência de
  versão (Opção B) e, quando houver uma segunda instalação dedicada, a SPEC da
  Opção C.

- **D-2 = (c):** reescrever este PRD como PRD de construção da Opção D antes de
  qualquer SPEC.

---

## 9. Como saber que deu certo (Opção A)

- Os 3 usuários do `rs` entram em `vn` com a senha que já usavam.
- Contagem de contatos, conversas, mensagens, etiquetas, funis, campanhas e
  automações da conta idêntica entre origem e destino.
- Mensagem recebida e enviada nos 4 canais (Cloud e QRCode) aparece no inbox
  da conta em `vn`.
- Mídias antigas (incluindo as 7 de URL absoluta) abrem.
- A conta aparece no `/admin` com plano e quotas corretos.
- Próxima SPEC com migração é aplicada **em um banco só**.
