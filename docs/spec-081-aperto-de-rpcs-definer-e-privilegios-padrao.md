# SPEC 081 — Aperto das RPCs `SECURITY DEFINER` e dos privilégios padrão

|                   |                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**        | Migrações escritas e testadas num Postgres descartável. **Nada aplicado no `vn`.** O achado no banco real ainda não foi confirmado nem descartado |
| **Data**          | 2026-11-05                                                                                                                                        |
| **Origem**        | Porte da SPEC 080 do Valen Ranch (migrações 090, 091 e 092 de lá).                                                                                |
| **Código do app** | Nenhum em `src/`                                                                                                                                  |
| **Migrações**     | `090_tighten_definer_rpc_grants_and_search_path.sql`, `091_default_privileges_closed.sql`                                                         |
| **Conferência**   | `scripts/verify-090-rpc-grants.sql` (só lê)                                                                                                       |
| **Contexto**      | [`supabase-rls-mcp`](./context/supabase-rls-mcp.md) (D-19, D-20) · [`status.md`](./context/status.md)                                             |

> `/supabase` e `/scripts` estão no `.gitignore`: os três arquivos SQL acima não entram em commit. Só esta SPEC e os `.md` de contexto vão para o Git.

---

## 1. O problema

O ZAP e o Ranch compartilham as migrações 001–089, então herdam o mesmo furo: na cadeia aplicada do zero, `anon` executa 23 funções `SECURITY DEFINER` e `authenticated` executa 30. A anon key está no bundle público, então qualquer pessoa alcança essas funções por `/rest/v1/rpc`.

Quatro delas não checam quem chama:

| Função                                          | O que um anônimo consegue                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `upsert_webhook_funnel(uuid, uuid, text, text)` | Criar ou incrementar um disparo `streaming` em qualquer conta               |
| `increment_broadcast_total_recipients(uuid)`    | Inflar o contador de qualquer disparo                                       |
| `purge_webhook_ingest_logs(integer)`            | Apagar o log de ingestão de todas as contas (`dias = 0`)                    |
| `recount_account_usage(uuid)`                   | Reescrever o contador de contatos de qualquer conta, base da quota de plano |

No teste local, `purge_webhook_ingest_logs(0)` chamada como `anon` funcionou. As outras funções já recusam por dentro (`auth.uid()` ou `is_account_member()`); nelas, o ACL é a segunda tranca.

**Causa raiz.** O Supabase mantém privilégio padrão no schema `public` que concede `EXECUTE` nominalmente a `anon`, `authenticated` e `service_role` em toda função criada por `postgres`. `REVOKE … FROM PUBLIC` não toca esses grants, e foi por isso que a 067 não fechou `recount_account_usage`. O mesmo padrão abre tabelas e sequências novas para `anon`, com só a RLS no meio.

---

## 2. O que muda

### 090: funções que já existem

| Grupo | Funções | Depois da 090                                           |
| ----- | ------- | ------------------------------------------------------- |
| A     | 10      | Sem `anon` e sem `authenticated`; `service_role` mantém |
| B     | 12      | Só `authenticated`                                      |
| C     | 1       | `peek_invitation` mantém `anon`                         |

- **Grupo A:** os 6 gatilhos, `upsert_webhook_funnel`, `increment_broadcast_total_recipients`, `purge_webhook_ingest_logs` e `recount_account_usage`. Revogar `EXECUTE` não afeta o disparo: o Postgres checa esse privilégio ao criar o gatilho.
- **Grupo B:** as 4 funções-predicado de RLS, as 4 `dashboard_*`, `set_member_role`, `transfer_account_ownership`, `touch_presence` e `redeem_invitation`.
- **Grupo C:** o convidado abre `/join/[token]` sem sessão. Revogar `anon` quebraria o convite.
- **Fora dos grupos:** outras 7 funções de sessão já estavam corretas e não mudam. A 090 só confere que continuam assim.
- **`plans_select_own`:** vai para `TO authenticated` antes dos `REVOKE`. O Postgres checa `EXECUTE` de toda função das policies permissivas ao iniciar o executor, sem curto-circuito do `OR`. Sem isso, o catálogo público de `plans` daria `42501` para `anon`.
- **`search_path`:** fixado em `update_updated_at_column`, `_bcast_cols_for_status`, `update_ai_configs_updated_at`, `update_ai_knowledge_documents_updated_at` e `conversations_channel_id_immutable`.

### 091: a causa

- Função nova criada por `postgres` em `public` deixa de nascer com grant explícito para `anon` e `authenticated`. Sobra o `EXECUTE` implícito de `PUBLIC`, então `REVOKE ALL … FROM PUBLIC` continua obrigatório.
- Tabela e sequência novas deixam de dar qualquer coisa a `anon`. `authenticated` e `service_role` ficam.
- Nada que já existe é revogado.

### Efeito colateral aceito

`SELECT` anônimo em tabela de tenant passa de 0 linhas para `42501`. Continua fechado, só muda o formato da recusa. Nenhum caminho do app lê tabela de tenant sem sessão.

---

## 3. Decisões

