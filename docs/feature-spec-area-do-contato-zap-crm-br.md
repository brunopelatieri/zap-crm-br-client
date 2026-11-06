# Feature Spec — Área do contato no ZAP CRM BR

> **O que é este arquivo:** a especificação da feature **já implementada** no Valen Ranch, escrita para ser reimplantada no ZAP CRM BR. Consolida a [SPEC 084](./spec-084-area-do-contato.md), o [roteiro de teste manual](./spec-084-teste-manual.md) e a [SPEC 085](./spec-085-cache-control-das-paginas.md), e acrescenta o que muda no destino.
> **Data:** 2026-11-05 · **Status:** pronta para implementar. Nada foi alterado no repositório do ZAP CRM BR.
> **Origem:** repositório Valen Ranch, `main` em `e778c97`.
> **Destino:** `E:\Documentos\0005_Customers\zap-crm-br-client` (`github.com/brunopelatieri/zap-crm-br-client`, privado), `main` em `11e5875`.
> **Número no destino:** ao copiar para o ZAP, este arquivo vira `docs/spec-081-area-do-contato.md` (a última SPEC de lá é a 080). Conferir antes de gravar.

## 1. Resumo

O contato de uma conta entra em `/area` com telefone e senha. A credencial é **do contato** (uma por conta), fica num schema Postgres próprio e usa bcrypt. A sessão é um token opaco num cookie `Path=/area`. O contato **nunca** vira usuário do Supabase Auth: não ganha `auth.users`, `profiles`, JWT nem papel Postgres, então nenhuma policy ou grant da CRM o alcança.

O código de primeiro acesso e de recuperação sai pelo WhatsApp da própria conta e nunca fica em claro no banco do inbox. A entrega é **a porta**: entrar, primeiro acesso, recuperação, escolher conta, painel vazio e minha conta. O conteúdo do painel fica para SPECs próprias do ZAP.

A SPEC 085 entra junto: toda página passa a sair com `Cache-Control: private, no-store`. Sem isso, a página de um contato pode ser servida a outro por um cache compartilhado.

## 2. Hierarquia de acesso

```text
Proprietário da plataforma ──── /admin
        └── Conta (accounts) ──── CRM
               │   usuários: owner > admin > agent > viewer (Supabase Auth)
               └── Contatos (contacts) ──── NOVO: /area
                       acesso = telefone + senha, por contato
                       sessão própria, sem JWT do Supabase
                       nunca é membro da conta, nunca vê a CRM
```

- **Conta** oferece a área: nasce desligada e pode ser desligada a qualquer momento.
- **Acesso** é a credencial de um contato numa conta. A mesma pessoa em três contas tem três acessos.
- **Mesma senha em duas contas:** a pessoa entra uma vez e escolhe a conta. Com senhas diferentes, só abre a conta cuja senha bateu.
- **Por que acesso por conta:** o código passa pelo canal da conta, e a equipe consegue lê-lo no celular do canal QRCode. Com senha global, a equipe da conta A redefiniria a senha e entraria na conta B da mesma pessoa.

## 3. Estado de partida (medido em 2026-11-05)

### 3.1. Fatos

| Fato                  | Valor                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ponto comum           | Commit `ea146e5` (2026-10-22), ancestral dos dois repositórios                                                                                                                |
| `src/` e `messages/`  | **Sem nenhuma mudança** no ZAP desde `ea146e5`; os 8 commits de lá são de docs, contexto e Docker                                                                             |
| Dependências          | `package.json` idêntico. A feature não adiciona pacote                                                                                                                        |
| Variáveis de ambiente | Nenhuma nova. `NEXT_PUBLIC_SITE_URL` já é obrigatória na imagem do ZAP e é trocada ao subir por `docker/runtime-env.mjs`                                                      |
| Migrações             | ZAP vai até `089`; próximo número livre `090`                                                                                                                                 |
| `supabase/`           | **Fora do git** nos dois repositórios. Migrações e seeds são copiados à mão; não vêm em patch                                                                                 |
| `scripts/`            | Fora do git no ZAP (linha `/scripts` do `.gitignore`). Existe no checkout                                                                                                     |
| Repo público          | `github.com/brunopelatieri/zap-crm-br` está em `938db2f` (2026-09-09) e **não contém** `ea146e5`. Por isso o destino desta especificação é o `zap-crm-br-client`               |
| Modelo de instância   | Um app e um Supabase: `zap.local.ia.br` + `vn`                                                                                                                                |
| Registro no `vn`      | Para em 085, embora os objetos de 086–089 existam. `list_migrations` **não serve** para conferir versão no `vn`                                                               |

### 3.2. Ensaio do porte

Feito num clone temporário do ZAP, sem tocar nos dois repositórios: os 8 commits da feature aplicaram **sem nenhum conflito**, limitados a `src`, `messages` e `next.config.ts`. Todos os arquivos da feature ficaram idênticos aos do Ranch.

Depois das adaptações de cookie, chave de `sessionStorage`, nomes de migração e seeds (§10.3, §7.2 e §7.4), o clone deu:

