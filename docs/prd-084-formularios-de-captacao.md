# PRD 084 — Formulários de captação: criar, publicar e classificar leads em `contacts`, liberado por plano

> **O que é este arquivo:** o PRD do ZAP CRM BR para o construtor de **formulários de captação** (uma pergunta por tela, no modelo do Yay! Forms / Typeform, com foco em celular), as respostas vinculadas ao contato da conta, a classificação do lead por regras e a integração com automações, flows, disparos, inbox, funis, área do contato e o agente de IA. O detalhe técnico está em três SPECs: núcleo (085), integrações (086) e domínio próprio (087). Origem: pedido do mantenedor em [`docs/prompt/form-custom-capta-lead.md`](./prompt/form-custom-capta-lead.md) (2026-11-05).

**Status:** decisões D-1…D-16 (§4) e catálogo do §7 **ratificados pelo mantenedor em 2026-11-06** (F0 concluída). As quatro perguntas de clarify (identidade do respondente, escopo do plano, domínio próprio, classificação) foram respondidas no mesmo dia e estão embutidas nas decisões. Próxima fase: F1 (SPEC 085 §11). Nada foi alterado ainda em `src/`, `messages/` ou `supabase/`.
**Data:** 2026-11-06.
**SPECs de execução:** [`spec-085-formularios-nucleo.md`](./spec-085-formularios-nucleo.md) · [`spec-086-formularios-integracoes.md`](./spec-086-formularios-integracoes.md) · [`spec-087-formularios-dominio-proprio.md`](./spec-087-formularios-dominio-proprio.md).
**Pré-requisito em produção:** [`SPEC 081`](./spec-081-aperto-de-rpcs-definer-e-privilegios-padrao.md) aplicada no `vn` antes do primeiro formulário público real (D-15). Mesmo motivo do PRD 082 D-8: a página pública é uma superfície anônima a mais num banco onde `anon` ainda executa funções que não checam quem chama.
**Emenda declarada ao PRD 058:** a §5 daquele PRD lista as quotas e a §5.1 as chaves de recurso. Este PRD acrescenta a chave `forms_enabled` (fail-closed, lida por `plan_feature_strict`) e **três quotas de uso novas**: `forms`, `form_responses_month` e `form_upload_mb` (D-10).

---

## 1. Por que agora

1. **O lead entra hoje sem porta própria.** Um contato novo nasce no ZAP de três jeitos: alguém escreve no WhatsApp, a equipe cadastra à mão ou importa planilha, ou um sistema externo chama `POST /api/v1/ingest/contact` (SPEC 055). Nenhum deles serve para o caso mais comum de captação: um link numa bio, num anúncio, num QR code na loja, numa mensagem de disparo. Quem tem esse link hoje usa Typeform, Yay! Forms ou Google Forms e depois cola a planilha no ZAP, perdendo o vínculo com o contato, a classificação e o gatilho de automação.
2. **Tudo que o formulário precisa do outro lado já existe.** Contato deduplicado por telefone (SPEC 050), campos personalizados com `upsert` seguro (SPEC 055 achado C), etiquetas aditivas (D-6 da 055), negócio por contato (`createDeal`), gatilhos de automação por contato (`runAutomationsForTrigger`), chave de recurso fail-closed e quota por trigger (PRD 058 / 082), bucket privado com URL assinada (SPEC 040), área do contato com sessão própria (SPEC 083), registro de atividade (SPEC 075) e um agente de IA que já recebe contexto e base de conhecimento (`buildSystemPrompt`). O trabalho é o construtor, a página pública e a cola, não a fundação.
3. **É um recurso comercializável e mensurável.** "Quantos formulários", "quantas respostas por mês" e "quanto de arquivo" são tetos que o proprietário vende, exatamente como contatos e canais. É também o primeiro recurso que entrega algo **dentro** da área do contato (PRD 082 D-5 previu que cada um nasceria do próprio PRD).
4. **O agente de IA fica cego para o lead.** Hoje a IA responde só com o histórico da conversa e a base de conhecimento. Um lead que preencheu "orçamento até R$ 5 mil, prazo este mês, interesse em plano anual" merece uma resposta que saiba disso. O formulário é a fonte estruturada que o agente não tem.

## 2. O que já existe (e por que isso encurta o trabalho)

