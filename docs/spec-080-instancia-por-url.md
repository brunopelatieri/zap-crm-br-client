# SPEC 080 — Instância por URL: outra URL do Zap CRM BR com outro Supabase

|                   |                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**        | Aprovada. D-1 a D-9 ratificadas em 2026-10-30 (§2). Próximo passo: F1. Nada implementado                                                          |
| **Data**          | 2026-10-30                                                                                                                                        |
| **Origem**        | [PRD 077](./prd-077-supabase-dedicado-por-cliente.md) §3                                                                                          |
| **Código do app** | **Nenhum** em `src/`. Entregas: documentação, `.env.local.example` completo e um verificador de versão de schema só leitura (§6)                  |
| **Migração**      | Nenhuma                                                                                                                                           |
| **Contexto**      | [`deploy-docker`][dd] · [`supabase-rls-mcp`][sr] · [`canais-e-qrcode`][cq] · [`whatsapp-cloud`][wc] · [`automacoes-cron`][ac] · [`status.md`][st] |

[dd]: ./context/deploy-docker.md
[sr]: ./context/supabase-rls-mcp.md
[cq]: ./context/canais-e-qrcode.md
[wc]: ./context/whatsapp-cloud.md
[ac]: ./context/automacoes-cron.md
[st]: ./context/status.md

---

## 1. O que esta SPEC entrega

- **Instância oficial:** stack `zapcrm` (serviço `zapcrm_app`) em
  `https://zap.local.ia.br`, com o Supabase `vn` e a Evolution Go oficial
  (`go.local.ia.br`). Não muda nada.
- **Instância extra:** um conjunto próprio, tudo com as mesmas imagens:
  - **stack do app no Portainer**, com a própria URL, o próprio `.env` (outro
    Supabase) e o próprio console `/admin`;
  - **stack da Evolution Go**, com URL, `GLOBAL_API_KEY` e banco próprios.

```text
Instância     Stack do app      URL do app                Supabase   Stack Evolution Go   URL Evolution
oficial       zapcrm            zap.local.ia.br           vn         (oficial)            go.local.ia.br
<nome>        zapcrm-<nome>     <host>                    próprio    evogo-<nome>         <host-evolution>
```

Esta SPEC transforma isso em procedimento repetível (§4), define o que muda e o
que se compartilha entre instâncias (§3), fixa as invariantes de operar N
bancos (§5) e entrega as poucas peças de repositório que tornam o processo
seguro (§6).

---

## 2. Decisões

| #   | Decisão                  | Recomendação                                                                                                                                                                                                                                             |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Modelo                   | **Uma instância por URL** — ratificada em 2026-10-30 (PRD 077 §3)                                                                                                                                                                                        |
| D-2 | Onde o app vive          | **Ratificada: uma stack do Portainer por instância** (`zapcrm-<nome>`), não um serviço a mais na stack `zapcrm`. Cada instância atualiza no próprio ritmo (§5)                                                                                           |
| D-3 | URL do app e Meta        | **Ratificada: uma URL de app por instância, na stack dela.** Para WhatsApp Cloud, App da Meta próprio com callback `https://<host>/api/whatsapp/webhook` (um App tem uma só URL de callback). Override por WABA fica para SPEC futura (PRD 077 §5)       |
| D-4 | Evolution Go (QRCode)    | **Ratificada: Evolution Go própria por instância.** Stack `evogo-<nome>` com a mesma imagem da oficial, URL, `GLOBAL_API_KEY` e banco próprios. Nenhuma instância enxerga as sessões de WhatsApp da outra, e a capacidade de uma não disputa com a outra |
| D-5 | Dono do projeto Supabase | **Ratificada: organização do mantenedor**, região `us-east-2` (perto da VPS). Plano: decidir por cliente; o Free não tem backup gerenciado, como já acontece com o `vn`                                                                                  |
| D-6 | Schema do banco novo     | **Ratificada: aplicar `supabase/migrations/*.sql` em ordem com `psql -v ON_ERROR_STOP=1`**, ensaiado antes num Supabase local (F3). Fallback: dump de schema do `vn`                                                                                     |
| D-7 | Cadastro público         | **Ratificada: desligado** (`NEXT_PUBLIC_SIGNUP_ENABLED=false` e "Allow new users to sign up" off no Supabase Auth). O primeiro usuário nasce pelo painel do Supabase (§4, passo 8)                                                                       |
| D-8 | Console `/admin`         | **Ratificada: cada instância com o seu.** `PLATFORM_OWNER_EMAILS` e `PLATFORM_ADMIN_SECRET` próprios. Quem estiver na lista controla planos, quotas, bloqueios e exclusões **daquela** instância e de nenhuma outra                                      |
| D-9 | Registro das instâncias  | **Ratificada: tabela "Instâncias" em [`status.md`][st]**, com as colunas de §6. O painel no `/admin` (Opção C) só a partir de 2 instâncias extras                                                                                                        |