| Etapa          | Resultado                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`    | Passou                                                                                                                                       |
| `i18n:check`   | Passou, com 3.676 chaves nos dois idiomas                                                                                                    |
| `lint`         | 0 erros e 7 avisos                                                                                                                           |
| `test`         | 298 arquivos e 4.326 testes passaram, inclusive o contrato de limites contra as migrações renumeradas                                        |
| `build`        | Passou; as 15 rotas de `/area` aparecem no manifesto                                                                                         |
| `format:check` | Falhou em 1.158 arquivos pelo fim de linha do clone (`core.autocrlf=true` com `endOfLine: lf`), não pelo conteúdo. Os arquivos `.ts`/`.tsx` alterados passaram com `--end-of-line auto` |

Os textos de Z-2 e Z-3 ainda não estavam trocados nesse ensaio.

**Não ensaiado:** as migrações não rodaram em nenhum banco do ZAP. O Docker estava parado na medição, então também não houve Postgres local. As pré-condições do §7.1 existem para cobrir isso.

## 4. Decisões antes de começar

| #   | Decisão                                  | Recomendação                                                                                         | Quem        |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------- |
| Z-1 | Planos que incluem a área                | `false` em todos no seed e ligar um por vez. Atenção ao §7.4                                         | Mantenedor  |
| Z-2 | Texto do aceite de uso                   | Sem texto definitivo no Ranch. O ZAP precisa do próprio, com revisão jurídica, antes de ligar para cliente real | Mantenedor |
| Z-3 | Frase do painel vazio                    | Trocar `ContactPortal.panel.comingSoonBody`, que fala de inscrições e comprovantes (§10.3)           | Mantenedor  |
| Z-4 | Nome visível                             | Manter "Área do contato"                                                                             | Mantenedor  |
| Z-5 | Endurecimento de RPCs (Ranch 090–092)    | Tarefa separada e **anterior** a ligar a área em produção (§14)                                      | Mantenedor  |
| Z-6 | Propostas abertas da revisão de segurança | Implementar o teto diário por telefone (§9.3, A-6) antes de abrir para muitas contas                 | Mantenedor  |

## 5. Comportamento

### 5.1. Jornadas

| Jornada | Gatilho                                                                       | Resultado                                                                                     |
| ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **J1**  | Usuário clica em "Enviar acesso" na ficha ou no painel da conversa            | Contato recebe código (válido por 24 h) e link, digita o código, cria a senha e entra         |
| **J2**  | Contato envia a palavra-chave (padrão `SENHA`) ao número da conta             | Resposta com código e link na mesma conversa. Sem automação, flow ou IA                       |
| **J3**  | Contato abre `/area/c/<código>` ou `/area` e pede o primeiro acesso           | Código sai pela conta do endereço; em `/area`, pela conta da conversa mais recente            |
| **J4**  | Telefone + senha                                                              | Uma conta: painel. Várias: tela de escolher conta                                             |
| **J5**  | "Esqueci minha senha"                                                         | Igual à J3. Redefine só o acesso da conta que entregou o código e encerra as sessões dele     |

Quem não é contato recebe a mesma resposta de quem é: "Se este número tiver acesso, enviamos um código pelo WhatsApp."

### 5.2. Telas (`src/app/(portal)/area/`, fora de busca e sem o shell da CRM)

| URL                                                | Conteúdo                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/area`                                            | Entrar, genérico                                                                          |
| `/area/c/<código>`                                 | Entrar com o nome da conta. Código inválido dá 404; conta não elegível mostra o genérico  |
| `/area/c/<código>/codigo`                          | Destino do link da mensagem: lê `#c=`, preenche o campo e tira o fragmento da barra        |
| `/area/primeiro-acesso`, `/area/recuperar`         | Telefone → envio do código. Aceitam `?conta=<código>`                                     |
| `/area/codigo`                                     | Código + nova senha + confirmação + aceite, numa tela só                                  |
| `/area/escolher-conta`                             | Só quando a senha vale em mais de uma conta                                               |
| `/area/painel`                                     | Saudação, nome da conta e bloco "Em breve"                                                |
| `/area/minha-conta`                                | Nome, telefone mascarado, trocar senha, sair, sair de todos os aparelhos                  |

O telefone passa da tela de pedir código para a de digitar código por `sessionStorage`, nunca pela URL. A tela de código usa o medidor de senha e a regra de `password-policy.ts`.

### 5.3. Lado da conta e papéis

| Ação                                                          | viewer | agent | admin+ |
| ------------------------------------------------------------- | ------ | ----- | ------ |
| Ver estado (sem acesso, convite enviado, ativo, bloqueado) e último login | sim    | sim   | sim    |
| Enviar acesso (J1); o botão respeita opt-out                  | não    | sim   | sim    |
| Bloquear, desbloquear, encerrar sessões                       | não    | não   | sim    |
| Configurações → Área do contato                               | não    | não   | sim    |

- **Configurações:** ligar/desligar, canal dos códigos, template `AUTHENTICATION`, palavra-chave e endereço `/area/c/<código>`.
- **Ficha:** cartão `ContactPortalAccessCard` na aba Detalhes e no painel lateral da conversa.
- **Console `/admin`:** "ligada/desligada · N contatos com acesso".
- **Atividade:** `contact.portal_invited`, `contact.portal_blocked`, `contact.portal_unblocked`. Login comum não entra.

### 5.4. Ciclo de vida

| Evento                  | Efeito                                                                 | Como                                                                 |
| ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Contato excluído        | Acesso e sessões somem                                                 | `ON DELETE CASCADE`                                                  |
| Telefone alterado       | Acesso, códigos e sessões somem. Trocar número nunca transfere a senha | Gatilho `contact_portal_phone_changed`                               |
| Conta bloqueada         | Contatos dela param de entrar nela. Outras contas seguem               | `account_is_eligible` a cada requisição                              |
| Conta excluída          | Acessos removidos                                                      | `ON DELETE CASCADE`                                                  |
| Área desligada ou plano sem o item | Acesso negado com mensagem neutra; senha preservada         | `account_is_eligible` a cada requisição                              |
| Acesso bloqueado        | Sessões apagadas na hora, senha preservada                             | `portal_set_blocked`                                                 |

## 6. Regras de execução

