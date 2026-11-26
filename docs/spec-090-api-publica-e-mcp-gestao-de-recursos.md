# SPEC 090 — API pública e MCP: criar, gerenciar, editar e excluir os recursos do ZAP CRM BR

| Campo            | Valor                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | **Proposta** — decisões M-1…M-18 aguardam ratificação do mantenedor. Nada implementado.                                                                                                             |
| Data             | 2026-11-26                                                                                                                                                                                          |
| Escopo           | `src/app/api/v1/**`, `src/lib/api-keys/scopes.ts`, camada de serviço em `src/lib/<módulo>/`, `mcp-server/`, `docs/public-api.md`, `public/openapi.json`, `public/openapi.pt-BR.json`, `docs/mcp.md` |
| Depende de       | [SPEC 089](./spec-089-agentes-de-ia-openrouter-rag-ferramentas.md) F1–F3 para a parte do agente (F3 daqui). As demais fases não dependem dela                                                       |
| Absorve          | SPEC 086 **I-17** (endpoints `/api/v1/forms`) e **I-18** (ferramentas MCP de formulário), ainda não implementadas                                                                                   |
| Migração         | Provisória **105**, só se M-11 (idempotência) for ratificada. Escopos não precisam de migração (`api_keys.scopes` é `text[]` livre)                                                                 |
| Dependências npm | Nenhuma no app. No `mcp-server/`: as já existentes (`@modelcontextprotocol/sdk`, `zod`)                                                                                                             |
| i18n             | Rótulos dos escopos novos na tela de chaves de API e ações novas em `Activity.actions.*`. Mensagens de `/api/v1` ficam em inglês                                                                    |

---

## 1. Contexto

O servidor MCP do ZAP CRM BR (`mcp-server/`) é uma camada fina sobre a API pública `/api/v1`: tudo o que ele faz, faz com uma chave de API escopada. Hoje ele lê contatos, conversas e mensagens, envia mensagem, cria e edita contato e lança disparo. Não enxerga o agente de IA, formulários, automações nem fluxos, e não exclui nada.

O pedido: pelo MCP, **criar, gerenciar, editar e excluir** o prompt do agente, disparos, formulários, automações, fluxos e contatos.

Como o MCP só faz o que a API pública faz, esta SPEC é, na prática, a **ampliação da API pública**, com o MCP acompanhando endpoint a endpoint.

## 2. Objetivo

1. Cobrir na `/api/v1` o ciclo completo (listar, ler, criar, editar, excluir e ações de estado) de: **agente de IA**, **contatos**, **disparos**, **formulários**, **automações** e **fluxos**.
2. Expor tudo como ferramentas MCP, organizadas em **conjuntos (toolsets)** que o operador liga por variável de ambiente.
3. Ampliar o modelo de segurança do MCP: leitura por padrão, escrita, configuração, exclusão e disparo como opt-ins separados, e confirmação explícita em tudo o que entra em produção ou não tem volta.
4. Publicar o servidor MCP **do fork** com nome próprio e instalação de um clique no Claude Desktop.

### Não-objetivos

- **MCP remoto por HTTP com OAuth** (conector personalizado do claude.ai). Ver M-16.
- **Criar ou revogar chave de API** por endpoint. Continua só pelo painel.
- **Chaves de provedor de IA** (`api_key`, `embeddings_api_key`) e segredos de ferramenta HTTP pela API. Só pelo painel.
- **Canais, números, QRCode, templates da Meta (criação), membros, convites, plano e cobrança.** Leitura de apoio de alguns deles entra (§4.7); gestão, não.
- **Inbox**: atribuição, etiquetas de conversa, notas. Fica para uma SPEC seguinte.
- **Operações em massa** de contato (importar, excluir em lote, exportar). Já existem no painel com proteções próprias.
- **Escopo de plataforma** (gerir contas do SaaS): é a SPEC 091.

---

## 3. Estado de partida (medido em 2026-11-26)