---

## 3. O que muda por instância

### 3.1. Variáveis de ambiente

Extraídas do código em 2026-10-30: `process.env.*` e `env.*` em `src/`, mais
os 33 `envVar` de [`src/lib/limits/registry.ts`](../src/lib/limits/registry.ts)
(limites de ajuste fino, todos com padrão no código). O `.env.local.example`
hoje lista só 7 nomes; F1 o completa (§6).

| Regra                              | Variáveis                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Única por instância**            | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` · `NEXT_PUBLIC_SITE_URL` (= `https://<host>`) · `ENCRYPTION_KEY` (nova: `openssl rand -hex 32`) · `AUTOMATION_CRON_SECRET` · `EVOLUTION_API_URL` (= URL da `evogo-<nome>`), `EVOLUTION_GLOBAL_API_KEY` (a dessa Evolution) · `PLATFORM_OWNER_EMAILS`, `PLATFORM_ADMIN_SECRET` (D-8) · `ALLOWED_INVITE_HOSTS` (= `<host>`) |
| **Por instância, se houver**       | `META_APP_ID`, `META_APP_SECRET` (D-3) · `EVOLUTION_WEBHOOK_PUBLIC_URL` (só se diferente do `SITE_URL`) · `SYSTEM_EVENT_WEBHOOK_URL`, `SYSTEM_EVENT_WEBHOOK_SECRET`, `PLAN_REQUEST_WEBHOOK_URL` · `SYSTEM_NOTIFICATION_EMAIL`                                                                                                                                                                                      |
| **Podem repetir a oficial**        | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (ou SMTP do cliente) · `NEXT_PUBLIC_APP_LOCALE`                                                                                                                                                                                                                                                                                 |
| **Ajuste fino (padrão no código)** | `NEXT_PUBLIC_SIGNUP_ENABLED` (D-7) · `MESSAGE_RETENTION_*`, `ACTIVITY_LOG_RETENTION_DAYS` · `EVOLUTION_INSTANCE_PREFIX` (padrão `zapcrm` serve: a Evolution é exclusiva), `EVOLUTION_MAX_INSTANCES_TOTAL` (capacidade **desta** Evolution) e os demais limites do registro, `EVOLUTION_DEBUG` · `AI_CONTEXT_MESSAGE_LIMIT`, `AI_REQUEST_TIMEOUT_MS` · `WHATSAPP_TEMPLATES_DRY_RUN`                                 |

**`ENCRYPTION_KEY` nunca se copia da oficial.** Chave igual faria um token
cifrado num banco ser legível com a chave do outro, o que quebra o isolamento.
Ela também nunca muda depois de criada ([`deploy-docker`][dd], regra 6).

### 3.2. Fora do container

| Item              | Por instância                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DNS               | Dois registros apontando para a VPS: `<host>` (app) e `<host-evolution>`                                                                                                                                                                               |
| Traefik           | Regra `Host(...)` e **nomes de router e de service únicos** nos labels das duas stacks. O Traefik é um só para todas as stacks: um nome repetido faz um router engolir o outro                                                                         |
| Supabase Auth     | Site URL, Redirect URLs, SMTP de Auth, templates (`docs/templates_email_send/`), cadastro (D-7)                                                                                                                                                        |
| Agendador de cron | Pingers no cron-job.org para as rotas de [`status.md`][st], com o `AUTOMATION_CRON_SECRET` **desta** instância                                                                                                                                         |
| Meta              | App próprio (D-3); callback `https://<host>/api/whatsapp/webhook`; verify token cadastrado na tela do canal                                                                                                                                            |
| Evolution Go      | Stack `evogo-<nome>` (D-4): copiar a stack da Evolution oficial e trocar host, `GLOBAL_API_KEY` (nova), banco Postgres e armazenamento de mídia, todos exclusivos. O webhook de cada instância remota é registrado sozinho, com o `SITE_URL` deste app |

---

## 4. Runbook — criar uma instância

Cada passo tem uma checagem; não avance com ela vermelha. `<nome>` e `<host>`
são escolhidos aqui e vão para a tabela de [`status.md`][st] no fim.

