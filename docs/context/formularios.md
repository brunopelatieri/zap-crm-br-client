# Formulários de captação (construtor, página pública, respostas e plano)

> Domínio do PRD 084 / SPEC 085 (núcleo). Rule: `.claude/rules/formularios.md`. Migrações escritas vs. aplicadas, rota de cron e nº de chaves i18n: [`status.md`](./status.md). Integrações (automação, disparo, flows, IA, webhook, API) são da [SPEC 086](../spec-086-formularios-integracoes.md); domínio próprio, da [SPEC 087](../spec-087-formularios-dominio-proprio.md). Mapa: [`INDEX.md`](./INDEX.md).

Formulário de uma pergunta por tela (modelo Yay! Forms), mobile first. O `admin` cria e publica em `/forms`; o visitante responde em `/f/<slug>`; a resposta **sempre** vira (ou atualiza) um contato; pontuação por faixas dispara etiqueta, negócio, atribuição e aviso. Liberado por plano: chave `forms_enabled` (fail-closed) + quotas `forms`, `form_responses_month`, `form_upload_mb`.

## Onde mexer

- **Regra de negócio (testada, co-locada):** `src/lib/forms/` — `validate`, `logic`, `scoring`, `snapshot`, `identity`, `apply-mapping`, `apply-band`, `link-token`, `uploads`, `quota`, `templates`, `project-public`, `availability`.
- **Rotas da conta (sessão, RLS):** `src/app/api/forms/**` (lista, CRUD, blocos, publicar/arquivar, `link`, `media`, `responses`, `responses/[rid]/files/[idx]`, `responses/delete`, `responses/export`, `config`) e `src/app/api/contacts/[id]/form-responses`. Cola comum: `src/lib/forms/account-api.ts` (`requireFormsRole`, códigos de erro).
- **Rotas públicas (sem sessão):** `src/app/api/forms/public/[slug]/{start,responses/[id],upload-url,submit}` → `src/lib/forms/public-service.ts` (**único** uso do `service_role` do lado do visitante).
- **Página pública:** `src/app/(public)/f/[slug]/`; componente em `src/components/forms/public/` (modo `live` e `preview`).
- **Construtor / lista:** `src/components/forms/form-builder/`, `form-list.tsx`; páginas `src/app/(dashboard)/forms/`.
- **Respostas:** `src/components/forms/responses/` (tabela, filtros, painel de detalhe, exportar, apagar); lógica pura em `src/lib/forms/{responses-query,response-display,response-export}.ts`. Reaproveitado na ficha do contato (`components/contacts/contact-forms-tab.tsx`) e no inbox (`components/inbox/contact-forms-card.tsx`).
- **Varredura (cron):** `src/lib/forms/sweep.ts`, chamada pela fase 7 de `src/app/api/automations/cron/route.ts`.
- **Configurações → Formulários:** `src/components/settings/forms-settings.tsx` (`admin`+, só leitura das variáveis).
- **Cabeçalhos de frame / embed:** `src/middleware.ts` + `src/lib/forms/frame-policy.ts`; `next.config.ts` (regra `/f/:path*`).

## Regras que não podem quebrar

