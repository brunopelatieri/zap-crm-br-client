# Índice de contexto — mapa do repo e roteamento por tarefa

> Ponto de entrada sob demanda (SPEC 079). Fatos que envelhecem (versões, última migração, nº de chaves, rotas de cron) ficam **só** em [`status.md`](./status.md). Lista completa de SPECs/PRDs/guias: [`catalogo-specs.md`](./catalogo-specs.md).

## Mapa do repositório

```text
src/
  middleware.ts          gate de sessão/bloqueio (não há proxy.ts). NÃO resolve locale
                         (isso é src/i18n/request.ts) e o matcher exclui os webhooks
                         da Meta e da Evolution
  app/
    (auth)/              login, signup, forgot-password, reset-password
    (dashboard)/         dashboard, inbox, contacts, pipelines, broadcasts, automations,
                         flows, agents, forms, notifications, activity, plan, settings
    (public)/f/          página pública dos formulários (`/f/<slug>`, sem sessão)
    (platform)/admin/    console do proprietário da plataforma (SaaS)
    auth/                callback, confirm (troca de token do Supabase Auth)
    blocked/             tela de conta/usuário bloqueado
    join/[token]/        aceite de convite de equipe
    api/                 account, admin, ai, automations, broadcasts, channels, contacts,
                         evolution, flows, import, inbox, invitations, messages, plans,
                         platform, quick-replies, whatsapp (+ rotas */cron → status.md)
    api/v1/              API REST pública (chaves escopadas)
  components/<módulo>/   UI por módulo; components/ui/ = shadcn (não editar sem necessidade)
  lib/<módulo>/          regra de negócio + *.test.ts co-locado (tabela abaixo)
  hooks/                 hooks React compartilhados
  i18n/request.ts        config server-side do next-intl
  types/index.ts         tipos do domínio
messages/                en.json (fonte da verdade) + pt-BR.json (espelho)
supabase/migrations/     numeradas em sequência — última e próxima livre em status.md
supabase/setup/          NÃO-migração: cron-jobs.sql, plans-seed*.sql, orphan-media-cleanup.sql
scripts/                 check-i18n-parity.mjs, evolution-probe.mjs, sync-emojibase.mjs,
                         verify-039-rls.sql, verify-040-media.sql
public/openapi*.json     contrato OpenAPI 3.1 (en + pt-BR)
Dockerfile, docker/      imagem de produção (next.config.ts, .dockerignore)
mcp-server/              servidor MCP para controlar o CRM por assistentes
n8n_automation/          workflows n8n versionados (credenciais redigidas)
docs/                    SPECs/PRDs/guias (catalogo-specs.md); docs/context/ = este roteamento
```

## Tarefa → domínio → rule/skill

Domínio = `docs/context/<domínio>.md` (ler sob demanda). Rule = `.claude/rules/<domínio>.md`, carregada sozinha quando o arquivo editado casa os `paths:` dela. Skill = `.claude/skills/<nome>/` (só Claude Code). Caminhos sem prefixo na 2ª coluna são relativos a `src/lib/`. **†** = fora dos globs da rule previstos no §5.4 da SPEC 079: a rule não dispara sozinha ali — leia o domínio por este índice.

