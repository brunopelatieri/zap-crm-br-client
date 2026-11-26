# SPEC 091 — Assistente da plataforma no console `/admin` e MCP do proprietário

| Campo            | Valor                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | **Proposta, com A-19 ratificada** — excluir conta ou usuário fica fora do MCP do proprietário e da API de plataforma, por decisão do mantenedor em 2026-11-26. A-1…A-18 aguardam ratificação. Nada implementado.                                                                    |
| Data             | 2026-11-26                                                                                                                                                                                                                                                                          |
| Escopo           | `src/app/(platform)/admin/assistant/`, `src/app/api/platform/**`, `src/lib/platform/`, `src/lib/ai/` (abstração de escopo), widget no `(dashboard)`, `mcp-server/` (conjunto `platform`)                                                                                            |
| Depende de       | [SPEC 089](./spec-089-agentes-de-ia-openrouter-rag-ferramentas.md) (motor: provedores, base de conhecimento, ferramentas) e [SPEC 090](./spec-090-api-publica-e-mcp-gestao-de-recursos.md) F1 (camada de serviço e MCP com conjuntos). PRD 061 e SPEC 062 (console do proprietário) |
| Migração         | Provisórias **106** (assistente da plataforma) e **107** (chaves de API de plataforma). Conferir `ls supabase/migrations/` e [`status.md`](./context/status.md) antes de criar                                                                                                      |
| Dependências npm | Nenhuma além das da SPEC 089                                                                                                                                                                                                                                                        |
| i18n             | Namespaces novos `Assistant.*` (widget do cliente) e `Platform.assistant.*` (console), nos dois dicionários                                                                                                                                                                         |

---

## 1. Contexto

As SPECs 089 e 090 dão a cada **conta** um agente de IA que atende os clientes finais dela e um MCP para o dono da conta operar o próprio CRM. O pedido aqui é levar a mesma capacidade para o **proprietário do SaaS**:

1. Um **Assistente Virtual do ZAP CRM BR**, mantido pelo proprietário no console `/admin`, que atende os **donos das contas** (como configurar um número, por que um agendamento não dispara, o que o plano inclui).
2. Um **MCP do proprietário**, instalável no Claude Desktop, para ajudar a **montar esse assistente** e a **gerenciar as contas**.

São dois públicos e dois escopos que nunca se misturam: o do **inquilino** (uma conta) e o da **plataforma** (todas as contas).

## 2. Objetivo

1. Reaproveitar o motor da SPEC 089 num segundo escopo, o da plataforma, sem misturar dados com os das contas.
2. Console `/admin/assistant`: provedor e chave da plataforma, prompt com versões, base de conhecimento do produto, ferramentas, uso e custo por conta.
3. Widget **"Assistente"** dentro do painel do cliente, com respostas baseadas na base do produto e em diagnóstico da própria conta.
4. **Chaves de API de plataforma** e endpoints `/api/platform/v1/**`.
5. Conjunto **`platform`** no servidor MCP: gerir o assistente e as contas.

### Não-objetivos

- **Excluir conta ou usuário pelo MCP do proprietário ou pela API de plataforma.** Fora por decisão ratificada em 2026-11-26 (A-19). Continua só pelo console e pelo titular, com as guardas das SPECs 062 e 073.
- **Ler o conteúdo das contas** (contatos, conversas, mensagens) pelo escopo de plataforma. O console não faz isso hoje e o MCP não passa a fazer.
- **Estornar pagamento** e **editar e-mail de usuário** pelo MCP.
- **Atender o cliente final** das contas: isso é o agente de cada conta (SPEC 089).
- **Canal WhatsApp do assistente.** O suporte por WhatsApp do próprio SaaS já pode usar a conta do proprietário com o agente da SPEC 089; aqui o assistente vive dentro do painel.
- **MCP remoto com OAuth** (mesma razão da SPEC 090 M-16).
- **Cobrança por uso do assistente.** Só quota por plano.

---

## 3. Estado de partida (medido em 2026-11-26)

