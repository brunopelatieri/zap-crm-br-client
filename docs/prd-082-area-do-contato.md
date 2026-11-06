# PRD 082 — Área do contato: login do cliente final em `/area`, liberado por plano

> **O que é este arquivo:** o PRD do ZAP CRM BR para a **área do contato**, feature já implementada no Valen Ranch (SPEC 084, roteiro de teste manual e SPEC 085 daquele repositório, `main` em `e778c97`) e portada para cá. Substitui o antigo `docs/feature-spec-area-do-contato-zap-crm-br.md`, que misturava produto e execução num arquivo só e não seguia a numeração da casa. O detalhe técnico está na SPEC 083.

**Status:** decisões D-1…D-11 (§4) **ratificadas pelo mantenedor em 2026-11-05**. Próxima fase: F1 (§9). Nada foi alterado ainda em `src/`, `messages/` ou `supabase/`.
**Data:** 2026-11-05.
**SPEC de execução:** [`docs/spec-083-area-do-contato.md`](./spec-083-area-do-contato.md).
**Pré-requisito em produção:** [`SPEC 081`](./spec-081-aperto-de-rpcs-definer-e-privilegios-padrao.md) aplicada no `vn` (D-8).
**Emenda declarada ao PRD 058:** a §5.1 daquele PRD lista as chaves de recurso dos planos. Este PRD acrescenta `contact_portal_enabled` e, pela primeira vez, faz uma chave de recurso **bloquear de verdade** uma rota e uma RPC (§2, D-2).

---

## 1. Por que agora

1. **O cliente final hoje não tem porta.** O contato de uma conta só existe como linha em `contacts` e como conversa no inbox. Qualquer serviço que o ZAP queira oferecer ao cliente do cliente (consultar um pedido, baixar um comprovante, confirmar um agendamento) precisa antes de uma identidade do contato que **não** seja um usuário do CRM. Sem a porta, cada recurso futuro reinventaria login, senha e sessão.
2. **A implementação já existe e foi testada.** O Ranch construiu, revisou e testou a porta inteira (login por telefone e senha, código pelo WhatsApp da própria conta, sessão própria, isolamento da CRM). O ensaio do porte aplicou os 8 commits no ZAP sem conflito ([SPEC 083 §2.2](./spec-083-area-do-contato.md)). O custo aqui é adaptação e decisão, não construção.
3. **É um recurso comercializável.** Diferente de etiqueta ou resposta rápida, a área do contato é algo que o mantenedor pode cobrar por plano. O motor de planos (PRD 058, SPEC 059) já tem chave de recurso booleana, exceção por conta e checkbox no console; falta só a chave e a guarda.

## 2. O que já existe (e por que isso encurta o trabalho)

| Peça                                         | Onde                                                         | Papel aqui                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `FEATURE_KEYS` e `PlanFeatures`              | `src/lib/plans/types.ts`                                     | A chave nova entra na lista; `catalog.test.ts` valida o seed contra ela                                                     |
| `plan_feature(account_id, key)`              | migração 067                                                 | Lê `plans.features \|\| account_plans.limit_overrides`. **Devolve `TRUE` para chave ausente e com quotas desligadas** (D-2) |
| Checkbox por chave de recurso no console     | `src/app/(platform)/admin/plans/page.tsx`                    | Itera `FEATURE_KEYS`: a chave nova aparece **sem código novo** no editor de plano                                           |
| Exceção por conta (`limit_overrides`)        | `PUT /api/admin/accounts/[accountId]/plan`, console da conta | Permite ligar a área para **uma** conta sem mudar o catálogo (D-1)                                                          |
| Rótulo do recurso no catálogo do cliente     | `messages/*.json` → `Plan.featureLabel.<chave>`              | A chave nova precisa de rótulo nos dois dicionários, senão `MISSING_MESSAGE`                                                |
| `requireRole(min)`                           | `src/lib/auth/account.ts:259`                                | Guarda de papel das rotas do lado da conta                                                                                  |
| `minRole` em `SectionMeta`                   | `src/components/settings/settings-sections.ts`               | Gate da aba nova de Configurações (`admin`)                                                                                 |
| `sendAndPersistOutbound`, teto de envio frio | `src/lib/channels/send.ts`, `cold-send-wiring.ts`            | O código de acesso sai pelo canal da conta e é redigido no inbox                                                            |
| `password-policy.ts` e medidor               | `src/lib/auth/password-policy.ts`, `src/components/auth/`    | Mesma régua de senha do CRM na tela do contato                                                                              |
| `NEXT_PUBLIC_SITE_URL`                       | imagem Docker, `docker/runtime-env.mjs`                      | Origem do link da mensagem; já obrigatória                                                                                  |