| Tarefa                                                                                 | Onde                                                                                                                                                                                                                                             | Domínio                                                       | Skill                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------ |
| Enviar/receber WhatsApp Cloud, templates, disparos em massa, cobrança                  | `whatsapp/`, `broadcasts/`, `meta-errors.ts`, `broadcast-status.ts` †, `template-status.ts` †; `src/app/api/whatsapp/`, `src/app/api/broadcasts/` †                                                                                              | [`whatsapp-cloud`](./whatsapp-cloud.md)                       | `webhooks-meta`          |
| Canais, números oficiais, QRCode (Evolution Go), transferência                         | `channels/`, `evolution/`; `src/app/api/channels/`, `src/app/api/evolution/`, `scripts/evolution-probe.mjs`                                                                                                                                      | [`canais-e-qrcode`](./canais-e-qrcode.md)                     | `evolution-go-qrcode`    |
| Inbox, atribuição, presença, etiquetas, kanban, emojis, mídia                          | `inbox/`, `pipelines/`, `emoji/`, `storage/`, `presence.ts`, `tags.ts`, `colors.ts` †; `src/app/api/inbox/`, `src/app/api/quick-replies/` †                                                                                                      | [`inbox-atribuicao`](./inbox-atribuicao.md)                   | —                        |
| Apagar mensagem enviada (SPEC 074)                                                     | `messages/`                                                                                                                                                                                                                                      | [`inbox-atribuicao`](./inbox-atribuicao.md)                   | —                        |
| Automações no-code e agendamento por cron                                              | `automations/`; `src/app/api/automations/` †, `src/app/api/**/cron/route.ts`, `supabase/setup/cron-jobs.sql`                                                                                                                                     | [`automacoes-cron`](./automacoes-cron.md)                     | —                        |
| Flows (editor visual)                                                                  | `flows/`; `src/components/flows/`, `src/app/api/flows/`                                                                                                                                                                                          | [`flows`](./flows.md)                                         | —                        |
| Contatos, importação/exportação, audiência, telefone BR, ingestão                      | `contacts/`, `audience/`, `ingest/`, `phone/`, `spreadsheet/`; `src/app/api/contacts/`, `src/app/api/import/`, `n8n_automation/`                                                                                                                 | [`contatos-audiencia`](./contatos-audiencia.md)               | `integracao-n8n`         |
| Supabase: clientes, RLS, migrações, privilégios de função, MCP                         | `supabase/`; `supabase/**`, `scripts/verify-*.sql`                                                                                                                                                                                               | [`supabase-rls-mcp`](./supabase-rls-mcp.md)                   | `nova-migracao-supabase` |
| Traduções e locale                                                                     | `i18n/`; `messages/*.json`, `src/i18n/`, `scripts/check-i18n-parity.mjs`                                                                                                                                                                         | [`i18n`](./i18n.md)                                           | —                        |
| API pública `/api/v1`, chaves, webhooks de saída (SSRF), MCP                           | `api/v1/`, `api/uuid.ts` †, `api-keys/`, `webhooks/`; `public/openapi*.json`, `docs/public-api.md`, `mcp-server/src/`                                                                                                                            | [`api-publica-webhooks`](./api-publica-webhooks.md)           | `endpoint-api-publica`   |
| Planos, quotas, limites, console `/admin`, bloqueio                                    | `plans/`, `limits/`, `platform/`; `src/app/(platform)/admin/`, `src/app/api/admin/`, `src/app/api/platform/`, `src/app/blocked/`                                                                                                                 | [`planos-quotas-admin`](./planos-quotas-admin.md)             | —                        |
| Registro de atividade, painel/métricas, retenção                                       | `activity/`, `dashboard/`, `retention/`                                                                                                                                                                                                          | [`atividade-painel-retencao`](./atividade-painel-retencao.md) | —                        |
| Notificações do sistema (SMTP + webhook)                                               | `mailer/`, `notifications/`; `src/components/email-spam-notice.tsx`                                                                                                                                                                              | [`notificacoes-smtp`](./notificacoes-smtp.md)                 | —                        |
| Login, senha, papéis, convites, membros, excluir a conta                               | `auth/`, `account/`, `http/` †; `src/app/(auth)/` (forgot-password †), `src/app/auth/`, `src/app/join/`, `src/app/api/account/`, `src/app/api/invitations/`, `src/middleware.ts`                                                                 | [`auth-e-conta`](./auth-e-conta.md)                           | —                        |
| Área do contato (`/area`: login do cliente final, código pelo WhatsApp, item de plano) | `contact-portal/` (inclui `plan-gate.ts`); `src/app/(portal)/`, `src/app/api/contact-portal/`, `src/components/contact-portal/`, `src/components/contacts/contact-portal-access-card.tsx`, `src/components/settings/contact-portal-settings.tsx` | [`auth-e-conta`](./auth-e-conta.md) § Área do contato         | —                        |
| Formulários de captação (construtor `/forms`, página pública `/f/<slug>`, respostas, exportação, quotas e plano, varredura de uploads) | `forms/`; `src/components/forms/`, `src/app/api/forms/`, `src/app/(public)/f/`, `src/app/api/contacts/[id]/form-responses/`, `src/components/contacts/contact-forms-tab.tsx`, `src/components/inbox/contact-forms-card.tsx`, `src/components/settings/forms-settings.tsx` | [`formularios`](./formularios.md) | — |
| IA: rascunho, auto-reply, agentes, provedores                                          | `ai/`; `src/app/api/ai/`, `src/components/agents/`                                                                                                                                                                                               | [`ia-agentes`](./ia-agentes.md)                               | —                        |
| Deploy, Docker, build                                                                  | `Dockerfile`, `docker/`, `next.config.ts`, `.dockerignore`                                                                                                                                                                                       | [`deploy-docker`](./deploy-docker.md)                         | —                        |
| Acesso SSH à VPS (diagnóstico de Traefik, Swarm, logs; só leitura) | `docs/deploy/server_contabo.md` (local, sem segredo) | [`vps-ssh`](./vps-ssh.md) | — |
| Utilitários transversais                                                               | `array.ts`, `currency.ts`, `image-format.ts`, `rate-limit.ts`, `themes.ts`, `utils.ts`                                                                                                                                                           | sem domínio nem rule — siga as convenções do `AGENTS.md`      | —                        |