| #   | Passo                                                                                                                                                                                                                             | Checagem                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Criar o projeto Supabase (D-5) e guardar a senha do Postgres fora do repo                                                                                                                                                         | Painel mostra o projeto ativo                                                                                                 |
| 2   | Aplicar as migrações em ordem (D-6), pelo _session pooler_ (porta 5432): `docker run --rm -v "$PWD/supabase/migrations:/m" postgres:17 sh -c 'for f in /m/*.sql; do psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f" \|\| exit 1; done'` | Sem erro; o verificador de versão (§6) não acusa falta; `get_advisors` (security) sem alerta novo                             |
| 3   | Seed de planos: copiar `supabase/setup/plans-seed.sql` para `plans-seed-<nome>.sql`, ajustar preços e limites e rodar; conferir `platform_settings.default_plan_code`                                                             | `select code from plans` lista o catálogo; o plano padrão existe                                                              |
| 4   | Supabase Auth: Site URL `https://<host>`, Redirect URLs, SMTP, templates, cadastro off                                                                                                                                            | E-mail de teste com link para `<host>`, não `localhost`                                                                       |
| 5   | DNS de `<host>` e `<host-evolution>` para a VPS                                                                                                                                                                                   | `nslookup` dos dois devolve o IP da VPS                                                                                       |
| 6   | Stack `evogo-<nome>` no Portainer (§3.2), com a mesma imagem da Evolution oficial                                                                                                                                                 | `https://<host-evolution>` responde com certificado válido e aceita **só** a `GLOBAL_API_KEY` nova                            |
| 7   | Stack `zapcrm-<nome>` no Portainer: copiar o compose da stack `zapcrm` e trocar **só** os labels do Traefik (Host, router, service) e o `environment` (§3.1), apontando `EVOLUTION_API_URL` para a `evogo-<nome>`                 | Diff entre os dois composes = só esses dois pontos; log do `runtime-env` sem variável faltando; `https://<host>` abre o login |
| 8   | Primeiro usuário: "Add user" no painel do Supabase Auth. `handle_new_user` cria conta, perfil e plano padrão                                                                                                                      | Login em `<host>` cai no dashboard da conta nova                                                                              |
| 9   | Crons (§3.2)                                                                                                                                                                                                                      | Cada rota responde 200 ao pinger (503 = segredo faltando no servidor)                                                         |
| 10  | Canais: QRCode pela tela (cria a sessão na `evogo-<nome>`) e/ou Cloud com App próprio (§3.2)                                                                                                                                      | Mensagem enviada e recebida aparece no inbox de `<host>`; a sessão QR **não** aparece na Evolution oficial                    |
| 11  | Isolamento: o contato de teste criado em `<host>` não existe no `vn`; o `/admin` de `<host>` só abre para os e-mails da lista dele, e o de `zap.local.ia.br` não lista a conta nova                                               | `select count(*)` pelo telefone no `vn` = 0; 404 no `/admin` para quem não está na lista                                      |
| 12  | Registrar a instância na tabela de [`status.md`][st]                                                                                                                                                                              | Linha com host, stacks, ref, data e versão                                                                                    |

**Remover uma instância:** desligar os pingers; repontar ou apagar o callback
do App da Meta; remover as stacks `zapcrm-<nome>` e `evogo-<nome>` (as sessões
QR morrem com a Evolution dela, sem tocar na oficial) e o DNS; pausar o projeto
Supabase pelo prazo combinado; tirar a linha de [`status.md`][st].

---

## 5. Operar N instâncias — invariantes

1. **Migração antes da imagem, instância por instância.** Cada stack é
   atualizada sozinha (D-2): o Swarm fixa o digest da imagem no deploy, e a
   instância só muda de versão quando a stack dela é reimplantada com "re-pull".
   Uma imagem nova sobre um banco sem a migração dela quebra a instância.
   Ordem, para cada linha da tabela de instâncias: aplicar a migração no banco,
   rodar o verificador (§6) e só então reimplantar a stack do app. Instâncias
   podem ficar em versões diferentes por um tempo; um banco atrás da imagem,
   nunca. O `list_migrations` do MCP não serve para conferir: no `vn`, 086–089
   estão aplicadas sem registro ([`status.md`][st]).
2. **Nenhuma instância conhece outra.** Sem fallback, sem chave de outro banco,
   sem webhook cruzado. Instância fora do ar devolve erro; nunca grava no `vn`.
3. **Segredo novo por instância** (§3.1), gerado na hora, guardado só na
   stack, nunca no repo nem no chat.
4. **Capacidade compartilhada é só a da VPS.** Cada instância soma o
   container do app, o da Evolution Go e o banco/armazenamento dela. Antes de
   criar uma, `docker stats` na VPS.