**Achado importante:** as cinco chaves de recurso que já existem (`ai_enabled`, `api_v1_enabled`, `flows_enabled`, `broadcasts_enabled`, `webhooks_out_enabled`) estão **só no catálogo e na UI do console**. Nenhuma rota de `src/app/api/` e nenhuma RPC em `supabase/migrations/` chama `plan_feature()` hoje (`grep -rn plan_feature src` devolve só comentários). A área do contato será a primeira chave que bloqueia um caminho de verdade, e por isso a semântica de `plan_feature()` precisa ser decidida agora (D-2).

## 3. Objetivo

Entregar **a porta**, e só ela: o contato de uma conta entra em `/area` com telefone e senha, recebe o código de primeiro acesso e de recuperação pelo WhatsApp da própria conta, escolhe a conta quando a mesma senha vale em mais de uma, vê um painel vazio e administra a própria senha e sessões. O lado da conta liga e desliga a área, envia o acesso pela ficha do contato e bloqueia um acesso. O proprietário da plataforma decide, por plano ou por conta, quem pode oferecer a área.

### 3.1. Fora de escopo (explicitamente)

- **Qualquer recurso dentro da área logada.** O painel nasce com um bloco "Em breve" e nada mais. Não há consulta de pedido, comprovante, agendamento, histórico de conversa nem perfil editável. Cada recurso futuro entra por PRD próprio e, quando for cobrado, por chave de plano própria (D-5).
- Cadastro espontâneo do contato: só quem já é contato da conta recebe código. Quem não é recebe a mesma resposta neutra.
- Login social, e-mail, OTP por SMS ou qualquer canal que não o WhatsApp da conta.
- QR code do endereço `/area/c/<código>` em Configurações (não há gerador no cliente; pendência herdada).
- Filtro "com acesso ativo" na lista de contatos (pendência herdada; a RPC `portal_active_contact_ids` já existe).
- Mudança na API pública `/api/v1`: nenhuma.
- Marca e textos do Valen Ranch: não são portados.

## 4. Decisões de produto

### D-1 — A área é um item de plano: `contact_portal_enabled`, desligado em todos os planos

A chave entra em `FEATURE_KEYS` e nos dois seeds (`plans-seed.sql` e `plans-seed-vn.sql`) com `false` **explícito** em `free`, `essential`, `professional` e `enterprise`. Ligar é decisão comercial posterior, por dois caminhos que já existem:

- **Por plano:** marcar a checkbox no editor de planos do console (`/admin/plans`) ou editar o seed e rodá-lo de novo. Vale para todas as contas do plano.
- **Por conta:** `limit_overrides.contact_portal_enabled = true` pela tela da conta no console. Vale só para aquela conta, sem mexer no catálogo. É o caminho para a primeira conta piloto (F6).

**Por que não "ligado no Profissional para cima" desde o seed:** a área abre uma superfície pública de login (`/area`) que ainda não passou pelo roteiro manual em produção (SPEC 083 §11.4) nem tem texto de aceite revisado (D-9). O mantenedor liga uma conta por vez enquanto isso não fecha.

