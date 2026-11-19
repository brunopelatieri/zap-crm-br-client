# SPEC 085 — Formulários de captação: núcleo (modelo, construtor, página pública, respostas e plano)

**PRD:** [`docs/prd-084-formularios-de-captacao.md`](./prd-084-formularios-de-captacao.md)
**Irmãs:** [`SPEC 086`](./spec-086-formularios-integracoes.md) (integrações e IA) · [`SPEC 087`](./spec-087-formularios-dominio-proprio.md) (domínio próprio)
**Status:** **F2 feita no código em 2026-11-19** — equipe: lista `/forms` (cartões, medidor de quota, filtro por status, aviso de plano sem ação, modelos na criação), construtor `/forms/[id]` (`src/components/forms/form-builder/`: blocos ordenáveis com `@dnd-kit`, paleta dos 14 tipos, editor por tipo, abas Tema · Lógica · Classificação · Configurações, barra de publicar/despublicar/arquivar/duplicar/excluir, compartilhar com link + QR no cliente + embed, prévia em moldura 375×812 ou desktop), item "Formulários" na barra lateral (`ClipboardList`, depois de Disparos), `/forms` em `protectedPaths`, 14 rotas `/api/forms/**` da conta (testadas em `src/app/api/forms/routes.test.ts`, 49 casos; 4 modelos criam e publicam sem erro), módulos novos em `src/lib/forms/` (`account-input`, `account-api`, `builder`, `preview`, `contrast`, `mask`, `media-url`, `embed`, `block-defaults`, `error-codes`), namespace `Forms` (398 chaves) + `Sidebar.forms` nos dois dicionários (**4.134** cada), deep-link do feed de atividade para `form` → `/forms/<id>`. **Nada foi aplicado no `vn`** (097/098 seguem só no disco); a UI foi conferida no navegador com um harness descartável sobre dados de modelo (sem sessão não dá para abrir `/forms` real: o middleware redireciona ao login, como esperado) e a lista/o construtor contra o banco ficam para depois da F5. Gate local (2026-11-19): `typecheck` ✓ · `i18n:check` ✓ (4.134 chaves) · `lint` 0 erros / 7 avisos pré-existentes · `test` 325 arquivos / 4.651 testes ✓ · `format:check` só com o baseline (`docs/` + `docker/runtime-env.mjs`) · `build` ✓ (`/forms` e `/forms/[id]` na lista de rotas); revisão `/code-review high` com 7 achados, todos corrigidos.
**Desvios da SPEC decididos na F2** (atualizar o texto do §5/§7 na F5): (k) `form_fields_replace(form_id, fields JSONB)` e `forms_list_stats(account)` entraram na **097** (§9a/§9b), ambas `SECURITY INVOKER` — a RLS de admin/membro vale e a guarda no corpo só dá o erro (`42501`); `UNIQUE (form_id, key)` virou `form_fields_form_key_unique … DEFERRABLE INITIALLY IMMEDIATE` (trocar a ordem de dois blocos não colide) e `forms.version` sobe a cada substituição de blocos; (l) `GET …/link` **não** devolve QR (E-15: gerado no navegador) — devolve `url`, `tokenAvailable`, `embed {iframe, script, html}` e `embedOrigins`; (m) códigos novos além dos da §7.1: `SLUG_TAKEN` (409), `INVALID_STATE` (409) e `INVALID_FILE` (400, `reason`); `INVALID_FORM` é **422** com `issues[]` quando vem de `validateFormForPublish` e 400 quando é forma do corpo/CHECK; (n) `GET …/media?path=` (URL assinada de leitura, só caminho da conta e do formulário) foi acrescentada — sem ela a imagem recém-enviada só aparece recarregando; (o) `DELETE` exige formulário **fora do ar** (`INVALID_STATE`) além de sem respostas, porque `form_responses.form_id` é CASCADE e uma resposta chegando no meio seria apagada junto; `publish` só sai de rascunho; `PUT` do formulário e dos blocos num formulário **publicado** revalidam com `validateFormForPublish` (422), e o construtor tenta a ordem inversa uma vez quando a mudança só é válida com a outra metade gravada antes; formulário arquivado não edita; (p) o medidor de quota é o `PlanUsageBars` (o `quota-meter.tsx` de disparos mede o tier da Meta e não serve); (q) `qrcode` (+ `@types/qrcode`) entrou nas dependências; (r) `media` de vídeo só aceita embed de YouTube (`youtube-nocookie.com`) e Vimeo (`normalizeVideoEmbedUrl`) e todo caminho de imagem precisa estar em `account-<conta>/` (a página pública assina esse caminho com `service_role`).
**O que a F3 ainda precisa acrescentar ao componente público** (`src/components/forms/public/public-form.tsx`, hoje com `mode="preview"`; a lista também está no cabeçalho do arquivo): (1) `POST …/start` ao responder o bloco de identidade e autosave por bloco (`PATCH …/responses/[id]`), `identity.mode = 'token'` pulando o telefone (salvo `confirm_phone_with_token`); (2) upload de arquivo (`…/upload-url` + `PUT`) no lugar do bloco desligado de `file_upload`; (3) rascunho local (`localStorage`, em `try/catch`) e fila de reenvio; (4) Turnstile quando `settings.turnstile_site_key` vier no payload; (5) "Falar no WhatsApp" com o `wa.me` do canal e o redirecionamento de `redirect_url` após 3 s; (6) `postMessage({ type: 'zapcrm-form-resize', height })` para o embed (`src/lib/forms/embed.ts` já gera o `<script>` que escuta); (7) `onSubmit` real no modo `live`. Textos de sistema vêm do mapa plano de `loadPublicFormMessages` pelo `usePublicTranslator` (sem `NextIntlClientProvider` aninhado).
**F1 feita no código em 2026-11-06** — `097_forms_core.sql` e `098_forms_plan_quotas.sql` escritas localmente (**não aplicadas no `vn`**; buckets `form-uploads`/`form-media` só existem na migração), `src/lib/forms/` (19 módulos da tabela do §6, cada um com `*.test.ts` co-locado + `test-fixtures.ts`; 149 casos novos no módulo, 156 contando `account-plan`, `catalog` e `messages-icu`; revisão `/code-review high` com 8 achados, todos corrigidos), `src/types` (`Form`, `FormField`, `FormResponse`, `FieldType`; `NotificationType` += `form_response_received`), `plans/types.ts` + `account-plan.ts` (5ª consulta em `account_usage_counters`) + seeds + `catalog.test.ts`, `ACTIVITY_CATALOG` (`form.*` e `contact.form_submitted`) com frases ICU, namespace `PublicForm` (39 chaves) e rótulos de plano nos dois dicionários (3.735 chaves cada). Sem UI nem rotas (F2/F3); `admin-client.test.ts` já varre `components/forms/**` e `app/(public)/f/**`. Gate local da F1 (2026-11-06): `typecheck` ✓ · `i18n:check` ✓ (3.735 chaves) · `lint` 0 erros / 7 avisos pré-existentes (nenhum em `src/lib/forms`) · `test` 318 arquivos / 4.513 testes ✓ · `format:check` limpo em `src/` e `messages/` (só o baseline de `docs/`) · `build` não exigido na F1.
**Desvios da SPEC decididos na F1** (atualizar o texto do §5 na F5, antes de aplicar): (a) `forms.user_id` **nullable** — `ON DELETE SET NULL` é incompatível com `NOT NULL`; `forms` entrou na lista de `reassign_user_rows_to_owner()` (088); (b) slug **3–60** (`^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`) — a regex do §5 aceitava 1 caractere; (c) `account_usage_counters.value` vira **BIGINT** (098) — o contador de bytes de upload estoura INTEGER com 5.120 MB; (d) `form_public_availability(p_slug, p_generic_link BOOLEAN DEFAULT TRUE)` — o segundo parâmetro liga a checagem da quota de contatos só ao link genérico; (e) `set_contact_opt_in()` e o CHECK de `contact_consent_events.source` aceitam `'form'` (mapeamento `contact.opt_in`); (f) CHECK de `account_activity_log.resource_type` (084) recriado com `'form'`; (g) helpers novos `form_month_metric(timestamptz)` (IMMUTABLE, chave `form_responses:YYYY-MM` em `America/Sao_Paulo`) e `form_upload_bytes_add(uuid, bigint)`; (h) `contacts.created_via` CHECK recriado com `'form'`; (i) `yes_no` carrega `options` fixas `yes`/`no` (pontos e `jump_to`); (j) o deep-link do feed para `form` ficava `null` até a F2 criar `/forms` — **resolvido na F2** (`/forms/<id>`).
**Números provisórios:** migrações **097** e **098**, próximo livre em [`status.md`](./context/status.md) no momento da escrita — **conferir com `ls supabase/migrations/` antes de criar**; outra sessão pode ter pego o número.
**Modelo de trabalho por fase:** PRD 084 §10.