| Fato                                                                                                                                                                                                                                                  | Onde                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `/api/v1` tem: `me`, `messages` (POST), `contacts` (GET, POST), `contacts/{id}` (GET, PATCH), `conversations`, `conversations/{id}`, `conversations/{id}/messages`, `broadcasts` (POST), `broadcasts/{id}` (GET), `webhooks`, `ingest/contact`        | `src/app/api/v1/`                                              |
| **Não há `DELETE` de contato**, nem listagem de disparos; `POST /broadcasts` lança na hora, com até 1.000 destinatários no corpo                                                                                                                      | idem; `mcp-server/src/tools/broadcast.ts`                      |
| 8 escopos: `messages:send`, `messages:read`, `contacts:read`, `contacts:write`, `conversations:read`, `broadcasts:send`, `webhooks:manage`, `ingest:write`                                                                                            | `src/lib/api-keys/scopes.ts`                                   |
| MCP: 11 ferramentas (7 de leitura, 3 de escrita, 1 de disparo); opt-ins `WACRM_ENABLE_WRITES` e `WACRM_ENABLE_BROADCASTS`; só transporte stdio                                                                                                        | `mcp-server/src/`                                              |
| O pacote ainda é o do projeto original: `name: wacrm-mcp`, `mcpName: io.github.ArnasDon/wacrm-mcp`, autor e repositório do upstream. `docs/mcp.md` manda instalar com `npx -y wacrm-mcp`, que baixa o pacote **do upstream**, sem as mudanças do fork | `mcp-server/package.json`, `docs/mcp.md`                       |
| Versão divergente: `0.1.1` no `package.json`, `0.1.0` na constante `VERSION`                                                                                                                                                                          | `mcp-server/src/index.ts`                                      |
| Rotas internas (sessão por cookie) já fazem o CRUD de automações, fluxos e formulários; parte da regra mora **dentro da rota** (o `PATCH` de automação e o `PUT` de fluxo têm mais de 180 linhas cada)                                                | `src/app/api/automations/[id]/route.ts`, `flows/[id]/route.ts` |
| Validadores já estão em `src/lib/`: `automations/validate.ts`, `flows/validate.ts`, `forms/builder.ts` e `account-input.ts`, `broadcasts/parse-input.ts` e `draft.ts`                                                                                 | `src/lib/`                                                     |
| Contato é criado e apagado pelo painel **direto no navegador** (cliente Supabase sob RLS), sem rota interna                                                                                                                                           | `src/app/api/contacts/` (só `consent`, `export`, `check`)      |
| Rascunho de disparo usa o cliente de **sessão** de propósito (`loadBroadcastDraft` / `saveBroadcastDraft`)                                                                                                                                            | `src/lib/broadcasts/draft.ts`                                  |
| `requireApiKey` resolve a conta e barra conta bloqueada; **não** confere item de plano. `api_v1_enabled`, `flows_enabled`, `broadcasts_enabled` e `ai_enabled` existem em `FEATURE_KEYS` e nenhum código os lê                                        | `src/lib/auth/api-context.ts`, `src/lib/plans/types.ts`        |
| O registro de atividade já tem `actor_kind = 'api'`                                                                                                                                                                                                   | `src/lib/activity/query.ts`                                    |
| SPEC 086 I-17 previa `forms:read`, `forms:write` e **não** previa criar formulário pela API                                                                                                                                                           | `docs/spec-086-formularios-integracoes.md`                     |

---

## 4. Contrato proposto

Regra permanente: **cada linha das tabelas abaixo edita os três arquivos juntos** (`docs/public-api.md`, `public/openapi.json`, `public/openapi.pt-BR.json`), passa no `redocly lint` e no teste de paridade. Procedimento: skill `endpoint-api-publica`.

### 4.1 Escopos novos