- **E-1 — Elegibilidade numa função só.** Conta elegível = `settings.enabled` + `plan_feature(account_id, 'contact_portal_enabled')` + `accounts.blocked_at IS NULL`. Acesso elegível = conta elegível + `access.blocked_at IS NULL`. Reconferido a cada requisição, sem cache.
- **E-2 — Telefone: candidatos.** `phone_normalized` é só "tirar não dígitos", e há celulares sem o nono dígito. O servidor gera até dois candidatos (canônico de 13 dígitos e legado de 12). O primeiro é a chave dos contadores.
- **E-3 — Código e senha numa tela só**, sem ticket intermediário.
- **E-4 — O código nasce no Node** (`crypto.randomInt`, seis dígitos), o hash no banco. Em claro, só na memória da rota até o envio.
- **E-5 — Custo do bcrypt:** senha `bf` 10, código `bf` 8. Sem candidato, roda um `crypt` de mesmo custo. Medido no Ranch: bf 10 ≈ 74 ms e bf 8 ≈ 18 ms. O teto do Ranch (compute Micro) é cerca de 27 logins/s; medir de novo no `vn` se o compute for outro.
- **E-6 — IP:** primeiro valor de `x-forwarded-for`. O banco guarda só `sha256(ip)`.
- **E-7 — Sem variável de ambiente nova.** Limites são constantes em `src/lib/contact-portal/limits.ts`.
- **E-8 — Sem cron novo.** Vencidos são apagados dentro das próprias funções.

## 7. Banco

### 7.1. Pré-condições (rodar antes, no projeto confirmado)

Regra do ZAP: perguntar o projeto, rodar `get_project_url` e confirmar com o mantenedor antes de qualquer escrita. As consultas abaixo são só leitura.

```sql
select e.extname, n.nspname from pg_extension e
join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';
-- Esperado: pgcrypto em extensions. As migrações NÃO criam a extensão.

select md5(prosrc) from pg_proc where oid = 'public.handle_new_user()'::regprocedure;
-- Ver a tabela abaixo.

select to_regnamespace('contact_portal');          -- Esperado: nulo
select count(*) from pg_proc where proname = 'plan_feature';  -- Esperado: 1
select to_regclass('public.whatsapp_billing_status'),
       exists(select 1 from pg_proc where proname = 'sync_profile_email');  -- 089 presente
select count(*) from public.contacts;              -- Dimensiona o índice do §7.3
```

| `md5(prosrc)`                      | Significado                                       | Ação                                                                                          |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `42dbf56301eec1b34457364a82b27754` | Versão da 067 com fim de linha LF                 | Seguir                                                                                        |
| `2ce62f9d86dece7b37aed920a7f9621a` | Mesma versão, aplicada com CRLF                   | Trocar o hash esperado na asserção 4 da primeira migração e seguir                            |
| Outro                              | A função não é a da 067                           | **Parar.** Ler a função e entender o desvio. Não enfraquecer a asserção                       |

### 7.2. Migrações

Três arquivos. Copiar do Ranch e renumerar. O SQL fica idêntico, exceto o aviso de origem no topo, para o diff com o Ranch continuar trivial.

| Ranch                                     | ZAP                                      | Conteúdo                                                                            |
| ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `094_contact_portal.sql`                  | `090_contact_portal.sql`                 | Schema, tabelas, gatilho, 16 funções `portal_*`, asserções                          |
| `095_contact_portal_public_account.sql`   | `091_contact_portal_public_account.sql`  | `portal_public_account`: nome da conta em `/area/c/<código>`                        |
| `096_contact_portal_limit_locks.sql`      | `092_contact_portal_limit_locks.sql`     | Travas por telefone, bcrypt nos ramos `no_match`, chave canônica do convite         |

**Não dependem das migrações 090–093 do Ranch.** Cada `portal_*` faz `REVOKE ALL … FROM PUBLIC, anon, authenticated` explícito, então funciona sem a `091_default_privileges_functions_closed` do Ranch. A asserção 3 confere isso e falha alto.

### 7.3. Schema `contact_portal`

Fora de "Exposed schemas" e sem `USAGE` para ninguém além do dono. RLS ligada em todas as tabelas, **sem policy**: só o dono das funções lê.

| Tabela           | Papel                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `settings`       | `account_id` PK, `enabled` (padrão `false`), `channel_id`, `auth_template_id`, `keyword` (padrão `SENHA`, `NULL` desliga), `public_code` único de 8 caracteres |
| `access`         | `contact_id` PK, `account_id`, `phone`, `password_hash` (nulo = convite pendente), convite, ativação, último login, bloqueio, termos |
| `codes`          | `purpose` (`first_access`, `reset`, `invite`), `code_hash`, `expires_at`, `attempts`, `consumed_at`. Um código ativo por contato  |
| `sessions`       | `token_hash` (`bytea`), `current_contact_id`, 30 dias deslizantes                                                                 |
| `session_access` | Quais acessos a sessão abriu                                                                                                      |
| `attempts`       | Contadores por `kind` e `key_hash`                                                                                                |

**Principais ajudantes internos:** `account_is_eligible`, `candidates`, `canonical_phone` e `lock_phone`.

**Índice em tabela viva:** a primeira migração cria `idx_contacts_phone_normalized` em `public.contacts` sem `CONCURRENTLY`, o que bloqueia escrita em contatos durante a construção. Se a contagem do §7.1 for grande, criar antes, fora de transação, e a migração seguirá adiante pelo `IF NOT EXISTS`:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_phone_normalized
  ON public.contacts (phone_normalized);
