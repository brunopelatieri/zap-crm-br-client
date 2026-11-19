# SPEC 083 — Área do contato: porte do Valen Ranch para o ZAP CRM BR, com liberação por plano

**PRD:** [`docs/prd-082-area-do-contato.md`](./prd-082-area-do-contato.md)
**Origem:** Valen Ranch, `main` em `e778c97` (SPEC 084, roteiro de teste manual da 084 e SPEC 085 daquele repositório)
**Status:** **F1 feita no código em 2026-11-05** — porte por arquivo (§10.1), guarda de plano (§8.4, `plan-gate.ts` + 403 nas rotas), adaptações (§8.3), migrações 093–096 e seeds escritos localmente (fora do git, **não aplicados no `vn`**), `INDEX.md` e `auth-e-conta.md`. Gate local: `typecheck` ✓ · `i18n:check` ✓ (3.682 chaves) · `lint` 0 erros / 7 avisos pré-existentes na árvore versionada · `test` 299 arquivos / 4.354 testes ✓ · `format:check` só o baseline de `docs/` · `build` ✓ com as 15 rotas de `/area` no manifesto. **F2 feita em 2026-11-06 no `vn`**: pré-condições OK (hash de `handle_new_user` `42dbf563…`, `contact_portal` inexistente, 089/092 presentes, 1.349 contatos, `quotas_enforced = true`, SPEC 081 ainda não aplicada); 093, 094, 095 e 096 aplicadas uma a uma e conferidas pelos objetos (a 096 falhou na asserção (b) porque o corpo da função citava a palavra da asserção em comentário; rollback limpo, comentário reescrito, asserção intacta, reaplicada). `get_advisors` (security): só os 6 INFO 0008 de `contact_portal`, nenhuma `portal_*` nem `plan_feature_strict` em WARN. `contact_portal` fora de "Exposed schemas" (conferido no painel). Nas 5 contas, `plan_feature_strict` e `account_is_eligible` = `false`; para chave ausente, `plan_feature` = `true` e a estrita = `false`. **Seed não rodado** (o catálogo vivo diverge de `plans-seed-vn.sql`): gravado só `contact_portal_enabled: false` nos 5 planos, e o arquivo de seed precisa ser reconciliado com o `vn` antes de qualquer uso. Pendente: SPEC 081 (D-8) e termos (D-9) antes da primeira conta real; roteiro manual (§11.4) e F6. **F3 medida em 2026-11-06 em `https://zap.local.ia.br`** (deploy feito pelo mantenedor): §11.5 com `curl` — `private, no-store` em `/login`, `/dashboard`, `/inbox`, `/admin` (404), `/join/x`, `/area`, `/area/painel`, `/auth/confirm` e `/`; `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` em `/og-image.webp`, `/openapi.json` e `/favicon.ico`; `/api/v1/contacts` com `no-store`; `/emojibase/pt/data.json` e `/_next/static/…` com `public, max-age=31536000, immutable`. §11.2: nenhum marcador `zapcrm-placeholder` no HTML de `/login`, `/area` e `/area/c/<código>` (variáveis `NEXT_PUBLIC_*` trocadas na subida); `POST /area/api/login` sem `Origin` e com `Origin` alheio dá 403; `GET /api/contact-portal/settings` sem login dá 401; a aba "Área do contato" em Configurações abre com o aviso "não está incluída no seu plano" (guarda de plano fechando, conta no plano sem a chave). Não verificados daqui: Traefik como borda (A-5) e `rateLimit` opcional em `/area/api/*`, que ficam com o mantenedor. **F4 encerrada em 2026-11-06 sem concluir o roteiro** (decisão do mantenedor; resultado e pendências em §14): 1 e 3 aprovados, 4 e 18 reprovados, 9 parcial, demais pendentes. **F5 bloqueada** até 4 e 18 serem resolvidos · **Data:** 2026-11-06
**Pré-requisito em produção:** [`SPEC 081`](./spec-081-aperto-de-rpcs-definer-e-privilegios-padrao.md) aplicada no `vn` (PRD 082 D-8)
**Migrações:** `093_contact_portal.sql`, `094_contact_portal_public_account.sql`, `095_contact_portal_limit_locks.sql` (portadas) e `096_contact_portal_plan_gate_strict.sql` (só do ZAP)

> `/supabase` e `/scripts` estão no `.gitignore`: migrações e seeds são copiados à mão e não entram em commit. Só esta SPEC, o PRD e os `.md` de contexto vão para o Git.

---

## 1. Resumo

O contato de uma conta entra em `/area` com telefone e senha. A credencial é **do contato** (uma por conta), fica num schema Postgres próprio e usa bcrypt. A sessão é um token opaco num cookie `Path=/area`. O contato **nunca** vira usuário do Supabase Auth: não ganha `auth.users`, `profiles`, JWT nem papel Postgres, então nenhuma policy ou grant da CRM o alcança.

O código de primeiro acesso e de recuperação sai pelo WhatsApp da própria conta e nunca fica em claro no banco do inbox. A entrega é **a porta**: entrar, primeiro acesso, recuperação, escolher conta, painel vazio e minha conta. Nenhum recurso dentro da área logada (PRD 082 §3.1 e D-5).

O que muda em relação ao Ranch:

1. **Liberação por plano** (PRD 082 D-1…D-4): chave `contact_portal_enabled`, guarda fail-closed `plan_feature_strict()`, aviso na aba, 403 na rota, resposta neutra na área. §5.4 e §8.4.
2. **Numeração:** migrações 093–095 (o Ranch usa 094–096) e uma quarta, 096, só do ZAP.
3. **Adaptações de nome** (cookie, `sessionStorage`, textos). §8.3.

A SPEC 085 do Ranch entra junto (§9): toda página passa a sair com `Cache-Control: private, no-store`. Sem isso, a página de um contato pode ser servida a outro por um cache compartilhado.

## 2. Estado de partida (medido em 2026-11-05)

### 2.1. Fatos