---

## 1. Resumo

Esta SPEC entrega o que funciona **sozinho**: o `admin` cria e publica um formulário de uma pergunta por tela, o visitante responde em `/f/<slug>`, a resposta vira contato e fica consultável, e o proprietário controla por plano. Nada aqui depende da SPEC 086 (integrações) nem da 087 (domínio). As três compartilham o módulo `src/lib/forms/` definido no §6.

Em uma frase para quem vai implementar: **o servidor é o dono de tudo que importa** (identidade, pontuação, quota, projeção pública); o navegador do visitante só recebe blocos e tema e só devolve valores.

## 2. Estado de partida (medido em 2026-11-06)

### 2.1. Fatos

| Fato                                                                                           | Onde conferir                                                                    |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Última migração `096`; próximo livre `097`                                                     | `ls supabase/migrations/ \| tail -2`                                             |
| `contacts.created_via` tem `CHECK` (`contacts_created_via_check`, migração 067 §7)             | `grep -n created_via_check supabase/migrations/067_plans_and_quotas.sql`         |
| `account_usage_counters (account_id, metric TEXT, value INTEGER)`, escrita só por trigger      | migração 067 §6                                                                  |
| `plan_feature_strict(account, key)` só `service_role`, fail-closed                             | migração 096                                                                     |
| `custom_fields` sem índice único `(account_id, field_name)`                                    | SPEC 055 §2.2                                                                    |
| `applyCustomValues` faz `upsert` por `(contact_id, custom_field_id)`                           | `src/lib/ingest/custom-values.ts`                                                |
| Bucket privado por conta com policy `account-<uuid>` no primeiro segmento                      | migrações 040 (`chat-media`, `flow-media`) e 078 (`contact-avatars`)             |
| `MEDIA_MAX_BYTES = 16 MB`, `baseMimeType`, tabela de extensões                                 | `src/lib/storage/upload-media.ts`                                                |
| `RATE_LIMITS` em memória por processo, `checkRateLimit(key, opts)`                             | `src/lib/rate-limit.ts`                                                          |
| Middleware sai cedo em `/area`; `protectedPaths` só cobre páginas da CRM                       | `src/middleware.ts`                                                              |
| `X-Frame-Options: DENY` e CSP `frame-ancestors 'none'` (report-only) em toda resposta          | `next.config.ts` `SECURITY_HEADERS`                                              |
| `SUPPORTED_LOCALES = ['pt-BR','en']`, `DEFAULT_LOCALE = 'pt-BR'`                               | `src/lib/i18n/locales.ts`                                                        |
| Ficha do contato tem abas `details`, `tags`, `notes`, `custom`, `deals`                        | `src/components/contacts/contact-detail-view.tsx`                                |
| Barra lateral declara itens em `src/components/layout/sidebar.tsx` (`href`, `labelKey`, `icon`) | idem                                                                             |
| Exportação de contatos: `requireRole('admin')`, auditada em `contact_exports`                  | `src/app/api/contacts/export/route.ts`                                           |
| Registro de atividade: catálogo fechado `ACTIVITY_CATALOG`, `recordActivity` nunca lança        | `src/lib/activity/types.ts`, `record.ts`                                         |
| i18n: 3.682 chaves nos dois dicionários                                                        | `status.md`                                                                      |

### 2.2. O que **não** existe e esta SPEC cria

Tabelas de formulário, bucket `form-uploads`, módulo `src/lib/forms/`, rotas `/api/forms/**`, página `/f/[slug]`, páginas `/forms/**`, chave `forms_enabled`, quotas `forms`, `form_responses_month`, `form_upload_mb`, namespaces i18n `Forms` e `PublicForm`, domínio de contexto `docs/context/formularios.md` e rule `.claude/rules/formularios.md`.

## 3. Decisões de execução