### D-2 — A guarda é fail-closed: chave ausente ou quotas desligadas **não** liberam a área

`plan_feature()` da migração 067 devolve `TRUE` quando a chave não está no plano e quando `platform_settings.quotas_enforced` está `FALSE` (PRD 058 D-1 e D-3: quota é opt-in e ausência é "ilimitado"). Esse padrão é certo para quota de contatos, e errado para uma porta de login: num deployment que nunca rodou o seed, ou com quotas desligadas, **todo** plano liberaria a área e o único freio seria o `enabled` de cada conta.

Decisão: a elegibilidade da área usa uma função nova, `plan_feature_strict(account_id, key)`, com três diferenças em relação a `plan_feature()`:

1. Chave ausente é `FALSE`.
2. `quotas_enforced` **não** é consultado. O item é uma permissão comercial, não um teto de uso; ele vale mesmo em deployment que não aplica quota.
3. Conta sem `account_plans` é `FALSE`.

`plan_feature()` continua como está para as cinco chaves antigas; mudar a semântica delas é outro PRD. A função nova fica numa migração só do ZAP (SPEC 083 §5.2), para as três migrações portadas continuarem byte a byte iguais às do Ranch.

**Alternativa descartada:** usar `plan_feature()` e confiar no seed. Foi a escolha do Ranch, que tem um deployment só e roda o seed junto. O ZAP é fork público: um terceiro que suba o app sem o seed teria a área aberta para todas as contas no primeiro clique em "ligar".

### D-3 — Dupla trava: plano **e** interruptor da conta

Conta elegível = `plan_feature_strict(account_id, 'contact_portal_enabled')` **e** `contact_portal.settings.enabled` **e** `accounts.blocked_at IS NULL`. As três são reconferidas a cada requisição da área, sem cache, numa função só (`account_is_eligible`, SPEC 083 E-1).

O interruptor da conta nasce `false` e é ligado por `admin` ou `owner` em Configurações → Área do contato. O plano libera; a conta decide usar. Sem a segunda trava, ligar um plano ligaria a área em contas que nunca configuraram canal nem palavra-chave.

### D-4 — Plano sem o item: a UI esconde, a rota recusa, a área responde neutro

Mesmo padrão da SPEC 059 §7.3 ("não mostra botão que devolve 403"), em três camadas, nenhuma bastando sozinha:

| Camada                                   | Comportamento                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI da conta                              | A aba "Área do contato" em Configurações fica visível para `admin+` com um aviso "não incluído no seu plano" e os controles desabilitados; o cartão na ficha e no painel da conversa **não** aparece |
| Rotas da conta (`/api/contact-portal/*`) | Depois de `requireRole`, conferem a chave e respondem `403` com código `FEATURE_NOT_IN_PLAN` (mensagem em inglês, como toda `/api/**`)                                                               |
| Área do contato (`/area/**`)             | `account_is_eligible` falha; login, pedido de código e sessão existente recebem a mesma resposta neutra de "conta não elegível". Senha e sessões não são apagadas (D-6)                              |

Por que a aba fica visível com aviso, e não some: o `admin` precisa descobrir que o recurso existe e que depende do plano. Esconder a aba esconderia o produto.

### D-5 — Uma chave para a porta; recursos futuros têm chave própria

`contact_portal_enabled` libera **só** o que este PRD entrega. Um recurso dentro da área que venha a ser cobrado ganha a própria chave (`contact_portal_<recurso>_enabled`), o próprio PRD e a própria linha no seed. A chave da porta nunca vira guarda-chuva: se virasse, ligar a porta para um plano barato ligaria junto tudo o que vier depois.

Recurso futuro **gratuito** (incluído para quem tem a porta) não precisa de chave; a SPEC do recurso diz isso.

### D-6 — Perder o item não destrói dado