| Peça                                                             | Onde                                                    | Papel aqui                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `normalizeContactPhone`, dedup por `phone_normalized`            | `src/lib/phone/br.ts`, migração 022                     | A resposta vira contato pelo mesmo caminho do formulário manual (SPEC 050 D-5)                          |
| `applyCustomValues` (upsert por `(contact_id, custom_field_id)`) | `src/lib/ingest/custom-values.ts`                       | Mapear uma pergunta para um campo personalizado sem apagar os outros                                    |
| Etiquetas aditivas, `resolveImportTagIds`                        | `src/lib/contacts/resolve-import-tags.ts`, SPEC 057 D-1 | Faixa de pontuação aplica etiqueta sem substituir as existentes                                         |
| `createDeal`                                                     | `src/lib/pipelines/deals.ts`                            | Faixa cria o negócio na etapa certa do funil                                                            |
| `runAutomationsForTrigger`, `interpolate` (`{{vars.*}}`)         | `src/lib/automations/engine.ts`                         | Gatilho `form_submitted` e variáveis `{{form.*}}` nas mensagens                                         |
| `VariableMapping` (`static` / `field` / `custom_field`)          | `src/lib/whatsapp/broadcast-variables.ts`               | Tipo novo `form_link`: link por destinatário no disparo                                                 |
| `sendAndPersistOutbound`                                         | `src/lib/channels/send.ts`                              | Botão "Enviar formulário" no inbox sai pelo canal da conversa                                           |
| `FEATURE_KEYS`, `USAGE_QUOTA_KEYS`, `plan_feature_strict`        | `src/lib/plans/types.ts`, migração 096                  | Chave `forms_enabled` fail-closed; as três quotas aparecem na barra de uso e no console sem código novo |
| `enforce_contact_quota` (trigger + `account_usage_counters`)     | migração 067                                            | Modelo da trigger de quota de `forms` e dos contadores mensais                                          |
| Bucket privado por conta, `signStoragePath`                      | migração 040/078, `src/lib/storage/sign-media.ts`       | Bucket `form-uploads`, leitura só assinada                                                              |
| `/area` com sessão própria, `portalDb()`, `isolation.test.ts`    | `src/lib/contact-portal/`, SPEC 083                     | Formulários e respostas dentro da área, sem Supabase Auth                                               |
| `buildSystemPrompt`, `HANDOFF_SENTINEL`, `generateReply`         | `src/lib/ai/defaults.ts`, `generate.ts`                 | Bloco "perfil do lead" no prompt e sentinela `[[FORM:slug]]` para a IA oferecer um formulário           |
| `recordActivity`, `ACTIVITY_CATALOG`                             | `src/lib/activity/`                                     | Eventos `form.*` e `contact.form_*`                                                                     |
| `checkRateLimit`, `RATE_LIMITS`                                  | `src/lib/rate-limit.ts`                                 | Tetos por IP da página pública                                                                          |
| `resolveRequestOrigin`, `NEXT_PUBLIC_SITE_URL`                   | `src/lib/http/request-origin.ts`                        | Origem dos links; base do domínio próprio (SPEC 087)                                                    |
| Middleware sai cedo em `/area`                                   | `src/middleware.ts`                                     | Mesmo padrão para `/f/**` (página pública sem `getUser()`)                                              |

**Achados que mudam o desenho:**

- `custom_fields` não tem índice único por `(account_id, field_name)` (SPEC 055 §2.2). O mapeamento de pergunta → campo personalizado é por **id**, nunca por nome.
- `broadcasts` é só WhatsApp Cloud API (template). O link do formulário entra como **variável de template** (texto do corpo ou sufixo de botão de URL); não existe disparo em texto livre para dar outro caminho.
- `next.config.ts` manda `X-Frame-Options: DENY` e `frame-ancestors 'none'` em toda resposta. Embutir o formulário no site do cliente (`<iframe>`) exige exceção **por rota** `/f/**` e **por formulário** (D-13).
- A IA já tem um protocolo de sentinela (`[[HANDOFF]]`) interpretado por `generateReply`. Oferecer um formulário entra pelo mesmo mecanismo, sem "tool calling" novo (D-12).
- O cron já existe para automações; o formulário **não** precisa de rota de cron nova. A única varredura (limpar rascunhos abandonados e arquivos órfãos) vira fase do `/api/automations/cron`, como manda [`automacoes-cron.md`](./context/automacoes-cron.md).

## 3. Objetivo

Entregar, em três SPECs:

1. **Núcleo (SPEC 085):** o `admin` cria um formulário com blocos (texto curto, texto longo, e-mail, telefone, número, data, escolha única, escolha múltipla, lista suspensa, sim/não, nota de 1 a N, arquivo, declaração só com mídia, consentimento), um bloco por tela, com logo, cores, imagem ou vídeo por etapa, tela de boas-vindas e de agradecimento, lógica de pulo simples e pontuação por resposta com faixas. Publica em `<app>/f/<slug>`. Quem responde vira (ou atualiza) um contato da conta; a resposta fica em tabela própria, vinculada ao contato; arquivos vão para bucket privado. A equipe gerencia formulários e respostas em `/forms`, vê as respostas na ficha do contato e exporta. O proprietário controla por plano.
2. **Integrações (SPEC 086):** gatilho de automação `form_submitted` e variáveis `{{form.*}}`; link do formulário por destinatário em disparos, flows e no inbox; registro de atividade; notificação à equipe; negócio no funil pela faixa; formulários e respostas dentro da área do contato; a IA lê as respostas como perfil do lead e pode oferecer o link; evento de webhook `form.submitted` e endpoints `/api/v1/forms`.
3. **Domínio próprio (SPEC 087):** o owner aponta `formularios.suaempresa.com.br` para o ZAP, verifica por registro TXT e recebe certificado automaticamente; o app traz o tutorial de DNS.