```

**Funções do contato** (todas `SECURITY DEFINER`, `search_path = public`, só `service_role`):

| Função                                                        | Faz                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `portal_request_code`                                         | Aplica limites, escolhe o contato, grava o hash. Devolve `(status, contact_id, account_id)`                          |
| `portal_complete_code`                                        | Confere o código (5 erros consomem), grava senha e termos, apaga as sessões do acesso                                |
| `portal_login`                                                | Confere a senha contra cada acesso elegível do telefone. Devolve os `contact_id` que bateram                         |
| `portal_create_session`, `portal_resolve_session`             | Criam e validam a sessão. A resolução desliza a validade e devolve só acessos **ainda** elegíveis                    |
| `portal_select_account`, `portal_change_password`, `portal_logout` | Trocam de conta, trocam a senha (e apagam as outras sessões), encerram esta sessão ou todas                     |
| `portal_public_account`                                       | Nome da conta pelo código público. Só para conta elegível; nunca devolve o id                                        |

**Funções da conta** (chamadas depois de `requireRole`): `portal_account_settings_get`, `portal_account_settings_set`, `portal_access_status`, `portal_active_contact_ids`, `portal_invite`, `portal_set_blocked`, `portal_end_sessions`, `portal_account_summary`.

### 7.4. Plano

`contact_portal_enabled` entra em `FEATURE_KEYS` (`src/lib/plans/types.ts`) e nos dois seeds do ZAP (`plans-seed.sql` e `plans-seed-vn.sql`).

**Armadilha:** `plan_feature()` devolve `TRUE` para chave ausente e quando as quotas estão desligadas. Enquanto o seed não rodar, ou com `quotas_enforced` desligado, todo plano permite a área. O freio passa a ser só o `enabled` de cada conta, que nasce `false`. O seed precisa gravar `false` explícito onde o item não vale.

`src/lib/plans/catalog.test.ts` valida o seed contra `FEATURE_KEYS`.

### 7.5. Depois de aplicar

1. `get_advisors` (security) no mesmo projeto. Esperado: nenhuma `portal_*` nos WARN e 6 INFO 0008 de `contact_portal`, sem policy por desenho.
2. Conferir no painel que `contact_portal` não está em "Exposed schemas".
3. Rodar os seeds de planos.
4. Atualizar `docs/context/status.md` do ZAP: última migração, próximo número e chaves de i18n.

## 8. Envio do código

| Situação                                  | Como sai                                                    |
| ----------------------------------------- | ----------------------------------------------------------- |
| Canal QRCode                              | Texto livre com código e link                               |
| Cloud API com janela de 24 h aberta       | Texto livre com código e link                               |
| Cloud API fora da janela                  | Template `AUTHENTICATION` de `settings.auth_template_id`    |
| Cloud API, sem template aprovado          | `needs_template`: a UI avisa e a J2 continua valendo        |
| Teto de envio frio do QRCode atingido     | `cold_limit`                                                |

- **Redação:** `sendAndPersistOutbound` manda o texto real ao provedor e grava `[código de acesso enviado]` em `messages`. Envio de motor não dispara webhook de saída. Origem nova no log: `contact_portal`.
- **Eco `fromMe` da Evolution:** no teste real o eco chegou ~450 ms **antes** do `INSERT`. Por isso `ingest.ts` descarta o eco quando `looksLikePortalCodeMessage` reconhece o marcador fixo `🔐` mais seis dígitos. O marcador fica fora da tradução de propósito.
- **Link:** `{NEXT_PUBLIC_SITE_URL}/area/c/<código-da-conta>/codigo#c=<código>`. O código vai no fragmento, que não chega ao servidor nem ao log do proxy. A origem vem **só** da variável (`configuredSiteOrigin`), nunca do host da requisição.
- **Template:** corpo com `add_security_recommendation`, rodapé com `code_expiration_minutes: 10`, botão `OTP`/`COPY_CODE`. No envio, o código vai no `body` e no botão de índice `"0"` com `sub_type: url`. Os componentes prontos viajam em `rawComponents`.
- **Palavra-chave:** etapa de `ingestInbound` depois do opt-out e antes dos flows. Compara sem acento, sem caixa e com espaços colapsados. Consumida, suprime flows, gatilhos de conteúdo e IA.
- **Opt-out:** a J1 respeita. J2, J3 e J5 são transacionais e pedidas pelo contato, então ignoram.
- **Teto frio:** no QRCode, `last_customer_message_at` fica sempre nulo, e todo envio de motor contava como frio. Sem a correção `loadLastInboundAt`, a J1 e a J2 falham com `cold_limit`. Ela vale também para automações, flows e IA, e **muda o comportamento dessas rotinas no ZAP**.

## 9. Segurança

### 9.1. Limites

Fonte única: `PORTAL_LIMITS` em `limits.ts`. Cada função recebe em `p_limits` e falha com `22023` se faltar chave.

| Chave                | Janela | Máximo                                       |
| -------------------- | ------ | -------------------------------------------- |
| Envio por telefone   | 60 s   | 1                                            |
| Envio por telefone   | 1 h    | 5                                            |
| Envio por IP         | 1 h    | 20                                           |
| Erros de código por IP | 15 min | 30                                         |
| Erros de login por telefone | 15 min | 10                                    |
| Erros de login por IP | 15 min | 30                                          |
| Validade do código   | —      | 10 min (convite: 24 h), 5 erros o invalidam  |

A rota traduz `throttled` em 429 só no login e na conclusão do código. No pedido de código a resposta segue neutra, com piso de 750 ms (`PORTAL_REQUEST_CODE_MIN_MS`) em todos os caminhos.

### 9.2. Isolamento