Downgrade de plano, remoção da exceção por conta, desligar o interruptor ou bloquear a conta **negam o acesso na próxima requisição e preservam** senha, termos aceitos e sessões. Religar em até 30 dias revive as sessões (achado A-8 do Ranch, aceito). Mesma regra do PRD 058 D-4: estourar ou perder plano bloqueia, nunca apaga. Apagar sessões ao desligar fica como decisão aberta na SPEC 083 §7.3.

### D-7 — A credencial é do contato, por conta, e nunca entra no Supabase Auth

Herdado do Ranch e mantido: o contato não ganha `auth.users`, `profiles`, JWT nem papel Postgres. A senha fica num schema próprio (`contact_portal`), com bcrypt, e a sessão é um token opaco em cookie `Path=/area`. A mesma pessoa em três contas tem três acessos; com a mesma senha, entra uma vez e escolhe a conta. Motivo: o código passa pelo canal da conta e a equipe consegue lê-lo no celular do QRCode. Com senha global, a equipe da conta A redefiniria a senha e entraria na conta B da mesma pessoa.

### D-8 — SPEC 081 antes de ligar a área em produção

As migrações 090 e 091 (aperto das RPCs `SECURITY DEFINER` e privilégios padrão) são tarefa separada e **anterior** à primeira conta real com a área. Motivo: a área adiciona 16 funções `SECURITY DEFINER` e um schema novo num banco onde `anon` ainda executa funções que não checam quem chama. As migrações da área não dependem da 091 (cada `portal_*` revoga `PUBLIC`, `anon` e `authenticated` explicitamente), então podem ser **escritas e testadas** antes; só a ida a produção espera.

### D-9 — Texto de aceite de uso próprio do ZAP, com revisão, antes da primeira conta real

O Ranch não tem texto definitivo; a tela de código mostra só a frase do checkbox. O ZAP precisa do próprio texto, revisado, e a versão dos termos (`PORTAL_TERMS_VERSION`) passa a ser a data do texto aprovado. Até lá a feature pode ir a produção **desligada** em todos os planos (D-1).

### D-10 — Teto diário por telefone antes de abrir para muitas contas

Achado A-6 do Ranch: 25 palpites por hora por telefone somam cerca de 1,8 % de acerto em 30 dias. Antes de ligar a área em mais de uma conta, implementar um teto diário (`send_phone_per_day` = 10 ou `code_phone_fail_per_day` = 20). É mudança em `PORTAL_LIMITS` e numa `portal_*`, então pede migração pequena; vai na SPEC 083 como fase própria.

### D-11 — Dois efeitos colaterais na CRM inteira, aceitos

1. **`Cache-Control: private, no-store` em toda página** (SPEC 085 do Ranch, §9 da SPEC 083). O catch-all de `next.config.ts` põe hoje `public, s-maxage=300` em toda página, inclusive nas que carregam `Set-Cookie` de sessão. Com cache compartilhado na frente, a página de um usuário pode ir para outro. A correção vale para a CRM inteira, não só para `/area`; o custo é a página não entrar no bfcache de alguns navegadores.
2. **Teto de envio frio passa a ler a última mensagem recebida do contato** (`loadLastInboundAt`). No QRCode, `last_customer_message_at` fica sempre nulo e todo envio de motor contava como frio. A correção vale também para automações, flows e IA: envio para quem acabou de escrever deixa de gastar o teto frio. É mudança de comportamento de rotinas que já estão em produção.

## 5. Hierarquia de acesso

```text
Proprietário da plataforma ──── /admin
        │   decide, por plano ou por conta, quem pode oferecer a área (D-1)
        └── Conta (accounts) ──── CRM
               │   usuários: owner > admin > agent > viewer (Supabase Auth)
               │   admin+ liga a área, escolhe canal, template e palavra-chave (D-3)
               └── Contatos (contacts) ──── NOVO: /area
                       acesso = telefone + senha, por contato e por conta (D-7)
                       sessão própria, sem JWT do Supabase
                       nunca é membro da conta, nunca vê a CRM
```