### 3.1. Fora de escopo (explicitamente)

- **Pagamento dentro do formulário** (Pix, cartão). Nasce de PRD próprio se houver demanda.
- **Agendamento de horário** (calendário com vagas). Idem.
- **Formulário multi-idioma no mesmo link.** Cada formulário tem **um** idioma, escolhido pelo owner (D-8).
- **Testes A/B de formulário**, relatórios de funil por pergunta além do básico (iniciados / concluídos / abandono por etapa).
- **Assinatura eletrônica**, campo de CPF com validação de dígito (entra como texto curto com máscara; validação fiscal é PRD próprio).
- **Resposta anônima** (sem contato). Toda resposta nasce vinculada a um contato (D-2).
- **Edição de resposta pelo contato** depois de enviada, dentro ou fora da área.
- **Retenção/expurgo automático de respostas.** Fica para a política de retenção existente estender o escopo (SPEC 060), não para cá.
- **Novo motor de cron.**
- **Marca branca do rodapé** ("Feito com ZAP CRM BR"): o rodapé existe e some só por chave de plano futura, fora deste PRD.

## 4. Decisões de produto

### D-1 — Um construtor próprio, no modelo "uma pergunta por tela"

O construtor é código do repositório (React + shadcn, `@dnd-kit` para ordenar blocos, como o kanban), não um embed de Typeform, Yay! Forms, Formbricks ou Tally. A página pública mostra **um bloco por tela**, com barra de progresso, avanço por botão ou Enter, atalhos de teclado nas opções e mídia (imagem ou vídeo) acima da pergunta; no celular é tela cheia, no desktop é um cartão centralizado de até 640 px.

**Por que não embutir um serviço de terceiros:** o valor do recurso é o vínculo com `contacts`, a classificação e os gatilhos internos. Um embed devolveria uma planilha e um webhook, exatamente o que o cliente faz hoje. E o fork público não pode depender de conta paga em serviço externo.

**Por que não um formulário tradicional (todas as perguntas numa página):** o pedido é explícito ("seguir o modelo do Yay Form, cada elemento uma etapa, foco principal em mobile"); uma pergunta por tela tem taxa de conclusão maior no celular, que é onde o link de WhatsApp é aberto.

### D-2 — Toda resposta nasce vinculada a um contato: telefone obrigatório **ou** link com token

Ratificado no clarify. Duas portas de identidade, nunca nenhuma:

1. **Link genérico** (`/f/<slug>`, o da bio, do anúncio, do QR code): o formulário tem **um bloco Telefone obrigatório**, inserido por padrão e não removível enquanto o formulário aceitar o link genérico. O número passa pela validação do formulário manual (SPEC 050 D-5: bloqueia inválido, aceita celular legado de 8 dígitos, número estrangeiro pelo caminho genérico). O contato é encontrado ou criado por `phone_normalized` na conta do formulário.
2. **Link com token** (`/f/<slug>?t=…`), gerado pelo ZAP **para um contato específico**: botão no inbox, variável de disparo, passo de automação, nó de flow, área do contato ou API. O token já diz quem é; o bloco Telefone é **pulado** (o owner pode marcar "confirmar telefone mesmo com token", padrão desligado).

Um link com token inválido ou expirado degrada para o comportamento do link genérico (pede o telefone), nunca para um erro. Resposta "anônima" não existe (fora de escopo); um formulário sem bloco Telefone só pode ser publicado com "aceitar só links com token" ligado, e o construtor avisa.

### D-3 — O token do link é assinado e sem estado; a revogação é do formulário

O token é `base64url(contact_id · expiração · origem · HMAC-SHA256)` com chave derivada de uma variável de servidor nova (`FORM_LINK_SECRET`). Não há tabela de links: um disparo para 5.000 contatos não grava 5.000 linhas, e a validação é uma comparação em tempo constante.

Consequências aceitas: (a) não se revoga **um** link; revoga-se despublicando ou arquivando o formulário, ou bloqueando o contato; (b) sem a variável no servidor, links com token ficam **indisponíveis** (o botão do inbox, a variável do disparo e a IA avisam "não configurado"), e o link genérico continua funcionando. É o mesmo padrão "canal ausente é no-op com aviso" das notificações, não o `503` do cron, porque o formulário público não depende do token para existir.