| #    | Decisão                                                                                                                                                                                                                                                                                                                                                | Motivo                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-1  | Tabelas no schema `public`, com RLS por `is_account_member` para a equipe e **nenhuma** policy para `anon`. A página pública usa `supabaseAdmin()` escopado por `slug`.                                                                                                                                                                                | Equipe lê e escreve pelo client de sessão (padrão do repo, PRD 084 D-9). Visitante nunca toca o banco; um schema à parte (como `contact_portal`) só faria sentido se o visitante tivesse identidade própria, e ele não tem.          |
| E-2  | Blocos em **tabela própria** `form_fields` (não JSONB dentro de `forms`); respostas em `form_responses.answers` **JSONB** com instantâneo (PRD D-4).                                                                                                                                                                                                    | Blocos são editados um a um e precisam de FK para o mapeamento; respostas são imutáveis e consultadas inteiras. GIN em `answers` cobre o filtro por resposta de bloco.                                                             |
| E-3  | `slug` **único no deployment**, minúsculo, `[a-z0-9-]{3,60}`, com lista de reservados (`api`, `_next`, `area`, `admin`, `f`, `static`, `assets`, `favicon.ico`, `robots.txt`).                                                                                                                                                                      | A URL é `/f/<slug>` sem id de conta; na SPEC 087 vira `/<slug>` no domínio do owner.                                                                                                                                              |
| E-4  | Token do link: HMAC-SHA256 sem estado (PRD D-3), módulo puro `link-token.ts`, chave `FORM_LINK_SECRET` (≥ 32 bytes). Sem a variável, `signFormLink` devolve `null` e os chamadores mostram "não configurado".                                                                                                                                         | Sem tabela de links; comparação em tempo constante com `timingSafeEqual`.                                                                                                                                                         |
| E-5  | Pontuação e faixa calculadas **só** em `scoring.ts` no servidor, a partir do `answers` validado e da definição atual dos blocos; o payload de envio não tem campo de pontos.                                                                                                                                                                         | PRD D-5, R-6.                                                                                                                                                                                                                     |
| E-6  | Upload por **URL assinada de upload** (`createSignedUploadUrl`) emitida por rota do servidor após validar MIME, extensão, tamanho declarado e quota; no envio, o servidor confere o objeto (`storage.from().info()` ou `list` no prefixo) e o tamanho; objeto não referenciado por resposta concluída em 24 h é apagado pela varredura.                | PRD D-9; o arquivo não passa pelo Node; a quota em bytes é somada **no envio concluído**, pelo tamanho real do objeto.                                                                                                             |
| E-7  | Quota `forms` por trigger `AFTER INSERT` e `AFTER UPDATE OF status` em `forms` (arquivar decrementa, desarquivar incrementa e checa), no padrão de `enforce_contact_quota`. Quota `form_responses_month` por trigger `AFTER UPDATE OF status` quando vira `completed`, com métrica `form_responses:YYYY-MM` em `America/Sao_Paulo`. Quota de bytes por `UPDATE` no contador feito pela rota de envio (service_role), não por trigger. | Quota decide no banco (SPEC 059 §1); respostas são escritas só pela rota com `service_role`, então o contador de bytes pode ficar na rota, mas a decisão de "mês cheio" precisa ser O(1) e consistente: fica na função `form_month_quota_state(account)`. |
| E-8  | A página pública **pré-checa** disponibilidade em uma RPC só, `form_public_availability(slug) → (status, reason)`, `SECURITY DEFINER`, só `service_role`: publicado, conta não bloqueada, `plan_feature_strict(…, 'forms_enabled')`, `form_responses_month` com vaga, `contacts` com vaga (só quando o link é genérico).                                 | Um motivo só de "indisponível" (PRD D-11, L5); a rota de envio reconfere.                                                                                                                                                         |
| E-9  | Projeção pública é um tipo fechado `PublicFormPayload` montado por `project-public.ts`; teste de contrato serializa um formulário cheio e falha se o JSON contiver `account_id`, `points`, `band`, `tag_id`, `pipeline_id`, `stage_id`, `assign`, `user_id`, `notify`.                                                                                  | PRD R-5.                                                                                                                                                                                                                          |
| E-10 | Idioma da página pública vem de `forms.locale` (PRD D-8), carregado com `getMessages`/`createTranslator` do `next-intl` para aquele locale, namespace `PublicForm`. Não lê cookie.                                                                                                                                                                    | Mesmo mecanismo da área do contato para textos fora do shell.                                                                                                                                                                     |
| E-11 | `/f/**` e `/api/forms/public/**` saem cedo do middleware (sem `getUser()`); `/forms` entra em `protectedPaths`.                                                                                                                                                                                                                                       | Visitante não tem sessão; evitar refresh de cookie de um usuário logado no mesmo navegador (mesma razão do `/area`).                                                                                                              |
| E-12 | `X-Frame-Options`/`frame-ancestors` para `/f/**`: `/f/[slug]` continua `page.tsx`; o `next.config.ts` ganha uma regra `source: '/f/:path*'` que **não** envia `X-Frame-Options`, e o `middleware` injeta por formulário `Content-Security-Policy: frame-ancestors <origens>` quando há origens de embed cadastradas e `X-Frame-Options: DENY` quando não há. (Route segment config e `generateMetadata` não definem cabeçalhos de resposta; por isso a decisão fica no middleware.) | O catch-all de `next.config.ts` aplica `DENY` a tudo; a exceção precisa ser por rota (config) **e** por formulário (middleware, que é quem conhece o slug). PRD D-13.                                                             |
| E-13 | Formulário **não** cria `conversations` nem `messages`. A conversa nasce quando o contato escreve (mesma regra do disparo, SPEC 057 §0).                                                                                                                                                                                                              | Evita conversa vazia no inbox para cada lead; a SPEC 086 trata o envio de link, que aí sim precisa de conversa.                                                                                                                    |
| E-14 | Modelos iniciais (`templates.ts`): "Em branco", "Captação de lead" (nome, telefone, interesse, orçamento, prazo, consentimento), "Pesquisa de satisfação" (nota, o que melhorar), "Inscrição em evento" (nome, telefone, e-mail, acompanhantes, restrições). Texto dos modelos em pt-BR e en pelo `locale` escolhido na criação.                   | Mesmo padrão da galeria de automações; evita formulário em branco no primeiro uso.                                                                                                                                                |
| E-15 | QR code do link gerado **no cliente** com `qrcode` (dependência nova, MIT, sem rede). Nenhum serviço externo recebe a URL.                                                                                                                                                                                                                              | Pendência herdada da área do contato (PRD 082 §3.1) resolvida de passagem para os dois recursos; a SPEC 083 pode reutilizar o componente.                                                                                          |
| E-16 | Vídeo por etapa só por **URL de embed** (YouTube `youtube-nocookie.com`, Vimeo) e imagem por upload no bucket `form-media` (público? **não**: privado, servido por URL assinada de 7 dias gerada no servidor ao renderizar a página).                                                                                                                 | Hospedar vídeo no Storage custaria quota e banda; imagem precisa ser do owner. URL assinada curta evita bucket público (lição da SPEC 040).                                                                                       |

## 4. Comportamento

### 4.1. Tipos de bloco

| `type`          | Entrada do visitante                                           | Valor em `answers`           | Pontua? | Mapeável para                                    |
| --------------- | -------------------------------------------------------------- | ---------------------------- | ------- | ------------------------------------------------ |
| `short_text`    | uma linha, máscara opcional (`cpf`, `cep`, `none`)              | `string`                     | não     | `contact.name`, `contact.company`, `custom:<id>` |
| `long_text`     | várias linhas, `max_length`                                    | `string`                     | não     | `custom:<id>`                                    |
| `email`         | e-mail validado (RFC simples)                                  | `string`                     | não     | `contact.email`, `custom:<id>`                   |
| `phone`         | telefone BR com DDI, validação SPEC 050 (manual)               | `string` (só dígitos)        | não     | **identidade** (PRD D-2); 2º bloco: `custom:<id>` |
| `number`        | numérico, `min`/`max`, `step`                                  | `number`                     | por faixa | `custom:<id>`                                   |
| `date`          | data (input nativo)                                            | `YYYY-MM-DD`                 | não     | `custom:<id>`                                    |
| `single_select` | uma opção (rádio), atalhos A/B/C, avança sozinho              | `option_id`                  | por opção | `custom:<id>`, `tag` (opção → etiqueta)         |
| `multi_select`  | várias opções (checkbox), `min`/`max` escolhas                  | `option_id[]`                | soma    | `tag` (cada opção → etiqueta)                    |
| `dropdown`      | lista suspensa (muitas opções)                                 | `option_id`                  | por opção | `custom:<id>`, `tag`                            |
| `yes_no`        | dois botões                                                    | `boolean`                    | por opção | `custom:<id>`, `tag`                            |
| `rating`        | 1..N (N ∈ 3..10), estrelas ou números                          | `number`                     | por valor | `custom:<id>`                                   |
| `file_upload`   | 1..`max_files` arquivos, allowlist                             | `file_ref[]`                 | não     | —                                                |
| `statement`     | só texto + mídia, botão "Continuar"                            | ausente                      | não     | —                                                |
| `consent`       | checkbox com texto rico + link de política                     | `boolean` (precisa `true`)   | não     | `contact.opt_in` (via `set_contact_opt_in`, só quando o owner marcar) |

Todo bloco tem: `key` (estável, `[a-z0-9_]{1,40}`, única no formulário, gerada do rótulo e editável), `label`, `description`, `required`, `media` (`{kind:'image', path}` ou `{kind:'video', url}`), `show_if` (uma condição: `{field_key, op: 'eq'|'neq'|'contains'|'answered', value}`), e, em escolhas, `options[]` com `{id, label, points, jump_to?}`.