| ID  | Decisão                                                       | Motivo                                                                                                                     |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Duas migrações, não três                                      | A 092 do Ranch corrigia a 090 depois de aplicada. Aqui as correções já nascem na 090 e na 091                              |
| D-2 | `triage_row_matches` fica sem `search_path`                   | A 046/047 deixaram assim para o planner fazer inline. O corpo só usa built-ins, e o lint 0011 fica com esse 1 WARN, aceito |
| D-3 | Invariantes por assinatura (`regprocedure`), não por nome     | Uma sobrecarga com o mesmo nome não escapa                                                                                 |
| D-4 | A asserção de `search_path` trata `proconfig` nulo como falha | A forma do Ranch dá `NULL` nesse caso e não pega justamente a função sem `SET`                                             |
| D-5 | `extension vector` continua em `public`                       | Mover é outra tarefa. O lint 0014 fica como risco aceito                                                                   |
| D-6 | Não fechar `PUBLIC` no privilégio padrão                      | `REVOKE` com `IN SCHEMA` não alcança `PUBLIC`, e sem `IN SCHEMA` atingiria extensões instaladas depois                     |

---

## 4. O que foi testado

Ambiente: Postgres 16 descartável, com stubs do Supabase (papéis, `auth`, `storage`, privilégio padrão) e `vector` trocado por um domínio de texto. Cadeia 001–089, depois 090 e 091.

| Conferência                                        | Antes da 090 | Depois da 091         |
| -------------------------------------------------- | ------------ | --------------------- |
| `SECURITY DEFINER` executáveis por `anon`          | 23           | 1 (`peek_invitation`) |
| `SECURITY DEFINER` executáveis por `authenticated` | 30           | 20                    |
| `purge_webhook_ingest_logs(0)` como `anon`         | funcionou    | `permission denied`   |

Também passaram:

- `authenticated` negado no grupo A.
- `SELECT contacts` como `anon` dá `42501`; `plans` como `anon` responde; `peek_invitation` como `anon` responde.
- `service_role` e `postgres` executam a purga.
- Como `authenticated`: cadastro, contato inserido e apagado, contador de uso e `touch_presence`.
- Reaplicar as duas migrações não muda nada.
- 4 testes negativos fazem as asserções falharem e reverterem a transação.

Nenhum uso do grupo A em `src/` passa por sessão: `upsert_webhook_funnel` e `increment_broadcast_total_recipients` rodam em `/api/v1/ingest/contact` com `supabaseAdmin()`. Não há chamada a `rest/v1/rpc` em `n8n_automation`, `src` ou `mcp-server`.

Gate local em 2026-11-05: `typecheck`, `i18n:check`, `test` (4.115 testes) e `build` passaram. `lint` falhou em 7 erros, todos em `.claude/worktrees/docker-optimize-gitignore-3becc9/public/opus/encoderWorker.min.js`. `format:check` falhou em 49 arquivos, nenhum tocado nesta tarefa.

**Limite:** isso prova a cadeia de migrações, não o `vn`. Lá pode haver desvio, e o achado só fecha com a leitura do §5.

---

## 5. Roteiro de aplicação

Rode no diretório do ZAP, com o projeto `vn` confirmado pelo mantenedor. Os passos 2 e 6 só leem; **os passos 4 e 5 exigem OK do mantenedor**.

1. Rode `get_project_url` e confirme que é o `vn`.
2. Rode `scripts/verify-090-rpc-grants.sql` e guarde o resultado.
3. Leia o resultado:

   | Linha           | O que decide                                                                          |
   | --------------- | ------------------------------------------------------------------------------------- |
   | `achado`        | `exec_anon=true` nas 4 funções confirma o achado. `false` nas 4 descarta              |
   | `assinatura`    | Precisa vir vazia. Se não vier, **pare**: a 090 referencia função que o banco não tem |
   | `definer_extra` | Precisa vir vazia. Se não vier, **pare**: a asserção da 090 vai falhar                |
   | `default_acl`   | Precisa bater com o §1. Se não bater, revise as asserções da 091 antes de aplicar     |

4. Aplique a `090_tighten_definer_rpc_grants_and_search_path.sql` como `postgres`.
5. Aplique a `091_default_privileges_closed.sql` como `postgres`.
6. Rode `scripts/verify-090-rpc-grants.sql` de novo e rode `get_advisors` (security). Esperado:

   | Conferência                        | Esperado                      |
   | ---------------------------------- | ----------------------------- |
   | `definer_anon`                     | 1, só `peek_invitation(text)` |
   | `definer_auth`                     | 20                            |
   | `assinatura` e `definer_extra`     | vazias                        |
   | `plans_policy`, `plans_select_own` | só `authenticated`            |
   | Lints 0028, 0029, 0011 e 0014      | 1, 20, 1 e 1                  |

7. Faça a fumaça no app: login, cadastro, painel, inbox, criar e apagar contato, ingestão por `/api/v1/ingest/contact`, disparo, abrir `/join/[token]` sem sessão e aceitar o convite.
8. Registre o resultado neste arquivo e em [`status.md`](./context/status.md). Depois, o mantenedor faz o commit dos `.md`.

**Se algo quebrar depois de aplicar:** devolva o `GRANT` só da função afetada e só ao papel que o caminho quebrado usa. Nunca devolva `EXECUTE` a `anon` em predicado de RLS: mova a policy para `TO authenticated` (D-20 de `supabase-rls-mcp.md`).

---

## 6. Pontas abertas

- **Numeração da área do contato.** `docs/feature-spec-area-do-contato-zap-crm-br.md`, no repositório do Ranch, mapeia as migrações da área para ZAP 090/091/092. Esses números estão ocupados: a área passa a 092/093/094. A spec ainda não foi corrigida.
- **Registro de migrações no `vn`.** `list_migrations` para em 085 e não prova nada. Confira pelo script.