5. **Evolution Go também segue a ordem de atualização.** Ao atualizar a imagem
   da Evolution, faça uma stack `evogo-*` de cada vez e confira as sessões QR
   daquela instância antes de seguir para a próxima.
6. **MCP:** o Supabase de uma instância extra só entra no `.mcp.json` se o
   mantenedor pedir. Agentes não escrevem nele por padrão.

---

## 6. Entregas no repositório

| Entrega                                     | Detalhe                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.local.example` completo               | Todos os nomes de §3.1, agrupados e comentados, **sem valor**; os do registro de limites podem entrar como bloco comentado. É a lista que o runbook manda preencher                                                                                                                                                                                                     |
| [`deploy-docker`][dd] — "Instância por URL" | Seção curta com as regras de §3 e §5 e link para esta SPEC; [`INDEX.md`](./context/INDEX.md) ganha a linha "Nova URL/instância → `deploy-docker`"                                                                                                                                                                                                                       |
| [`status.md`][st] — tabela "Instâncias"     | Colunas: host do app, stack do app, project ref, stack/host da Evolution Go, criada em, versão de schema conferida. Começa com a oficial (`zap.local.ia.br`, `zapcrm`, `vn`, `go.local.ia.br`). D-9                                                                                                                                                                     |
| `scripts/schema-version-check.mjs`          | Lê `supabase/migrations/`, extrai de cada arquivo um objeto marcante (primeira `CREATE TABLE`/`FUNCTION`/`TRIGGER`/`INDEX`) e imprime **um `SELECT` só leitura** que, rodado em qualquer banco, lista as migrações cujo objeto falta. Não conecta em banco nenhum. A extração mora num módulo com teste Vitest co-locado (`*.test.ts`), seguindo a regra do `AGENTS.md` |

---

## 7. Fases

Uma sessão por fase, cada uma fechando com `/code-review high` nos arquivos
que tocou. Nenhuma roda git; nenhuma escreve em banco sem confirmação.

| Fase | Entrega                                                                                                                                                                                                                                            | Modelo         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| F0   | Ratificar D-1 a D-9 — **feito em 2026-10-30**                                                                                                                                                                                                      | manual         |
| F1   | Documentação de §6 (domínio, INDEX, tabela de instâncias) e `.env.local.example`                                                                                                                                                                   | Sonnet 5.5     |
| F2   | `schema-version-check` + teste; rodar o `SELECT` gerado no `vn` e registrar o resultado em [`status.md`][st]                                                                                                                                       | Sonnet 5.5     |
| F3   | Ensaio do passo 2 num Supabase local (`supabase start`, banco na porta 54322): migrações 001→última num banco vazio, verificador zerado. **Também prova que um fork consegue subir o schema do zero.** Falha encontrada vira SPEC/migração própria | Sonnet 5.5     |
| F4   | Primeira instância real, quando houver cliente (§4)                                                                                                                                                                                                | manual (Bruno) |

---

## 8. Armadilhas

| Sintoma                                              | Causa provável                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A URL nova abre a instância oficial (ou vice-versa)  | Nome de router/service do Traefik repetido entre as stacks                                                         |
| Container reinicia em loop ao subir                  | Variável obrigatória ausente: o `runtime-env` para de propósito; leia o log                                        |
| E-mail de convite ou de senha aponta para outro host | Site URL do Supabase Auth ou `NEXT_PUBLIC_SITE_URL` copiados da oficial                                            |
| Webhook da Meta nunca chega na instância nova        | App da Meta compartilhado: o callback continua na oficial (D-3)                                                    |
| Sessão QR do cliente aparece na Evolution oficial    | `EVOLUTION_API_URL`/`EVOLUTION_GLOBAL_API_KEY` copiados da stack `zapcrm` em vez de apontar para a `evogo-<nome>`  |
| Cliente vê o `/admin` da plataforma oficial          | `PLATFORM_OWNER_EMAILS` copiado da stack `zapcrm` (D-8)                                                            |
| Instância quebra logo depois de reimplantar a stack  | Migração nova não aplicada no banco dela (§5, invariante 1)                                                        |
| `supabase db push` ignora arquivos                   | O CLI espera `<versão>_<nome>.sql` numérico; `084b_*` não casa. Use `psql` em ordem (D-6), confirmado no ensaio F3 |
| Cron "não dispara", sem erro                         | Pinger sem o `AUTOMATION_CRON_SECRET` desta instância (rota devolve 503)                                           |

## 9. Fora de escopo

- Roteamento por host num processo único e resolver por usuário (PRD 077 §4).
- Painel de instâncias no `/admin` (Opção C) e override de callback da Meta
  por WABA (PRD 077 §5).
- Mover conta existente do `vn` para uma instância dedicada.