### 4.2. Página pública (`/f/[slug]`)

1. **Carregamento (servidor):** `form_public_availability(slug)`; se indisponível → página neutra (`PublicForm.unavailable`), HTTP 200, mesmo HTML para qualquer motivo, sem revelar se o slug existe. Disponível → carrega formulário + blocos com `supabaseAdmin()`, projeta `PublicFormPayload` (E-9), assina URLs de imagem (E-16), lê `?t=` e valida o token (E-4): válido → `identity = {mode:'token'}` (sem `contact_id` no payload; o token volta no envio); inválido/ausente → `identity = {mode:'phone'}`.
2. **Boas-vindas:** logo, título, descrição, mídia, botão "Começar" (texto editável), tempo estimado (calculado: blocos × 10 s).
3. **Blocos:** um por tela. Barra de progresso no topo; botão "OK"/"Continuar" e seta "voltar"; Enter avança (Shift+Enter quebra linha em `long_text`); atalhos de letra em escolhas; `single_select` e `yes_no` avançam sozinhos após 300 ms. Validação inline no idioma do formulário. `show_if` e `jump_to` resolvidos no cliente **e** reconferidos no servidor (um bloco escondido com valor é descartado).
4. **Identidade:** em `mode:'phone'`, o bloco `phone` marcado `is_identity` é o primeiro bloco **com entrada** (o construtor fixa isso); respondido e válido, o cliente chama `POST /api/forms/public/[slug]/start` com `{phone, utm, honeypot, started_at}` → cria `form_responses` `partial` e devolve `response_id` + `resume_token` (opaco, 32 bytes, `sha256` guardado). Em `mode:'token'`, o `start` acontece no primeiro bloco com o token do link.
5. **Autosave:** a cada bloco respondido depois do `start`, `PATCH .../responses/[id]` com `{resume_token, answers_delta}`; falha de rede não trava (fila local, reenvio).
6. **Arquivo:** `POST .../upload-url` com `{response_id, resume_token, field_key, name, mime, size}` → `{path, signed_url, token}`; o cliente faz `PUT`; o valor do bloco é `[{path, name, mime, size}]`.
7. **Envio:** `POST .../submit` com `{response_id, resume_token, answers, link_token?, turnstile?}`. O servidor: valida tudo de novo (tipos, obrigatórios, `show_if`), resolve identidade (token > telefone), encontra/cria o contato, aplica mapeamentos, calcula pontuação/faixa, marca `completed`, soma bytes, executa ações da faixa (etiqueta, negócio, atribuição, notificação), grava atividade, e devolve `{thank_you}`; a SPEC 086 acrescenta aqui os despachos (automação, webhook).
8. **Agradecimento:** título, texto, botão opcional "Falar no WhatsApp" (`wa.me/<número do canal padrão da conta>` com texto pré-definido) ou redirecionamento (`redirect_url`, só `https://`, após 3 s).
9. **Rascunho local:** `localStorage` por slug com as respostas antes do `start`; apagado no envio. Em `try/catch`, nunca obrigatório.
10. **Rodapé:** "Feito com ZAP CRM BR" (link para o site do deployment, `NEXT_PUBLIC_SITE_URL`), fora de escopo removê-lo (PRD §3.1).

Acessibilidade mínima: foco visível, `aria-live` na validação, contraste checado no construtor (aviso quando a cor do texto sobre o fundo < 4.5:1).

### 4.3. Construtor (`/forms/[id]`)

Três colunas (no celular, abas):

- **Blocos:** lista ordenável (`@dnd-kit`), "+ bloco" com galeria por tipo, duplicar, apagar (com confirmação quando há respostas: "respostas antigas mantêm o valor").
- **Prévia:** moldura de celular (375×812) renderizando o **mesmo** componente da página pública com `identity = {mode:'preview'}` (nada grava); alterna para desktop.
- **Painel** com abas: Bloco (campos do §4.1) · Tema (logo, 4 cores, fonte entre 4 opções do sistema, botão arredondado/quadrado, boas-vindas, agradecimento, idioma) · Lógica (`show_if`, `jump_to`) · Classificação (pontos por opção/faixa, faixas e ações) · Configurações (slug, `accept_generic_link`, `confirm_phone_with_token`, `allow_multiple_responses`, `token_ttl_days`, Turnstile, honeypot sempre ligado, origens de embed, `portal_visibility` e `ai_offerable` (campos criados aqui, **usados** na SPEC 086)).

Barra superior: nome, status (`draft` / `published` / `archived`), "Salvar" (rascunho pode ser inválido), "Publicar" (roda `validate.ts` no cliente **e** no servidor; lista os erros), link + QR + embed quando publicado, "Despublicar", menu "Arquivar / Excluir (só sem respostas) / Duplicar".

### 4.4. Lista (`/forms`) e respostas (`/forms/[id]/respostas`)

- Lista: cartões ou tabela com nome, status, respostas concluídas no mês, taxa de conclusão (concluídas ÷ iniciadas), última resposta, medidor de quota `forms` (`quota-meter.tsx` reaproveitado), filtro por status. Conta sem o item: aviso e nada clicável (PRD D-11).
- Respostas: tabela paginada (servidor) com colunas fixas (contato, data, status, pontuação, faixa, origem) + colunas escolhidas entre os blocos; filtros por status, faixa, período, origem e "bloco X = valor"; busca por nome/telefone. Detalhe em painel lateral: todas as respostas com rótulo do instantâneo, arquivos (URL assinada de 10 min, `Content-Disposition: attachment`), contato (link para a ficha), negócio criado. Ações `admin+`: exportar (CSV/XLSX, `requireRole('admin')`, linha em `contact_exports` com `source = 'form_responses'`, mesma rota-padrão da SPEC 051), apagar selecionadas / todas (confirmação com nome do formulário).
- Ficha do contato: aba `forms` com as respostas do contato (todas as de todos os formulários), mesmo painel de detalhe. Painel lateral do inbox: cartão compacto "Formulários" com a última resposta concluída (3 primeiros blocos) e botão "Enviar formulário" (SPEC 086).

### 4.5. Ciclo de vida do formulário

```text
draft ──publish──▶ published ──unpublish──▶ draft
  │                    │
  └──archive──▶ archived ◀──archive──┘        (archived ──restore──▶ draft, checa quota)
  └──delete (só sem respostas)──▶ ∅
```

`archived` despublica e sai da quota. Excluir o **contato** cascateia `form_responses` (FK `ON DELETE CASCADE`) e a varredura apaga os objetos do bucket cujo `response_id` não existe mais.

### 4.6. Ciclo de vida da resposta

`partial` (criada no `start`) → `completed` (no `submit`) · `partial` com `updated_at` > 24 h → `abandoned` (varredura). Só `completed` conta na quota, dispara faixa e integrações. `allow_multiple_responses = false`: um contato com `completed` para o formulário vê, no `start`, a tela "você já respondeu" (com a data), e o `submit` recusa `409`.

## 5. Banco

### 5.1. Migração 097 — `097_forms_core.sql`