### D-4 — A resposta é um instantâneo; o contato recebe só o que foi mapeado

`form_responses.answers` guarda, por bloco, **rótulo, tipo, valor e pontos no momento do envio**. Editar o formulário depois não reescreve respostas antigas, e apagar um bloco não apaga o que já foi respondido.

Só o que o owner **mapeou** chega ao contato: nome, e-mail, empresa, um campo personalizado (por id), uma etiqueta. Regra de escrita por mapeamento: **preenche se vazio** por padrão; "sobrescrever" é opção por bloco. Etiquetas são aditivas (SPEC 055 D-6). Campos personalizados usam `upsert` por `(contact_id, custom_field_id)`. O resto fica só na resposta, consultável na ficha, na tela de respostas, na área do contato e pela IA.

### D-5 — Classificação por regras no construtor; a IA lê, não decide

Ratificado no clarify. Cada opção de escolha única, múltipla, sim/não e nota pode valer **pontos**; número pode valer pontos por faixa. A soma é a **pontuação** da resposta, calculada **no servidor** no envio. O owner define **faixas** (ex.: 0–20 frio, 21–60 morno, 61+ quente), cada uma com ações determinísticas: aplicar etiqueta, criar negócio em funil/etapa, atribuir o negócio a um membro ou em rodízio, notificar membros. Faixa e pontuação ficam gravadas na resposta e viram variáveis para automações (`{{form.score}}`, `{{form.band}}`).

A IA **recebe** as respostas como contexto (D-12) e pode sugerir no rascunho, mas **não** classifica: não gasta token da chave BYO da conta, não varia entre execuções e o owner entende por que o lead caiu numa faixa. Uma classificação por IA, se vier, é PRD próprio e opt-in.

### D-6 — Lógica de pulo simples, sem grafo

Um bloco pode ter **uma** condição de exibição ("mostrar se bloco X é / não é / contém valor") e um bloco de escolha pode ter **pular para** por opção. Não há grafo, variáveis nem expressões. Quem precisa de ramificação complexa usa um Flow depois do envio (SPEC 086). O validador do construtor recusa referências a blocos posteriores inexistentes e ciclos; a página pública segue a ordem resolvida no servidor.

### D-7 — Resposta parcial é gravada só depois da identidade e aparece como "incompleta"

A página grava a resposta no servidor **a partir do bloco que identifica o contato** (telefone respondido, ou primeiro bloco quando há token). Antes disso o progresso vive só no navegador (rascunho local por formulário, conveniência do visitante). Resposta incompleta: `status = 'partial'`, visível na tela de respostas com filtro, **não** dispara automação, faixa, negócio nem notificação, e não conta na quota de respostas até ser concluída. Uma resposta parcial que o visitante nunca termina é marcada `abandoned` pela varredura após 24 h (fase do cron de automações), continua consultável e pode ser apagada em lote.

**Por que gravar parcial:** é o lead que começou e desistiu, informação que o Yay! Forms e o Typeform entregam e que a equipe usa para reengajar. **Por que só depois da identidade:** sem contato não há onde pendurar (D-2), e gravar teclas de visitante anônimo criaria dado pessoal sem titular.

### D-8 — Um idioma por formulário, escolhido pelo owner

O formulário tem `locale` (`pt-BR` ou `en`, a lista de `SUPPORTED_LOCALES`), padrão `NEXT_PUBLIC_APP_LOCALE`. Os textos de sistema da página pública (botões, erros de validação, "enviando…") saem do dicionário **desse** idioma, não do cookie do visitante: o owner é quem sabe para quem o link vai. Os textos do próprio formulário (perguntas, opções, telas) são conteúdo, não tradução. Mesma regra que a validação de telefone (D-1 da SPEC 050): decisão do dono do dado, não do dispositivo.

### D-9 — Página pública sem sessão, servida com `service_role` escopado por slug

`/f/<slug>` sai cedo do middleware (como `/area`), não cria client do Supabase no navegador e não dá a `anon` nenhuma policy nas tabelas de formulário. O servidor carrega o formulário publicado por `slug` com `supabaseAdmin()` e devolve ao cliente **só** o que a página precisa (blocos, tema, textos), nunca `account_id`, ids internos de etiqueta/funil, pontos ou faixas. Envio e upload passam por rotas `/api/forms/public/...` com rate limit por IP, `Origin` obrigatório e validação integral no servidor (os pontos são recalculados lá; o cliente nunca manda pontuação).

Uploads: o servidor valida tipo, tamanho declarado e quota, e devolve uma **URL de upload assinada** do bucket privado `form-uploads`; o navegador sobe direto para o Storage; no envio, o servidor confere que o objeto existe com o tamanho declarado. O arquivo não atravessa o Node do app.

### D-10 — Chave `forms_enabled` fail-closed e três quotas de uso