| Fato                  | Valor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ponto comum           | Commit `ea146e5` (2026-10-22), ancestral dos dois repositórios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/` e `messages/`  | Desde `ea146e5`, o ZAP mudou `src/` só em `37af386` e `f8a5c75` (App ID da Meta por canal, `src/lib/whatsapp/`); o resto é docs, contexto e Docker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Dependências          | `package.json` idêntico. A feature não adiciona pacote                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Variáveis de ambiente | Nenhuma nova. `NEXT_PUBLIC_SITE_URL` já é obrigatória na imagem do ZAP e é trocada ao subir por `docker/runtime-env.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Migrações             | ZAP vai até `092` (`092_whatsapp_config_app_id.sql`); próximo número livre `093` ([`status.md`](./context/status.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `supabase/`           | **Fora do git** nos dois repositórios. Migrações e seeds são copiados à mão; não vêm em patch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `scripts/`            | Fora do git no ZAP (linha `/scripts` do `.gitignore`). Existe no checkout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Repo público          | `github.com/brunopelatieri/zap-crm-br` está em `938db2f` (2026-09-09) e **não contém** `ea146e5`. O destino desta SPEC é o `zap-crm-br-client`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Modelo de instância   | Um app e um Supabase: `zap.local.ia.br` + `vn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Registro no `vn`      | Para em 085, embora os objetos de 086–089 e 092 existam. `list_migrations` **não serve** para conferir versão no `vn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Chaves de recurso     | As cinco de `FEATURE_KEYS` não são aplicadas por nenhuma rota nem RPC (PRD 082 §2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Fonte do porte        | `E:\Documentos\008_Valen\ranch_decrapeted` (checkout do Ranch, **sem `.git`**: o mantenedor renomeou a pasta e a desvinculou do GitHub em 2026-11-05 sem alterar conteúdo, então o disco é o `main` do Ranch). Os hashes citados aqui não são verificáveis nele; a feature está inteira no disco: `src/lib/contact-portal/` (26 arquivos), `src/app/(portal)/` (18), `src/components/contact-portal/` (7), migrações 094–096, seeds com `contact_portal_enabled: false`, `docs/spec-084-area-do-contato.md` e `docs/spec-085-cache-control-das-paginas.md`. `src/` difere do ZAP em 55 arquivos e 12 caminhos só do Ranch; só parte disso é a feature (§10.1) |

### 2.2. Ensaio do porte

Feito num clone temporário do ZAP, sem tocar nos dois repositórios: os 8 commits da feature aplicaram **sem nenhum conflito**, limitados a `src`, `messages` e `next.config.ts`. Todos os arquivos da feature ficaram idênticos aos do Ranch.

Depois das adaptações de cookie, chave de `sessionStorage`, nomes de migração e seeds, o clone deu:

| Etapa          | Resultado                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typecheck`    | Passou                                                                                                                                                                         |
| `i18n:check`   | Passou, com 3.676 chaves nos dois idiomas                                                                                                                                      |
| `lint`         | 0 erros e 7 avisos                                                                                                                                                             |
| `test`         | 298 arquivos e 4.326 testes passaram, inclusive o contrato de limites contra as migrações renumeradas                                                                          |
| `build`        | Passou; as 15 rotas de `/area` aparecem no manifesto                                                                                                                           |
| `format:check` | Falhou em 1.158 arquivos pelo fim de linha do clone (`core.autocrlf=true` com `endOfLine: lf`), não pelo conteúdo. Os `.ts`/`.tsx` alterados passaram com `--end-of-line auto` |

**O ensaio é anterior a este documento e usou `git am`, que não está mais disponível** (o checkout do Ranch perdeu o `.git`; §10.1 troca o método por porte por arquivo). Não cobriu: os commits `37af386` e `f8a5c75` (que tocam `src/lib/whatsapp/meta-api.ts`, também alterado pela feature; esperar conflito pequeno em `rawComponents`), a guarda por plano (§5.4, §8.4), a migração 096, os textos adaptados e o número de chaves i18n final (3.555 hoje + 126 da feature + as do plano = conferir no gate).

**Não ensaiado em banco:** as migrações não rodaram em nenhum banco do ZAP. As pré-condições do §7.1 existem para cobrir isso.

## 3. Decisões de execução

As decisões de produto estão no PRD 082 (D-1…D-11). As que são só de execução:

| ID   | Decisão                                                                                                    | Motivo                                                                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E-1  | Elegibilidade numa função só (`account_is_eligible`), reconferida a cada requisição                        | Conta elegível = `plan_feature_strict(account_id, 'contact_portal_enabled')` + `settings.enabled` + `accounts.blocked_at IS NULL`. Acesso elegível = conta elegível + `access.blocked_at IS NULL`. Sem cache |
| E-2  | Guarda de plano numa migração separada (096), depois das três portadas                                     | 093–095 ficam byte a byte iguais às do Ranch, salvo o aviso de origem; a 096 `CREATE OR REPLACE` só `account_is_eligible` e cria `plan_feature_strict`                                                       |
| E-3  | Telefone: até dois candidatos (canônico de 13 dígitos e legado de 12); o primeiro é a chave dos contadores | `phone_normalized` é só "tirar não dígitos", e há celulares sem o nono dígito                                                                                                                                |
| E-4  | Código e senha numa tela só, sem ticket intermediário                                                      | Menos estado entre telas                                                                                                                                                                                     |
| E-5  | O código nasce no Node (`crypto.randomInt`, seis dígitos), o hash no banco                                 | Em claro, só na memória da rota até o envio                                                                                                                                                                  |
| E-6  | Custo do bcrypt: senha `bf` 10, código `bf` 8. Sem candidato, roda um `crypt` de mesmo custo               | Tempo constante entre contato e não contato. Medido no Ranch: bf 10 ≈ 74 ms e bf 8 ≈ 18 ms (compute Micro, ~27 logins/s). Medir no `vn`                                                                      |
| E-7  | IP: primeiro valor de `x-forwarded-for`; o banco guarda só `sha256(ip)`                                    | Limite por IP sem guardar IP                                                                                                                                                                                 |
| E-8  | Sem variável de ambiente nova; limites são constantes em `src/lib/contact-portal/limits.ts`                | Uma fonte, testável                                                                                                                                                                                          |
| E-9  | Sem cron novo; vencidos são apagados dentro das próprias funções                                           | Nenhuma linha nova em `cron-jobs.sql`                                                                                                                                                                        |
| E-10 | Erro de plano na rota da conta: `403` com `{ error: 'FEATURE_NOT_IN_PLAN' }`                               | Mensagem em inglês, como toda `/api/**`; a UI traduz                                                                                                                                                         |

## 4. Comportamento

### 4.1. Jornadas

| Jornada | Gatilho                                                             | Resultado                                                                                 |
| ------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **J1**  | Usuário clica em "Enviar acesso" na ficha ou no painel da conversa  | Contato recebe código (válido por 24 h) e link, digita o código, cria a senha e entra     |
| **J2**  | Contato envia a palavra-chave (padrão `SENHA`) ao número da conta   | Resposta com código e link na mesma conversa. Sem automação, flow ou IA                   |
| **J3**  | Contato abre `/area/c/<código>` ou `/area` e pede o primeiro acesso | Código sai pela conta do endereço; em `/area`, pela conta da conversa mais recente        |
| **J4**  | Telefone + senha                                                    | Uma conta: painel. Várias: tela de escolher conta                                         |
| **J5**  | "Esqueci minha senha"                                               | Igual à J3. Redefine só o acesso da conta que entregou o código e encerra as sessões dele |

Quem não é contato, ou cuja conta não é elegível, recebe a mesma resposta: "Se este número tiver acesso, enviamos um código pelo WhatsApp."

### 4.2. Telas (`src/app/(portal)/area/`, fora de busca e sem o shell da CRM)

| URL                                        | Conteúdo                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `/area`                                    | Entrar, genérico                                                                         |
| `/area/c/<código>`                         | Entrar com o nome da conta. Código inválido dá 404; conta não elegível mostra o genérico |
| `/area/c/<código>/codigo`                  | Destino do link da mensagem: lê `#c=`, preenche o campo e tira o fragmento da barra      |
| `/area/primeiro-acesso`, `/area/recuperar` | Telefone → envio do código. Aceitam `?conta=<código>`                                    |
| `/area/codigo`                             | Código + nova senha + confirmação + aceite, numa tela só                                 |
| `/area/escolher-conta`                     | Só quando a senha vale em mais de uma conta                                              |
| `/area/painel`                             | Saudação, nome da conta e bloco "Em breve" (texto genérico, §8.3)                        |
| `/area/minha-conta`                        | Nome, telefone mascarado, trocar senha, sair, sair de todos os aparelhos                 |

O telefone passa da tela de pedir código para a de digitar código por `sessionStorage`, nunca pela URL. A tela de código usa o medidor de senha e a regra de `password-policy.ts`.

### 4.3. Lado da conta e papéis

| Ação                                                                      | viewer | agent | admin+ |
| ------------------------------------------------------------------------- | ------ | ----- | ------ |
| Ver estado (sem acesso, convite enviado, ativo, bloqueado) e último login | sim    | sim   | sim    |
| Enviar acesso (J1); o botão respeita opt-out                              | não    | sim   | sim    |
| Bloquear, desbloquear, encerrar sessões                                   | não    | não   | sim    |
| Configurações → Área do contato                                           | não    | não   | sim    |

- **Configurações:** ligar/desligar, canal dos códigos, template `AUTHENTICATION`, palavra-chave e endereço `/area/c/<código>`. Sem o item no plano: aviso e controles desabilitados (§8.4).
- **Ficha:** cartão `ContactPortalAccessCard` na aba Detalhes e no painel lateral da conversa. Sem o item no plano: não renderiza.
- **Console `/admin`:** "ligada/desligada · N contatos com acesso". Checkbox `contact_portal_enabled` no editor de plano e na exceção por conta, sem código novo.
- **Atividade:** `contact.portal_invited`, `contact.portal_blocked`, `contact.portal_unblocked`. Login comum não entra.

### 4.4. Ciclo de vida

| Evento                                 | Efeito                                                                 | Como                                    |
| -------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| Contato excluído                       | Acesso e sessões somem                                                 | `ON DELETE CASCADE`                     |
| Telefone alterado                      | Acesso, códigos e sessões somem. Trocar número nunca transfere a senha | Gatilho `contact_portal_phone_changed`  |
| Conta bloqueada                        | Contatos dela param de entrar nela. Outras contas seguem               | `account_is_eligible` a cada requisição |
| Conta excluída                         | Acessos removidos                                                      | `ON DELETE CASCADE`                     |
| Área desligada **ou plano sem o item** | Acesso negado com mensagem neutra; senha e sessões preservadas         | `account_is_eligible` a cada requisição |
| Acesso bloqueado                       | Sessões apagadas na hora, senha preservada                             | `portal_set_blocked`                    |

## 5. Banco

### 5.1. Pré-condições (rodar antes, no projeto confirmado)

Regra do ZAP: perguntar o projeto, rodar `get_project_url` e confirmar com o mantenedor antes de qualquer escrita. As consultas abaixo são só leitura.

```sql
select e.extname, n.nspname from pg_extension e
join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';
-- Esperado: pgcrypto em extensions. As migrações NÃO criam a extensão.

select md5(prosrc) from pg_proc where oid = 'public.handle_new_user()'::regprocedure;
-- Ver a tabela abaixo.

select to_regnamespace('contact_portal');                       -- Esperado: nulo
select count(*) from pg_proc where proname = 'plan_feature';    -- Esperado: 1
select count(*) from pg_proc where proname = 'plan_feature_strict'; -- Esperado: 0
select to_regclass('public.whatsapp_billing_status'),
       exists(select 1 from pg_proc where proname = 'sync_profile_email'); -- 089 presente
select exists(select 1 from information_schema.columns
  where table_name = 'whatsapp_config' and column_name = 'app_id');       -- 092 presente
select has_function_privilege('anon', 'public.recount_account_usage(uuid)', 'EXECUTE');
-- false = SPEC 081 aplicada; true = ainda não (D-8: só bloqueia a ida a produção)
select count(*) from public.contacts;                           -- Dimensiona o índice do §5.3
select quotas_enforced from platform_settings;                  -- Só para registrar; a 096 não depende
```

| `md5(prosrc)`                      | Significado                       | Ação                                                                    |
| ---------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `42dbf56301eec1b34457364a82b27754` | Versão da 067 com fim de linha LF | Seguir                                                                  |
| `2ce62f9d86dece7b37aed920a7f9621a` | Mesma versão, aplicada com CRLF   | Trocar o hash esperado na asserção 4 da 093 e seguir                    |
| Outro                              | A função não é a da 067           | **Parar.** Ler a função e entender o desvio. Não enfraquecer a asserção |

### 5.2. Migrações

Quatro arquivos. Os três primeiros são copiados do Ranch e renumerados; o SQL fica idêntico, exceto o aviso de origem no topo, para o diff com o Ranch continuar trivial. O quarto é só do ZAP.

| Ranch                                   | ZAP                                       | Conteúdo                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `094_contact_portal.sql`                | `093_contact_portal.sql`                  | Schema, tabelas, gatilho, 16 funções `portal_*`, asserções                                                                                                                    |
| `095_contact_portal_public_account.sql` | `094_contact_portal_public_account.sql`   | `portal_public_account`: nome da conta em `/area/c/<código>`                                                                                                                  |
| `096_contact_portal_limit_locks.sql`    | `095_contact_portal_limit_locks.sql`      | Travas por telefone, bcrypt nos ramos `no_match`, chave canônica do convite                                                                                                   |
| —                                       | `096_contact_portal_plan_gate_strict.sql` | `plan_feature_strict()` e `account_is_eligible` reescrita para usá-la (PRD 082 D-2). Asserções: chave ausente nega; `quotas_enforced = false` nega; override por conta libera |

**Não dependem da 091.** Cada `portal_*` faz `REVOKE ALL … FROM PUBLIC, anon, authenticated` explícito, então funciona sem a 091. A asserção 3 da 093 confere isso e falha alto. A 096 segue a mesma convenção: `plan_feature_strict` é `SECURITY DEFINER`, `search_path = public`, só `service_role`.

**Esboço da 096** (o arquivo final nasce na F1, com asserções):

```sql
-- plan_feature_strict: PRD 082 D-2. Diferente de plan_feature():
-- chave ausente é FALSE, quotas_enforced não é consultado e conta sem
-- account_plans é FALSE. Para permissão comercial, não para quota.
CREATE OR REPLACE FUNCTION public.plan_feature_strict(p_account_id UUID, p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (
      SELECT ((p.features || ap.limit_overrides) ->> p_key)::boolean
      FROM account_plans ap
      JOIN plans p ON p.id = ap.plan_id
      WHERE ap.account_id = p_account_id
    ),
    FALSE
  );
$$;
ALTER FUNCTION public.plan_feature_strict(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.plan_feature_strict(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.plan_feature_strict(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.plan_feature_strict(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.plan_feature_strict(UUID, TEXT) TO service_role;

-- account_is_eligible: mesma assinatura da 093, trocando
-- plan_feature(...) por plan_feature_strict(...). CREATE OR REPLACE.
```

### 5.3. Schema `contact_portal`

Fora de "Exposed schemas" e sem `USAGE` para ninguém além do dono. RLS ligada em todas as tabelas, **sem policy**: só o dono das funções lê.

| Tabela           | Papel                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings`       | `account_id` PK, `enabled` (padrão `false`), `channel_id`, `auth_template_id`, `keyword` (padrão `SENHA`, `NULL` desliga), `public_code` único de 8 caracteres |
| `access`         | `contact_id` PK, `account_id`, `phone`, `password_hash` (nulo = convite pendente), convite, ativação, último login, bloqueio, termos                           |
| `codes`          | `purpose` (`first_access`, `reset`, `invite`), `code_hash`, `expires_at`, `attempts`, `consumed_at`. Um código ativo por contato                               |
| `sessions`       | `token_hash` (`bytea`), `current_contact_id`, 30 dias deslizantes                                                                                              |
| `session_access` | Quais acessos a sessão abriu                                                                                                                                   |
| `attempts`       | Contadores por `kind` e `key_hash`                                                                                                                             |

**Principais ajudantes internos:** `account_is_eligible`, `candidates`, `canonical_phone` e `lock_phone`.

**Índice em tabela viva:** a 093 cria `idx_contacts_phone_normalized` em `public.contacts` sem `CONCURRENTLY`, o que bloqueia escrita em contatos durante a construção. Se a contagem do §5.1 for grande, criar antes, fora de transação, e a migração seguirá adiante pelo `IF NOT EXISTS`:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_phone_normalized
  ON public.contacts (phone_normalized);
```

**Funções do contato** (todas `SECURITY DEFINER`, `search_path = public`, só `service_role`):

| Função                                                             | Faz                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `portal_request_code`                                              | Aplica limites, escolhe o contato, grava o hash. Devolve `(status, contact_id, account_id)`       |
| `portal_complete_code`                                             | Confere o código (5 erros consomem), grava senha e termos, apaga as sessões do acesso             |
| `portal_login`                                                     | Confere a senha contra cada acesso elegível do telefone. Devolve os `contact_id` que bateram      |
| `portal_create_session`, `portal_resolve_session`                  | Criam e validam a sessão. A resolução desliza a validade e devolve só acessos **ainda** elegíveis |
| `portal_select_account`, `portal_change_password`, `portal_logout` | Trocam de conta, trocam a senha (e apagam as outras sessões), encerram esta sessão ou todas       |
| `portal_public_account`                                            | Nome da conta pelo código público. Só para conta elegível; nunca devolve o id                     |

**Funções da conta** (chamadas depois de `requireRole` e da guarda de plano): `portal_account_settings_get`, `portal_account_settings_set`, `portal_access_status`, `portal_active_contact_ids`, `portal_invite`, `portal_set_blocked`, `portal_end_sessions`, `portal_account_summary`.

### 5.4. Plano

`contact_portal_enabled` entra em `FEATURE_KEYS` (`src/lib/plans/types.ts`) e nos dois seeds do ZAP (`plans-seed.sql` e `plans-seed-vn.sql`) com `false` explícito nos quatro planos (PRD 082 D-1). `src/lib/plans/catalog.test.ts` valida `plans-seed.sql` contra `FEATURE_KEYS`; estender o teste para `plans-seed-vn.sql` é parte da F1.

Rótulo: `Plan.featureLabel.contact_portal_enabled` em `en.json` ("Contact portal") e `pt-BR.json` ("Área do contato"). Sem ele, o catálogo do cliente e o editor do console dão `MISSING_MESSAGE`.

**Por que `plan_feature()` não serve** (PRD 082 D-2): devolve `TRUE` para chave ausente e quando `quotas_enforced` está desligado. A 096 põe `plan_feature_strict()` no lugar, dentro de `account_is_eligible`. O lado da conta (§8.4) lê a mesma decisão pelo servidor, nunca pelo `plan.features` do cliente.

### 5.5. Depois de aplicar

1. `get_advisors` (security) no mesmo projeto. Esperado: nenhuma `portal_*` nem `plan_feature_strict` nos WARN e 6 INFO 0008 de `contact_portal`, sem policy por desenho.
2. Conferir no painel que `contact_portal` não está em "Exposed schemas".
3. Rodar os seeds de planos (os dois).
4. Atualizar [`status.md`](./context/status.md): última migração, próximo número, chaves de i18n, scripts de `supabase/setup/`.

## 6. Envio do código

| Situação                              | Como sai                                                 |
| ------------------------------------- | -------------------------------------------------------- |
| Canal QRCode                          | Texto livre com código e link                            |
| Cloud API com janela de 24 h aberta   | Texto livre com código e link                            |
| Cloud API fora da janela              | Template `AUTHENTICATION` de `settings.auth_template_id` |
| Cloud API, sem template aprovado      | `needs_template`: a UI avisa e a J2 continua valendo     |
| Teto de envio frio do QRCode atingido | `cold_limit`                                             |

- **Redação:** `sendAndPersistOutbound` manda o texto real ao provedor e grava `[código de acesso enviado]` em `messages`. Envio de motor não dispara webhook de saída. Origem nova no log: `contact_portal`.
- **Eco `fromMe` da Evolution:** no teste real o eco chegou ~450 ms **antes** do `INSERT`. Por isso `ingest.ts` descarta o eco quando `looksLikePortalCodeMessage` reconhece o marcador fixo `🔐` mais seis dígitos. O marcador fica fora da tradução de propósito.
- **Link:** `{NEXT_PUBLIC_SITE_URL}/area/c/<código-da-conta>/codigo#c=<código>`. O código vai no fragmento, que não chega ao servidor nem ao log do proxy. A origem vem **só** da variável (`configuredSiteOrigin`), nunca do host da requisição.
- **Template:** corpo com `add_security_recommendation`, rodapé com `code_expiration_minutes: 10`, botão `OTP`/`COPY_CODE`. No envio, o código vai no `body` e no botão de índice `"0"` com `sub_type: url`. Os componentes prontos viajam em `rawComponents`. O ZAP já tem `app_id` por canal (092): o upload de cabeçalho não se aplica ao template `AUTHENTICATION`, então não há interação.
- **Palavra-chave:** etapa de `ingestInbound` depois do opt-out e antes dos flows. Compara sem acento, sem caixa e com espaços colapsados. Consumida, suprime flows, gatilhos de conteúdo e IA. Em conta não elegível (plano ou interruptor), a palavra-chave **não** é consumida e a mensagem segue o caminho normal.
- **Opt-out:** a J1 respeita. J2, J3 e J5 são transacionais e pedidas pelo contato, então ignoram.
- **Teto frio:** no QRCode, `last_customer_message_at` fica sempre nulo, e todo envio de motor contava como frio. Sem a correção `loadLastInboundAt`, a J1 e a J2 falham com `cold_limit`. Ela vale também para automações, flows e IA, e **muda o comportamento dessas rotinas no ZAP** (PRD 082 D-11).

## 7. Segurança

### 7.1. Limites

Fonte única: `PORTAL_LIMITS` em `limits.ts`. Cada função recebe em `p_limits` e falha com `22023` se faltar chave.

| Chave                       | Janela | Máximo                                      |
| --------------------------- | ------ | ------------------------------------------- |
| Envio por telefone          | 60 s   | 1                                           |
| Envio por telefone          | 1 h    | 5                                           |
| Envio por IP                | 1 h    | 20                                          |
| Erros de código por IP      | 15 min | 30                                          |
| Erros de login por telefone | 15 min | 10                                          |
| Erros de login por IP       | 15 min | 30                                          |
| Validade do código          | —      | 10 min (convite: 24 h), 5 erros o invalidam |

A rota traduz `throttled` em 429 só no login e na conclusão do código. No pedido de código a resposta segue neutra, com piso de 750 ms (`PORTAL_REQUEST_CODE_MIN_MS`) em todos os caminhos. O teto diário por telefone (PRD 082 D-10) entra na F7, com migração própria.

### 7.2. Isolamento

- `/area` sai cedo do middleware, sem `getUser()`. A sessão da área não abre nenhuma rota da CRM.
- O cookie `zap_area_session` não começa com `sb-` e só vale em `Path=/area`. É `HttpOnly`, `SameSite=Lax` e `Secure` fora de `http://localhost`.
- O login sempre gera token novo. O banco guarda só o sha256.
- Toda escrita em `/area/api/*` confere `Origin` (`guardWrite`). Ausente ou `null` responde 403.
- Rotas `/area/api/*` importam só `@/lib/contact-portal/*`. Dentro da área, só `service.ts` e `account.ts` tocam `@/lib/supabase/*`.
- Rotas da conta: `requireRole`, depois guarda de plano (§8.4), depois contato conferido pela RLS da sessão (`visibleContact[Ids]`), depois `portal_*`.
- `isolation.test.ts` e `middleware.contact-portal.test.ts` prendem essas regras por varredura estática e por teste de rota.

### 7.3. Achados da revisão do Ranch

**Já corrigidos no código portado:** A-1 (cache), A-2 (link por host forjado), A-3 (tempo do pedido), A-4 (corrida nos limites, na 095) e A-9 (chave do convite).

**Abertos, herdados pelo ZAP:**

| #    | Gravidade | Risco                                                                                                           | Ação no ZAP                                                                                                              |
| ---- | --------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A-5  | Médio     | Se o proxy repassar `X-Forwarded-For` do cliente, os limites por IP caem                                        | Conferir na stack: Traefik é a borda, sem `forwardedHeaders.insecure`/`trustedIPs` abertos, e porta do app não publicada |
| A-6  | Médio     | 25 palpites/h por telefone somam ~1,8 % de acerto em 30 dias                                                    | PRD 082 D-10: F7                                                                                                         |
| A-7  | Baixo     | Qualquer um trava o login de um telefone por 15 min. A recuperação por código continua                          | Aceito                                                                                                                   |
| A-8  | Baixo     | Desligar a área, bloquear a conta ou perder o item do plano não apaga sessões. Religar em até 30 dias as revive | PRD 082 D-6: aceito por ora; decidir se apaga depois do piloto                                                           |
| A-10 | Baixo     | Com a mesma linha salva duas vezes, o código pode nascer para um contato e sair na conversa do outro            | Aceito                                                                                                                   |
| A-11 | Info      | `Path=/area` impede o prefixo `__Host-`                                                                         | Aceito                                                                                                                   |
| A-12 | Info      | O contato que reencaminhar o código ao número da conta o grava em claro                                         | Aceito                                                                                                                   |

## 8. Aplicação

### 8.1. Arquivos novos (62 portados + os da guarda de plano)

| Caminho                                                  | Conteúdo                                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/contact-portal/`                                | `types`, `limits`, `phone`, `code`, `session`, `current`, `request`, `http`, `service`, `journeys`, `delivery`, `keyword`, `account`, com testes         |
| `src/lib/contact-portal/plan-gate.ts` (+ teste)          | **Novo no ZAP:** `requireContactPortalFeature(accountId)` lê `plan_feature_strict` por `supabaseAdmin()` e lança `ForbiddenError('FEATURE_NOT_IN_PLAN')` |
| `src/app/(portal)/`                                      | Layout, telas da §4.2 e rotas `area/api/`: `request-code`, `complete-code`, `login`, `logout`, `select-account`, `change-password`                       |
| `src/app/api/contact-portal/`                            | `settings` (GET/PATCH), `contacts/status`, `contacts/[contactId]/invite`, `/block`, `/sessions`                                                          |
| `src/components/contact-portal/`                         | `portal-card`, `login-form`, `request-code-form`, `code-form`, `session-actions`, `password-input`, `portal-api`                                         |
| `src/components/contacts/contact-portal-access-card.tsx` | Cartão de estado e ações                                                                                                                                 |
| `src/components/settings/contact-portal-settings.tsx`    | Aba de Configurações                                                                                                                                     |
| `src/middleware.contact-portal.test.ts`                  | Isolamento no middleware                                                                                                                                 |
| `src/next-config.test.ts`                                | Política de cache                                                                                                                                        |
| `src/lib/whatsapp/meta-api.template.test.ts`             | Envio de template com `rawComponents`                                                                                                                    |

### 8.2. Arquivos alterados (30 portados + os da guarda de plano)

| Arquivo                                                                                                        | Mudança                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/middleware.ts`                                                                                            | `/area` e abaixo saem antes do `createServerClient`                                                             |
| `next.config.ts`                                                                                               | Política de cache (§9)                                                                                          |
| `src/lib/plans/types.ts`                                                                                       | `contact_portal_enabled` em `FEATURE_KEYS`                                                                      |
| `src/lib/plans/catalog.test.ts`                                                                                | **ZAP:** valida também `plans-seed-vn.sql`                                                                      |
| `messages/en.json`, `messages/pt-BR.json`                                                                      | +126 chaves da feature, `Plan.featureLabel.contact_portal_enabled` e o aviso "não incluído no seu plano" da aba |
| `src/lib/activity/types.ts`                                                                                    | Três ações `contact.portal_*`                                                                                   |
| `src/lib/channels/ingest.ts` e teste                                                                           | Descarte do eco e etapa da palavra-chave                                                                        |
| `src/lib/channels/send.ts` e teste, `send-log.ts`, `types.ts`                                                  | `rawComponents`, origem `contact_portal`, leitura da última mensagem do contato                                 |
| `src/lib/channels/adapters/whatsapp-cloud.ts`, `src/lib/whatsapp/meta-api.ts`                                  | Repasse de `rawComponents` (conflito esperado com 092, §2.2)                                                    |
| `src/lib/channels/cold-send-wiring.ts` e teste                                                                 | `loadLastInboundAt`                                                                                             |
| `src/lib/whatsapp/send-message.ts` e teste                                                                     | Teto frio pela mesma leitura                                                                                    |
| `src/lib/whatsapp/template-components.ts`, `template-send-builder.ts`, `template-validators.ts` e testes       | Payload e envio `AUTHENTICATION`; corpo opcional nessa categoria                                                |
| `src/app/(dashboard)/settings/page.tsx`, `src/components/settings/settings-sections.ts`                        | Aba `contact-portal` (`minRole: 'admin'`)                                                                       |
| `src/components/contacts/contact-detail-view.tsx`, `src/components/inbox/contact-sidebar.tsx`                  | Cartão de acesso, condicionado ao plano                                                                         |
| `src/app/(platform)/admin/accounts/[accountId]/page.tsx`, `src/app/api/platform/accounts/[accountId]/route.ts` | Resumo no console                                                                                               |
| `docs/context/INDEX.md`, `docs/context/auth-e-conta.md`                                                        | **ZAP:** linha "Área do contato" no roteamento e no domínio (`src/lib/contact-portal/`, `src/app/(portal)/`)    |

A API pública `/api/v1` não muda.

### 8.3. Adaptações obrigatórias no destino

| Item                                    | Ranch                                    | ZAP                                               | Onde                                              |
| --------------------------------------- | ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| Cookie de sessão                        | `vr_area_session`                        | `zap_area_session`                                | `session.ts`, `middleware.contact-portal.test.ts` |
| Chave de `sessionStorage`               | `valenranch:area:phone`                  | `zapcrm:area:phone`                               | `portal-api.ts`                                   |
| Nomes de migração em teste              | `094_…`, `096_…`                         | `093_…`, `095_…`                                  | `limits.test.ts`, `phone.test.ts`                 |
| Frase do painel                         | "Inscrições, comprovantes e resultados…" | Texto genérico, nos dois idiomas (PRD 082 §3.1)   | `ContactPortal.panel.comingSoonBody`              |
| Versão dos termos                       | `2026-10-30`                             | Data do texto aprovado (PRD 082 D-9)              | `PORTAL_TERMS_VERSION` em `journeys.ts`           |
| Texto dos termos                        | Só a frase do checkbox                   | Texto aprovado (PRD 082 D-9)                      | `ContactPortal.code.terms`                        |
| Comentário                              | "a porta do competidor"                  | "a porta do contato"                              | `src/app/(portal)/area/painel/page.tsx`           |
| Referências em comentário               | `SPEC 084`, `PRD 081`, `SPEC 085`        | Trocar por `PRD 082` / `SPEC 083` (§9 para a 085) | Código portado                                    |
| `plan_feature` em `account_is_eligible` | `plan_feature(...)`                      | `plan_feature_strict(...)` pela 096               | Banco                                             |

Domínios de exemplo nos testes (`dev.valenranch.com.br`, `Valen Ranch`) são dados de teste e não afetam a execução. Trocar por `zap.local.ia.br` / `ZAP CRM BR` é opcional.

### 8.4. Guarda de plano no app (novo no ZAP)

| Camada                                  | Implementação                                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rotas `/api/contact-portal/*`           | Depois de `requireRole(min)`, `await requireContactPortalFeature(ctx.accountId)`. Lança `ForbiddenError` com mensagem `FEATURE_NOT_IN_PLAN`; o handler responde `403 { error: 'FEATURE_NOT_IN_PLAN' }`                        |
| `GET /api/contact-portal/settings`      | Não falha com 403: devolve `{ featureInPlan: false, settings: null }` para a aba renderizar o aviso. É a única rota do grupo que responde 200 sem o item                                                                      |
| Aba de Configurações                    | Lê `featureInPlan` do GET. `false`: aviso traduzido ("A área do contato não está incluída no seu plano") e controles desabilitados. Não usa `useAccountPlan().plan.features` para decidir: o cliente não vê `limit_overrides` |
| Cartão da ficha e do painel da conversa | `GET /api/contact-portal/contacts/status` responde `403`; o cartão trata 403 como "não renderizar", sem toast                                                                                                                 |
| Área (`/area/**`)                       | Nada a fazer no app: `account_is_eligible` já nega no banco                                                                                                                                                                   |
| Palavra-chave em `ingestInbound`        | `portal_account_settings_get` devolve `eligible = false`; a etapa não consome a mensagem                                                                                                                                      |
| Console                                 | Sem código: `FEATURE_KEYS` alimenta o editor de plano e a tela da conta                                                                                                                                                       |

Teste: `plan-gate.test.ts` cobre os três estados (chave `true`, `false`, ausente) com o cliente mockado, e um teste de rota por grupo garante o 403.

## 9. Cache-Control das páginas (SPEC 085 do Ranch)

**Problema.** O catch-all de `headers()` em `next.config.ts` põe `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` em toda página, e esse valor vence o `private` que o Next põe nas páginas dinâmicas. Com cache compartilhado na frente, a página de um usuário e o `Set-Cookie` do refresh de sessão podem ir para outra pessoa. O ZAP tem hoje essa regra (`next.config.ts:158`).

| Caminho                                                                   | `Cache-Control`                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Toda página: CRM, auth, convite, console, `/area/**`, `/area/api/*`       | `private, no-store`                                             |
| Arquivo solto na raiz de `public/`, um segmento, com extensão de estático | `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` |
| `/api/*`                                                                  | `no-store`                                                      |
| `/emojibase/*`, `/opus/*`                                                 | `public, max-age=31536000, immutable`                           |
| `/_next/static/*`, `/_next/image`                                         | Definido pelo Next                                              |

Extensões da segunda linha: `svg`, `png`, `jpe?g`, `gif`, `webp`, `avif`, `ico`, `json`, `txt`, `xml`, `webmanifest`. Uma extensão abaixo da raiz, como `/area/x.json`, continua privada.

**Por que resolve o motivo original.** A regra pública existia porque um CDN guardava HTML velho apontando para chunks sumidos. Com `no-store`, nenhum HTML fica na edge. O custo é a página não entrar no bfcache de alguns navegadores.

**Alcance:** esta mudança vale para a CRM inteira, não só para a área (PRD 082 D-11).

## 10. Plano de implementação

As fases e os modelos estão no PRD 082 §9. Aqui, só o que cada fase toca.

| Fase | Toca                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | Porte por arquivo da §10.1, migrações 093–096 copiadas e escritas, seeds, §8.3, §8.4, `INDEX.md` e `auth-e-conta.md`, gate local          |
| F2   | §5.1, §5.2 e §5.5 no `vn`, com confirmação do mantenedor em cada escrita                                                                  |
| F3   | Deploy, §11.2, §11.5                                                                                                                      |
| F4   | §11.4, inclusive os cenários 18–20 de plano                                                                                               |
| F5   | `/security-review` do diff                                                                                                                |
| F6   | `limit_overrides` da conta piloto pelo console; termos definitivos                                                                        |
| F7   | Teto diário por telefone: chave nova em `PORTAL_LIMITS`, migração 097 com `CREATE OR REPLACE` de `portal_request_code`, cenário 8 de novo |

### 10.1. Porte por arquivo (o checkout do Ranch não tem git)

O método original era `git am` dos 8 commits (`83ad199`, `08c0570`, `c3f58fe`, `91823f9`, `1a4f590`, `c4a8227`, `4b30fea`, `792699a`). Sem `.git` na fonte, o porte é por arquivo, em duas classes, sempre lendo a `docs/spec-084-area-do-contato.md` do Ranch como mapa do que cada arquivo faz:

**Classe A, copiar inteiro** (só existem no Ranch e são todos da feature): `src/lib/contact-portal/`, `src/app/(portal)/`, `src/app/api/contact-portal/`, `src/components/contact-portal/`, `src/components/contacts/contact-portal-access-card.tsx`, `src/components/settings/contact-portal-settings.tsx`, `src/middleware.contact-portal.test.ts`, `src/next-config.test.ts`, `src/lib/whatsapp/meta-api.template.test.ts`. **Não copiar** `src/lib/retention/log-purge*.ts` nem `src/app/api/automations/cron/route.test.ts` (outra feature, §12).

**Classe B, portar só os trechos da feature** nos 30 arquivos da §8.2 que já existem no ZAP. Para cada um, `diff` Ranch → ZAP, aplicar apenas o que a §8.2 descreve e **descartar** o resto do diff, que é deriva sem relação:

| Deriva a descartar                                                                                                                                            | Motivo                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/globals.css`, `src/app/layout.tsx`, `src/components/email-spam-notice.tsx`, `src/lib/mailer/render*.ts`                                              | Identidade Valen                                                                                                                   |
| `src/lib/retention/defaults*.ts`, `src/lib/activity/retention.ts`, `src/app/api/automations/cron/route.ts`                                                    | Purga de logs (SPEC 083 do Ranch)                                                                                                  |
| `src/app/api/channels/evolution/webhook/[secret]/route*.ts`                                                                                                   | Revogação `fromMe` (§12)                                                                                                           |
| `src/lib/evolution/config*.ts`, `src/lib/evolution/instance-name.ts`, `src/lib/inbox/export/*`, `src/lib/whatsapp/cloud-channel-crud.ts`, `cloud-channels.ts` | Correções e ajustes do Ranch sem relação com a área (§12)                                                                          |
| Em `meta-api.ts`, `template-header-handle*.ts`, `template-manager.tsx`, `whatsapp-config.tsx`, `app/api/whatsapp/config/*`, `templates/*`, `types/index.ts`   | O ZAP está **à frente** (092, `app_id` por canal): manter o lado do ZAP e inserir só `rawComponents` e o template `AUTHENTICATION` |

Nos 30 arquivos da feature, o diff esperado é o da §8.2; qualquer hunk fora dessa descrição é deriva e fica de fora. `messages/*.json`: copiar o namespace `ContactPortal` (67 chaves), as chaves novas de `Settings`, `Contacts`, `Inbox`, `Activity` e `Admin` que a feature usa (conferir pelo `grep` de `t('` nos arquivos da classe A) e `Plan.featureLabel.contact_portal_enabled`; o total final se mede no gate, não se presume 3.676. `next.config.ts`: só a política de cache (§9).

Ordem sugerida: classe A, depois classe B de baixo para cima na pilha (`lib/` → `app/api/` → `components/` → `app/`), `messages`, `next.config.ts`, migrações e seeds, por fim a guarda de plano (§8.4), a 096 e as adaptações da §8.3. Gate local ao fim; `format:check` pode acusar CRLF nos arquivos copiados (ver §10.2).

### 10.2. Gate

Gate local do ZAP, ao fim da F1:

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

Com `core.autocrlf=true`, o `git am` pode deixar CRLF nos arquivos que tocar, e `format:check` exige LF. Se isso acontecer, rodar `npx prettier --write` nos arquivos alterados. O conteúdo versionado não muda.

## 11. Critérios de aceite e testes

### 11.1. Critérios

Os dez do PRD 082 §8. O critério 8 (plano) é o novo e é provado pelos cenários 18–20 abaixo mais as asserções da 096.

### 11.2. Conferências de deploy

- `NEXT_PUBLIC_SITE_URL` preenchida na stack. Sem ela, a mensagem sai sem link.
- Traefik como borda, conforme A-5.
- `contact_portal` fora de "Exposed schemas".
- Os dois seeds rodados: `select code, features->'contact_portal_enabled' from plans` devolve `false` em todos.
- Opcional: `rateLimit` do Traefik em `/area/api/*`, como freio barato antes do bcrypt.

### 11.3. Consultas de apoio (só leitura)

Trocar `<contact_id>` pelo contato de teste e `<account_id>` pela conta de teste. Nunca use contato real.

```sql
-- Plano da conta: o que a área enxerga
select plan_feature_strict('<account_id>', 'contact_portal_enabled') as strict,
       plan_feature('<account_id>', 'contact_portal_enabled')        as legado,
       (select quotas_enforced from platform_settings)               as quotas;

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

### 11.4. Roteiro manual

**Regras:** só leitura nas consultas; envio real só para contato de teste, em conta de teste; sem disparo em massa. Antes de cada envio pelo QRCode, faça o contato escrever ao número da conta, para não gastar envio frio. Rode 8 e 15 por último. `<ZAP_URL>` é a URL da instância e `<CÓDIGO>` o endereço público da conta. Os cenários 1–17 pressupõem a conta de teste com `limit_overrides.contact_portal_enabled = true`.

| #   | Cenário                                 | Passos                                                                                                                                                                | Esperado                                                                                                                         |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | J3 pela web                             | `/area/c/<CÓDIGO>` → Primeiro acesso → telefone → link do WhatsApp → senha → aceite                                                                                   | Painel; `$2a$10$`; uma sessão; cadastro zerado; uma bolha `[código de acesso enviado]`; `#c=` some da barra                      |
| 2   | J1 pela ficha                           | "Enviar acesso" para contato sem senha                                                                                                                                | Código válido por 24 h; atividade `contact.portal_invited`; sem código no `metadata`                                             |
| 3   | J2 e variações                          | Enviar `SENHA`, `senha` e `Sénha`                                                                                                                                     | Código na conversa; nenhuma automação, flow ou IA; mensagem do contato fica como comum                                           |
| 4   | J4 e J5                                 | Sair, entrar; depois "Esqueci minha senha"                                                                                                                            | Sessão nova a cada login; sessão anterior perde o acesso; eco descartado                                                         |
| 5   | Duas contas com template fora da janela | Conta B Cloud API com template aprovado, mesmo contato sem conversa em 24 h; enviar acesso; mesma senha; depois senha diferente                                       | Template com "copiar código"; tela de escolher conta com A e B; depois só A                                                      |
| 6   | Reset em A não muda B                   | Recuperar por A                                                                                                                                                       | Senha de B continua valendo                                                                                                      |
| 7   | Não contato                             | `/area` → Primeiro acesso com número inexistente, depois com o contato                                                                                                | Mesma tela; `{"ok":true}` nos dois; ≥ 750 ms; nada enviado ao primeiro                                                           |
| 8   | Seis pedidos em uma hora                | Intervalo acima de 60 s                                                                                                                                               | Cinco entregam; o sexto mostra a mesma tela e não envia                                                                          |
| 9   | Isolamento                              | Janela anônima com sessão da área: `/dashboard`, `/inbox`, `/contacts`, `/settings`, `GET /api/contacts`. Janela normal com CRM e área                                | Redirect para `/login` e 401. As duas sessões convivem; cookies com `Path` certo                                                 |
| 10  | Ciclo de vida                           | Excluir contato descartável, trocar telefone, bloquear conta, desligar área, bloquear acesso                                                                          | Volta para `/area` em todos. Registrar o que acontece ao religar (A-8)                                                           |
| 11  | Trocar senha                            | Dois navegadores; trocar em A                                                                                                                                         | A segue; B volta para `/area`; senha antiga não entra                                                                            |
| 12  | Sair de todos os aparelhos              | Dois navegadores                                                                                                                                                      | Os dois voltam para `/area`                                                                                                      |
| 13  | Limite de login                         | Onze senhas erradas                                                                                                                                                   | Dez 401, a 11ª 429; senha certa também 429 nos 15 min; nenhuma mensagem sai                                                      |
| 14  | Paralelo não fura o limite              | Onze logins errados simultâneos                                                                                                                                       | No máximo 10 viram 401, o resto 429; `login_phone` = 10                                                                          |
| 15  | Cinco códigos errados                   | Pedir código, errar cinco vezes, digitar o certo                                                                                                                      | Certo recusado; `attempts = 5`; `consumed_at` preenchido                                                                         |
| 16  | Papéis                                  | `viewer`, `agent` e `admin` na ficha e em Configurações                                                                                                               | Conforme §4.3                                                                                                                    |
| 17  | Teto frio em automação                  | Automação no QRCode responde a quem acabou de escrever                                                                                                                | Não conta como envio frio                                                                                                        |
| 18  | **Plano sem o item**                    | Conta de teste no plano `free` sem override; `admin` abre Configurações → Área do contato; abre a ficha de um contato; `curl` em `PATCH /api/contact-portal/settings` | Aba com aviso e controles desabilitados; cartão ausente; `403 FEATURE_NOT_IN_PLAN`; sem toast de erro                            |
| 19  | **Perder o item com sessão aberta**     | Contato logado; no console, remover `limit_overrides.contact_portal_enabled`; contato recarrega `/area/painel`; devolver o override                                   | Volta para `/area` com mensagem neutra; `contact_portal.access` e `sessions` intactos; ao devolver, a sessão volta a abrir (A-8) |
| 20  | **`quotas_enforced` desligado**         | Em banco de teste, `quotas_enforced = false` e plano sem a chave; pedir código e enviar `SENHA`                                                                       | Nada sai; `plan_feature_strict` = `false`, `plan_feature` = `true` na consulta do §11.3                                          |

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

### 11.5. Medição do `Cache-Control` (com `next start` e no host)

```bash
for p in /login /dashboard /inbox /admin /join/x /area /area/painel /auth/confirm /; do printf '%s ' "$p"; curl -sI "https://<ZAP_URL>$p" | grep -i '^cache-control'; done
```

Esperado acima: `private, no-store` em todas.

```bash
for p in /og-image.webp /openapi.json /favicon.ico; do printf '%s ' "$p"; curl -sI "https://<ZAP_URL>$p" | grep -i '^cache-control'; done
```

Esperado acima: `public, max-age=0, s-maxage=300, stale-while-revalidate=86400`. Conferir também `/api/...` com `no-store` e `/emojibase/...` com `immutable`.

Sem `.env.local`, o middleware devolve 500 e o Next põe o cabeçalho de erro dele. Para medir localmente, passe `NEXT_PUBLIC_SUPABASE_URL` e a chave anon falsas só no ambiente do processo.

## 12. Fora do porte

| Item do Ranch                                                          | Por quê                                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Migrações 090–092 do Ranch (endurecimento de RPCs)                     | Já portadas como 090 e 091 do ZAP na [SPEC 081](./spec-081-aperto-de-rpcs-definer-e-privilegios-padrao.md); aplicar lá, antes da F6 (D-8) |
| Migração 093 do Ranch, `log-purge.ts`, fase 7 do cron (SPEC 083 de lá) | Outra feature                                                                                                                             |
| Identidade Valen (`34c306a`, `9f9ab39`)                                | Marca do Ranch                                                                                                                            |
| Correções `db5b1a6` e `859f13e` (nome do contato)                      | Sem relação com a área. Úteis ao ZAP, em tarefa própria                                                                                   |
| Trecho de `792699a` no webhook da Evolution (revogação `fromMe`)       | Sem relação com a área. Portar só `contact-sidebar.tsx`                                                                                   |
| Barreiras de docs no `Dockerfile`                                      | O ZAP tem as próprias                                                                                                                     |
| `plans-seed-rs.sql`                                                    | O projeto `rs` foi removido do ZAP                                                                                                        |
| §12 da SPEC 084 do Ranch (ganchos de prova) e regras de Ranch Sorting  | Não se aplicam ao ZAP                                                                                                                     |
| Qualquer recurso dentro da área logada                                 | PRD 082 §3.1 e D-5: PRD próprio, chave própria quando cobrado                                                                             |

## 13. Pendências herdadas

- **Filtro "com acesso ativo" na lista de contatos:** filtrar por `.in('id', …)` estoura a URL e `service_role` furaria o escopo por papel. Fazer no servidor, respeitando a RLS. A função `portal_active_contact_ids` já existe.
- **Evento `contact.portal_activated`:** `portal_complete_code` não diz se foi primeiro acesso. Pede migração pequena, com `DROP FUNCTION`.
- **QR code do endereço em Configurações:** não há gerador no cliente.
- **Template `AUTHENTICATION`:** cada conta oficial precisa aprovar o seu na Meta. O custo da conversa é da conta.
- **Apagar sessões ao perder elegibilidade (A-8):** decidir depois do piloto (PRD 082 D-6).

## 14. Resultado da F4 (2026-11-06)

Roteiro do §11.4 executado pelo mantenedor no navegador e no WhatsApp, com conferência por consultas só de leitura no `vn` e por `curl` de fora. Conta de teste `5e0564ad-a8f6-4dec-89a1-7e7bdc1775be` (plano `vn_personal`, área ligada por `limit_overrides`). Contato de teste: Fatima, no canal QRCode `brunovnteste`. A única escrita no `vn` foi o `UPDATE` de `limit_overrides` da conta de teste, rodado pelo mantenedor no SQL Editor. Ligar a área foi feito na UI.

| #       | Resultado                                                                | Evidência medida                                                                                                                                                                                | Motivo ou ressalva                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | **Aprovado**                                                             | `$2a$10$`; código `$2a$08$` consumido com 0 erros; 1 sessão; 0 linhas novas em `auth.users`, `accounts`, `profiles` e `account_plans`; 1 bolha `[código de acesso enviado]`; 0 códigos em claro | `terms_version` = `2026-11-05`, texto provisório (D-9)                                                                                                                                               |
| 2       | Pendente                                                                 | —                                                                                                                                                                                               | Pulado. Exige contato sem senha com número próprio do mantenedor                                                                                                                                     |
| 3       | **Aprovado**                                                             | `SENHA` 14:11:50, `senha` 14:15:12 e `Sénha` 14:17:42 geraram código; sem resposta de automação                                                                                                 | A primeira `Sénha`, dentro de 60 s, foi bloqueada pelo limite por telefone, como previsto                                                                                                            |
| 4       | **Reprovado** (critério "sessão anterior perde o acesso" num novo login) | Sessão `e9971f64` (14:21:45) segue válida e vinculada depois do login `fbe85aa5` (14:31:14); painel abriu (mantenedor)                                                                          | "Sair" desvincula a sessão que saiu, e isso está ok. Pela SPEC §5.3, `portal_login` não encerra outras sessões. O roteiro e o desenho divergem. Decisão do mantenedor: o roteiro vale. Não corrigido |
| 5       | Pendente                                                                 | —                                                                                                                                                                                               | Exige Cloud API com template `AUTHENTICATION` aprovado                                                                                                                                               |
| 6       | Pendente                                                                 | —                                                                                                                                                                                               | Exige segunda conta com o mesmo contato                                                                                                                                                              |
| 7       | Pendente                                                                 | Tentativas de "Primeiro acesso" não registradas após 14:30                                                                                                                                      | Pulado pelo mantenedor                                                                                                                                                                               |
| 8       | Pendente                                                                 | —                                                                                                                                                                                               | Pulado. Rodar por último                                                                                                                                                                             |
| 9       | Parcial                                                                  | `POST /api/contacts/export` sem sessão → `401`; `/dashboard`, `/inbox`, `/contacts` e `/settings` com cookie da área → login (`307` por `curl`; mantenedor viu a tela de login)                 | Janela normal, com CRM e área ao mesmo tempo, não testada. Um 404 inicial foi a URL `/area/dashboard`, que não existe                                                                                |
| 10      | Pendente                                                                 | —                                                                                                                                                                                               | Pulado. A-8 não registrado                                                                                                                                                                           |
| 11 a 17 | Pendentes                                                                | —                                                                                                                                                                                               | Pulados                                                                                                                                                                                              |
| 18      | **Reprovado**                                                            | `PATCH` e `POST contacts/status` → `403 FEATURE_NOT_IN_PLAN`; `GET settings` → `200` com `featureInPlan: false`; aviso "não incluída no seu plano" aparece; cartão ausente no painel do contato | Controles da aba **não** ficaram desabilitados e apareceu um toast de erro (texto não registrado). Não corrigido. Revalidar após o 19                                                                |
| 19      | Pendente                                                                 | —                                                                                                                                                                                               | Pulado. Exige remover e devolver o override                                                                                                                                                          |
| 20      | Pendente de banco de teste                                               | Evidência indireta: asserção (c) da 096; consulta da F2 (chave ausente: `plan_feature` = true, `plan_feature_strict` = false)                                                                   | Não desligar `quotas_enforced` no `vn`                                                                                                                                                               |

**Observações fora do roteiro:**

- O nome do contato é sobrescrito pelo perfil do WhatsApp a cada mensagem recebida (`src/lib/channels/ingest.ts`, `findOrCreateContact`). Observado com o contato de teste: o nome trocou quatro vezes em um minuto. Follow-up, fora da F4.
- A conta de teste registrou um disparo de 97 destinatários às 13:43 UTC (template `clientes_inss_balcao_0611`), durante a F4. Origem não confirmada.
- Mensagens `agent` sem `sender_id` às 14:11 e 14:14–14:16. Origem não confirmada.
- Sessões de aparelhos diferentes coexistem após novo login (ver cenário 4).

### 14.1. Encerramento da F4 por declaração do mantenedor (2026-11-19)

O mantenedor declarou a F4 **encerrada e todos os cenários aprovados**. A tabela acima fica como foi medida em 2026-11-06 e **não foi refeita**. A declaração cobre o que a medição não cobriu, e o registro honesto é este:

| Cenários               | Evidência medida          | Situação que a declaração aceita                                                                                                                                                                                                                           |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 e 3                  | Sim, aprovados na medição | Aprovados                                                                                                                                                                                                                                                  |
| 4                      | Reprovado na medição      | Aceito como está: novo login **não** encerra sessões anteriores (desenho da §4.3 e do Ranch). O roteiro deixa de exigir isso. `portal_login` não muda, sem migração                                                                                        |
| 18                     | Reprovado na medição      | Aceito como está: controles da aba **não** ficam desabilitados sem o item no plano e um toast de erro aparece. As três camadas de bloqueio (403, aviso, cartão ausente) foram medidas e funcionam. Correção de interface fica como pendência de acabamento |
| 9                      | Parcial                   | Aceito. Falta só o teste com CRM e área abertas ao mesmo tempo na janela normal                                                                                                                                                                            |
| 2, 5–8, 10–17, 19 e 20 | **Nenhuma**               | Aceitos sem execução. Os riscos ficam para a F5 (limites e travas de 7–8 e 13–15) e para a primeira conta piloto (5, 6 e 19)                                                                                                                               |

Consequência: a F5 deixa de estar bloqueada. A F6 continua exigindo a SPEC 081 aplicada no `vn` e o texto de aceite definitivo (PRD 082 D-8 e D-9).

**F5 (`/security-review`, Opus 5.5): liberada.** Recebe os cenários não executados e o comportamento do 4 como superfície de revisão.

## 15. Resultado da F5 (2026-11-19)

Revisão de segurança do que está em produção, **sem alterar código nem banco**. Escopo: commit `4bc3624` (`src/lib/contact-portal/`, `src/app/(portal)/`, `src/app/api/contact-portal/`, `src/components/contact-portal/`, `middleware.ts`, `next.config.ts`, trechos de `channels/` e `whatsapp/`) e as migrações locais 093–096. Método: leitura integral do SQL e do TypeScript da feature; consultas `SELECT` no `vn` (projeto confirmado por `get_project_url`, ref `awylbf…`) e sondagens HTTP sem escrita; nenhuma escrita no `vn`. Testes da feature rodados: 17 arquivos passam, **1 falha** (F5-07).

**Veredito: nenhum HIGH no código da área; um HIGH preexistente no banco (SPEC 081) e dois MEDIUM de configuração e operação. A F6 (primeira conta real) fica BLOQUEADA** até F5-01, F5-02 e F5-03 serem resolvidos (além de D-8 e D-9, que já a bloqueavam). O desenho do núcleo (credencial fora do Supabase Auth, funções `portal_*` só `service_role`, elegibilidade reconferida a cada requisição, travas por telefone) resistiu à revisão.

### 15.1. Respostas às oito perguntas

**1. Rotas sem `Origin`, sem `requireRole` ou sem guarda de plano? A sessão do contato abre a CRM?** Não. As seis rotas `/area/api/*` só exportam `POST` e chamam `guardWrite` (403 sem `Origin` válido) logo no começo: `request-code/route.ts:23`, `login:20`, `complete-code:29`, `logout:16`, `select-account:11`, `change-password:24`. `GET` dá 405 (medido). As cinco rotas `/api/contact-portal/*` chamam `requireRole` e depois a guarda de plano (`settings` GET:42-43 devolve `featureInPlan:false`; PATCH:61-62; `contacts/status`:28-29; `block`:26-28; `invite`:33-35; `sessions`:23-25) e conferem o contato pela RLS da sessão antes de qualquer `portal_*`. A sessão do contato **não abre rota da CRM**: cookie `zap_area_session` (sem `sb-`, `Path=/area`), saída antecipada em `middleware.ts:30-35`, e nada fora de `lib/contact-portal` o lê (`isolation.test.ts`). `Origin` é defesa de CSRF, não autenticação: um cliente fora do navegador forja o cabeçalho, e por isso as rotas anônimas dependem dos limites (F5-03).

**2. Código ou senha em claro em `messages`, `conversations`, logs, webhooks, `activity_log`, URL?** Não no nosso banco. `messages` e `conversations` gravam `[código de acesso enviado]` (`delivery.ts:259-277`); no `vn`: 0 mensagens e 0 prévias com o marcador `🔐` e 6 dígitos, 5 mensagens redigidas. `send.ts` não despacha webhook de saída, `meta-api.ts` não registra corpo, os logs da área gravam só o nome do erro e o `metadata` do convite leva só `{via}` (hoje 0 linhas `contact.portal_*` em `account_activity_log`). O código no link vai no fragmento `#c=` (não chega ao servidor; `code-form.tsx:43-55` o apaga da barra) e o telefone passa por `sessionStorage`, não pela URL. O eco `fromMe` é descartado em `ingest.ts:186`. Resíduo fora do nosso controle: WhatsApp, banco da Evolution e Meta guardam o texto (F5-11).

**3. Limites aguentam concorrência? Resposta indistinguível?** Por telefone, sim, por construção; por IP, aproximado (documentado em 095). `lock_phone` (`pg_advisory_xact_lock`) serializa pedido, convite, conclusão e login no mesmo telefone (095:142, 236, 352, 526) e `FOR UPDATE` protege os códigos e a sessão (095:258, 425); as cinco funções vivas no `vn` contêm a trava (consulta). Os cenários 13 a 15 **continuam não executados**: a conclusão vem da leitura (procedimento em §15.5). A resposta do pedido de código é `{ok:true}` em todos os caminhos e fica ≥ 750 ms (`request-code/route.ts:49`); os dois ramos `no_match` gastam o mesmo bcrypt do ramo que acha contato (095:163, 177). Resíduos de tempo em F5-12.

**4. Enumeração.** Sem enumeração prática. `/area/c/<código>` dá 404 só para formato inválido; código bem formado mas inexistente (medido: `ZZZZZZZZ` dá 200) e código de conta não elegível mostram o mesmo genérico; só conta elegível mostra o nome, que é público por desenho. Espaço do código: 31⁸ ≈ 8,5·10¹¹, sem como varrer. O `publicCode` no pedido de código vira `no_match` indistinguível. Contato ou não contato: mesmo corpo, mesmo piso de tempo e mesmo contador gravado antes da busca.

**5. Elegibilidade reconferida a cada requisição, inclusive em sessão aberta?** Sim. `portal_resolve_session` filtra por `password_hash`, `blocked_at` e `account_is_eligible` (093:780-788); `portal_create_session`, `portal_select_account` e `portal_change_password` também. No `vn`, `account_is_eligible` usa `plan_feature_strict` e não usa `plan_feature` (consulta); `quotas_enforced` não entra. O cenário 19 segue não executado; a leitura do SQL cobre o caminho (sessão sem acesso elegível vira "sem sessão", `service.ts:76`).

**6. Privilégios no `vn`.** Limpo para a área. As 16 `portal_*`, `portal_public_account` e `plan_feature_strict`: dono `postgres`, `SECURITY DEFINER`, `search_path=public`, `EXECUTE` só `service_role` (consulta). As 14 funções de `contact_portal` não têm `EXECUTE` para nenhum papel; nenhum papel tem `USAGE` no schema nem privilégio nas 6 tabelas, todas com RLS e 0 policy. `contact_portal` está fora de Exposed schemas: PostgREST responde `PGRST106` e lista só `public, graphql_public`; `rpc/portal_login` como `anon` dá 404 (fora do schema cache) e `rpc/plan_feature_strict` e `rpc/portal_public_account` dão 401 `42501`. `get_advisors`: nenhuma `portal_*` em WARN. **Efeito da SPEC 081 pendente:** nenhum sobre as funções da área (elas revogam explicitamente), mas o banco segue com 23 `SECURITY DEFINER` executáveis por `anon` e 30 por `authenticated` (F5-01).

**7. Aceitar o cenário 4 cria risco real?** Risco real, hoje baixo; cresce quando houver recurso dentro da área. Aceitar o cenário 4 não abre brecha nova, mas combina com uma propriedade que a SPEC não declara: a validade desliza sem teto absoluto (093:766-771), enquanto o cookie do dono morre em 30 dias fixos (`maxAge` só no login, `session.ts:73-81`). O deslizante **só beneficia quem tem o token**: um token roubado vale indefinidamente se for usado ao menos uma vez a cada 30 dias. Mitigações que existem e funcionam: "sair de todos" (`portal_logout`), troca de senha apaga as outras sessões (exige a senha atual, sob o limite do login), recuperação por código apaga todas, bloqueio e encerrar sessões pela conta. Lacuna: a pessoa não vê nem é avisada de outras sessões. Correção barata em F5-04 (teto absoluto igual ao do cookie, sem mudar a experiência).

**8. Reclassificação de A-5, A-6 e A-8.** Ver §15.3.

### 15.2. Achados

| ID    | Gravidade                                | Onde (arquivo:linha ou consulta)                                                                                                                                              | Cenário de ataque                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Correção proposta                                                                                                                                                                                                                                                                                                                                                                                                                       | Bloqueia F6                                   |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| F5-01 | **HIGH** (preexistente, fora do diff)    | `vn`: `get_advisors` 0028 (23) e 0029 (30); `prosrc` de `purge_webhook_ingest_logs`, `upsert_webhook_funnel`, `increment_broadcast_total_recipients`, `recount_account_usage` | Quem tem a chave `anon` (pública, vai ao browser) chama `POST /rest/v1/rpc/purge_webhook_ingest_logs {"p_older_than_days":0}` e apaga os logs de ingestão de todas as contas; `upsert_webhook_funnel` e `increment_broadcast_total_recipients` gravam em `broadcasts` sem guarda no corpo. Provado por privilégio e código-fonte; **não executado** (seria escrita). Não envolve a área: as `portal_*` estão fechadas.                                                                                                                                                                  | Aplicar a SPEC 081 (090/091) com OK do mantenedor; depois repetir a consulta de §15.5 e o `get_advisors`. É a D-8, agora com dano concreto demonstrável.                                                                                                                                                                                                                                                                                | **Sim** (D-8)                                 |
| F5-02 | **MEDIUM** (governança)                  | `vn`: `plans.features->'contact_portal_enabled'` = `true` em `valen_ranch_personal`; conta `941045d6…` com `plan_feature_strict = true` sem override                          | PRD 082 D-1 e o registro da F2 dizem `false` em todos os planos e piloto só por `limit_overrides`. O plano foi criado pelo console em 2026-11-10 20:04 (`catalog.upsert`) já com a chave ligada e a conta foi vinculada em seguida (`plan.change`). Falta só `settings.enabled` (hoje `false`) para a área de uma conta real ficar elegível: o `admin` dela liga em Configurações **sem passar por D-8 nem D-9**. Pode ser intencional (a conta é a origem da feature).                                                                                                                 | Decidir: (a) não intencional: desligar a chave do plano (`UPDATE plans SET features = features \|\| '{"contact_portal_enabled":false}' WHERE code = 'valen_ranch_personal'`, com OK) e usar `limit_overrides` na hora do piloto; ou (b) intencional: declarar essa conta como a piloto da F6 e só liberar o interruptor depois de F5-01 e D-9. Incluir `select code, features->'contact_portal_enabled' from plans` no checklist da F6. | **Sim** (decisão do mantenedor)               |
| F5-03 | **MEDIUM** (A-5 + falta de freio global) | `request.ts:22-28` (primeiro valor de `x-forwarded-for`), `limits.ts:11-27`; Traefik **não verificado**                                                                       | Os limites por IP dependem de o proxy não repassar o `X-Forwarded-For` do cliente. Se repassar, o atacante gira o IP: some o limite de 30 erros por 15 min e de 20 envios por hora, e cada tentativa custa um bcrypt (~74 ms) no único Postgres da produção (`max_connections = 60`, compute pequeno), que também serve a CRM de todos os clientes. Se o IP real se perder no ingress do Swarm, o inverso: todos dividem um balde e 30 erros travam o login de **todos**. Evidência fraca a favor: o hash de IP gravado na F4 não é `unknown` nem endereço privado dos blocos testados. | (1) Rodar o teste de §15.5 e registrar o resultado. (2) Tornar o `rateLimit` do Traefik em `PathPrefix(/area/api)` **obrigatório** (média 5/s, rajada 20 por IP) e limitar o corpo (`buffering.maxRequestBodyBytes` ≈ 4 KB; hoje `request.json()` não tem teto). (3) Em código, ler o IP **da direita para a esquerda**, pulando N saltos confiáveis (padrão 1), em vez do primeiro valor.                                              | **Sim**, até o teste (1) passar e (2) existir |
| F5-04 | LOW (sobe a MEDIUM com recurso na área)  | `093:757-771`; `session.ts:73-81`; `login/route.ts:58`; sessões vivas no `vn` (criadas em 2026-11-06, expiram em 2026-12-06)                                                  | Token de sessão roubado (malware, aparelho compartilhado) vale para sempre se usado a cada menos de 30 dias; o dono não vê outras sessões. Novo login não revoga as anteriores (cenário 4, aceito).                                                                                                                                                                                                                                                                                                                                                                                     | Migração 099: `CREATE OR REPLACE portal_resolve_session` com teto absoluto `AND s.created_at > NOW() - make_interval(secs => p_ttl_s)` (igual ao `maxAge` do cookie: **zero mudança para o usuário**, assinatura intacta). Opcional: no `portal_create_session`, manter só as N (ex.: 10) sessões mais novas por acesso.                                                                                                                | Não (obrigatório antes do 1º recurso na área) |
| F5-05 | LOW                                      | `journeys.ts:63-123`; 095:169-180 (`candidates` não filtra `opted_out`; o convite filtra em 095:514)                                                                          | O pedido de código é **anônimo** (J3/J5), mas a SPEC o trata como "pedido pelo contato" e ignora opt-out: um terceiro faz a conta mandar até 5 códigos por hora a quem pediu para sair (denúncia, risco de banimento do número). No Cloud API fora da janela vira template `AUTHENTICATION` cobrado pela Meta; no QRCode consome o teto frio da instância e pode travar as automações da conta.                                                                                                                                                                                         | (a) J3/J5: contato `opted_out` vira `no_match` silencioso (ele ainda tem a J2, que ele mesmo inicia). (b) Teto por conta para envios disparados pela web (contador `send_account`, ex.: 60 por hora) na migração da F7. Combina com o `rateLimit` de F5-03.                                                                                                                                                                             | Não (fazer com a F7)                          |
| F5-06 | LOW                                      | `next.config.ts:42` (CSP só `Report-Only`, `script-src` com `'unsafe-inline' 'unsafe-eval'`), medido em `/area`                                                               | As páginas que recebem senha e código não têm CSP efetiva. Hoje não há HTML de usuário renderizado (React escapa nome de contato e de conta), então não há XSS conhecido; é defesa em profundidade contra exfiltração.                                                                                                                                                                                                                                                                                                                                                                  | Regra própria para `/area/:path*` com `Content-Security-Policy` **aplicado**: `default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` (mantendo `script-src 'self' 'unsafe-inline'` para a hidratação). O ganho está em `connect-src` e `form-action`.                                                                                                                 | Não                                           |
| F5-07 | LOW                                      | `isolation.test.ts:121-126` falha; `src/lib/forms/account-api.ts:169` (`'portal_visibility'`)                                                                                 | Falso positivo trazido pelos formulários (SPEC 085): o teste que prende "só `lib/contact-portal` chama `portal_*`" está **vermelho**; um erro real passaria despercebido no meio do ruído.                                                                                                                                                                                                                                                                                                                                                                                              | Trocar a expressão por uma lista fechada dos 17 nomes de RPC (`portal_(request_code\|complete_code\|login\|…)`) ou renomear o campo dos formulários. Não é código da área.                                                                                                                                                                                                                                                              | Não                                           |
| F5-08 | INFO                                     | `request.ts:31-37`                                                                                                                                                            | `sha256(ip)` sem segredo é reversível por varredura do espaço IPv4 (retenção de até 24 h, tabela inacessível). Pseudonimização fraca para a LGPD.                                                                                                                                                                                                                                                                                                                                                                                                                                       | HMAC com um segredo de servidor já existente (sem variável nova), junto com a F7.                                                                                                                                                                                                                                                                                                                                                       | Não                                           |
| F5-09 | LOW (A-6 reclassificado)                 | `limits.ts:13-14`, 095:144-157                                                                                                                                                | 25 palpites por hora por telefone somam ~1,8 % em 30 dias, mas só com 5 mensagens de código por hora para a vítima durante um mês, o que se percebe de longe. Com o painel vazio, o prêmio é baixo.                                                                                                                                                                                                                                                                                                                                                                                     | Teto diário por telefone (PRD 082 D-10), na F7, antes de ligar a segunda conta ou de haver recurso dentro da área.                                                                                                                                                                                                                                                                                                                      | Não (F7)                                      |
| F5-10 | LOW (A-8 mantido)                        | 093:764-788                                                                                                                                                                   | Perder o item, desligar a área ou bloquear a conta não apaga sessão; religar revive sessões antigas (e roubadas). A validade só desliza quando alguém usa o token.                                                                                                                                                                                                                                                                                                                                                                                                                      | Em `portal_account_settings_set`, quando `enabled` passa a `false`, apagar `session_access` da conta (a perda de plano continua preservando, D-6). Com F5-04 a vida útil fica limitada de qualquer forma.                                                                                                                                                                                                                               | Não                                           |
| F5-11 | INFO                                     | Desenho; `vn`: 1 mensagem de cliente só com 6 dígitos (2026-10-30, teste)                                                                                                     | O código existe em claro no WhatsApp, no banco da Evolution e na Meta; o contato que o reencaminha à conta o grava (A-12, 1 ocorrência de teste, expirada). A J2 cria contato: **quem escrever `SENHA` ao número da conta recebe acesso**, o que contraria "só quem já é contato" (PRD 082 §3.1), e a equipe da conta lê os códigos (D-7). Hoje o painel é vazio.                                                                                                                                                                                                                       | Regra para recursos futuros: autorizar pelo dado ligado ao contato, nunca por "ter acesso"; corrigir o texto do PRD §3.1.                                                                                                                                                                                                                                                                                                               | Não                                           |
| F5-12 | INFO                                     | 093:289-300 e 095:251-266; `authenticator`: `lock_timeout = 8s`                                                                                                               | O login faz um bcrypt por acesso do telefone (o tempo denuncia a pessoa com 2 ou mais contas) e a conclusão um por código ativo. Sob rajada no mesmo telefone, a espera na trava passa de 8 s e a rota responde 500: **falha fechada**, sem furar limite.                                                                                                                                                                                                                                                                                                                               | Aceitar; monitorar 500 em `/area/api/login`.                                                                                                                                                                                                                                                                                                                                                                                            | Não                                           |
| F5-13 | INFO                                     | `vn`: conta `5e0564ad…` elegível, `enabled = true`, 2 sessões vivas até 2026-12-06, 5 códigos e 12 contadores de 2026-11-06                                                   | Estado residual do teste da F4: "desligada em todas as contas" vale para os planos, não para esta conta de teste. A senha do contato de teste segue válida.                                                                                                                                                                                                                                                                                                                                                                                                                             | Com OK, desligar a área na UI e encerrar as sessões (`DELETE /api/contact-portal/contacts/<id>/sessions`) ao fim dos testes.                                                                                                                                                                                                                                                                                                            | Não                                           |
| F5-14 | INFO                                     | `096:52-69`; `account_plans.status` (`past_due`, `suspended`, `canceled`) e `grace_until`                                                                                     | `plan_feature_strict` ignora status e carência: plano vencido continua liberando. Coerente com `lifecycle.ts` ("nunca bloqueia"); o bloqueio de verdade é `accounts.blocked_at`, que a elegibilidade respeita. O vencimento efetivo rebaixa ao plano padrão (chave `false`).                                                                                                                                                                                                                                                                                                            | Nenhuma; registrar a decisão no PRD 082 D-6.                                                                                                                                                                                                                                                                                                                                                                                            | Não                                           |

### 15.3. Reclassificação dos achados herdados

| Achado                        | Antes | Agora              | Por quê                                                                                                                                                                                                                                       |
| ----------------------------- | ----- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-5 (`X-Forwarded-For`)       | Médio | **MEDIUM (F5-03)** | O código confia no primeiro valor do cabeçalho e o Traefik não está verificado. O banco é único e compartilhado (`max_connections = 60`), então o custo vai além da área. O teste de §15.5 rebaixa a LOW se o proxy sobrescrever o cabeçalho. |
| A-6 (palpites por dia)        | Médio | **LOW (F5-09)**    | Exige 5 mensagens por hora para a vítima durante 30 dias e o painel está vazio. Volta a MEDIUM quando houver recurso na área. F7 antes da segunda conta.                                                                                      |
| A-8 (sessões e elegibilidade) | Baixo | **LOW (F5-10)**    | A reconferência a cada requisição foi confirmada no SQL vivo. O resíduo é o revival ao religar; F5-04 limita o prazo.                                                                                                                         |
| Cenário 4 aceito              | —     | **LOW (F5-04)**    | Risco real só pela falta de teto absoluto; barato de corrigir.                                                                                                                                                                                |

### 15.4. Ordem de correção sugerida

1. F5-01: aplicar a SPEC 081 (090/091) no `vn`. Pré-requisito da F6; é migração e pede OK explícito.
2. F5-02: decisão do mantenedor sobre `valen_ranch_personal`.
3. F5-03: teste do `X-Forwarded-For`, `rateLimit` e corpo máximo no Traefik; troca da leitura do IP em `request.ts` (TS e teste).
4. Migração **099** (próximo número livre; 097 e 098 são dos formulários): F5-04 e F5-10 em `portal_resolve_session` e `portal_account_settings_set` (`CREATE OR REPLACE`, assinaturas intactas, asserções de privilégio como na 095).
5. F7 (já prevista): F5-05, F5-08 e F5-09 na mesma migração do teto diário.
6. Pequenos: F5-06 (CSP de `/area`), F5-07 (teste de isolamento), F5-13 (limpar o teste).

### 15.5. Verificado e não verificado

**Verificado, com evidência:**

- Código e SQL lidos por inteiro: 093 (1.362 linhas), 094, 095, 096; `lib/contact-portal/*` (sem os testes); as 6 rotas de `/area/api`; as 5 de `/api/contact-portal`; as 11 páginas; os componentes; `middleware.ts`; `next.config.ts`; os trechos de `ingest.ts`, `send.ts`, `cold-send-wiring.ts` e o payload `AUTHENTICATION`.
- `vn`, só `SELECT`: privilégios e `search_path` das funções, RLS, policies e privilégios das 6 tabelas, `USAGE` do schema, gatilho de troca de telefone presente, `account_is_eligible` estrita, reconferência de elegibilidade nas funções vivas, trava nas 5 funções, `portal_*` fora do `get_advisors`, 0 códigos em claro, planos, contas e contadores.
- HTTP, sem escrita: `contact_portal` fora de Exposed schemas, `anon` sem `EXECUTE`, `Cache-Control: private, no-store` também em `/area/api/login` (405), `/area/c/ZZZZZZZZ` 200 e `/area/c/bad` 404, `X-Frame-Options: DENY`, HSTS e CSP `Report-Only`.
- Testes: `vitest` em `src/lib/contact-portal`, `(portal)`, `api/contact-portal`, `middleware.contact-portal.test.ts` e `next-config.test.ts`: 210 de 211 passam (a falha é F5-07).

**Não verificado:**

- Traefik (`forwardedHeaders`, `trustedIPs`, publicação da porta, `rateLimit`): fica em `docs/deploy/`, que esta revisão não lê. Teste de campo abaixo.
- Cenários 13, 14 e 15 (concorrência e cinco erros de código), 7 e 8 (limites do pedido), 5 e 6 (duas contas e template `AUTHENTICATION`), 10 a 12 e 19 (ciclo de vida e sessões): **seguem sem execução**; a análise é estática. Executar exigiria gravar contadores no `vn` pelo app.
- Execução real de F5-01 (seria escrita no `vn`).
- O que o banco da Evolution guarda do texto, e uma conta Cloud API com template aprovado.
- Carga: custo do bcrypt no compute do `vn` (E-6 pede medição) e comportamento sob rajada.

**Testes de campo para o mantenedor, a partir de uma máquina própria.** A-5: dois logins errados com `X-Forwarded-For` diferentes, e depois conferir no `vn`.

```bash
for ip in 203.0.113.7 198.51.100.9; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://zap.local.ia.br/area/api/login \
    -H "content-type: application/json" -H "origin: https://zap.local.ia.br" \
    -H "x-forwarded-for: $ip" -d '{"phone":"11900000000","password":"x"}'
done
```

```sql
select key_hash, count(*) from contact_portal.attempts
where kind = 'login_ip' and created_at > now() - interval '5 minutes' group by 1;
```

Uma linha com contagem 2 significa que o proxy ignora o cabeçalho forjado (A-5 cai para LOW); duas linhas, que confia nele (F5-03 confirmado). Para os cenários 13 e 14, com um telefone de teste: 11 logins errados em paralelo (`xargs -P 11`) e conferir `login_phone = 10` na mesma tabela.

Para acompanhar F5-01 depois da SPEC 081:

```sql
select count(*) filter (where prosecdef and has_function_privilege('anon', oid, 'EXECUTE')) as definer_anon,
       count(*) filter (where prosecdef and has_function_privilege('authenticated', oid, 'EXECUTE')) as definer_auth
from pg_proc where pronamespace = 'public'::regnamespace;
```

### 15.6. Correções aplicadas (2026-11-19)

Sessão de correção da F5 (Sonnet 5.5; a recomendação era Opus 5.5 pela reescrita de funções de segurança, e as duas funções alteradas foram conferidas contra o SQL vivo do `vn` antes de escrever a 099). Sem git. **A migração 099 está escrita e NÃO foi aplicada:** o mantenedor deu o OK no diálogo, mas o `apply_migration` foi recusado no momento da chamada, e a chamada não foi repetida. Nada foi escrito no `vn` nesta sessão; as consultas foram só `SELECT` (projeto confirmado por `get_project_url`, ref `awylbf…`).

| ID                  | Situação                 | Arquivo                                                                           | Evidência                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5-07               | **Corrigido**            | `src/lib/contact-portal/isolation.test.ts`                                        | Lista fechada das 17 RPCs `portal_*` (conferida contra os `CREATE FUNCTION public.portal_*` de 093–096), mais um teste que cobra a lista contra as migrações. 8 de 8 passam. `account-api.ts` já tinha contornado com `Omit`; o comentário dele ficou obsoleto                                                                                |
| F5-03               | **Parcial** (código)     | `src/lib/contact-portal/request.ts`, `request.test.ts`                            | `getClientIp` lê o **último** valor de `x-forwarded-for`, com fallback `x-real-ip` e `unknown`. Testes: cabeçalho forjado com vários valores, valor único, vazio, só vírgulas, vírgula no fim e ausente. Hash inalterado. **Pendentes (mantenedor):** teste de campo do Traefik (§15.5), `rateLimit` em `/area/api` e corpo máximo no Traefik |
| F5-04               | **Pronto, não aplicado** | `supabase/migrations/099_contact_portal_session_ceiling.sql` (local, fora do git) | `portal_resolve_session` exige `s.created_at > NOW() - make_interval(secs => p_ttl_s)`. Assinatura, retorno e privilégios intactos; asserções `DO` no fim. Estado vivo do `vn` conferido em 2026-11-19: ainda sem o teto (corpo da 093)                                                                                                       |
| F5-10               | **Pronto, não aplicado** | idem                                                                              | `portal_account_settings_set` apaga `session_access` da conta, e as sessões que ficam sem acesso, quando `enabled` passa de `true` a `false` (sob `FOR UPDATE` na linha de `settings`). Quem tem acesso em outra conta continua logado nela. Perda do item do plano segue preservando (D-6)                                                   |
| F5-06               | **Corrigido**            | `next.config.ts`, `src/next-config.test.ts`                                       | Regra `/area/:path*` com `Content-Security-Policy` **aplicado**; `'unsafe-eval'` só fora de produção. 54 testes passam. Em `next start` (build de produção), `curl -I`: `/area` e `/area/c/ZZZZZZZZ` saem com a política; `/login` e `/dashboard` seguem só com a Report-Only. `/area` hidratou e o console ficou sem violações               |
| F5-05               | **Parcial** (TypeScript) | `src/lib/contact-portal/journeys.ts`, `journeys.test.ts`                          | O envio em segundo plano da J3/J5 não envia a contato `opted_out` (nem se a leitura falhar), e registra só o motivo no log. A resposta da rota e o piso de tempo não mudam; a J2 permanece. **Resta para a migração da F7:** `portal_request_code` ainda grava e consome o código do contato `opted_out`; teto por conta (`send_account`)     |
| F5-13               | **Proposto**             | conta `5e0564ad-a8f6-4dec-89a1-7e7bdc1775be`                                      | Proposta abaixo. Não executado                                                                                                                                                                                                                                                                                                                |
| F5-01               | Pendente                 | SPEC 081 (090/091)                                                                | Tarefa própria, com OK do mantenedor; continua bloqueando a F6                                                                                                                                                                                                                                                                                |
| F5-02               | Pendente                 | `plans` (`valen_ranch_personal`)                                                  | Decisão do mantenedor; bloqueia a F6                                                                                                                                                                                                                                                                                                          |
| F5-08               | Pendente (F7)            | `request.ts` (`hashIp`)                                                           | HMAC do IP, junto com a migração do teto diário                                                                                                                                                                                                                                                                                               |
| F5-09               | Pendente (F7)            | `limits.ts`, 095                                                                  | Teto diário por telefone (PRD 082 D-10)                                                                                                                                                                                                                                                                                                       |
| F5-11, F5-12, F5-14 | Sem mudança (INFO)       | —                                                                                 | Como na §15.2                                                                                                                                                                                                                                                                                                                                 |

**Gate:** `typecheck`, `i18n:check`, `lint` (0 erros, 7 avisos antigos), `test` (325 arquivos, 4.672 testes) e `build` passam. `format:check` acusa só `docs/` e `docker/runtime-env.mjs`, o baseline aceito.

**`/code-review high` sobre estas correções:** 8 achados; 2 corrigidos (log do motivo da supressão e leitura de opt-in em paralelo com `getSettings`) e 6 registrados como follow-up:

- O IP assume **um** proxy confiável; com outro proxy ou CDN antes do Traefik todos cairiam no mesmo balde (o inverso de F5-03). O teste do Traefik antes da F6 decide.
- `peek` e `redeem` de `/api/invitations/[token]` têm cópias locais de `getClientIp` que ainda leem o **primeiro** valor. Usar um helper único.
- O opt-out é filtrado depois de o banco gravar o código (ver F5-05, parcial).
- A regex do teste de isolamento só casa o nome entre aspas simples ou duplas.
- Comentário obsoleto em `src/lib/forms/account-api.ts` (SPEC 085).
- `contact_portal.housekeep()` não apaga sessões acima do teto de 30 dias (ficam inertes até `expires_at`); entrariam na 099 ou na migração da F7.

**F5-13: proposta (não executada).** Com a 099 aplicada, uma única chamada desliga a área da conta de teste e encerra as 2 sessões vivas (a função nova faz as duas coisas):

```sql
select public.portal_account_settings_set(
  '5e0564ad-a8f6-4dec-89a1-7e7bdc1775be'::uuid,
  '{"enabled": false}'::jsonb,
  null::uuid
);
```

Conferência por `SELECT`: `enabled = false` em `contact_portal.settings` e zero linhas em `contact_portal.sessions` e `session_access` desta conta. Alternativa sem a 099: desligar na UI da conta e chamar `DELETE /api/contact-portal/contacts/<id>/sessions` para cada contato com sessão.

**Conferir a 099 pelos objetos depois de aplicada:**

```sql
select p.proname,
       p.prosrc like '%s.created_at > NOW() - make_interval%' as teto,
       p.prosrc like '%DELETE FROM contact_portal.sessions%' as encerra_sessoes,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('portal_resolve_session', 'portal_account_settings_set');
```

Depois, `get_advisors` (security): nenhuma `portal_*` em WARN.