| Escopo              | Dá direito a                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `account:read`      | Catálogos de apoio: templates, etiquetas, campos personalizados, funis, membros atribuíveis         |
| `contacts:delete`   | Excluir contato (separado de `contacts:write` por ser irreversível)                                 |
| `broadcasts:read`   | Listar e ler disparos                                                                               |
| `broadcasts:write`  | Criar, editar, agendar, cancelar e excluir **rascunho**. Lançar continua exigindo `broadcasts:send` |
| `forms:read`        | Formulários e respostas                                                                             |
| `forms:write`       | Criar, editar, publicar, arquivar, gerar link                                                       |
| `forms:delete`      | Excluir formulário e apagar respostas                                                               |
| `automations:read`  | Automações e o esquema de gatilhos e passos                                                         |
| `automations:write` | Criar, editar, duplicar, ativar, desativar, excluir                                                 |
| `flows:read`        | Fluxos, execuções e o esquema de nós                                                                |
| `flows:write`       | Criar, editar, ativar, desativar, excluir                                                           |
| `agent:read`        | Configuração do agente (sem chaves), versões de prompt, base de conhecimento, ferramentas, exemplos |
| `agent:write`       | Editar prompt e parâmetros, gerir documentos da base, ligar ferramentas, testar o agente            |

Escopo continua sendo da **conta**, nunca de um agente humano. Chave existente não ganha escopo novo sozinha.

### 4.2 Agente de IA (depende da SPEC 089)

| Método e caminho                                            | Escopo                       | Observação                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/agent`                                         | `agent:read`                 | Provedor, modelo, prompt, interruptores, teto por conversa, agente de handoff. **Nunca** devolve chave                                                                                                  |
| `PATCH /api/v1/agent`                                       | `agent:write`                | `system_prompt`, `model`, `auto_reply_enabled`, `auto_reply_max_per_conversation`, `handoff_agent_id`. **Não** aceita chave nem troca de provedor. Mudar o prompt grava uma versão com `source = 'api'` |
| `GET /api/v1/agent/prompt-versions`                         | `agent:read`                 | Histórico                                                                                                                                                                                               |
| `POST /api/v1/agent/prompt-versions/{id}/restore`           | `agent:write`                | Volta a uma versão                                                                                                                                                                                      |
| `POST /api/v1/agent/test`                                   | `agent:write`                | Playground: recebe mensagens, devolve a resposta, as fontes usadas e as ferramentas que seriam chamadas (sempre em simulação). Gasta tokens da chave da conta: limite `aiDraftAccount`                  |
| `GET` / `POST /api/v1/knowledge/documents`                  | `agent:read` / `agent:write` | Texto, pergunta e resposta, ou URL. Arquivo binário fica só no painel nesta SPEC                                                                                                                        |
| `GET` / `PATCH` / `DELETE /api/v1/knowledge/documents/{id}` | idem                         | `PATCH` aceita `title`, `content`, `is_enabled`, `tags`                                                                                                                                                 |
| `POST /api/v1/knowledge/documents/{id}/reindex`             | `agent:write`                |                                                                                                                                                                                                         |
| `POST /api/v1/knowledge/search`                             | `agent:read`                 | Teste de recuperação, sem LLM                                                                                                                                                                           |
| `GET` / `PATCH /api/v1/agent/tools`                         | idem                         | Liga, desliga e define listas permitidas. Ferramenta HTTP da conta: só leitura pela API (o segredo é do painel)                                                                                         |
| `GET` / `POST` / `PATCH` / `DELETE /api/v1/agent/examples`  | idem                         | Exemplos do ajuste do agente; aprovar candidato é `PATCH`                                                                                                                                               |

Ligar o interruptor geral da IA (`is_active`) pela API fica **fora**: é a decisão M-9.

### 4.3 Contatos

| Método e caminho                          | Escopo            | Observação                                                                                               |
| ----------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `DELETE /api/v1/contacts/{id}`            | `contacts:delete` | Mesmo efeito do painel (cascata de conversas e mensagens). Resposta traz o que foi apagado               |
| `POST /api/v1/contacts/{id}/tags`         | `contacts:write`  | Acrescenta etiquetas sem substituir as demais (hoje o `PATCH` só substitui tudo)                         |
| `DELETE /api/v1/contacts/{id}/tags/{tag}` | `contacts:write`  |                                                                                                          |
| `PATCH /api/v1/contacts/{id}`             | `contacts:write`  | Passa a aceitar `custom_fields` e `consent` (opt-in e opt-out), seguindo as regras de `consent-rules.ts` |
| `GET /api/v1/contacts`                    | `contacts:read`   | Filtros novos: `tag`, `q`, `updated_since`                                                               |

Telefone sempre validado pelo padrão da SPEC 050 (`src/lib/phone/`), como nas rotas atuais.

### 4.4 Disparos

| Método e caminho                        | Escopo                                  | Observação                                                                                                                     |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/broadcasts`                | `broadcasts:read`                       | Lista paginada, filtro por `status`                                                                                            |
| `POST /api/v1/broadcasts`               | `broadcasts:send` ou `broadcasts:write` | Ganha `draft: true`: cria **rascunho** e não envia (aí basta `broadcasts:write`). Sem o campo, comportamento atual, inalterado |
| `PATCH /api/v1/broadcasts/{id}`         | `broadcasts:write`                      | Só em `draft` ou `scheduled`. Nome, template, canal, variáveis, audiência                                                      |
| `POST /api/v1/broadcasts/{id}/schedule` | `broadcasts:send`                       | Agenda. Agendar é mandar: exige o escopo de envio                                                                              |
| `POST /api/v1/broadcasts/{id}/send`     | `broadcasts:send`                       | Lança um rascunho                                                                                                              |
| `POST /api/v1/broadcasts/{id}/cancel`   | `broadcasts:write`                      | Cancela agendado ou interrompe o que ainda não saiu                                                                            |
| `DELETE /api/v1/broadcasts/{id}`        | `broadcasts:write`                      | Só rascunho. Disparo enviado é histórico e não se apaga pela API                                                               |