Ratificado no clarify. Chave de recurso `forms_enabled` lida por `plan_feature_strict` (ausente = `FALSE`, independe de `quotas_enforced`, conta sem plano = `FALSE`), mesmo raciocínio do PRD 082 D-2: formulário é porta pública, não teto de uso. E três quotas em `USAGE_QUOTA_KEYS` (aparecem na barra de uso do cliente e no editor de planos do console sem código novo):

| Chave                  | Conta o quê                                                        | Estourou                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `forms`                | Formulários **não arquivados** da conta (rascunho + publicados)    | Trigger recusa criar/desarquivar com `QUOTA_EXCEEDED:forms:…` (contrato de `src/lib/plans/errors.ts`)                    |
| `form_responses_month` | Respostas **concluídas** no mês corrente (`America/Sao_Paulo`)     | Página pública mostra "indisponível no momento"; nada é gravado; aviso ao owner em 80 % e 100 % (outbox de notificações) |
| `form_upload_mb`       | Bytes acumulados em `form-uploads` da conta (decrementa ao apagar) | Bloco de arquivo vira opcional-sem-upload com aviso; o resto do formulário segue                                         |

`NULL` = ilimitado e `0` = bloqueado, como em toda quota (PRD 058 D-3). O catálogo proposto (§7) vai no seed, nunca em migração (PRD 058 D-2). Perder o item ou estourar quota **nunca apaga** formulário, resposta ou arquivo (PRD 058 D-4): despublica na próxima requisição e preserva tudo.

**Contato novo vindo de formulário conta na quota de `contacts`** com `created_via = 'form'` e **não** tem a isenção do inbound (PRD 058 D-5): o plano vende contatos, e um formulário viral não pode furar o teto. Quando `contacts` está cheia, a página pública mostra "indisponível" **antes** de o visitante começar, e o owner já recebe `quota.exceeded`. Contato que **já existe** segue respondendo normalmente.

### D-11 — Plano sem o item: a UI esconde, a rota recusa, a página pública some

Três camadas, como na SPEC 059 §7.3 e no PRD 082 D-4: a entrada "Formulários" na barra lateral aparece para `admin+` com aviso "não incluído no seu plano" e sem ação; `/api/forms/*` responde `403 FEATURE_NOT_IN_PLAN`; `/f/<slug>` de conta sem o item responde a mesma página neutra de "formulário indisponível" de um slug inexistente (não distingue "não existe" de "plano não inclui"). Exceção por conta via `limit_overrides.forms_enabled = true` para o piloto.

### D-12 — A IA recebe o perfil do lead e pode **oferecer** um formulário por sentinela

Duas integrações, as duas pelo que já existe:

1. **Leitura.** `buildSystemPrompt` ganha um bloco "Lead profile from forms" com a última resposta concluída de cada formulário do contato (pergunta → resposta, até um teto de caracteres, sem arquivos). Vale para rascunho e auto-reply. O bloco é referência, não instrução, com a mesma frase defensiva do bloco de base de conhecimento.
2. **Ação.** O prompt lista os formulários publicados que o owner marcou como **"a IA pode oferecer"** (slug + descrição curta de "quando oferecer"). O modelo pode incluir `[[FORM:<slug>]]` no texto; `generateReply` troca o sentinela pelo link com token do contato, remove sentinelas de slug desconhecido e limita a um por resposta. Sem `FORM_LINK_SECRET`, a lista não entra no prompt.

A IA **não** chama API, não grava resposta e não classifica (D-5). É o mesmo protocolo do `[[HANDOFF]]`, com o mesmo teste de parsing.

### D-13 — Embutir no site do cliente é opt-in por formulário, com origens explícitas

`X-Frame-Options: DENY` e `frame-ancestors 'none'` continuam valendo para o app inteiro. Para `/f/<slug>`, quando o owner cadastrou **origens de embed** no formulário (`https://www.suaempresa.com.br`), a resposta troca `X-Frame-Options` por `Content-Security-Policy: frame-ancestors <origens>`; sem origens cadastradas, `DENY`. O construtor gera o `<iframe>` e um `<script>` de redimensionamento. Embed em origem não listada falha em silêncio no navegador do visitante, que é o comportamento esperado.

### D-14 — Formulário não se apaga com respostas: arquiva

`archived` é o estado terminal: sai da quota `forms`, despublica o link, mantém respostas e arquivos consultáveis. Excluir de verdade só é permitido para formulário com zero respostas. Apagar respostas é ação separada, `admin+`, com confirmação, e leva os arquivos do bucket junto (melhor esforço, como o `orphan-media-cleanup.sql`). Excluir o **contato** cascateia as respostas e dispara a limpeza dos arquivos: titular dos dados apagado, dados apagados (LGPD).

### D-15 — SPEC 081 e revisão de segurança antes do primeiro formulário real