```sql
CREATE TABLE forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,  -- criador; ver 088 (reatribuir ao dono antes do delete)
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  locale TEXT NOT NULL DEFAULT 'pt-BR' CHECK (locale IN ('pt-BR','en')),
  description TEXT,
  theme JSONB NOT NULL DEFAULT '{}'::jsonb,       -- logo_path, colors{primary,background,text,button}, font, radius, welcome{…}, thank_you{…}
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,    -- accept_generic_link, confirm_phone_with_token, allow_multiple_responses, token_ttl_days, turnstile, embed_origins[], redirect_url, whatsapp_cta
  scoring JSONB NOT NULL DEFAULT '{}'::jsonb,     -- bands[]: {key,label,min,max,actions{tag_ids[],deal{pipeline_id,stage_id,title_template,assign:{mode,user_id}},notify_user_ids[]}}
  portal_visibility TEXT NOT NULL DEFAULT 'none' CHECK (portal_visibility IN ('none','fill','responses','both')),
  ai_offerable BOOLEAN NOT NULL DEFAULT FALSE,
  ai_offer_hint TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  published_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_forms_account ON forms(account_id);
CREATE INDEX idx_forms_published_slug ON forms(slug) WHERE status = 'published';

CREATE TABLE form_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,  -- redundante de propósito: RLS sem join
  key TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,40}$'),
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('short_text','long_text','email','phone','number','date','single_select','multi_select','dropdown','yes_no','rating','file_upload','statement','consent')),
  label TEXT NOT NULL,
  description TEXT,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  is_identity BOOLEAN NOT NULL DEFAULT FALSE,   -- só em type='phone'; no máximo um por formulário (índice único parcial)
  options JSONB,                                 -- [{id,label,points,jump_to}]
  validation JSONB NOT NULL DEFAULT '{}'::jsonb, -- min,max,step,max_length,mask,min_choices,max_choices,max_files,accept[],scale,points_ranges[]
  media JSONB,                                   -- {kind:'image',path} | {kind:'video',url}
  mapping JSONB,                                 -- {target:'contact.name'|'contact.email'|'contact.company'|'contact.opt_in'|'custom:<uuid>'|'tag', overwrite:boolean, tag_by_option:{option_id:tag_id}}
  show_if JSONB,                                 -- {field_key,op,value}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (form_id, key)
);
CREATE UNIQUE INDEX idx_form_fields_one_identity ON form_fields(form_id) WHERE is_identity;
CREATE INDEX idx_form_fields_form_position ON form_fields(form_id, position);

CREATE TABLE form_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,   -- PRD D-2: nunca nulo
  status TEXT NOT NULL DEFAULT 'partial' CHECK (status IN ('partial','completed','abandoned')),
  identity_mode TEXT NOT NULL CHECK (identity_mode IN ('phone','token')),
  source TEXT NOT NULL DEFAULT 'link' CHECK (source IN ('link','inbox','broadcast','automation','flow','portal','ai','api','embed')),
  form_version INTEGER NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {key:{label,type,value,points,option_labels?}}
  score INTEGER,
  band_key TEXT,
  resume_token_hash BYTEA,                      -- sha256; NULL depois de completed
  upload_bytes BIGINT NOT NULL DEFAULT 0,
  utm JSONB,
  locale TEXT,
  ip_hash TEXT,                                 -- sha256(ip + FORM_LINK_SECRET-derivado); nunca o IP
  user_agent TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_form_responses_form_status ON form_responses(form_id, status, completed_at DESC);
CREATE INDEX idx_form_responses_contact ON form_responses(contact_id);
CREATE INDEX idx_form_responses_account_month ON form_responses(account_id, completed_at) WHERE status = 'completed';
CREATE INDEX idx_form_responses_answers ON form_responses USING GIN (answers jsonb_path_ops);
CREATE INDEX idx_form_responses_partial_stale ON form_responses(updated_at) WHERE status = 'partial';
```

RLS (todas com `ENABLE ROW LEVEL SECURITY`, policies `TO authenticated`, D-20):

| Tabela           | SELECT                       | INSERT / UPDATE / DELETE                                                                                   |
| ---------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `forms`          | `is_account_member(account_id)` | `is_account_member(account_id, 'admin')`                                                                 |
| `form_fields`    | idem                         | idem                                                                                                       |
| `form_responses` | `is_account_member(account_id)` | **nenhuma** para `authenticated` (escrita só por `service_role` nas rotas públicas); DELETE `admin` via RPC `form_responses_delete(form_id, ids[])` |

`anon`: nada (nem `GRANT SELECT`). Depois da 091 isso já é o padrão; a migração **não** concede nada a `anon` de propósito.

Mais na 097:

- `ALTER TABLE contacts DROP CONSTRAINT contacts_created_via_check; ADD CONSTRAINT … CHECK (created_via IN (<lista atual>, 'form'))` — **copiar a lista atual da 067 §7 no momento de escrever**, nunca de memória.
- Bucket `form-uploads` (privado, `file_size_limit` 16 MB, `allowed_mime_types`: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `text/plain`, `text/csv`, `audio/mpeg`, `audio/ogg`, `video/mp4`), caminho `account-<uuid>/<form_id>/<response_id>/<uuid>.<ext>`. Policy de leitura para membros no padrão da 040 (primeiro segmento `account-<uuid>`); **sem** policy de escrita para `authenticated` (só `service_role` assina upload).
- Bucket `form-media` (privado, 5 MB, só imagens), caminho `account-<uuid>/<form_id>/<uuid>.<ext>`; escrita para `admin` da conta pelo mesmo padrão de `flow-media` (020), leitura por URL assinada no servidor (E-16).
- Trigger `set_updated_at` nas três tabelas (função já existe).
- Função `form_responses_delete(p_form_id, p_ids UUID[])` `SECURITY DEFINER`: confere `is_account_member(account_id,'admin')` no corpo, apaga, devolve os `storage paths` para a rota remover os objetos. `REVOKE … FROM PUBLIC, anon`; `GRANT … TO authenticated, service_role`.
- Função `form_public_availability(p_slug TEXT) RETURNS TABLE(status TEXT, reason TEXT, form_id UUID, account_id UUID)` (E-8): só `service_role`.
- `REVOKE ALL … FROM PUBLIC` e `FROM anon` em toda função; internas também `FROM authenticated`; `SECURITY DEFINER` com `SET search_path = public`; `OWNER TO postgres`.

### 5.2. Migração 098 — `098_forms_plan_quotas.sql`

- `enforce_form_quota()` (`AFTER INSERT OR UPDATE OF status ON forms`): incrementa `account_usage_counters('forms')` ao inserir não-arquivado ou ao sair de `archived`; decrementa ao entrar em `archived` ou ao apagar (`AFTER DELETE`); se `plan_limit(account,'forms')` não nulo e `value > limit` → `RAISE EXCEPTION 'QUOTA_EXCEEDED:forms:%:%'` (`P0001`, contrato de `errors.ts`).
- `count_form_responses_month()` (`AFTER UPDATE OF status ON form_responses WHEN NEW.status = 'completed'`): incrementa `account_usage_counters('form_responses:' || to_char(NOW() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM'))`. **Não** levanta exceção: a recusa é na pré-checagem (E-8) e na rota, porque a resposta já está meio gravada; um estouro por corrida fica como `completed` acima do teto, aceito.
- `form_month_quota_state(p_account UUID) RETURNS TABLE(used INTEGER, "limit" INTEGER)`: lê o contador do mês e `plan_limit(…, 'form_responses_month')`. Só `service_role`.
- `form_upload_quota_state(p_account UUID)`: idem para `form_upload_bytes` (contador em bytes; `plan_limit` em MB × 1.048.576).
- `recount_account_usage` **estendida** para recalcular `forms`, `form_responses:<mês corrente>` e `form_upload_bytes` (soma de `upload_bytes` das `completed`).
- `form_public_availability` **reescrita** aqui para incluir as duas quotas e `plan_feature_strict(account,'forms_enabled')` (a 097 cria a versão que só checa status e bloqueio; a 098 completa, para a 097 não depender de função de plano).
- Asserções finais: `has_function_privilege('anon', …)` falso para todas; `anon` sem `SELECT` nas três tabelas; `plan_feature_strict(<conta de teste>, 'forms_enabled') = false`.