UI: `src/components/<mesmo nome do módulo>/`, com estas exceções sem módulo homônimo em `src/lib/`: `interactive/` (mensagem interativa, preview de template) → `whatsapp-cloud`; `pipelines/`, `presence/` → `inbox-atribuicao`; `dashboard/`, `tremor/` (gráficos) → `atividade-painel-retencao`; `auth/` → `auth-e-conta`; `layout/` (shell, sidebar) → transversal. Hooks (`src/hooks/use-*.ts`): pelo assunto do nome — ex.: `use-channel-templates`, `use-broadcast-sending` → `whatsapp-cloud`; `use-transfer-channels`, `use-fallback-channels` → `canais-e-qrcode`; `use-conversation-feed`, `use-inbox-tabs`, `use-presence`, `use-emoji-preferences` → `inbox-atribuicao`; `use-account-plan*` → `planos-quotas-admin`; `use-auth`, `use-can`, `use-account-members` → `auth-e-conta`; `use-spreadsheet-parser` → `contatos-audiencia`. `src/components/settings/` reúne abas de vários domínios — templates/WhatsApp/cobrança → `whatsapp-cloud`; QRCode → `canais-e-qrcode`; etiquetas, campos e respostas rápidas → `inbox-atribuicao`; IA → `ia-agentes`; membros, segurança, zona de risco → `auth-e-conta`; chaves de API e log de webhooks → `api-publica-webhooks`.

## Referências fora de `docs/context/`

- [`README.md`](../../README.md) (não editar por esta SPEC, D-12): seções **"Agendador cron"** (configurar as rotas de cron), **"Retenção de mensagens"** e **"Retenção do registro de atividade"** (variáveis e interruptores), **"Notificações do sistema (SMTP + webhook)"**, **"Internacionalização (i18n) — detalhes para desenvolvedores"** e **"⚠️ Validação local — obrigatória (sem CI no GitHub)"**.
- [`docs/comandos-desenvolvimento.md`](../comandos-desenvolvimento.md) — o que cada comando `npm run …` cobre e quando rodar.
- [`phone-number-format-standard.md`](./phone-number-format-standard.md) — padrão de telefone (domínio `contatos-audiencia`).