- `/area` sai cedo do middleware, sem `getUser()`. A sessão da área não abre nenhuma rota da CRM.
- O cookie não começa com `sb-` e só vale em `Path=/area`. É `HttpOnly`, `SameSite=Lax` e `Secure` fora de `http://localhost`.
- O login sempre gera token novo. O banco guarda só o sha256.
- Toda escrita em `/area/api/*` confere `Origin` (`guardWrite`). Ausente ou `null` responde 403.
- Rotas `/area/api/*` importam só `@/lib/contact-portal/*`. Dentro da área, só `service.ts` e `account.ts` tocam `@/lib/supabase/*`.
- Rotas da conta: `requireRole`, depois contato conferido pela RLS da sessão (`visibleContact[Ids]`), depois `portal_*`.
- `isolation.test.ts` e `middleware.contact-portal.test.ts` prendem essas regras por varredura estática e por teste de rota.

### 9.3. Achados da revisão do Ranch

**Já corrigidos no código portado:** A-1 (cache), A-2 (link por host forjado), A-3 (tempo do pedido), A-4 (corrida nos limites, na terceira migração) e A-9 (chave do convite).

**Abertos, herdados pelo ZAP:**

| #    | Gravidade | Risco                                                                                                  | Ação no ZAP                                                                              |
| ---- | --------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| A-5  | Médio     | Se o proxy repassar `X-Forwarded-For` do cliente, os limites por IP caem                               | Conferir na stack: Traefik é a borda, sem `forwardedHeaders.insecure`/`trustedIPs` abertos, e porta do app não publicada |
| A-6  | Médio     | 25 palpites/h por telefone somam ~1,8 % de acerto em 30 dias                                           | Decidir Z-6: `send_phone_per_day` (10) ou `code_phone_fail_per_day` (20)                 |
| A-7  | Baixo     | Qualquer um trava o login de um telefone por 15 min. A recuperação por código continua                 | Aceito                                                                                   |
| A-8  | Baixo     | Desligar a área ou bloquear a conta não apaga sessões. Religar em até 30 dias as revive                | Decidir se apaga                                                                         |
| A-10 | Baixo     | Com a mesma linha salva duas vezes, o código pode nascer para um contato e sair na conversa do outro   | Aceito                                                                                   |
| A-11 | Info      | `Path=/area` impede o prefixo `__Host-`                                                                | Aceito                                                                                   |
| A-12 | Info      | O contato que reencaminhar o código ao número da conta o grava em claro                                | Aceito                                                                                   |

## 10. Aplicação

### 10.1. Arquivos novos (62)

| Caminho                                                   | Conteúdo                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/lib/contact-portal/`                                 | `types`, `limits`, `phone`, `code`, `session`, `current`, `request`, `http`, `service`, `journeys`, `delivery`, `keyword`, `account`, com testes |
| `src/app/(portal)/`                                       | Layout, telas da §5.2 e rotas `area/api/`: `request-code`, `complete-code`, `login`, `logout`, `select-account`, `change-password` |
| `src/app/api/contact-portal/`                             | `settings` (GET/PATCH), `contacts/status`, `contacts/[contactId]/invite`, `/block`, `/sessions` |
| `src/components/contact-portal/`                          | `portal-card`, `login-form`, `request-code-form`, `code-form`, `session-actions`, `password-input`, `portal-api` |
| `src/components/contacts/contact-portal-access-card.tsx`  | Cartão de estado e ações                                                                     |
| `src/components/settings/contact-portal-settings.tsx`     | Aba de Configurações                                                                         |
| `src/middleware.contact-portal.test.ts`                   | Isolamento no middleware                                                                     |
| `src/next-config.test.ts`                                 | Política de cache                                                                            |
| `src/lib/whatsapp/meta-api.template.test.ts`              | Envio de template com `rawComponents`                                                        |

### 10.2. Arquivos alterados (30)

| Arquivo                                                                 | Mudança                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/middleware.ts`                                                     | `/area` e abaixo saem antes do `createServerClient`                           |
| `next.config.ts`                                                        | Política de cache (§11)                                                       |
| `src/lib/plans/types.ts`                                                | `contact_portal_enabled`                                                      |
| `src/lib/activity/types.ts`                                             | Três ações `contact.portal_*`                                                 |
| `src/lib/channels/ingest.ts` e teste                                    | Descarte do eco e etapa da palavra-chave                                      |
| `src/lib/channels/send.ts` e teste, `send-log.ts`, `types.ts`           | `rawComponents`, origem `contact_portal`, leitura da última mensagem do contato |
| `src/lib/channels/adapters/whatsapp-cloud.ts`, `src/lib/whatsapp/meta-api.ts` | Repasse de `rawComponents`                                              |
| `src/lib/channels/cold-send-wiring.ts` e teste                          | `loadLastInboundAt`                                                           |
| `src/lib/whatsapp/send-message.ts` e teste                              | Teto frio pela mesma leitura                                                  |
| `src/lib/whatsapp/template-components.ts`, `template-send-builder.ts`, `template-validators.ts` e testes | Payload e envio `AUTHENTICATION`; corpo opcional nessa categoria |
| `src/app/(dashboard)/settings/page.tsx`, `src/components/settings/settings-sections.ts` | Aba `contact-portal` (`minRole: 'admin'`)                     |
| `src/components/contacts/contact-detail-view.tsx`, `src/components/inbox/contact-sidebar.tsx` | Cartão de acesso                                        |
| `src/app/(platform)/admin/accounts/[accountId]/page.tsx`, `src/app/api/platform/accounts/[accountId]/route.ts` | Resumo no console                      |
| `messages/en.json`, `messages/pt-BR.json`                               | +126 chaves: de 3.550 para 3.676 em cada arquivo                              |

A API pública `/api/v1` não muda.

### 10.3. Adaptações obrigatórias no destino