Audiência: além da lista de destinatários no corpo, aceitar `audience: { type: 'filter', … }` com o mesmo `AudienceConfig` do assistente do painel (`src/lib/audience/`). Os estados reais de `BroadcastStatus` e o que o cron (`/api/broadcasts/cron`) faz com cada um são medidos na F0 antes de fechar este contrato.

### 4.5 Formulários (absorve SPEC 086 I-17)

| Método e caminho                                                                      | Escopo                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------- |
| `GET` / `POST /api/v1/forms`                                                          | `forms:read` / `forms:write`                  |
| `GET` / `PUT` / `DELETE /api/v1/forms/{id}`                                           | `forms:read` / `forms:write` / `forms:delete` |
| `PUT /api/v1/forms/{id}/fields`                                                       | `forms:write`                                 |
| `POST /api/v1/forms/{id}/publish` · `unpublish` · `archive` · `restore` · `duplicate` | `forms:write`                                 |
| `GET /api/v1/forms/{id}/responses` · `GET …/responses/{rid}`                          | `forms:read`                                  |
| `POST /api/v1/forms/{id}/responses/delete`                                            | `forms:delete`                                |
| `POST /api/v1/forms/{id}/links`                                                       | `forms:write`                                 |
| `GET /api/v1/forms/schema`                                                            | `forms:read`                                  |

Diferença em relação à 086: **criar e editar formulário pela API passa a existir**, porque é o que o pedido exige. Guarda de plano estrita (`forms_enabled`) e quotas da SPEC 085 valem igual. Upload de mídia do formulário fica só no painel.

### 4.6 Automações e fluxos

| Método e caminho                                                      | Escopo                                   |
| --------------------------------------------------------------------- | ---------------------------------------- |
| `GET` / `POST /api/v1/automations`                                    | `automations:read` / `automations:write` |
| `GET` / `PATCH` / `DELETE /api/v1/automations/{id}`                   | idem                                     |
| `POST /api/v1/automations/{id}/duplicate` · `activate` · `deactivate` | `automations:write`                      |
| `GET /api/v1/automations/schema`                                      | `automations:read`                       |
| `GET` / `POST /api/v1/flows`                                          | `flows:read` / `flows:write`             |
| `GET` / `PUT` / `DELETE /api/v1/flows/{id}`                           | idem                                     |
| `POST /api/v1/flows/{id}/activate` · `deactivate`                     | `flows:write`                            |
| `GET /api/v1/flows/{id}/runs`                                         | `flows:read`                             |
| `GET /api/v1/flows/templates` · `GET /api/v1/flows/schema`            | `flows:read`                             |