Mesmo raciocínio do PRD 082 D-8. A página pública e as rotas `/api/forms/public/*` são anônimas; as tabelas novas nascem com RLS e sem policy para `anon`; mesmo assim, o deployment só liga `forms_enabled` para a primeira conta real depois de 090/091 aplicadas no `vn` e do `/security-review` sem achado HIGH ou MEDIUM novo.

### D-16 — Domínio próprio depois do núcleo, com tutorial no app

Ratificado no clarify. A v1 publica em `<app>/f/<slug>`. O domínio do owner (`formularios.suaempresa.com.br` por CNAME, verificação por TXT, certificado automático) é a SPEC 087, porque exige decisão de infraestrutura na borda (Traefik ou Caddy com TLS sob demanda) que não pode segurar o construtor. O tutorial de DNS é tela do app (i18n), com passos genéricos e notas para Registro.br, Cloudflare e GoDaddy.

## 5. Hierarquia e papéis

```text
Proprietário da plataforma ──── /admin
        │   decide, por plano ou por conta, quem tem formulários e quantos (D-10)
        └── Conta (accounts) ──── CRM
               │   admin+ cria, edita, publica, arquiva, configura domínio
               │   agent  vê respostas, envia link pelo inbox
               │   viewer vê respostas
               ├── /forms            gestão (CRM, Supabase Auth)
               ├── /f/<slug>         página pública (sem sessão, service_role por slug)
               └── /area/formularios o contato logado preenche e consulta (sessão da área)
```

| Ação                                                              | viewer | agent | admin+ |
| ----------------------------------------------------------------- | ------ | ----- | ------ |
| Ver lista de formulários e respostas, abrir resposta, ver arquivo | sim    | sim   | sim    |
| Enviar link pelo inbox / ficha                                    | não    | sim   | sim    |
| Criar, editar, publicar, despublicar, arquivar, tema, faixas      | não    | não   | sim    |
| Exportar respostas (CSV/XLSX, auditado como em SPEC 051)          | não    | não   | sim    |
| Apagar respostas, excluir formulário sem respostas                | não    | não   | sim    |
| Configurar embed, visibilidade na área, "IA pode oferecer"        | não    | não   | sim    |
| Domínio próprio (SPEC 087)                                        | não    | não   | sim    |

Tudo acima **só com o item no plano** (D-11). Console `/admin`: a conta mostra "N formulários · N respostas no mês · N MB", e o editor de plano ganha a chave e as três quotas sem código novo.

## 6. Experiência

### 6.1. Jornadas do lead (visitante)

| Jornada | Gatilho                                                               | Resultado                                                                                                                 |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **L1**  | Abre o link genérico (bio, anúncio, QR)                               | Boas-vindas → blocos, um por tela → bloco Telefone → envio → agradecimento (com botão para o WhatsApp da conta, opcional) |
| **L2**  | Recebe o link com token pelo WhatsApp (inbox, disparo, automação, IA) | Mesmo fluxo, sem o bloco Telefone; a resposta já nasce no contato certo                                                   |
| **L3**  | Desiste no meio                                                       | Rascunho local no navegador; no servidor, `partial` a partir da identidade (D-7); volta e continua de onde parou          |
| **L4**  | Entra na área do contato (`/area`)                                    | Vê "Formulários": os que pode preencher e as respostas que o owner liberou (SPEC 086)                                     |
| **L5**  | Formulário indisponível (despublicado, plano, quota, conta bloqueada) | Página neutra "Este formulário não está disponível no momento", igual para todos os motivos                               |

### 6.2. Jornadas da equipe

| Jornada | Quem  | O que                                                                                                                                                    |
| ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1**  | admin | `/forms` → Novo → escolhe modelo (em branco, captação de lead, pesquisa de satisfação, inscrição em evento) → edita blocos no construtor                 |
| **E2**  | admin | Aba Tema: logo, cor primária, cor de fundo, cor do texto, fonte, imagem/vídeo por bloco, tela de boas-vindas e de agradecimento, idioma                  |
| **E3**  | admin | Aba Classificação: pontos por opção, faixas e ações (etiqueta, negócio, atribuição, notificação)                                                         |
| **E4**  | admin | Publicar → recebe link, QR code (gerado no cliente, sem serviço externo) e snippet de embed                                                              |
| **E5**  | agent | No inbox, "Enviar formulário" → escolhe → mensagem com link com token sai pelo canal da conversa                                                         |
| **E6**  | todos | `/forms/<id>/respostas`: tabela com filtros (faixa, status, período, resposta de um bloco), detalhe com arquivos; na ficha do contato, aba "Formulários" |
| **E7**  | admin | Exportar CSV/XLSX; apagar respostas; arquivar                                                                                                            |
| **E8**  | admin | Configurações → Formulários → Domínio próprio (SPEC 087), com tutorial                                                                                   |