1. **O servidor é o dono do que importa**: identidade, pontuação, faixa, quota e projeção pública. O navegador só devolve valores; o payload de envio não tem campo de pontos. A projeção `PublicFormPayload` é fechada (`project-public.ts`) e tem teste de contrato — nada de `account_id`, `points`, `band`, `tag_id`, `pipeline_id`, `assign`, `notify` no JSON do visitante.
2. **Toda rota da conta: `requireRole` e DEPOIS `requireFormsFeature`** (403 `FEATURE_NOT_IN_PLAN`). Exceções deliberadas: `GET /api/forms` e `GET /api/forms/config` respondem 200 com `featureInPlan: false`. Conta sem o item, formulário despublicado, arquivado, quota cheia: a página pública mostra **a mesma página neutra** (HTTP 200) para qualquer motivo.
3. **`service_role` só onde há autorização validada**: `public-service.ts` (escopado por `form_id`/`account_id` de `form_public_availability`), `plan-gate.ts`, a trilha de exportação e a remoção de objetos do bucket depois de `admin` confirmado. `src/components/forms/**` e `src/app/(public)/f/**` nunca importam `admin-client` (teste `admin-client.test.ts`).
4. **Resposta sempre ligada a um contato** (`contact_id NOT NULL`); nada é gravado antes da identidade (telefone válido ou token). Identidade fixada no `start` (token > telefone); o envio ignora `link_token`.
5. **Instantâneo imutável**: `form_responses.answers` guarda rótulo, tipo, valor e pontos de cada bloco no momento do envio. Editar o formulário depois não reescreve respostas. O JSONB **não preserva a ordem** das chaves: a ordem de exibição vem dos blocos (`field_order`/`fieldOrders`).
6. **Arquivos**: bucket privado `form-uploads`, caminho `account-<uuid>/<form_id>/<response_id>/<arquivo>`; leitura só por URL assinada de 10 min com `download` (nunca inline); o download confere que o caminho pertence à pasta **daquela** resposta. Apagar resposta remove os objetos (melhor esforço) e devolve os bytes a `form_upload_bytes`; o resto a varredura recolhe.
7. **Exportar é `admin`+ e auditado** em `contact_exports` (`source = 'form_responses'`, migração 098). Toda célula passa por `neutralizeFormula`: a resposta é de um visitante anônimo (injeção de fórmula no Excel/Sheets). **Apagar** exige o nome do formulário digitado (conferido de novo no servidor).
8. **Filtro "bloco X = valor"** usa `answers @> {key:{value:…}}` (GIN `jsonb_path_ops`); `multi_select` guarda array. Busca por contato usa `.or()` do PostgREST: o termo passa por `sanitizeSearchTerm`.
9. **Cron**: `partial` com `updated_at` > 24 h vira `abandoned`; objetos de `form-uploads` sem resposta (órfãos) ou de `abandoned` há > 7 dias são removidos; `completed` nunca perde arquivo. A varredura de Storage roda no máximo 1×/h por processo, 10 contas por vez (cursor em memória).
10. **Quota no banco, app explica**: `forms` e `form_responses_month` por trigger (098); `form_upload_bytes` na rota. Mês em `America/Sao_Paulo` no SQL **e** no TS (`monthMetricKey`).
11. **i18n**: `Forms` e `PublicForm` nos dois dicionários; textos da página pública seguem `forms.locale`, não o cookie do visitante. Mensagens de `/api/**` em inglês; a UI traduz o código (`Forms.errors.*`).
12. **Git/banco**: 097/098 são **escritas e não aplicadas** até a F5 (confirmar com o mantenedor). `supabase/` está no `.gitignore`: as migrações não aparecem em `git status`.

## Armadilhas

| Sintoma | Causa provável |
| --- | --- |
| Página pública "indisponível" com tudo ligado | `plan_feature_strict` falso (chave ausente no plano), `contacts` cheia, 098 não aplicada |
| Link com token sempre pede telefone | `FORM_LINK_SECRET` ausente, < 32 bytes ou trocado entre deploys; token de outro formulário |
| "Apagar" some a linha mas o arquivo continua | Falha no `remove` do bucket (melhor esforço): a varredura recolhe como órfão em até ~1 h |
| Coluna/ordem dos blocos embaralhada | Leu `Object.keys(answers)` em vez da ordem dos blocos |
| Planilha abre com `'=…` numa célula | É o `neutralizeFormula` funcionando; não remova |
| Notificação não abre a resposta | Aviso antigo sem `form_response_id` (cai na lista); coluna da 098 não aplicada |
| Varredura "não limpa" | Interruptor não existe: depende do cron de `/api/automations/cron` e de `AUTOMATION_CRON_SECRET` (503 sem ele) |
| Upload falha sem erro visível | MIME com parâmetro (`;codecs=`) não normalizado, ou extensão fora da allowlist |

## Mais

[`../prd-084-formularios-de-captacao.md`](../prd-084-formularios-de-captacao.md) · [`../spec-085-formularios-nucleo.md`](../spec-085-formularios-nucleo.md) (Status = estado por fase e desvios) · [`planos-quotas-admin.md`](./planos-quotas-admin.md) · [`atividade-painel-retencao.md`](./atividade-painel-retencao.md) · [`automacoes-cron.md`](./automacoes-cron.md) · [`catalogo-specs.md`](./catalogo-specs.md).