| Item                         | Ranch                                      | ZAP                                                         | Onde                                                                 |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Cookie de sessão             | `vr_area_session`                          | `zap_area_session`                                          | `session.ts`, `middleware.contact-portal.test.ts`                    |
| Chave de `sessionStorage`    | `valenranch:area:phone`                    | `zapcrm:area:phone`                                         | `portal-api.ts`                                                      |
| Nomes de migração em teste   | `094_…`, `096_…`                           | `090_…`, `092_…`                                            | `limits.test.ts`, `phone.test.ts`                                    |
| Frase do painel              | "Inscrições, comprovantes e resultados…"   | Texto genérico (Z-3), nos dois idiomas                      | `ContactPortal.panel.comingSoonBody`                                 |
| Versão dos termos            | `2026-10-30`                               | Data do texto aprovado (Z-2)                                | `PORTAL_TERMS_VERSION` em `journeys.ts`                              |
| Texto dos termos             | Só a frase do checkbox                     | Texto aprovado (Z-2)                                        | `ContactPortal.code.terms`                                           |
| Comentário                   | "a porta do competidor"                    | "a porta do contato"                                        | `src/app/(portal)/area/painel/page.tsx`                              |
| Referências em comentário    | `SPEC 084`, `PRD 081`, `SPEC 085`          | Manter: apontam para a origem, explicada na tabela abaixo   | Código portado                                                       |

| Citação em comentário do código | Onde ler no ZAP                       |
| ------------------------------- | ------------------------------------- |
| `SPEC 084`, `PRD 081`           | Esta especificação (origem: Valen Ranch) |
| `SPEC 085`                      | §11 desta especificação               |
| `migração 094/095/096`          | ZAP `090/091/092`                     |

Domínios de exemplo nos testes (`dev.valenranch.com.br`, `Valen Ranch`) são dados de teste e não afetam a execução. Trocá-los é opcional.

## 11. Cache-Control das páginas (SPEC 085)

**Problema.** O catch-all de `headers()` em `next.config.ts` põe `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` em toda página, e esse valor vence o `private` que o Next põe nas páginas dinâmicas. Com cache compartilhado na frente, a página de um usuário e o `Set-Cookie` do refresh de sessão podem ir para outra pessoa. O ZAP tem hoje essa regra.

| Caminho                                                                  | `Cache-Control`                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Toda página: CRM, auth, convite, console, `/area/**`, `/area/api/*`      | `private, no-store`                                             |
| Arquivo solto na raiz de `public/`, um segmento, com extensão de estático | `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` |
| `/api/*`                                                                 | `no-store`                                                      |
| `/emojibase/*`, `/opus/*`                                                | `public, max-age=31536000, immutable`                           |
| `/_next/static/*`, `/_next/image`                                        | Definido pelo Next                                              |

Extensões da segunda linha: `svg`, `png`, `jpe?g`, `gif`, `webp`, `avif`, `ico`, `json`, `txt`, `xml`, `webmanifest`. Uma extensão abaixo da raiz, como `/area/x.json`, continua privada.

**Por que resolve o motivo original.** A regra pública existia porque um CDN guardava HTML velho apontando para chunks sumidos. Com `no-store`, nenhum HTML fica na edge. O custo é a página não entrar no bfcache de alguns navegadores.

**Alcance:** esta mudança vale para a CRM inteira, não só para a área.

## 12. Plano de implementação

| Fase | Entrega                                                                 | Pronto quando                                                  | Modelo recomendado                                 |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| F0   | Decisões Z-1 a Z-6                                                      | Registradas nesta especificação                                | Decisão humana                                     |
| F1   | Aplicar patches, copiar migrações e seeds, adaptações da §10.3          | Gate local passa                                               | **Sonnet**: trabalho mecânico guiado               |
| F2   | Pré-condições e migrações no `vn`, com confirmação                      | Asserções passam; `get_advisors` sem achado novo               | **Opus**: decide diante de qualquer desvio no banco |
| F3   | Deploy, conferências do §13.2 e medições da SPEC 085                    | Cabeçalhos e variável conferidos no host                       | **Sonnet**                                         |
| F4   | Roteiro manual do §13.4                                                 | Todos os cenários obrigatórios marcados                        | **Haiku** para o checklist; a pessoa opera o WhatsApp |
| F5   | Revisão de segurança do diff                                            | `/security-review` sem achado HIGH ou MEDIUM novo              | **Opus**                                           |
| F6   | Ligar para a primeira conta real, depois dos termos e do Z-5            | Primeira conta em produção com o aceite definitivo             | Decisão humana                                     |

### 12.1. Commits a portar

Aplicar nesta ordem, sempre limitando aos caminhos indicados. Sem esse limite, `docs/` conflita já no primeiro commit.

| Commit    | Conteúdo                                      | Caminhos                                       |
| --------- | --------------------------------------------- | ---------------------------------------------- |
| `83ad199` | Item de plano                                 | `src`, `messages`, `next.config.ts`            |
| `08c0570` | Núcleo, envio do código, telas, middleware    | `src`, `messages`, `next.config.ts`            |
| `c3f58fe` | Lado da conta                                 | `src`, `messages`, `next.config.ts`            |
| `91823f9` | Correção do teto de envio frio                | `src`, `messages`, `next.config.ts`            |
| `1a4f590` | Correções da revisão de segurança             | `src`, `messages`, `next.config.ts`            |
| `c4a8227` | Testes de paridade com a terceira migração    | `src`, `messages`, `next.config.ts`            |
| `4b30fea` | SPEC 085                                      | `src`, `messages`, `next.config.ts`            |
| `792699a` | Cartão no painel da conversa                  | **Só** `src/components/inbox/contact-sidebar.tsx` |