## 6. Experiência

### 6.1. Jornadas do contato

| Jornada | Gatilho                                                             | Resultado                                                                                 |
| ------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **J1**  | Usuário clica em "Enviar acesso" na ficha ou no painel da conversa  | Contato recebe código (24 h) e link, digita o código, cria a senha e entra                |
| **J2**  | Contato envia a palavra-chave (padrão `SENHA`) ao número da conta   | Resposta com código e link na mesma conversa. Sem automação, flow ou IA                   |
| **J3**  | Contato abre `/area/c/<código>` ou `/area` e pede o primeiro acesso | Código sai pela conta do endereço; em `/area`, pela conta da conversa mais recente        |
| **J4**  | Telefone + senha                                                    | Uma conta: painel. Várias: tela de escolher conta                                         |
| **J5**  | "Esqueci minha senha"                                               | Igual à J3. Redefine só o acesso da conta que entregou o código e encerra as sessões dele |

Quem não é contato, ou cuja conta não é elegível (D-3), recebe a mesma resposta de quem é: "Se este número tiver acesso, enviamos um código pelo WhatsApp."

### 6.2. Telas do contato (`/area/**`, fora de busca e sem o shell da CRM)

`/area` (entrar) · `/area/c/<código>` (entrar com o nome da conta) · `/area/c/<código>/codigo` (destino do link) · `/area/primeiro-acesso` e `/area/recuperar` · `/area/codigo` (código + senha + aceite numa tela) · `/area/escolher-conta` · `/area/painel` (saudação, nome da conta, bloco "Em breve") · `/area/minha-conta` (nome, telefone mascarado, trocar senha, sair, sair de todos os aparelhos). Detalhe na SPEC 083 §4.2.

### 6.3. Lado da conta e papéis

| Ação                                                                    | viewer | agent | admin+ |
| ----------------------------------------------------------------------- | ------ | ----- | ------ |
| Ver estado do acesso (sem acesso, convite enviado, ativo, bloqueado)    | sim    | sim   | sim    |
| Enviar acesso (J1); o botão respeita opt-out                            | não    | sim   | sim    |
| Bloquear, desbloquear, encerrar sessões                                 | não    | não   | sim    |
| Configurações → Área do contato (ligar, canal, template, palavra-chave) | não    | não   | sim    |

Tudo acima **só com o item no plano** (D-4). Console `/admin`: a conta mostra "ligada/desligada · N contatos com acesso", e o editor de plano e a tela da conta ganham a checkbox da chave sem código novo.

### 6.4. Registro de atividade

`contact.portal_invited`, `contact.portal_blocked`, `contact.portal_unblocked`. Login comum do contato não entra no registro da conta.

## 7. Riscos

| #   | Risco                                                                                                     | Mitigação                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R-1 | Primeira chave de plano que bloqueia de verdade: descobrir que `plan_feature()` libera demais em produção | D-2 (função estrita, fail-closed) e teste de contrato na SPEC 083 §11                                         |
| R-2 | Superfície pública de login em `/area`                                                                    | Limites por telefone e IP, bcrypt, resposta neutra, `Origin` obrigatório (SPEC 083 §7); D-10 antes de escalar |
| R-3 | `X-Forwarded-For` forjado derruba os limites por IP                                                       | Conferir que o Traefik é a borda e a porta do app não é publicada (SPEC 083 A-5)                              |
| R-4 | Custo de CPU do bcrypt no compute do `vn`                                                                 | Medir `bf 10` e `bf 8` no `vn`; o Ranch mediu 74 ms e 18 ms no Micro, teto de ~27 logins/s                    |
| R-5 | A correção do teto frio muda automações, flows e IA em produção (D-11)                                    | Cenário 17 do roteiro manual; anunciar no deploy                                                              |
| R-6 | `no-store` em toda página tira o HTML do cache de borda (D-11)                                            | Era o motivo original da regra pública; medir carregamento após dois deploys (critério 10)                    |
| R-7 | Texto de aceite sem revisão em conta real                                                                 | D-9: a área só liga para conta real depois do texto aprovado                                                  |