| Fato                                                                                                                                                                                                | Onde                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| O console vive em `/admin` (contas, planos, solicitações, retenção, notificações, configurações), com rotas em `/api/platform/**`                                                                   | `src/app/(platform)/admin/`, `src/app/api/platform/`          |
| **Proprietário = `PLATFORM_OWNER_EMAILS` no `.env`**, não tabela. `requirePlatformOwner()` exige `getUser()` e e-mail confirmado; sem a variável, `/admin` e `/api/platform/**` respondem **404**   | `src/lib/platform/owner.ts`, `planos-quotas-admin.md` regra 5 |
| **O console não afrouxa RLS**: leitura entre contas é rota de servidor com `service_role` atrás de `requirePlatformOwner()`                                                                         | regra 4                                                       |
| Existe uma segunda porta, de operador: `/api/admin/**` com `x-admin-secret` = `PLATFORM_ADMIN_SECRET` (contas, planos, solicitações de plano). Segredo único, sem escopo e sem revogação individual | `src/app/api/admin/`, regra 9                                 |
| A regra do console já está em `src/lib/platform/`: `changeAccountPlan`, `blockAccount`, `unblockAccount`, `blockUser`, `billing-console.ts`, `summary.ts`, `accounts.ts`                            | `src/lib/platform/`                                           |
| `platform_audit_log` (RLS ligada, **sem policy**: só `service_role`), com `actor` em texto (`console:<email>` ou `api:<ator>`)                                                                      | migração 069, `src/lib/platform/audit.ts`                     |
| `platform_settings` é linha única                                                                                                                                                                   | migração 067                                                  |
| O agente de IA é **por conta**: `ai_configs.account_id UNIQUE NOT NULL`, e as RPCs de busca filtram por `p_account_id`                                                                              | migrações 029 e 030                                           |
| O proprietário não bloqueia nem apaga a si mesmo (`guards.ts`)                                                                                                                                      | regra 8                                                       |
| Histórico: exclusão de usuário já apagou 1.627 contatos de outra conta por cascata (corrigido pela migração 088), e o `vn` não tem backup                                                           | `planos-quotas-admin.md`, § Exclusão                          |
| O shell do painel tem `header.tsx` e `sidebar.tsx`                                                                                                                                                  | `src/components/layout/`                                      |

---

## 4. Decisões

Em estado **Proposta**, exceto a **A-19, ratificada pelo mantenedor em 2026-11-26**.