Os endpoints `…/schema` devolvem, em JSON Schema, os tipos de gatilho, de passo e de nó com seus campos, gerados a partir de `trigger-meta.ts`, `automations/validate.ts` e `flows/types.ts`. São o que permite a um assistente montar uma definição **válida** sem adivinhar.

### 4.7 Catálogos de apoio (`account:read`)

`GET /api/v1/templates` (aprovados, por canal), `GET /api/v1/tags`, `GET /api/v1/custom-fields`, `GET /api/v1/pipelines` (com etapas), `GET /api/v1/members` (só atribuíveis, sem e-mail). Somente leitura: uma automação que "adiciona a etiqueta X e move para a etapa Y" precisa desses identificadores.

### 4.8 Convenções transversais

- **`dry_run`**: todo `POST`, `PUT` e `PATCH` de formulário, automação, fluxo e disparo aceita `?dry_run=true`: valida, devolve o que seria gravado e os erros de validação, e não grava.
- **Nasce desligado**: automação e fluxo criados pela API nascem **inativos**, formulário nasce **rascunho**, disparo nasce **rascunho** quando `draft: true`. Ativar, publicar, agendar e enviar são chamadas separadas.
- **Envelope, paginação por cursor e erros em inglês**: os de hoje (`src/lib/api/v1/respond.ts`, `pagination.ts`).
- **Atividade**: toda escrita grava no registro de atividade com `actor_kind = 'api'` e o identificador da chave.
- **Eventos de webhook de saída novos** não entram nesta SPEC (a 086 I-16 trata de `form.submitted`).

---

## 5. Desenho

### 5.1 Um serviço, duas portas

Hoje parte da regra de automações, fluxos e disparos mora dentro da rota interna. Duplicá-la numa rota `/api/v1` criaria dois comportamentos para o mesmo recurso.

```text
src/lib/<módulo>/service.ts     regra e acesso a dados; recebe (db, accountId, actor, input)
        ▲                 ▲
src/app/api/<módulo>/     src/app/api/v1/<módulo>/
  sessão por cookie         chave de API (requireApiKey)
  db = cliente de sessão    db = cliente da chave, filtrado por account_id
```

- A extração é **refatoração sem mudança de comportamento**: primeiro o serviço com teste, depois a rota interna passa a chamá-lo, e só então nasce a rota `/api/v1`.
- `actor` (`{ kind: 'user', userId, role } | { kind: 'api', apiKeyId }`) vai para o serviço, que grava a atividade.
- **Cliente Supabase**: a rota interna continua com o cliente de sessão (RLS). A rota `/api/v1` usa o cliente que `requireApiKey` entrega; todo serviço filtra por `account_id` explicitamente, como redundância deliberada. Funções que hoje exigem o cliente de sessão (rascunho de disparo) são revistas uma a uma na F0, e a decisão fica registrada no serviço.
- Contatos não têm rota interna: o serviço de contato nasce aqui e o painel **não** é migrado para ele nesta SPEC.
- A mesma camada serve às ferramentas do agente (SPEC 089 §5.3).

### 5.2 Guardas no servidor

| Guarda          | Como                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chave e escopo  | `requireApiKey(request, scope)`, como hoje                                                                                                                       |
| Conta bloqueada | Já barrada por `requireApiKey`                                                                                                                                   |
| Item de plano   | Helper novo `requirePlanFeature(ctx, key)`: `forms_enabled` é estrito (já é); `flows_enabled`, `broadcasts_enabled`, `ai_enabled` e `api_v1_enabled` seguem M-12 |
| Quota           | O banco decide (triggers); o serviço traduz `QUOTA_EXCEEDED` para `402`/`409` com código estável                                                                 |
| Limite de taxa  | `RATE_LIMITS.publicApi` para leitura; limite novo, mais apertado, para escrita de configuração (`publicApiConfig`) e para `agent/test`                           |
| Papel           | Chave não tem papel: o escopo é a autorização. Criar chave continua restrito a admin                                                                             |