### 5.3. Plano (TypeScript e seed)

- `src/lib/plans/types.ts`: `USAGE_QUOTA_KEYS` += `'forms'`, `'form_responses_month'`, `'form_upload_mb'`; `FEATURE_KEYS` += `'forms_enabled'`. `catalog.test.ts` passa a exigir as chaves nos dois seeds.
- `src/lib/plans/account-plan.ts`: os buckets de uso leem `forms` direto, `form_responses_month` pelo contador do mês corrente e `form_upload_mb` convertendo bytes → MB (arredondar para cima).
- Seeds `plans-seed.sql` e `plans-seed-vn.sql`: valores do PRD §7 (ou `forms_enabled: false` em todos, se o mantenedor preferir ligar por conta primeiro). **Reconciliar `plans-seed-vn.sql` com o `vn` antes** (status.md).
- Rótulos: `Plan.featureLabel.forms_enabled`, `Plan.quotaLabel.forms` etc. nos dois dicionários (conferir o nome real da chave de rótulo de quota em `messages/en.json` → `Plan`).
- Guarda no app: `src/lib/forms/plan-gate.ts` copiando `contact-portal/plan-gate.ts` (`hasFormsFeature`, `requireFormsFeature` → `403 FEATURE_NOT_IN_PLAN`). Toda rota `/api/forms/*` (lado da conta) chama `requireRole` **e depois** `requireFormsFeature`. Exceção: `GET /api/forms` responde `200 { featureInPlan: false, forms: [] }` para a lista mostrar o aviso.

### 5.4. Depois de aplicar

1. `get_advisors` (security) no `vn`: esperado nenhum WARN novo; INFO de RLS sem policy não deve aparecer (as tabelas têm policy para `authenticated`).
2. `SELECT has_table_privilege('anon','public.forms','SELECT')` → `false` (idem as outras duas).
3. Rodar os seeds (os dois) **ou** `UPDATE plans SET features = features || '{"forms_enabled":false}'` como feito para a área.
4. `status.md`: última migração, próximo número, chaves i18n, buckets.

## 6. Módulo `src/lib/forms/` (regra de negócio, testado)

| Arquivo               | Responsabilidade                                                                                                                                                                                   | Teste co-locado                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `types.ts`            | Tipos de `Form`, `FormField`, `FormResponse`, `PublicFormPayload`, `Band`, `Mapping`, `ShowIf`, união fechada de `FieldType`                                                                       | —                                                                                                   |
| `slug.ts`             | `slugify`, `isReservedSlug`, `suggestSlug(name, taken)`                                                                                                                                            | reservados, acentos, colisão                                                                        |
| `validate.ts`         | `validateFormForPublish(form, fields)` (identidade obrigatória se `accept_generic_link`, `show_if`/`jump_to` só para blocos anteriores/posteriores válidos, sem ciclo, opções únicas, faixas sem sobreposição e cobrindo o domínio) e `validateAnswers(fields, answers, identityMode)` | cada regra com caso positivo e negativo                                                             |
| `logic.ts`            | `resolveVisibleFields(fields, answers)` e `nextFieldKey(fields, answers, currentKey)`; usado no cliente e no servidor                                                                                | `show_if` por operador, `jump_to`, bloco escondido descartado                                       |
| `scoring.ts`          | `computeScore(fields, answers) → {score, breakdown}` e `resolveBand(bands, score)`                                                                                                                  | pontos por opção, soma em `multi_select`, faixas por `number`/`rating`, sem faixa → `null`           |
| `snapshot.ts`         | `snapshotAnswers(fields, answers, points)` → o JSONB de `answers` (PRD D-4)                                                                                                                         | rótulo preservado, opção removida mantém rótulo                                                     |
| `link-token.ts`       | `signFormLink({formId, contactId, source, ttlDays})`, `verifyFormLink(token, formId)`, `formPublicUrl(slug, origin, token?)`; chave derivada de `FORM_LINK_SECRET` com HKDF (`info = 'form-link'`) | round-trip, expiração, adulteração, `null` sem segredo, tempo constante (`timingSafeEqual`)          |
| `identity.ts`         | `resolveIdentity({token, phone, formId, accountId})` → `{contactId, created, mode}` usando `normalizeContactPhone` + upsert em `contacts` com `created_via='form'`, tratando `23505` como corrida   | telefone inválido, contato existente, corrida, token vence telefone                                 |
| `apply-mapping.ts`    | `applyMappings(db, {contactId, fields, answers})`: nome/e-mail/empresa (preenche se vazio ou sobrescreve), `custom:<id>` via `applyCustomValues`-like por **id**, `tag` aditiva, `contact.opt_in` via `set_contact_opt_in` | não sobrescreve por padrão, etiqueta aditiva, campo inexistente pulado com aviso                     |
| `apply-band.ts`       | `applyBandActions(db, {band, contactId, formId, responseId})`: etiquetas, `createDeal` (título por template `{{contact.name}} — {{form.name}}`), atribuição (`specific`/`round_robin` entre `isAssignableMember`), notificações in-app | cada ação isolada; falha de uma não impede as outras; nunca lança                                   |
| `project-public.ts`   | `toPublicPayload(form, fields, signedMedia)` (E-9)                                                                                                                                                 | **teste de contrato**: JSON sem as chaves proibidas                                                 |
| `availability.ts`     | Tipagem do retorno de `form_public_availability` e mensagem neutra                                                                                                                                  | mapeamento de `reason` → mesmo texto                                                                 |
| `uploads.ts`          | `validateUploadRequest`, allowlist MIME/extensão, `MEDIA_MAX_BYTES_BY_KIND`-like para formulário, `buildUploadPath`, `verifyUploadedObject`                                                        | MIME com parâmetro (`baseMimeType`), extensão divergente, tamanho                                   |
| `quota.ts`            | `checkFormsAvailableQuota`, `monthMetricKey(now, tz)`, parsing de `QUOTA_EXCEEDED:forms`                                                                                                           | virada de mês em `America/Sao_Paulo`                                                                |
| `templates.ts`        | Modelos iniciais (E-14)                                                                                                                                                                            | cada modelo passa em `validateFormForPublish`                                                       |
| `public-messages.ts`  | Carrega `PublicForm.*` para o `locale` do formulário                                                                                                                                               | os dois locales compilam (padrão `messages-icu.test.ts`)                                            |
| `activity.ts`         | Helpers que chamam `recordActivity` com as ações do §9                                                                                                                                             | catálogo aceita as ações                                                                            |
| `admin-client.ts`     | Reexporta `src/lib/supabase/admin.ts` (nunca no browser)                                                                                                                                           | `isolation`-like: nenhum arquivo de `src/components/forms/` importa                                  |

## 7. Rotas

### 7.1. Lado da conta (`/api/forms/**`, sessão, `requireRole` + `requireFormsFeature`)