| #    | Decisão                                                                                                                                                                                                                                                                                                                                       | Motivo                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1  | **Tabelas próprias da plataforma** (`platform_assistant_*`), com RLS ligada e **nenhuma policy**, lidas só por `service_role` atrás de `requirePlatformOwner()` ou da chave de plataforma. **Não** reaproveitar `ai_configs` e `ai_knowledge_*` com `account_id` nulo.                                                                        | Mantém a regra 4 do console. Linha sem conta dentro de tabela de inquilino é um vazamento esperando acontecer numa policy ou numa RPC que filtra por `account_id`.        |
| A-2  | **O código é reaproveitado, o dado não.** O motor da SPEC 089 ganha duas interfaces, `KnowledgeStore` e `AgentScope` (`{ kind: 'account', accountId }` ou `{ kind: 'platform' }`); fatiamento, embeddings, fusão, adaptadores e laço de ferramentas são os mesmos.                                                                            | "Transferir a funcionalidade" sem duplicar 2 mil linhas.                                                                                                                  |
| A-3  | **A chave do provedor é da plataforma**, cadastrada em `/admin/assistant`, cifrada com o mesmo AES-GCM das chaves de conta, e **nunca** devolvida por rota.                                                                                                                                                                                   | Aqui não é BYO: quem paga o assistente é o SaaS. Mesma disciplina de segredo.                                                                                             |
| A-4  | **Quem usa o assistente:** papéis `owner` e `admin` da conta. Demais papéis não veem o widget.                                                                                                                                                                                                                                                | O pedido fala em assistir os donos das contas, e as respostas tratam de plano e configuração. Ampliar depois é barato.                                                    |
| A-5  | **Liberado por plano**, com chave estrita `platform_assistant_enabled` (ausente = desligado) e quota mensal `assistant_messages_month` por conta.                                                                                                                                                                                             | O custo é do SaaS; o padrão tem de ser fechado. Mesmo padrão de `forms_enabled`.                                                                                          |
| A-6  | **Teto global**: orçamento diário de tokens da plataforma e limite por usuário (10 mensagens por minuto). Estourou, o widget informa e oferece o contato de suporte.                                                                                                                                                                          | Uma conta com quota alta ou um laço não pode consumir o orçamento de todas.                                                                                               |
| A-7  | **Base de conhecimento do produto** é mantida pelo proprietário (guias, respostas frequentes, política comercial). Carga inicial sugerida: os guias públicos em `docs/` (operação de planos, console, comandos), revisados antes de entrar.                                                                                                   | O assistente só pode afirmar o que está na base. Documento interno com segredo de deploy **não** entra.                                                                   |
| A-8  | **Ferramentas de diagnóstico da conta**, somente leitura, executadas com o **cliente de sessão do usuário** (RLS), nunca com `service_role`: plano e uso, canais e estado de conexão, templates e situação, estado do agendador visto pela conta, últimas falhas de disparo e de automação.                                                   | "Por que não dispara?" só tem resposta olhando a conta. Com a sessão do usuário, o assistente enxerga exatamente o que aquele usuário já pode ver.                        |
| A-9  | **Ações na conta ficam para uma fase opcional (F5)** e, se ratificadas, exigem um botão de confirmação por ação na interface. O assistente propõe, o usuário confirma, e a ação roda com a sessão dele pela camada de serviço da SPEC 090.                                                                                                    | Assistente de suporte que altera configuração sozinho é risco maior que o ganho na primeira versão.                                                                       |
| A-10 | **Escalar para humano**: botão "Falar com o suporte" grava um pedido e dispara o evento `assistant.escalated` pelas notificações do sistema (SPEC 063, e-mail e webhook), com o resumo da conversa.                                                                                                                                           | Reaproveita a caixa de saída que já existe. O assistente também escala sozinho quando não sabe, como o handoff do agente.                                                 |
| A-11 | **Conversas guardadas por 90 dias**, visíveis ao proprietário no console, com aviso claro no widget. Dado pessoal mascarado no que vai para o provedor quando possível.                                                                                                                                                                       | O proprietário precisa ler para melhorar a base; o usuário precisa saber. Prazo a ratificar.                                                                              |
| A-12 | **Chaves de API de plataforma** em tabela própria (`platform_api_keys`: hash, prefixo, escopos, criada por, último uso, revogada em). Criadas e revogadas **só** em `/admin/settings`. Não existe escopo de exclusão (A-19).                                                                                                                  | O MCP não tem cookie de sessão. O segredo único `PLATFORM_ADMIN_SECRET` não serve: sem escopo, sem revogação individual e sem ator na auditoria. E o `vn` não tem backup. |
| A-13 | **Endpoints de plataforma em `/api/platform/v1/**`**, separados de `/api/v1`. Sem `PLATFORM_OWNER_EMAILS`, respondem **404**, como o resto do console.                                                                                                                                                                                        | Escopo de inquilino e de plataforma nunca na mesma árvore nem no mesmo contrato OpenAPI. O contrato de plataforma **não** entra em `public/openapi*.json`.                |
| A-14 | **Toda escrita de plataforma grava `platform_audit_log`** com `actor = 'api:<prefixo da chave>'`.                                                                                                                                                                                                                                             | A coluna já prevê esse formato.                                                                                                                                           |
| A-15 | **Mesmo pacote MCP, conjunto `platform`**, registrado só quando `ZAPCRM_PLATFORM_KEY` está presente. No Claude Desktop são **duas entradas**: uma com a chave de uma conta, outra com a chave de plataforma.                                                                                                                                  | Um pacote para publicar e manter; credenciais separadas por instância.                                                                                                    |
| A-16 | **Confirmação no MCP de plataforma**: bloquear ou desbloquear conta, trocar plano, alterar vencimento e registrar pagamento exigem `confirm: true` e o nome da conta em `expected_account_name`.                                                                                                                                              | Mesmo desenho da SPEC 090 para ação sem volta ou com efeito comercial.                                                                                                    |
| A-17 | **O proprietário não age sobre a própria conta** pelo MCP (bloqueio, plano), reaproveitando `guards.ts`.                                                                                                                                                                                                                                      | Regra 8 do domínio, agora por uma porta nova.                                                                                                                             |
| A-18 | **Sem chave de plataforma configurada, o recurso não existe**: `/admin/assistant` mostra o estado "não configurado" e o widget não aparece em conta nenhuma.                                                                                                                                                                                  | Fork de terceiro que não quer assistente não paga nada nem vê tela quebrada.                                                                                              |
| A-19 | **Ratificada (mantenedor, 2026-11-26): excluir conta ou usuário fica fora do MCP do proprietário e de `/api/platform/v1`.** Não existe endpoint, escopo de chave nem ferramenta de exclusão de conta, de usuário ou de membro, e nenhum opt-in os habilita. A exclusão continua só pelo console (`/admin`) e pela "Zona de risco" do titular. | O `vn` não tem backup e uma exclusão de usuário já apagou 1.627 contatos de outra conta por cascata. Um assistente não pode ter esse alcance.                             |