`2155c5d` só tem documentação e fica de fora.

### 12.2. Gate

Gate local do ZAP, ao fim da F1:

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

Com `core.autocrlf=true`, o `git am` pode deixar CRLF nos arquivos que tocar, e `format:check` exige LF. Se isso acontecer, rodar `npx prettier --write` nos arquivos alterados. O conteúdo versionado não muda.

## 13. Critérios de aceite e testes

### 13.1. Critérios

1. Contato de teste sem senha recebe o código pelos três caminhos, cria a senha e entra, **sem linha nova** em `auth.users`, `accounts`, `profiles` ou `account_plans`.
2. Mesma pessoa em duas contas com a mesma senha entra uma vez e troca de conta. Com a área desligada numa delas, só vê a outra.
3. Redefinir pela conta A não muda o acesso da conta B.
4. Telefone que não é contato recebe a mesma resposta, e nenhum código sai.
5. Com sessão de contato, `/dashboard`, `/inbox`, `/contacts` e `/api/**` da CRM respondem redirect ou 401. Usuário e contato convivem no mesmo navegador.
6. O código não aparece em claro em `messages`, inbox, webhooks de saída ou logs.
7. Excluir o contato, trocar o telefone, bloquear a conta ou desligar a área tira o acesso na hora.
8. `get_advisors` sem achado novo.
9. Toda página sai com `private, no-store`, e a CRM carrega com estilo logo após um segundo deploy.

No Ranch, os critérios 2, 3 e 7 ficaram parciais: provados por construção e por teste, faltando conta com Cloud API e template aprovado. No ZAP, valem como obrigatórios.

### 13.2. Conferências de deploy

- `NEXT_PUBLIC_SITE_URL` preenchida na stack. Sem ela, a mensagem sai sem link.
- Traefik como borda, conforme A-5.
- `contact_portal` fora de "Exposed schemas".
- Opcional: `rateLimit` do Traefik em `/area/api/*`, como freio barato antes do bcrypt.

### 13.3. Consultas de apoio (só leitura)

Trocar `<contact_id>` pelo contato de teste. Nunca use contato real.

```sql
-- Estado do acesso
select contact_id, account_id, (password_hash is not null) as tem_senha,
       left(password_hash, 7) as custo, invited_at, activated_at,
       last_login_at, blocked_at, terms_version
from contact_portal.access where contact_id = '<contact_id>';

-- Código: só o hash e o estado
select purpose, left(code_hash, 7) as custo, expires_at, attempts, consumed_at, created_at
from contact_portal.codes where contact_id = '<contact_id>'
order by created_at desc limit 5;

-- Sessões do acesso
select s.id, s.created_at, s.last_seen_at, s.expires_at
from contact_portal.sessions s
join contact_portal.session_access sa on sa.session_id = s.id
where sa.contact_id = '<contact_id>';

-- Contadores da última hora
select kind, count(*) from contact_portal.attempts
where created_at > now() - interval '1 hour' group by kind;

-- Nada novo no cadastro do SaaS
select (select count(*) from auth.users      where created_at >= '<data>') as users,
       (select count(*) from public.accounts where created_at >= '<data>') as accounts,
       (select count(*) from public.profiles where created_at >= '<data>') as profiles;

-- Código em claro no inbox (esperado: 0 e 0)
select (select count(*) from public.messages
         where content_text like '%🔐%' and content_text ~ '\m[0-9]{6}\M') as mensagens,
       (select count(*) from public.conversations
         where last_message_text like '%🔐%' and last_message_text ~ '\m[0-9]{6}\M') as previas;
```

### 13.4. Roteiro manual

**Regras:** só leitura nas consultas; envio real só para contato de teste, em conta de teste; sem disparo em massa. Antes de cada envio pelo QRCode, faça o contato escrever ao número da conta, para não gastar envio frio. Rode 8 e 15 por último. `<ZAP_URL>` é a URL da instância e `<CÓDIGO>` o endereço público da conta.