### 5.3 Servidor MCP

**Conjuntos de ferramentas.** Sessenta ferramentas carregadas de uma vez pioram a escolha do modelo e gastam contexto. O operador escolhe:

| Variável                   | Valores                                                                              | Padrão                     |
| -------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| `ZAPCRM_TOOLSETS`          | `core`, `contacts`, `broadcasts`, `forms`, `automations`, `flows`, `agent`, `all`    | `core` (o que existe hoje) |
| `ZAPCRM_ENABLE_WRITES`     | Cria e edita **dados** (contato, mensagem, rascunho de disparo)                      | desligado                  |
| `ZAPCRM_ENABLE_CONFIG`     | Cria e edita **configuração** (prompt do agente, base, formulário, automação, fluxo) | desligado                  |
| `ZAPCRM_ENABLE_DELETES`    | Ferramentas que excluem                                                              | desligado                  |
| `ZAPCRM_ENABLE_BROADCASTS` | Lançar e agendar disparo                                                             | desligado                  |

As variáveis `WACRM_*` continuam aceitas como sinônimo, para não quebrar instalação existente.

**Confirmação.** Exigem `confirm: true` e são marcadas `destructiveHint`: toda exclusão, e toda ação que **entra em produção** (ativar automação ou fluxo, publicar formulário, agendar ou lançar disparo, ligar `auto_reply_enabled`, ligar ferramenta de escrita do agente). A recusa devolve um resumo do que seria feito, como o `send_broadcast` já faz. Exclusão exige também `expected_name`, igual ao nome do recurso: o modelo tem de ter lido o que vai apagar.

**Ferramentas.** Uma por operação, com prefixo do recurso (`list_forms`, `get_form`, `create_form`, `update_form_fields`, `publish_form`, `archive_form`, `delete_form`, …; `get_agent`, `update_agent_prompt`, `list_prompt_versions`, `restore_prompt_version`, `test_agent`, `search_knowledge`, `create_knowledge_document`, …). A lista final sai da F0, uma por linha das tabelas do §4. Descrições em inglês, como as atuais.

**Esquemas como recurso MCP.** `get_automation_schema`, `get_flow_schema` e `get_form_schema` como ferramentas de leitura e também como _resources_ do MCP, para o cliente que os suporta.

**Empacotamento e nome.**

- Pacote próprio do fork (nome a ratificar em M-14), com `author` e `repository` do mantenedor e os créditos ao projeto original no README, como manda o `AGENTS.md`. `VERSION` passa a ser lida do `package.json`.
- **Pacote `.mcpb`** (extensão do Claude Desktop): instalação de um clique, com a URL da instância e a chave pedidas na interface e a chave guardada no cofre do sistema operacional.
- `docs/mcp.md` e `mcp-server/README.md` reescritos: instalação, conjuntos, opt-ins, tabela de ferramentas por escopo.
- Transporte continua **stdio**.

---

## 6. Decisões

Todas em estado **Proposta**.