---

## 5. Desenho

### 5.1 Dados (migração 106)

| Tabela                        | Conteúdo                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `platform_assistant_config`   | Linha única: provedor, modelo, chave cifrada, provedor e chave de embeddings, prompt, ligado, orçamento diário, opções do provedor |
| `platform_assistant_prompts`  | Versões do prompt                                                                                                                  |
| `platform_kb_documents`       | Mesmas colunas de `ai_knowledge_documents` da SPEC 089, **sem** `account_id`; mais `audience` (`all` ou lista de planos)           |
| `platform_kb_chunks`          | Mesmas colunas de `ai_knowledge_chunks`, sem `account_id`; `vector(1536)`, `fts` e `fts_pt`                                        |
| `platform_assistant_tools`    | Ferramenta, ligada, configuração                                                                                                   |
| `platform_assistant_threads`  | `account_id`, `user_id`, estado, escalada em, criada em                                                                            |
| `platform_assistant_messages` | Conversa, papel, texto, fontes usadas, ferramentas chamadas                                                                        |
| `platform_assistant_usage`    | Conta, usuário, modelo, tokens, custo, passos                                                                                      |

Todas com RLS ligada e sem policy, com a asserção final da migração conferindo isso (padrão da 069). RPC `match_platform_kb_hybrid` espelhando a da SPEC 089, com `EXECUTE` só para `service_role` (`REVOKE` de `PUBLIC`, `anon` **e** `authenticated`). `threads` e `messages` saem em cascata quando a conta é excluída; `usage` guarda `account_id` com `ON DELETE SET NULL`.

Quota: `assistant_messages_month` em `QUOTA_KEYS` e `platform_assistant_enabled` em `FEATURE_KEYS`, lidas por `plan_feature_strict()`. O catálogo comercial continua em `supabase/setup/`, nunca em migração.

### 5.2 Motor (reaproveitamento da SPEC 089)

```text
src/lib/ai/
  scope.ts            AgentScope, resolveScopeConfig(scope)
  knowledge-store.ts  interface KnowledgeStore { ingest, search }
    account-store.ts    implementação atual (ai_knowledge_*)
    platform-store.ts   platform_kb_*
src/lib/platform/assistant/
  config.ts           carrega e decifra a config da plataforma
  compose.ts          monta o turno: prompt do proprietário + base do produto + contexto da conta
  diagnostics/        ferramentas de leitura da conta (A-8), cada uma com teste
  quota.ts            quota mensal, orçamento diário, limite por usuário
  escalate.ts         A-10
```

O scaffold do prompt é outro: o assistente fala com o **usuário do CRM**, na língua da interface dele (`NEXT_LOCALE`), explica o produto, nunca promete recurso que o plano não tem, e escala quando a base não cobre. Texto do usuário, documento e resultado de ferramenta continuam sendo dado não confiável.

### 5.3 Console `/admin/assistant`

Abas: **Configuração** (provedor, chave, modelo, orçamento, ligar) · **Prompt** (com versões) · **Conhecimento** (documentos, fontes, teste de recuperação) · **Ferramentas** · **Conversas** (lista, leitura, o que foi escalado) · **Uso** (tokens e custo por conta e por dia). Rotas em `/api/platform/assistant/**`, todas atrás de `requirePlatformOwner()`. A habilitação por plano aparece no editor de planos já existente.

### 5.4 Widget no painel do cliente

- Botão no cabeçalho (`src/components/layout/header.tsx`) abre um painel lateral. Só aparece quando: a plataforma tem o assistente ligado, o plano da conta inclui e o papel é `owner` ou `admin`.
- Rotas `/api/assistant/**` com sessão por cookie: `POST /messages`, `GET /threads`, `POST /escalate`. A rota resolve conta e papel pela sessão, confere quota, monta o turno e responde. A chave da plataforma **nunca** chega ao navegador.
- Mostra as fontes da resposta (título do guia), o aviso de privacidade (A-11) e o botão de falar com o suporte.
- Conta bloqueada: o widget não aparece (a tela `/blocked` continua sendo a explicação).