| #  | Cenário                                | Passos                                                                                     | Esperado                                                                                                     |
| -- | -------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1  | J3 pela web                            | `/area/c/<CÓDIGO>` → Primeiro acesso → telefone → link do WhatsApp → senha → aceite        | Painel; `$2a$10$`; uma sessão; cadastro zerado; uma bolha `[código de acesso enviado]`; `#c=` some da barra  |
| 2  | J1 pela ficha                          | "Enviar acesso" para contato sem senha                                                     | Código válido por 24 h; atividade `contact.portal_invited`; sem código no `metadata`                         |
| 3  | J2 e variações                         | Enviar `SENHA`, ` senha ` e `Sénha`                                                        | Código na conversa; nenhuma automação, flow ou IA; mensagem do contato fica como comum                       |
| 4  | J4 e J5                                | Sair, entrar; depois "Esqueci minha senha"                                                 | Sessão nova a cada login; sessão anterior perde o acesso; eco descartado                                     |
| 5  | Duas contas com template fora da janela | Conta B Cloud API com template aprovado, mesmo contato sem conversa em 24 h; enviar acesso; mesma senha; depois senha diferente | Template com "copiar código"; tela de escolher conta com A e B; depois só A             |
| 6  | Reset em A não muda B                  | Recuperar por A                                                                            | Senha de B continua valendo                                                                                  |
| 7  | Não contato                            | `/area` → Primeiro acesso com número inexistente, depois com o contato                     | Mesma tela; `{"ok":true}` nos dois; ≥ 750 ms; nada enviado ao primeiro                                       |
| 8  | Seis pedidos em uma hora               | Intervalo acima de 60 s                                                                    | Cinco entregam; o sexto mostra a mesma tela e não envia                                                      |
| 9  | Isolamento                             | Janela anônima com sessão da área: `/dashboard`, `/inbox`, `/contacts`, `/settings`, `GET /api/contacts`. Janela normal com CRM e área | Redirect para `/login` e 401. As duas sessões convivem; cookies com `Path` certo    |
| 10 | Ciclo de vida                          | Excluir contato descartável, trocar telefone, bloquear conta, desligar área, bloquear acesso | Volta para `/area` em todos. Registrar o que acontece ao religar (A-8)                                     |
| 11 | Trocar senha                           | Dois navegadores; trocar em A                                                              | A segue; B volta para `/area`; senha antiga não entra                                                        |
| 12 | Sair de todos os aparelhos             | Dois navegadores                                                                           | Os dois voltam para `/area`                                                                                  |
| 13 | Limite de login                        | Onze senhas erradas                                                                        | Dez 401, a 11ª 429; senha certa também 429 nos 15 min; nenhuma mensagem sai                                  |
| 14 | Paralelo não fura o limite             | Onze logins errados simultâneos                                                            | No máximo 10 viram 401, o resto 429; `login_phone` = 10                                                      |
| 15 | Cinco códigos errados                  | Pedir código, errar cinco vezes, digitar o certo                                           | Certo recusado; `attempts = 5`; `consumed_at` preenchido                                                     |
| 16 | Papéis                                 | `viewer`, `agent` e `admin` na ficha e em Configurações                                    | Conforme §5.3                                                                                                |
| 17 | Teto frio em automação                 | Automação no QRCode responde a quem acabou de escrever                                     | Não conta como envio frio                                                                                    |

Comandos dos cenários de borda:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<ZAP_URL>/area/api/login -H "content-type: application/json" -d '{"phone":"11900000000","password":"x"}'
```

Esperado acima: `403`, sem `Origin`.

```bash
curl -s -X POST https://<ZAP_URL>/area/api/request-code -H "content-type: application/json" -H "origin: https://exemplo.invalid" -H "x-forwarded-host: exemplo.invalid" -d '{"phone":"<telefone de teste>","publicCode":"<CÓDIGO>","purpose":"reset"}'
```

Esperado acima: 403 ou, se passar, link da mensagem apontando para `NEXT_PUBLIC_SITE_URL`.

```bash
curl -s -o /dev/null -w "%{time_total}\n" -X POST https://<ZAP_URL>/area/api/request-code -H "content-type: application/json" -H "origin: https://<ZAP_URL>" -d '{"phone":"11900000000","purpose":"first_access"}'
```

Esperado acima: ≥ 0,75 s, sem diferença visível entre número de contato e de não contato.

### 13.5. Medição da SPEC 085 (com `next start` e no host)

```bash
for p in /login /dashboard /inbox /admin /join/x /area /area/painel /auth/confirm /; do printf '%s ' "$p"; curl -sI "https://<ZAP_URL>$p" | grep -i '^cache-control'; done
```

Esperado acima: `private, no-store` em todas.

```bash
for p in /og-image.webp /openapi.json /favicon.ico; do printf '%s ' "$p"; curl -sI "https://<ZAP_URL>$p" | grep -i '^cache-control'; done
```

Esperado acima: `public, max-age=0, s-maxage=300, stale-while-revalidate=86400`. Conferir também `/api/...` com `no-store` e `/emojibase/...` com `immutable`.

Sem `.env.local`, o middleware devolve 500 e o Next põe o cabeçalho de erro dele. Para medir localmente, passe `NEXT_PUBLIC_SUPABASE_URL` e a chave anon falsas só no ambiente do processo.

## 14. Fora do porte

| Item do Ranch                                                   | Por quê                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Migrações 090–092 (endurecimento de RPCs)                       | Tarefa separada, mas **prioritária**: o Ranch encontrou funções herdadas do ZAP executáveis com a chave anon, entre elas `upsert_webhook_funnel`, `purge_webhook_ingest_logs` e `recount_account_usage`. As migrações 001–089 são as mesmas, então o `vn` deve ter o mesmo problema; não foi conferido nesta especificação |
| Migração 093, `log-purge.ts`, fase 7 do cron (SPEC 083)         | Outra feature                                                                                                            |
| Identidade Valen (`34c306a`, `9f9ab39`)                         | Marca do Ranch                                                                                                           |
| Correções `db5b1a6` e `859f13e` (nome do contato)               | Sem relação com a área. Úteis ao ZAP, em tarefa própria                                                                  |
| Trecho de `792699a` no webhook da Evolution (revogação `fromMe`) | Sem relação com a área. Portar só `contact-sidebar.tsx`                                                                  |
| Barreiras de docs no `Dockerfile`                               | O ZAP tem as próprias                                                                                                    |
| `plans-seed-rs.sql`                                             | O projeto `rs` foi removido do ZAP                                                                                       |
| §12 da SPEC 084 (ganchos de prova) e regras de Ranch Sorting    | Não se aplicam ao ZAP                                                                                                    |

## 15. Pendências herdadas

- **Filtro "com acesso ativo" na lista de contatos:** filtrar por `.in('id', …)` estoura a URL e `service_role` furaria o escopo por papel. Fazer no servidor, respeitando a RLS. A função `portal_active_contact_ids` já existe.
- **Evento `contact.portal_activated`:** `portal_complete_code` não diz se foi primeiro acesso. Pede migração pequena, com `DROP FUNCTION`.
- **QR code do endereço em Configurações:** não há gerador no cliente.
- **Template `AUTHENTICATION`:** cada conta oficial precisa aprovar o seu na Meta. O custo da conversa é da conta.