| #    | Decisão                                                                                                                                                                                                                        | Motivo                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| M-1  | O MCP continua **camada fina sobre `/api/v1`**; nenhuma ferramenta fala direto com o banco.                                                                                                                                    | Um só lugar de autenticação, escopo, quota e auditoria. Regra do domínio `api-publica-webhooks`.                      |
| M-2  | **Camada de serviço** em `src/lib/` compartilhada entre rota interna, rota pública e ferramenta do agente (§5.1).                                                                                                              | Sem ela, cada recurso teria duas implementações divergindo com o tempo.                                               |
| M-3  | **Escopos por recurso, com exclusão separada** onde o estrago é irreversível (`contacts:delete`, `forms:delete`).                                                                                                              | Quem dá `contacts:write` a uma integração de sincronização não quer dar o poder de apagar a base.                     |
| M-4  | **Tudo nasce desligado** e ligar é chamada à parte, com `confirm` no MCP.                                                                                                                                                      | Um assistente que erra uma automação não pode começar a mandar mensagem para cliente no mesmo passo.                  |
| M-5  | **`dry_run`** em toda escrita de configuração.                                                                                                                                                                                 | O assistente valida antes de gravar, e o usuário revê o que será criado.                                              |
| M-6  | **Endpoints `…/schema`** gerados do código.                                                                                                                                                                                    | Definição de automação e de fluxo é uma árvore com muitos tipos; sem esquema, o modelo inventa campo.                 |
| M-7  | **Chaves de provedor e segredos nunca pela API.**                                                                                                                                                                              | Mesma regra das chaves de API: segredo só entra pelo painel, com sessão de admin.                                     |
| M-8  | **Trocar de provedor de IA** fica só no painel.                                                                                                                                                                                | A troca valida a chave nova com o provedor; sem a chave, não há o que validar.                                        |
| M-9  | **Interruptor geral da IA (`is_active`)** não se liga pela API; `auto_reply_enabled` sim, com `confirm`.                                                                                                                       | O interruptor geral é o "desligar tudo" do dono. Recomendação conservadora; rever se atrapalhar.                      |
| M-10 | **Disparo enviado não se apaga** pela API; só rascunho.                                                                                                                                                                        | É histórico de envio e base de cobrança da Meta.                                                                      |
| M-11 | **Idempotência** por cabeçalho `Idempotency-Key` nos `POST` que criam, com tabela `api_idempotency_keys` (24 h). Opcional: exige a migração 105.                                                                               | Cliente MCP repete chamada em caso de timeout; sem isso, dois formulários iguais. Recomendo incluir.                  |
| M-12 | **Itens de plano antigos** (`api_v1_enabled`, `flows_enabled`, `broadcasts_enabled`, `ai_enabled`): passam a valer nas rotas novas com semântica **não estrita** (ausente = permitido), depois de conferir o catálogo do `vn`. | Existem desde a 067 e nunca bloquearam nada. Modo estrito cortaria quem já usa. Decisão conjunta com a SPEC 089 D-20. |
| M-13 | **Conjuntos de ferramentas** no MCP, com `core` como padrão.                                                                                                                                                                   | Instalação existente não muda; quem quer mais, liga.                                                                  |
| M-14 | **Pacote próprio do fork.** Nome sugerido: `zap-crm-br-mcp`. Publicar no npm é ato do mantenedor.                                                                                                                              | `npx -y wacrm-mcp` instala o servidor do upstream, que não conhece as ferramentas novas.                              |
| M-15 | **`.mcpb` para o Claude Desktop** como forma recomendada de instalar.                                                                                                                                                          | Dispensa editar JSON e mantém a chave fora de arquivo de texto.                                                       |
| M-16 | **MCP remoto fica fora.** Conector personalizado do claude.ai conecta a partir da nuvem da Anthropic e, para o caso geral, exige OAuth; chave fixa em cabeçalho está em beta para um conjunto limitado de organizações (§9).   | Um servidor de autorização OAuth é um projeto à parte. O stdio atende o Claude Desktop, Claude Code e Cursor hoje.    |
| M-17 | **Absorver I-17 e I-18 da SPEC 086** e ampliá-las com criação e edição de formulário.                                                                                                                                          | Um só contrato de formulários na API. Ao ratificar, anotar na 086.                                                    |
| M-18 | **Limite de taxa próprio para escrita de configuração**, mais baixo que o de leitura.                                                                                                                                          | Um assistente em laço não deve criar centenas de automações antes de alguém notar.                                    |

---

## 7. Fases