### 5.5 Chaves e API de plataforma (migração 107)

`requirePlatformApiKey(request, scope)`: confere `PLATFORM_OWNER_EMAILS` (404 se ausente), acha a chave pelo hash, recusa revogada, confere o escopo, grava `last_used_at`.

| Escopo                     | Endpoints em `/api/platform/v1`                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform:read`            | `GET /summary`, `GET /accounts`, `GET /accounts/{id}` (plano, uso, estado, membros sem dado sensível), `GET /plans`, `GET /requests`, `GET /audit`                             |
| `platform:accounts:write`  | `POST /accounts/{id}/block` e `unblock`, `PUT /accounts/{id}/plan`, `PUT /accounts/{id}/billing/period-end`, `POST /accounts/{id}/billing/payments`, `PATCH /requests/{id}`    |
| `platform:assistant:read`  | `GET /assistant`, `GET /assistant/prompt-versions`, `GET /assistant/knowledge/documents`, `POST /assistant/knowledge/search`, `GET /assistant/usage`, `GET /assistant/threads` |
| `platform:assistant:write` | `PATCH /assistant` (prompt, modelo, ligar; **nunca** a chave), `POST`/`PATCH`/`DELETE` de documentos, `POST …/reindex`, `PATCH /assistant/tools`, `POST /assistant/test`       |

Cada endpoint chama a função de `src/lib/platform/` que o console já usa (`changeAccountPlan`, `blockAccount`, …), com o mesmo resultado e a mesma auditoria. Nenhuma regra nova de negócio nasce na rota.

### 5.6 Conjunto `platform` no MCP

| Grupo      | Ferramentas                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Leitura    | `platform_summary`, `list_accounts`, `get_account`, `list_plans`, `list_plan_requests`, `list_platform_audit`                                                                                                                                                                                                                        |
| Contas     | `block_account`, `unblock_account`, `change_account_plan`, `set_account_period_end`, `record_manual_payment`, `resolve_plan_request`                                                                                                                                                                                                 |
| Assistente | `get_assistant`, `update_assistant_prompt`, `list_assistant_prompt_versions`, `restore_assistant_prompt_version`, `test_assistant`, `list_assistant_documents`, `create_assistant_document`, `update_assistant_document`, `delete_assistant_document`, `search_assistant_knowledge`, `get_assistant_usage`, `list_assistant_threads` |

Não há ferramenta de exclusão de conta, de usuário nem de membro neste conjunto, com ou sem opt-in (A-19). `delete_assistant_document` apaga só documento da base do assistente.

Variáveis: `ZAPCRM_PLATFORM_KEY` (registra o conjunto), `ZAPCRM_PLATFORM_ENABLE_WRITES` (contas e assistente), mais o `confirm` de A-16. Uso típico, o que o pedido descreve: no Claude Desktop, "leia as 20 últimas conversas escaladas, proponha três documentos novos para a base e uma revisão do prompt"; o proprietário revê e aprova.

---

## 6. Segurança e LGPD

- **Separação de escopo**: chave de conta nunca abre `/api/platform/v1`, chave de plataforma nunca abre `/api/v1`. Prefixos diferentes e tabelas diferentes; teste cobre os dois sentidos.
- **Nada de conteúdo de inquilino** pelo escopo de plataforma (contatos, mensagens). `get_account` devolve metadado e uso.
- **Diagnóstico com a sessão do usuário** (A-8): o assistente não ganha visão maior que a de quem pergunta.
- **Segredo**: chave do provedor da plataforma cifrada; chave de plataforma guardada como hash e mostrada uma vez.
- **Sem exclusão de conta ou de usuário por MCP nem por API de plataforma** (A-19, ratificada) e sem estorno. O teste de registro do MCP falha se o conjunto `platform` expuser ferramenta de exclusão cujo alvo seja conta, usuário ou membro, e o teste de rotas falha se existir `DELETE` em `/api/platform/v1/accounts/**` ou `/users/**`. As ações com efeito comercial pedem confirmação com o nome da conta.
- **Injeção de prompt**: a pergunta do usuário não muda o que as ferramentas alcançam; as de diagnóstico são só leitura e já limitadas pela RLS.
- **Privacidade**: aviso no widget, retenção de 90 dias, exclusão em cascata com a conta, e a base do produto sem dado de cliente.
- **Custo**: quota por conta, orçamento diário, limite por usuário, modelo barato por padrão.
- Revisão de segurança dedicada na F6, antes de ligar o assistente em qualquer plano.

## 7. Fases

| Fase | Entrega                                                                                                                                                | Migração | Modelo sugerido                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------- |
| F0   | Decisões A-1…A-18 (a A-19 já está ratificada), estimativa de custo por conta e por mês, modelo padrão, conteúdo inicial da base, prazo de retenção     | —        | Opus 5.5                                            |
| F1   | `AgentScope` e `KnowledgeStore` no motor (refatoração sem mudar o comportamento da conta), tabelas `platform_assistant_*`, RPC, quota e chave de plano | 106      | Opus 5.5                                            |
| F2   | Console `/admin/assistant` completo                                                                                                                    | —        | Sonnet 5.5                                          |
| F3   | Widget no painel, ferramentas de diagnóstico, quota, escalar para o suporte                                                                            | —        | Sonnet 5.5                                          |
| F4   | Chaves de plataforma, `/api/platform/v1`, conjunto `platform` no MCP                                                                                   | 107      | Opus 5.5 (chaves e guardas), Sonnet 5.5 (endpoints) |
| F5   | **Opcional (A-9):** ações na conta com confirmação                                                                                                     | —        | Opus 5.5                                            |
| F6   | Revisão de segurança, roteiro manual, guia do proprietário (`docs/guia-console-do-proprietario.md`), `planos-quotas-admin.md`, `status.md`             | —        | Opus 5.5                                            |

Ordem entre as três SPECs: **089 F1–F3 → 090 F1 → 089 F4–F6 e 090 F2–F7 em paralelo → 091**. A 091 só começa com o motor de ferramentas (089 F4) e a camada de serviço (090 F1) prontos. Antes de aplicar cada migração no `vn`, confirmar com o mantenedor.

## 8. Testes

- **Motor**: os testes de `src/lib/ai/` passam sem alteração depois da F1 (a conta não percebe a refatoração); testes novos para `platform-store.ts`.
- **Isolamento**: chave de conta em rota de plataforma (404) e o inverso (401); usuário de uma conta não lê conversa de assistente de outra; `anon` e `authenticated` sem `EXECUTE` na RPC e sem `SELECT` nas tabelas (`scripts/verify-106-platform-assistant.sql`).
- **Quota e orçamento**: mensagem além da quota, orçamento diário estourado, plano sem a chave (widget ausente, rota 404).
- **Chave de plataforma**: escopo ausente, chave revogada, `PLATFORM_OWNER_EMAILS` vazio (404), proprietário agindo sobre a própria conta (recusa).
- **Auditoria**: cada escrita por API deixa uma linha em `platform_audit_log` com o ator certo.
- **MCP**: sem `ZAPCRM_PLATFORM_KEY` nenhuma ferramenta de plataforma é registrada; sem `confirm`, recusa com resumo.
- **Roteiro manual** (`docs/spec-091-teste-manual.md`): configurar o assistente, carregar três guias, perguntar pelo widget numa conta de teste, escalar, ver a conversa no console; pelo Claude Desktop, listar contas, trocar o plano de uma conta de teste e revisar o prompt.
- **Validação local completa** antes de cada entrega.

## 9. Pendências

| #   | Pendência                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | **Quem paga e quanto**: definir o modelo padrão e a quota por plano com base na estimativa da F0.                                                                     |
| R-2 | **Assistente para todos os papéis** da conta (A-4), depois de medir o uso.                                                                                            |
| R-3 | **Ações na conta** (A-9, F5): ratificar ou descartar depois da F3 em uso real.                                                                                        |
| R-4 | **Conteúdo da base**: quem escreve e revisa os guias; os `docs/` atuais são de operador e de desenvolvedor, não de cliente final.                                     |
| R-5 | **Transcrições**: confirmar o prazo de 90 dias e o texto do aviso; avaliar opção de o usuário apagar a própria conversa.                                              |
| R-6 | **Aposentar `/api/admin/**`** (`x-admin-secret`) em favor das chaves de plataforma, numa SPEC à parte, depois de migrar os scripts que a usam.                        |
| R-7 | **Backup do `vn`** antes de expor qualquer escrita de plataforma por API. Hoje não há; a recomendação desta SPEC é não ligar `ZAPCRM_PLATFORM_ENABLE_WRITES` sem ele. |