## 8. Critérios de aceite

1. Contato de teste sem senha recebe o código pelos três caminhos (J1, J2, J3), cria a senha e entra, **sem linha nova** em `auth.users`, `accounts`, `profiles` ou `account_plans`.
2. Mesma pessoa em duas contas com a mesma senha entra uma vez e troca de conta. Com a área desligada numa delas, só vê a outra.
3. Redefinir pela conta A não muda o acesso da conta B.
4. Telefone que não é contato recebe a mesma resposta, e nenhum código sai.
5. Com sessão de contato, `/dashboard`, `/inbox`, `/contacts` e `/api/**` da CRM respondem redirect ou 401. Usuário e contato convivem no mesmo navegador.
6. O código não aparece em claro em `messages`, inbox, webhooks de saída ou logs.
7. Excluir o contato, trocar o telefone, bloquear a conta ou desligar a área tira o acesso na hora.
8. **Plano:** com `contact_portal_enabled` ausente ou `false` e `quotas_enforced` em qualquer valor, a aba mostra o aviso, o cartão da ficha some, `/api/contact-portal/*` responde 403 `FEATURE_NOT_IN_PLAN` e `/area` responde neutro. Com `limit_overrides.contact_portal_enabled = true` só numa conta, só ela passa. Trocar o plano da conta para um sem o item nega o acesso na requisição seguinte sem apagar senha.
9. `get_advisors` (security) sem achado novo no `vn`; `contact_portal` fora de "Exposed schemas".
10. Toda página sai com `private, no-store`, e a CRM carrega com estilo logo após um segundo deploy.

No Ranch, os critérios 2, 3 e 7 ficaram parciais (provados por construção e por teste, sem conta com Cloud API e template aprovado). No ZAP, valem como obrigatórios. O critério 8 é novo.

## 9. Sequência sugerida

| Fase | Entrega                                                                                  | Pronto quando                                     | Modelo recomendado                                    |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| F0   | Ratificar D-1…D-11                                                                       | Registradas aqui                                  | Decisão humana (Opus 5.5 para discutir alternativas)  |
| F1   | Porte dos 8 commits, item de plano, guarda estrita, adaptações (SPEC 083 §8 e §10)       | Gate local passa                                  | Sonnet 5.5: trabalho mecânico guiado                  |
| F2   | Pré-condições e migrações 093–096 no `vn`, com confirmação do mantenedor                 | Asserções passam; `get_advisors` sem achado novo  | Opus 5.5: decide diante de qualquer desvio no banco   |
| F3   | Deploy, conferências de borda e medição do `Cache-Control`                               | Cabeçalhos e variável conferidos no host          | Sonnet 5.5                                            |
| F4   | Roteiro manual (SPEC 083 §11.4), inclusive os cenários de plano                          | Todos os cenários obrigatórios marcados           | Haiku 5.5 para o checklist; a pessoa opera o WhatsApp |
| F5   | Revisão de segurança do diff                                                             | `/security-review` sem achado HIGH ou MEDIUM novo | Opus 5.5                                              |
| F6   | Primeira conta piloto por `limit_overrides`, depois dos termos (D-9) e da SPEC 081 (D-8) | Conta em produção com aceite definitivo           | Decisão humana                                        |
| F7   | Teto diário por telefone (D-10) antes de ligar por plano                                 | Migração pequena aplicada e cenário 8 reexecutado | Sonnet 5.5                                            |

Recursos **dentro** da área logada não têm fase aqui: cada um nasce do próprio PRD (D-5), quando houver demanda.