| Rota                                              | Papel  | Faz                                                                                                   |
| ------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `GET /api/forms`                                  | viewer | Lista com contadores (uma query agregada); `featureInPlan`                                            |
| `POST /api/forms`                                 | admin  | Cria de modelo; trata `QUOTA_EXCEEDED:forms` → `409 { error: 'QUOTA_EXCEEDED', metric, used, limit }` |
| `GET/PUT/DELETE /api/forms/[id]`                  | admin  | Lê/salva rascunho (sem validar publicação) / exclui só sem respostas                                   |
| `PUT /api/forms/[id]/fields`                      | admin  | Substitui a lista de blocos em transação (RPC `form_fields_replace`), mantendo ids existentes          |
| `POST /api/forms/[id]/publish` · `/unpublish` · `/archive` · `/restore` · `/duplicate` | admin | Transições do §4.5, `validateFormForPublish` no publish                              |
| `POST /api/forms/[id]/media`                      | admin  | URL assinada de upload no `form-media`                                                                |
| `GET /api/forms/[id]/responses`                   | viewer | Paginação, filtros, busca; `answers` inteiro por linha                                                |
| `GET /api/forms/[id]/responses/[rid]/files/[idx]` | viewer | Redireciona para URL assinada de 10 min com `download`                                                |
| `POST /api/forms/[id]/responses/delete`           | admin  | `form_responses_delete` + remoção dos objetos                                                         |
| `POST /api/forms/[id]/responses/export`           | admin  | CSV/XLSX, `contact_exports`                                                                           |
| `GET /api/forms/[id]/link`                        | agent  | Link genérico + QR data URL + snippet de embed; `tokenAvailable: boolean`                              |
| `POST /api/forms/[id]/link`                       | agent  | `{contact_id, source}` → link com token (ou `503 FORM_LINK_SECRET_MISSING`)                           |
| `GET /api/contacts/[id]/form-responses`           | viewer | Para a aba da ficha e o painel do inbox                                                               |

Mensagens em inglês; a UI traduz os códigos (`FEATURE_NOT_IN_PLAN`, `QUOTA_EXCEEDED`, `FORM_LINK_SECRET_MISSING`, `FORM_HAS_RESPONSES`, `INVALID_FORM`).

### 7.2. Lado público (`/api/forms/public/[slug]/**`, sem sessão, `service_role`)

| Rota                        | Rate limit (por IP, `RATE_LIMITS`)        | Guardas                                                                                                         |
| --------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST …/start`              | `formStart: 30/min`                       | `Origin` obrigatório e igual à origem do app (ou do domínio verificado, SPEC 087); `form_public_availability`; honeypot vazio; `started_at` há ≥ 3 s; telefone válido ou token válido; `allow_multiple_responses` |
| `PATCH …/responses/[id]`    | `formAutosave: 120/min`                   | `resume_token` bate (`sha256`), resposta `partial`, só chaves de blocos existentes                              |
| `POST …/upload-url`         | `formUpload: 20/min`                      | idem + `validateUploadRequest` + `form_upload_quota_state` com folga para o tamanho declarado                   |
| `POST …/submit`             | `formSubmit: 10/min`                      | idem + `validateAnswers` + Turnstile (se ligado) + reconfere disponibilidade + `verifyUploadedObject` por arquivo |

`ip_hash` usa o IP de `X-Forwarded-For` **só porque o Traefik é a borda** (SPEC 083 A-5); a chave do hash deriva de `FORM_LINK_SECRET` (sem a variável: hash com sal fixo do processo, sem valor forense, aceito).

Turnstile: variáveis `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`; ausentes → o interruptor por formulário fica desabilitado no construtor com a explicação. É a única chamada externa do envio e tem `AbortSignal.timeout(5000)`; falha de rede do verificador **recusa** o envio (fail-closed, o formulário pediu proteção).

## 8. Segurança

1. **Sem policy para `anon`** nas tabelas e buckets novos; `has_table_privilege` conferido na asserção da 098 e por `get_advisors`.
2. **Projeção pública fechada** (E-9) com teste de contrato.
3. **Pontuação só no servidor** (E-5).
4. **Token HMAC** com HKDF, expiração, `formId` no payload (um token não serve em outro formulário), `timingSafeEqual`.
5. **`resume_token`** opaco por resposta; só o hash no banco; descartado no `completed`.
6. **`Origin` obrigatório** nas quatro rotas públicas (como `guardWrite` da área).
7. **Uploads:** allowlist dupla (MIME e extensão), tamanho, bucket privado, leitura só por URL assinada curta com `download`, nunca `inline`; a varredura remove órfãos.
8. **Rate limit por IP** nas rotas públicas e por usuário nas da conta (`adminAction` para transições).
9. **Honeypot + tempo mínimo + Turnstile opcional** contra bots.
10. **Embed** só com origens cadastradas (E-12); a lista aceita só `https://` + host, sem caminho, no máximo 10.
11. **Dados pessoais:** nada gravado antes da identidade (PRD D-7); `ip_hash`, não IP; `user_agent` truncado a 256; exportação auditada; cascata no delete do contato; `/security-review` antes do piloto (PRD D-15).
12. **Isolamento de código:** `src/components/forms/**` e `src/app/(public)/f/**` (cliente) importam só `@/lib/forms/{types,logic,validate,slug}`; nunca `admin-client`. Teste estático no padrão de `contact-portal/isolation.test.ts`.

## 9. Registro de atividade, notificações e cron

- `ACTIVITY_CATALOG` ganha o recurso `form`: `form.created`, `form.published`, `form.unpublished`, `form.archived`, `form.restored`, `form.deleted`, `form.responses_deleted`, `form.exported`; e em `contact`: `contact.form_submitted` (ator `contact`, telefone mascarado; `metadata: {form_id, response_id, score, band_key}`). `contact.form_link_sent` entra na SPEC 086 (quem envia é a integração). Mensagens ICU nos dois dicionários (`Activity.*`), com o teste `messages-icu.test.ts` estendido.
- **Notificação in-app** `form_response_received` (novo valor na `CHECK` `notifications_type_check`, migração 098) para `notify_user_ids` da faixa ou do formulário; `NotificationType` em `src/types/index.ts`; página `/notifications` renderiza com link para a resposta.
- **Aviso ao owner** em 80 % e 100 % de `form_responses_month`: reaproveita o evento `quota.exceeded` da outbox (`emitSystemEvent`, `dedupe_key` com `YYYY-MM-DD` e a métrica), sem evento novo.
- **Cron:** fase nova em `/api/automations/cron` (`forms`): marca `partial` com `updated_at` > 24 h como `abandoned`; apaga objetos de `form-uploads` cujo prefixo `<response_id>` não existe mais ou pertence a `abandoned` com > 7 dias; registra contagem no resultado. Comentário do topo da rota lista a fase; `status.md` registra. Sem rota nova.

## 10. UI