### 6.3. Telas (resumo; detalhe nas SPECs)

- `/forms` — lista (nome, status, respostas no mês, taxa de conclusão, última resposta), medidor de quota, botão Novo.
- `/forms/<id>` — construtor em três colunas: blocos (arrastar), prévia em moldura de celular, painel do bloco/tema/lógica/classificação/configurações.
- `/forms/<id>/respostas` — tabela, filtros, exportar, detalhe lateral.
- `/f/<slug>` — página pública (D-1, D-8, D-9).
- Ficha do contato — aba "Formulários"; painel lateral do inbox — últimas respostas resumidas e botão "Enviar formulário".
- `/area/formularios` e `/area/formularios/<slug>` — lado do contato (SPEC 086).
- Configurações → Formulários — domínio próprio (SPEC 087), origens de embed, variável `FORM_LINK_SECRET` presente ou não (só leitura).

### 6.4. Registro de atividade

`form.created`, `form.published`, `form.unpublished`, `form.archived`, `form.deleted`, `form.responses_deleted`, `form.exported` (recurso novo `form`); `contact.form_submitted` (ator: contato, telefone mascarado), `contact.form_link_sent` (ator: usuário, canal e formulário em `metadata`). Visita e resposta parcial **não** entram no registro.

## 7. Catálogo proposto (valores para o mantenedor ratificar; vão no seed)

| Plano        | `forms_enabled` | `forms` | `form_responses_month` | `form_upload_mb` |
| ------------ | --------------- | ------- | ---------------------- | ---------------- |
| Grátis       | `false`         | 0       | 0                      | 0                |
| Essencial    | `true`          | 1       | 200                    | 100              |
| Profissional | `true`          | 5       | 2.000                  | 1.024            |
| Empresarial  | `true`          | 20      | 10.000                 | 5.120            |

Como no PRD 082 D-1, o seed pode nascer com `forms_enabled: false` em todos os planos e o mantenedor ligar primeiro uma conta piloto por `limit_overrides`; o catálogo acima é a meta comercial, não a primeira rodada. O `plans-seed-vn.sql` diverge do catálogo vivo do `vn` ([`status.md`](./context/status.md)) e precisa ser reconciliado antes de rodar.

## 8. Riscos

| #    | Risco                                                                       | Mitigação                                                                                                                                          |
| ---- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | Formulário público viralizado estoura banco, Storage ou quota de contatos   | Três quotas (D-10), rate limit por IP, honeypot, tempo mínimo de preenchimento, Turnstile opcional por formulário, "indisponível" antes de começar |
| R-2  | Spam de respostas gera contatos lixo e dispara automações/negócios em massa | Validação de telefone BR estrita (D-2), faixa só em resposta concluída (D-7), teto de disparo de automação por formulário por hora (SPEC 086)      |
| R-3  | Upload malicioso                                                            | Allowlist de MIME e extensão, tamanho por tipo, bucket privado só com URL assinada, nunca servido inline (`Content-Disposition: attachment`)       |
| R-4  | Token de link vazado reaproveitado                                          | Expiração (padrão 30 dias), vínculo ao formulário e ao contato, degradação para pedir telefone, revogação pelo formulário (D-3)                    |
| R-5  | Página pública vaza dado da conta no HTML                                   | Projeção explícita do que vai ao cliente (D-9), teste de contrato que serializa o payload público e falha se aparecer `account_id`, `points`, ids  |
| R-6  | Pontuação manipulada pelo cliente                                           | Pontos e faixa calculados só no servidor (D-5); payload de envio não tem campo de pontos                                                           |
| R-7  | Embed abre clickjacking                                                     | Exceção por rota e por origem cadastrada (D-13); sem origem, `DENY`                                                                                |
| R-8  | Dado pessoal de visitante anônimo                                           | Nada é gravado antes da identidade (D-7); rascunho só no navegador                                                                                 |
| R-9  | Decisão de borda do domínio próprio trava a entrega                         | Separada na SPEC 087 (D-16); v1 funciona em `<app>/f/<slug>`                                                                                       |
| R-10 | A IA oferece formulário fora de hora ou inventa slug                        | Só slugs marcados "a IA pode oferecer" entram no prompt; sentinela desconhecido é removido; um por resposta (D-12)                                 |
| R-11 | Varredura de abandono e arquivos órfãos nunca roda                          | É fase do `/api/automations/cron`, que já está agendado; `status.md` registra                                                                      |

## 9. Critérios de aceite