| Fase | Entrega                                                                                                                                                                                | Modelo sugerido                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| F0   | Inventário por recurso: onde está a regra, o que precisa virar serviço, estados reais de disparo, lista final de endpoints e ferramentas, catálogo de plano do `vn`. Sem código        | Opus 5.5                                     |
| F1   | Fundação: padrão de serviço, escopos, `requirePlanFeature`, `dry_run`, atividade com ator `api`, limite `publicApiConfig`; MCP com conjuntos, opt-ins novos, pacote renomeado, `.mcpb` | Opus 5.5 (padrão), Sonnet 5.5 (resto)        |
| F2   | Contatos (excluir, etiquetas, consentimento, campos) e catálogos de apoio                                                                                                              | Sonnet 5.5                                   |
| F3   | Agente de IA (depende da SPEC 089 F1–F3)                                                                                                                                               | Sonnet 5.5                                   |
| F4   | Formulários                                                                                                                                                                            | Sonnet 5.5                                   |
| F5   | Automações, com esquema                                                                                                                                                                | Sonnet 5.5; extração do serviço com Opus 5.5 |
| F6   | Fluxos, com esquema                                                                                                                                                                    | idem                                         |
| F7   | Disparos: rascunho, agenda, cancelamento, audiência por filtro                                                                                                                         | Opus 5.5 (toca envio real)                   |
| F8   | Revisão de segurança, roteiro manual com o Claude Desktop, publicação do pacote, documentação                                                                                          | Opus 5.5                                     |

Cada fase fecha com: endpoint, os **três arquivos** do contrato, ferramentas MCP, testes e `/code-review high`. F2, F4, F5 e F6 são independentes entre si e podem ser feitas em qualquer ordem depois da F1.

## 8. Testes e segurança

- **Serviço**: teste ao lado, incluindo o caso "recurso de outra conta" (tem de devolver 404, nunca 403 com vazamento de existência).
- **Rota**: escopo ausente (403), conta bloqueada, item de plano desligado, quota estourada, `dry_run` que não grava, criação que nasce desligada.
- **Regressão**: as rotas internas refatoradas mantêm os testes atuais verdes (`routes.test.ts` de formulários e os de automação e fluxo).
- **Contrato**: `redocly lint` nos dois JSON e o comando de paridade de [`api-publica-webhooks.md`](./context/api-publica-webhooks.md).
- **MCP**: teste de registro (conjunto e opt-in certos expõem exatamente as ferramentas esperadas; sem opt-in, nenhuma de escrita aparece) e de recusa sem `confirm`.
- **Segurança (F8)**: isolamento entre contas em todo endpoint novo; nenhum segredo em resposta; injeção por conteúdo (um nome de formulário ou texto de documento com instruções não muda o que a ferramenta faz); teto de criação por minuto.
- **Roteiro manual** (`docs/spec-090-teste-manual.md`): com o Claude Desktop e uma chave real, criar um formulário, uma automação que reage a ele e um rascunho de disparo; conferir que nada ficou ativo sem confirmação; excluir tudo.

## 9. Fontes externas consultadas (2026-11-26)

- Autenticação de conectores personalizados do Claude: [documentação de autenticação](https://claude.com/docs/connectors/building/authentication). Tipos aceitos por padrão: OAuth com registro dinâmico e sem autenticação; cabeçalho fixo em beta para um conjunto limitado de organizações. O transporte exigido não foi confirmado nesta sessão.

## 10. Pendências

| #   | Pendência                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-1 | **MCP remoto com OAuth** (M-16): reavaliar quando houver demanda de uso pelo claude.ai na web ou no celular.                                            |
| Q-2 | **Inbox pela API** (atribuir, etiquetar conversa, nota interna): próxima SPEC da API pública.                                                           |
| Q-3 | **Upload de arquivo** para a base de conhecimento e mídia de formulário pela API: exige `multipart` ou URL assinada; fora daqui.                        |
| Q-4 | **Eventos de webhook de saída** para os recursos novos (`automation.updated`, `broadcast.completed`).                                                   |
| Q-5 | **Nome do pacote e do registro MCP** (M-14) e quem publica.                                                                                             |
| Q-6 | **Migrar o painel de contatos** para o serviço novo, tirando a escrita direta do navegador. Ganho de consistência, risco de regressão: decidir à parte. |