- **Barra lateral:** item `Formulários` (`ClipboardList`), `href: '/forms'`, após `Disparos`; esconder para `viewer`? **Não**: viewer vê respostas (PRD §5). Conta sem o item: o item leva à página com o aviso.
- **`src/components/forms/`:** `form-list.tsx`, `form-builder/` (`block-list.tsx`, `block-palette.tsx`, `block-editor.tsx`, `theme-editor.tsx`, `logic-editor.tsx`, `scoring-editor.tsx`, `settings-editor.tsx`, `publish-bar.tsx`, `phone-frame.tsx`), `public/` (`public-form.tsx`, `blocks/<type>.tsx`, `progress-bar.tsx`, `welcome-screen.tsx`, `thank-you-screen.tsx`, `unavailable.tsx`), `responses/` (`responses-table.tsx`, `response-detail.tsx`, `response-filters.tsx`, `export-dialog.tsx`), `share-dialog.tsx` (link, QR, embed), `quota-meter` reutilizado.
- **Página pública:** `src/app/(public)/f/[slug]/page.tsx` + `layout.tsx` próprio (sem shell, sem tema do usuário: as cores vêm do formulário por CSS variables; `<html lang>` do `locale`; `robots: noindex` configurável por formulário, padrão `index`).
- **Ficha do contato:** aba `forms`; **inbox:** cartão no `contact-sidebar.tsx`.
- **Configurações:** seção `forms` (`minRole: 'admin'`) com: estado da variável `FORM_LINK_SECRET` (presente/ausente, sem o valor), Turnstile (presente/ausente), link para `/forms`. Domínio próprio entra aqui na SPEC 087.
- **Console `/admin`:** a conta mostra os três contadores (lê `account_usage_counters`); editor de planos e tela da conta ganham a chave e as quotas via `FEATURE_KEYS`/`USAGE_QUOTA_KEYS` (sem código novo além dos rótulos).

### 10.1. i18n

Namespaces novos: `Forms` (CRM: lista, construtor, respostas, compartilhar, erros traduzidos) e `PublicForm` (página pública: `start`, `continue`, `ok`, `back`, `submit`, `submitting`, `required`, `invalidEmail`, `invalidPhone`, `invalidNumber`, `minChoices`, `maxChoices`, `fileTooLarge`, `fileTypeNotAllowed`, `alreadyAnswered`, `unavailable.title`, `unavailable.body`, `thankYou.default`, `footer.madeWith`, `estimatedTime`, `pressEnter`, `uploading`, `retry`). Mais `Sidebar.forms`, `Contacts.formsTab.*`, `Inbox.formsCard.*`, `Settings.forms.*`, `Notifications.formResponseReceived.*`, `Activity.form.*`, `Plan.featureLabel.forms_enabled`, rótulos das três quotas. `npm run i18n:check` obrigatório; placeholders ICU iguais nos dois.

## 11. Plano de implementação

| Fase | Entrega                                                                                                                                                                       | Gate                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F1   | Migrações 097/098 escritas (não aplicadas), `src/types` + `src/lib/forms/*` com testes, `plans/types.ts` + seeds + `catalog.test.ts`, `ACTIVITY_CATALOG`, `NotificationType`    | `typecheck`, `test` (novos ≥ 60 casos), `lint`                                        |
| F2   | `/forms` (lista), `/forms/[id]` (construtor completo com prévia), rotas da conta, i18n `Forms`                                                                                   | Cria/publica os 4 modelos; `i18n:check`                                              |
| F3   | `/f/[slug]`, rotas públicas, uploads, Turnstile, middleware, `next.config.ts` (E-12), página neutra, i18n `PublicForm`                                                           | Critérios 1–5 e 7 do PRD em `next dev` e `next build`                                 |
| F4   | Respostas (tabela, detalhe, exportação, apagar), ficha, inbox (cartão), Configurações, console, cron (fase `forms`), `docs/context/formularios.md`, rule, `INDEX.md`, `status.md` | Gate completo (`typecheck && i18n:check && lint && test && format:check && build`)   |
| F5   | Aplicar 097/098 no `vn` com confirmação (§5.4), seed reconciliado ou `UPDATE` pontual                                                                                           | Asserções; `get_advisors`; `has_table_privilege('anon', …) = false`                  |
| F6   | `/security-review`, roteiro manual (§12.3), piloto por `limit_overrides`                                                                                                        | Sem HIGH/MEDIUM; cenários marcados                                                    |

Cada fase em sessão própria, `/code-review high` ao fim. Commits e push pelo mantenedor.

## 12. Critérios de aceite e testes

### 12.1. Critérios

Os do PRD 084 §9 itens 1–7 e 10, mais:

8. `validateFormForPublish` recusa: formulário com `accept_generic_link` sem bloco `phone` de identidade; `show_if` apontando para bloco posterior; `jump_to` em ciclo; faixas sobrepostas.
9. Virada de mês: resposta concluída às 23:59:59 de 30/11 em `America/Sao_Paulo` conta em `form_responses:2026-11`; às 00:00:00 de 01/12, em `2026-12` (teste de `monthMetricKey` com `Date` fixa).
10. A varredura marca `abandoned` só `partial` > 24 h e remove só objetos órfãos (teste do seletor, sem Storage real).

### 12.2. Consultas de apoio (só leitura, no `vn`)

```sql
select slug, status, account_id from forms order by created_at desc limit 20;
select metric, value from account_usage_counters where account_id = '<conta>' and metric like 'form%';
select has_table_privilege('anon','public.form_responses','SELECT');
select * from form_public_availability('<slug>');
```

### 12.3. Roteiro manual (resumo; o detalhado nasce na F6 como `spec-085-teste-manual.md`)

1. Criar do modelo "Captação de lead", publicar, abrir no celular, concluir: contato criado, mapeamentos, etiqueta e negócio da faixa.
2. Responder de novo com o mesmo telefone: contato atualizado, segunda resposta.
3. Link com token (gerar por `POST /api/forms/[id]/link`): bloco de telefone pulado.
4. Token adulterado: pede telefone. Sem `FORM_LINK_SECRET`: `503` e aviso na UI.
5. Upload de PDF de 1 MB: aparece na resposta; `.exe` renomeado para `.pdf`: recusado.
6. Despublicar, arquivar, conta sem plano, quota de respostas em `0` por `limit_overrides`: página neutra idêntica nos quatro casos.
7. Embed em página local com origem cadastrada abre; sem origem, o navegador bloqueia.
8. Exportar: linha em `contact_exports`; apagar respostas: objetos somem do bucket.
9. Excluir o contato: respostas somem; varredura remove os arquivos.
10. `get_advisors` e `has_table_privilege` conforme §5.4.

## 13. Fora desta SPEC

Tudo da SPEC 086 (gatilho de automação, variáveis, disparos, flows, botão do inbox, área do contato, IA, webhook, API pública, MCP) e da 087 (domínio próprio). Os campos `portal_visibility`, `ai_offerable`, `ai_offer_hint` e `source` já nascem aqui para a 086 não precisar de migração em `forms`.

## 14. Armadilhas específicas

| Sintoma                                               | Causa provável                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Página pública mostra "indisponível" com tudo ligado  | `plan_feature_strict` falso (chave ausente no plano), `contacts` cheia, ou 098 não aplicada              |
| Link com token sempre pede telefone                   | `FORM_LINK_SECRET` ausente/trocado entre deploys, ou token de outro formulário                           |
| Upload falha sem erro visível                         | MIME com parâmetro (`;codecs=`) não normalizado, ou extensão fora da allowlist                           |
| Quota de respostas não zera no mês novo               | `monthMetricKey` com fuso errado; conferir `America/Sao_Paulo` no SQL **e** no TS                        |
| Formulário publicado some do `/f/<slug>` após deploy  | `slug` reservado novo colidiu, ou middleware deixou de sair cedo em `/f/`                                 |
| `MISSING_MESSAGE` na página pública                   | Chave `PublicForm.*` só em um dicionário; `i18n:check`                                                  |