1. `admin` cria um formulário com todos os tipos de bloco, tema completo, mídia por etapa, lógica de pulo e faixas; publica; o link abre no celular com um bloco por tela, Enter avança, barra de progresso, e o envio cria o contato com `created_via = 'form'`, os campos mapeados preenchidos, as etiquetas da faixa e o negócio na etapa configurada.
2. O mesmo telefone respondendo de novo **atualiza** o contato (não duplica), gera segunda resposta e respeita "preenche se vazio" por padrão.
3. Link com token enviado pelo inbox pula o bloco Telefone e grava a resposta no contato certo; token adulterado ou expirado pede o telefone; sem `FORM_LINK_SECRET`, o botão do inbox avisa e o link genérico funciona.
4. A pontuação enviada pelo cliente é ignorada; a do servidor bate com a regra; a faixa gravada é a esperada; resposta `partial` não dispara nada e vira `abandoned` após 24 h pela fase do cron.
5. Upload: arquivo acima do tamanho, fora da allowlist ou acima da quota é recusado no servidor antes da URL assinada; o arquivo gravado só abre por URL assinada; a resposta mostra o arquivo na ficha e na tela de respostas.
6. **Plano:** com `forms_enabled` ausente ou `false`, a entrada "Formulários" mostra o aviso, `/api/forms/*` responde `403 FEATURE_NOT_IN_PLAN` e `/f/<slug>` responde a página neutra; com `limit_overrides.forms_enabled = true` só numa conta, só ela passa. `forms` cheia recusa criar/desarquivar; `form_responses_month` cheia mostra "indisponível" e nada é gravado; `form_upload_mb` cheia desliga só o bloco de arquivo. Perder o item não apaga nada.
7. A página pública não contém `account_id`, ids de etiqueta/funil, pontos nem faixas (teste de contrato).
8. Automação com gatilho `form_submitted` dispara uma vez por resposta concluída, com `{{form.answers.<chave>}}`, `{{form.score}}`, `{{form.band}}` e `{{form.link.<slug>}}` resolvidos; disparo com variável `form_link` entrega link diferente por destinatário; flow envia link com token; a IA inclui `[[FORM:slug]]` só para formulário marcado e o link sai correto; `form.submitted` chega ao webhook de saída.
9. Na área do contato, o contato vê só os formulários com visibilidade liberada e só as **próprias** respostas; o link de preenchimento já nasce com token; conta sem `contact_portal_enabled` não mostra nada.
10. `get_advisors` (security) sem achado novo no `vn`; `anon` sem `SELECT` nas tabelas novas; `/security-review` sem HIGH/MEDIUM novo.
11. Domínio próprio (SPEC 087): CNAME + TXT verificados pelo app, certificado emitido automaticamente, `/` e `/<slug>` no domínio do owner abrem o formulário, e o link gerado pelo ZAP usa o domínio verificado.

## 10. Sequência sugerida

| Fase | Entrega                                                                                             | Pronto quando                          | Modelo recomendado                                                |
| ---- | --------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| F0   | Ratificar D-1…D-16 e o catálogo do §7 — **feita em 2026-11-06**                                     | Registradas aqui                       | Decisão humana (Opus 5.5 ou Fable 5.1 para discutir alternativas) |
| F1   | SPEC 085: migrações, tipos, módulos puros (`src/lib/forms/`) com testes                             | Gate local passa; `anon` sem acesso    | Sonnet 5.5                                                        |
| F2   | SPEC 085: construtor (`/forms`, `/forms/<id>`)                                                      | Cria/publica formulário completo       | Sonnet 5.5 (UI guiada pela SPEC)                                  |
| F3   | SPEC 085: página pública, envio, upload, quotas, página neutra                                      | Critérios 1–7                          | Sonnet 5.5; Opus 5.5 revisa a projeção pública (R-5)              |
| F4   | SPEC 085: respostas, ficha, exportação, arquivar/apagar, console                                    | Critério 6 completo                    | Sonnet 5.5                                                        |
| F5   | Migrações no `vn` com confirmação; seed reconciliado                                                | Asserções passam; `get_advisors` limpo | Opus 5.5                                                          |
| F6   | SPEC 086: automações, disparos, flows, inbox, atividade, notificação, funil                         | Critério 8 (parte)                     | Sonnet 5.5                                                        |
| F7   | SPEC 086: área do contato, IA (leitura + sentinela), webhook `form.submitted`, `/api/v1/forms`, MCP | Critérios 8 e 9                        | Opus 5.5 para o prompt e a projeção da IA; Sonnet 5.5 no resto    |
| F8   | `/security-review`, roteiro manual, SPEC 081 no `vn` (D-15), piloto por `limit_overrides`           | Critério 10; conta piloto em produção  | Opus 5.5 na revisão; Haiku 5.5 no checklist                       |
| F9   | SPEC 087: decisão de borda, verificação de DNS, roteamento por host, tutorial                       | Critério 11                            | Opus 5.5 decide a borda; Sonnet 5.5 implementa                    |

Cada fase abre sessão própria com `/code-review high` ao fim, como de costume na casa.
