# SPEC 069 — Checagem de números, captação de contatos e cascata única de limites (canal QRCode)

> A instância WhatsApp QRCode passa a **validar e enriquecer** a base (número existe, nome,
> avatar) e a **captar** contatos da própria agenda, tudo governado por **uma única cascata de
> limites** — instância → conta → `.env` → código — que passa a resolver também os limites que
> hoje só existem no código.

**PRD:** [`prd-068-enriquecimento-e-validacao-por-instancia-qrcode.md`](./prd-068-enriquecimento-e-validacao-por-instancia-qrcode.md)
**Depende de:** SPEC 048 (canal QRCode), SPEC 049 (§6.2, envio frio), SPEC 044 (§6.4,
`whatsapp_status`), SPEC 059 (motor de quotas), SPEC 060 (precedente de política por conta ×
canal), SPEC 062 (console do proprietário), SPEC 065 (seleção de canal por recurso).
**Migração:** `supabase/migrations/078_qr_enrichment_and_limits.sql` (confirme com
`ls supabase/migrations/` antes de criar — este número era o livre em 2026-09-02).

---

## 1. Sumário

Uma instância QRCode habilitada como validadora consulta o WhatsApp para dizer se um número
existe e para trazer nome e foto, alimentada por uma fila que dois caminhos enchem (importação
de contatos e disparo em massa) e dois crons consomem, sempre dentro de tetos resolvidos por
uma cascata única que substitui a leitura direta de `process.env` espalhada pelo código.

---

## 2. Decisões a ratificar

Nada abaixo está implementado. Cada decisão traz opções reais, trade-off e recomendação; o
mantenedor ratifica antes da F1.

### D-1 — Checar número consome a cota de envio frio?

`POST /user/check` não envia mensagem: o `whatsmeow` faz uma consulta de sincronização (o mesmo
tipo de tráfego que o aplicativo gera ao abrir a agenda). Mas em volume ela é, sim, um dos
padrões que o antispam observa.

*Opções:* (a) consome a mesma cota de `cold-send-limit.ts`; (b) **cota própria, mesmo motor**;
(c) nenhuma cota.

*Trade-off:* (a) é o mais simples e o mais seguro do ponto de vista de reputação, mas cada
checagem **apaga do dia um envio real que o cliente pagou** — pior ainda no R6, onde a campanha
gastaria a cota checando e depois não teria cota para disparar. (c) é a rajada por outro nome:
100 mil `usync` numa madrugada é exatamente o comportamento de ferramenta descartável. (b)
custa um eixo a mais de contagem.

*Recomendação:* **(b)**. Cota separada, com os mesmos três tetos (hora, dia, intervalo mínimo)
e **compartilhando a rampa de aquecimento** do envio frio — instância nova é nova para tudo, e
duplicar a rampa só criaria dois relógios para o mesmo número. Na implementação isso é o mesmo
`evaluateColdSend`, chamado com outro conjunto de limites e outro recorte do mesmo livro-caixa:
`channel_cold_sends` ganha `kind ('send' | 'check')`, com `DEFAULT 'send'`, e
`loadColdSendUsage` passa a filtrar por `kind`. Linhas antigas continuam contando exatamente
como hoje.

*Impacto se mudarmos depois:* baixo — é um filtro e um conjunto de chaves. Decidir agora evita
reescrever o R6.

### D-2 — Onde a checagem escreve o veredito?

*Opções:* (a) `contacts.whatsapp_status`, tornando a Evolution a **terceira** fonte do campo
(as outras são o erro 131026 da Meta e duas falhas consecutivas — SPEC 044 §6.4); (b) campo
novo, `whatsapp_qr_status`.

*Trade-off:* (b) evita conflito de fontes, mas cria dois campos que significam quase a mesma
coisa — e toda tela, filtro de audiência e relatório passa a ter que consultar os dois, o que
garante que algum lugar vai esquecer um deles. (a) mantém uma verdade só, ao custo de precisar
de uma regra de precedência escrita.

*Recomendação:* **(a), com precedência explícita e proveniência registrada.** Regras:

1. Motivos novos: `qr_check` (a Evolution respondeu `IsInWhatsapp: false`) e
   `qr_check_conflict` (registrado só em log, nunca sobrescreve — ver 3).
2. **A Evolution nunca reverte um `invalid` de outra fonte.** `meta_error` é a Meta afirmando o
   fato, e `manual` é uma pessoa decidindo; um `IsInWhatsapp: true` não desfaz nenhum dos dois.
   Tecnicamente: o UPDATE de "voltar a válido" nunca existe no caminho da checagem — só
   `markWhatsappValid` (ação de tela) faz isso, como hoje.
3. **Discordância é sinal, não decisão.** Meta disse inválido e a Evolution diz que existe? O
   número existe no WhatsApp mas não recebe mensagem de negócio daquele remetente — os dois
   fatos são compatíveis. Gravamos a discordância em `whatsapp_check_note` e deixamos o status
   como está.
4. Proveniência em colunas próprias: `whatsapp_checked_at` e `whatsapp_checked_channel_id`.
   Sem elas ninguém consegue responder "quando, e por qual instância" seis meses depois.

### D-3 — Contato captado (R5) entra na base ou numa triagem?

Decisão **de produto**, fechada no PRD 068 §3: **triagem** (`evolution_harvested_contacts`),
promoção explícita por uma pessoa. `opt_in_status = 'unknown'` na promoção — nunca `opted_in`,
porque ninguém consentiu — e `created_via = 'harvest'`, valor novo no CHECK de
`contacts_created_via_check`, para que uma audiência possa excluir contato captado por origem
sem depender de etiqueta manual.

Duas consequências técnicas que a triagem resolve de graça: a quota de contatos (trigger da
067) é consumida **na promoção**, com um humano na tela para ver o erro, e não às 3 da manhã
num cron; e a agenda pessoal do dono do número não entra em audiência de marketing por
omissão.

### D-4 — O estado "Em espera — disparo parcial" do R6

*Opções:* (a) valor novo no CHECK de `broadcasts.status`; (b) par "status + flag".

*Trade-off:* (b) parece menos invasivo, mas todo leitor de campanha hoje decide pelo `status`
(badge, filtro de lista, o claim do cron, a coluna do relatório). Uma flag obriga cada um deles
a aprender uma segunda variável, e o primeiro que esquecer vai renderizar "Enviando" para
sempre numa campanha parada.

*Recomendação:* **(a), valor `awaiting_check`**, seguindo exatamente o padrão idempotente que a
migração 065 usou para introduzir `'streaming'` (§1.2): localizar o CHECK anterior **por
conteúdo** — porque o da 001 era anônimo por posição e o da 065 tem nome próprio —, derrubá-lo
e recriar nomeado (`broadcasts_status_awaiting_check_check`). O DO block precisa reconhecer as
duas formas anteriores; a §5.6 traz o SQL.

### D-5 (R7) — Limites de segurança viram `QUOTA_KEYS` ou tabela própria?

*Opções:* (a) chaves novas em `QUOTA_KEYS`, reusando `plan_limit()` e o campo
`account_plans.limit_overrides`; (b) tabela própria por conta × instância.

*Trade-off:* a objeção conceitual a (a) é justa — quota é "quanto você pode ter", cold-send é
"com que taxa você pode agir". Mas a objeção que decide é outra: `account_plans` é **por
conta**, e o R1 já pede configuração **por instância** (o switch e o teto de captação). Nenhuma
das duas opções, sozinha, cobre os dois níveis. E (b) sozinha jogaria fora `plan_limit()`, o
catálogo de planos e a rota `PUT /api/admin/accounts/[accountId]/plan` que **já valida
`limitOverrides` contra `QUOTA_KEYS`**.

*Recomendação:* **as duas coisas, em níveis distintos, com um resolvedor só.**

- **Nível 1a — por conta:** chaves novas em `QUOTA_KEYS`, em `plans.limits` e em
  `account_plans.limit_overrides`. É onde a política **comercial** mora, e é o que aparece no
  catálogo de planos.
- **Nível 1b — por instância:** `evolution_instances.limit_overrides JSONB` — coluna nova na
  linha que **já existe**, é 1:1 com o canal e já cascateia na exclusão. Uma tabela nova aqui
  estaria vazia em 95% das contas.
- Um módulo (`src/lib/limits/`) resolve os quatro níveis. **Nenhum call site lê `process.env`
  para decidir limite** — essa é a regra que impede o segundo resolvedor de existir.

### D-6 (R7) — A colisão do "vazio": `NULL` = ilimitado × `0` = bloqueia

`plan_limit()` devolve `INTEGER` e documenta `NULL` como **ilimitado** (067, §"plan_limit").
`readColdSendLimits` trata **ausente** como padrão e **`0`** como bloqueio. Três estados
(herda / valor próprio / bloqueia) não cabem em dois.

*Recomendação:* **reinterpretar `NULL` por classe de chave, e assumir que limite de segurança
não tem "ilimitado".**

| Estado no banco             | Chave de **quota** (`contacts`, `members_*`) | Chave de **segurança** (`evolution_*`) |
| --------------------------- | -------------------------------------------- | --------------------------------------- |
| chave ausente → `NULL`      | ilimitado                                    | **não configurado aqui → desce um nível na cascata** |
| `0`                         | bloqueado                                    | bloqueado (mesma semântica de hoje)     |
| `n > 0`                     | teto                                         | teto                                    |
| "ilimitado"                 | existe                                       | **não existe, de propósito**            |

Isto não muda `plan_limit()` — muda quem lê. O resolvedor sabe a classe da chave pelo registro
(§4.1) e nunca traduz `NULL` como "sem limite" para chave de segurança. A ausência de
"ilimitado" é a decisão de fundo: um teto de segurança que pode ser desligado por engano deixa
de ser um teto.

*E se o operador digitar `0` esperando "sem limite"?* Não pode acontecer pela tela: a chave de
segurança é editada por um controle de **três estados explícitos** — "Usar o padrão" / "Valor
próprio" / "Bloquear este eixo" — em vez de um campo numérico vazio. Um `0` só chega ao banco
por `curl` direto na rota de plano; nesse caso ele significa bloqueio, o mesmo que significa
hoje no `.env`, e a tela mostra o rótulo "Bloqueado" em vermelho — que é a leitura correta e
imediatamente visível.

### D-7 (R7) — Teto duro que o override por conta não ultrapassa

*Recomendação:* **sim, por eixo, e clampando no resolvedor — não só na tela.**

Um `perDay` de 5.000 salvo pelo painel não fura política comercial: fura o número do cliente.
Como a rota `PUT .../plan` já aceita `limitOverrides` hoje e é alcançável por `curl`, validar
só na UI não é validação.

- Novas variáveis `EVOLUTION_*_MAX` (e `*_MIN` nos eixos em que **menor** é mais perigoso —
  intervalo mínimo, dias de aquecimento), com padrão de código (§4.2).
- O teto duro clampa os **níveis 1a e 1b** (conta e instância). **Não clampa o `.env`**: o
  nível 2 é a palavra do próprio operador do deployment, que é quem define o teto — clampar o
  operador contra ele mesmo é ruído. Se o `.env` estiver acima do teto, o resolvedor emite
  `console.warn` uma vez por processo, porque isso significa teto mal configurado.
- A rota de escrita recusa (`400`) valor acima do teto, com a mensagem em inglês
  (`/api/**` é para integração) e a tela traduz.
- A tela mostra o teto ao lado do campo, sempre — o operador não deve descobrir o limite ao
  errar.

### D-8 (R7) — Nível 1 é por conta ou por instância?

*Recomendação:* **os dois, nesta ordem: instância → conta → `.env` → código.**

Duas instâncias da mesma conta têm maturidades diferentes: uma com dois anos de uso aguenta
150/dia; a criada ontem não aguenta 30. Resolver só por conta obriga a tratar a mais frágil
como a mais forte (perigoso) ou o contrário (inútil).

O que cada tela mostra **sobre o nível acima** — e este ponto é o que evita o bug clássico de
override invisível:

- **Cartão da instância** (Configurações): quando não há valor próprio, mostra o valor herdado
  e de onde ele veio — "Herdando da conta: 60/dia" ou "Herdando do padrão do sistema: 60/dia".
- **Painel do proprietário** (`/admin/accounts/[accountId]`): ao lado de cada limite da conta,
  um aviso quando alguma instância tem valor próprio — "2 instâncias com valor próprio; a
  alteração aqui não afeta essas duas". Sem isso, o operador muda o número, nada acontece, e
  ele conclui que o produto está quebrado.

### D-9 — Quem configura o quê

O R1 põe os switches e o teto de captação na tela do **cliente** (Configurações), mas limite é
alavanca de segurança e comercial.

*Recomendação:* separação por natureza da decisão.

| Configuração                             | Quem                      | Onde                              |
| ---------------------------------------- | ------------------------- | --------------------------------- |
| Switch "usar para checagem"              | admin da conta            | Configurações → WhatsApp QRCode   |
| Switch "permitir captar contatos"        | admin da conta            | idem                              |
| Teto de captação **desta instância**     | admin da conta, **clampado** pelo teto da conta | idem            |
| Tetos de checagem e envio frio da conta  | **proprietário**          | `/admin/accounts/[accountId]`     |
| Tetos por instância                      | **proprietário**          | idem, dentro do cartão da conta   |

O cliente escolhe se corre o risco e com que volume dentro do que comprou; o proprietário
define o que foi comprado e o que a VPS aguenta.

### D-10 — O canal que checa não é o canal que dispara

Uma campanha pode ser Cloud API (SPEC 065 já deixa escolher o número) e ainda assim querer a
checagem, que só o canal QR sabe fazer.

*Recomendação:* **desacoplar**. `broadcasts.check_channel_id` é independente de
`broadcasts.channel_id`. Se a conta tem uma única instância validadora, ela é preenchida
automaticamente; com mais de uma, o passo de audiência pergunta. Sem nenhuma instância
validadora ligada, a opção de checagem aparece **desabilitada com o motivo**, nunca escondida —
a armadilha "não dispara e não avisa" do AGENTS.md aplicada à UI.

### D-11 — Disparo parcial e a janela de envio

O R6 retoma a campanha a cada ciclo de cota. Nada garante que o ciclo caia dentro da janela de
horário permitida (`send-window.ts`).

*Recomendação:* a retomada **reusa `isWithinSendWindow`**, exatamente como
`/api/broadcasts/cron` já faz. Fora da janela, a campanha continua em `awaiting_check` e o
motivo vai para a trilha de auditoria (`logBroadcastAudit`). Disparar às 23h para "aproveitar a
cota" é o oposto do que a feature existe para proteger.

*Corolário:* variante B de teste A/B **nunca** é varrida pelo cron de retomada, pela mesma
razão do §6.6 da SPEC 044 (senão a audiência inteira é disparada duas vezes).

### D-12 — Onde mora o avatar, e por que não em `contacts.avatar_url`

`contacts.avatar_url` já existe e é renderizada **direto como `src`** no inbox
(`conversation-list.tsx:668`). O bucket `avatars` (migração 008) é `public = TRUE` — correto
para a foto que o próprio usuário sobe de si mesmo, **errado** para a foto de perfil de um
terceiro que nunca falou com o CRM.

*Recomendação:* **bucket privado novo `contact-avatars`** (mesmo regime de `chat-media` desde a
migração 040: privado + URL assinada) e **coluna nova `contacts.avatar_path`**, não reuso de
`avatar_url`.

Duas colunas porque elas não são a mesma coisa: `avatar_url` é uma URL pronta (o que vier de
fora), `avatar_path` é um caminho dentro de um bucket privado que precisa ser assinado antes de
virar `src`. Sobrescrever `avatar_url` com um caminho quebraria silenciosamente os três lugares
que já a renderizam. A UI passa a preferir `avatar_path` (assinado, via o `use-media-src` que
já existe) e cai em `avatar_url`, e só depois nas iniciais.

### D-13 — Quando o avatar é buscado de novo

Foto de perfil muda. Buscar a cada checagem transformaria "reprocessar a lista" numa segunda
rajada de requisições.

*Recomendação:* buscar quando **ausente** ou quando `avatar_fetched_at` for mais velho que
`EVOLUTION_AVATAR_TTL_DAYS` (padrão 30). O download do avatar **não** consome a cota de
checagem (é um segundo round-trip da mesma consulta já autorizada), mas está sujeito ao mesmo
intervalo mínimo — ele entra no mesmo lote, sequencialmente.

### D-14 — Pendências de verificação contra a API real

> ✅ **Verificado em 2026-09-03**, F3, contra `go.local.ia.br`, instância `bruno` (conectada,
> número real do mantenedor, autorização explícita para o teste). Ver `src/lib/evolution/user.ts`
> para o parser resultante. 5 dos 6 itens foram medidos; o 6º (instância desconectada)
> permanece com a postura defensiva original — desconectar uma sessão real em uso para testar
> não é um teste que se faça sem avisar quem depende dela.

| # | Pendência | Resultado medido |
| - | --------- | ----------------- |
| 1 | Escopo de `GET /user/contacts` | **Por TOKEN, confirmado.** Chamado com o token da instância `bruno` (não a chave global), devolveu exatamente a agenda daquele número (1144 contatos). **Desbloqueia a F7.** |
| 2 | Paginação de `GET /user/contacts` | **Não pagina.** 1144 contatos em ~146 KB, uma resposta só, ~150 ms — rápido porque lê o cache local sincronizado (ao contrário de `/user/info`/`/user/avatar`, que parecem ir à rede). `harvest.ts` (F7) corta em `harvest_per_run` do lado do CRM mesmo assim — uma agenda muito maior pode não ser tão rápida. |
| 3 | Forma de `/user/check` | **Nem objeto plano nem array cru** — as duas hipóteses de `contact-identity.ts`. A forma real é `{"data":{"Users":[{Query,IsInWhatsapp,JID,RemoteJID,LID,VerifiedName}]},"message":"success"}`. 🔴 **Isto expôs um bug de produção**: o parser antigo nunca reconhecia essa forma e sempre devolvia `null` — o backfill de LID da SPEC 048 §6.4 nunca funcionou de verdade. Corrigido no mesmo commit (`user.ts` + `contact-identity.ts` reescritos, teste de regressão em `contact-identity.test.ts`). Adicionalmente medido: a ORDEM da resposta não bate com a do pedido (um lote de 3 números voltou com o 2º e 3º trocados) — todo pareamento casa por `Query`/`JID`, nunca por índice (`matchCheckResult`). |
| 4 | Dimensão/mimetype de `/user/avatar` | **Não confirmado.** As duas tentativas de teste (contra o PRÓPRIO número da instância) ficaram penduradas ~75 s e devolveram `500 {"error":"info query timed out"}` — ver item 6 abaixo. Postura original mantida: detectar o tipo pelos BYTES, nunca confiar em campo declarado. |
| 5 | Lote de `/user/check` e `/user/info` | `/user/check` **aceita lote confirmado** — testado com 3 números numa chamada só (`{"number":["a","b","c"]}`), respondeu em ~1 s. `/user/info` não foi confirmado com sucesso (item 6), mas a referência documenta o mesmo schema de request (`CheckUser`) — o parser assume lote também, sem confirmação de sucesso. |
| 6 | Instância desconectada | **Não testado** (postura original mantida — não se derruba uma sessão real em uso só para medir isto). Mas apareceu um achado não previsto: **autoconsulta em `/user/info` e `/user/avatar` trava.** As duas chamadas contra o próprio número da instância (`bruno` perguntando sobre `bruno`) ficaram penduradas por **~75 segundos** antes do servidor Evolution desistir com `500 {"error":"failed to send usync query: info query timed out"}` (`/user/info`) e `500 {"error":"info query timed out"}` (`/user/avatar`). Provavelmente é autoconsulta especificamente (o protocolo do WhatsApp não sincroniza "quem eu sou" do mesmo jeito que sincroniza um terceiro) — não foi possível confirmar contra um contato de verdade sem gastar uma consulta que o teste não precisava fazer (§6: checagem tem custo de reputação). **Consequência de design:** o timeout genérico de conectividade (`EVOLUTION_REQUEST_TIMEOUT_MS`, 15 s) abortaria a chamada ANTES do próprio servidor desistir — sempre `channel_unavailable`, nunca a resposta real. Criada uma quinta variável, `EVOLUTION_INFO_AVATAR_TIMEOUT_MS` (padrão 20 s, `src/lib/limits/registry.ts`), como aposta deliberada no meio-termo: longa o bastante para uma consulta real de terceiro pela rede, curta o bastante para não travar o lote inteiro do cron atrás de um contato ruim. Está registrada como aposta, não como medição. |

**Achado extra, fora do escopo de qualquer item numerado:** os testes usaram a mesma sessão
`bruno` autorizada para D-14; nenhum outro número foi consultado além do próprio e de dois
inexistentes (`5511999999999`, `5511900000000`, usados só para confirmar `IsInWhatsapp: false`).
`GET /user/contacts` devolveu dado pessoal real (nomes, telefones, LIDs de 1144 contatos) — usado
só para inspecionar a FORMA da resposta (contagem de campos preenchidos, sufixos de `Jid`); o
arquivo com o conteúdo bruto foi apagado do scratchpad ao final da sessão, nunca commitado.

---

## 3. Inventário de limites (R7)

Este é o critério de "pronto" do R7, como a §4 da SPEC 059 é para as quotas: **um limite que
não está nesta tabela é um limite que continua escondido no código.**

Legenda das colunas: *nível 1a* = chave em `QUOTA_KEYS` (conta); *nível 1b* = aceito em
`evolution_instances.limit_overrides`; *nível 2* = variável de ambiente; *nível 3* = padrão de
código.

### 3.1 Limites que já existem hoje

| # | Limite | O que protege | Nível 1a (conta) | 1b (instância) | Nível 2 (`.env`) | Nível 3 (código) | Lido hoje em |
| - | ------ | ------------- | ---------------- | -------------- | ---------------- | ---------------- | ------------ |
| 1 | Instâncias por conta | Recurso da conta (comercial) | `channels_whatsapp_qr` *(já existe)* | — | `EVOLUTION_MAX_INSTANCES_PER_ACCOUNT` | `3` | `evolution/limits.ts`, `evolution/config.ts:59` |
| 2 | Instâncias no deployment | A VPS (sessões whatsmeow) | **nenhuma, de propósito** | — | `EVOLUTION_MAX_INSTANCES_TOTAL` | `20` | `evolution/limits.ts` |
| 3 | Silêncio p/ contar como frio | Definição de "frio" | `evolution_cold_send_silence_hours` | ✓ | `EVOLUTION_COLD_SEND_SILENCE_HOURS` | `24` | `cold-send-limit.ts` |
| 4 | Envio frio por hora | **A rajada** — o eixo que mais evita banimento | `evolution_cold_send_per_hour` | ✓ | `EVOLUTION_COLD_SEND_PER_HOUR` | `12` | `cold-send-limit.ts` |
| 5 | Envio frio por 24 h | Volume diário | `evolution_cold_send_per_day` | ✓ | `EVOLUTION_COLD_SEND_PER_DAY` | `60` | `cold-send-limit.ts` |
| 6 | Intervalo mínimo entre frios | A metralhadora dentro da hora | `evolution_cold_send_min_interval_seconds` | ✓ | `EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS` | `45` | `cold-send-limit.ts` |
| 7 | Dias de aquecimento | Número novo com volume de veterano | `evolution_cold_send_warmup_days` | ✓ | `EVOLUTION_COLD_SEND_WARMUP_DAYS` | `14` | `cold-send-limit.ts` |
| 8 | Timeout de requisição | O pool de requisições da app | **não configurável por conta** | — | `EVOLUTION_REQUEST_TIMEOUT_MS` | `15000` | `evolution/config.ts` |
| 9 | Timeout de mídia | idem, com folga p/ upload | **não configurável por conta** | — | `EVOLUTION_MEDIA_REQUEST_TIMEOUT_MS` | `60000` | `evolution/config.ts` |

> **Por que 8 e 9 não têm nível 1.** O R7 pede uma cascata só, e eles passam por ela — mas
> declarados `accountConfigurable: false`. Timeout não é política que se venda; expor como
> override entrega ao operador uma forma de pendurar o pool de requisições de um deployment
> inteiro sem que isso beneficie nenhum cliente. Um mecanismo, uma exceção documentada no
> registro, e não duas leituras de `.env`.

### 3.2 Limites novos desta feature

| #  | Limite | O que protege | Nível 1a (conta) | 1b | Nível 2 (`.env`) | Nível 3 (código) | Lido em (novo) |
| -- | ------ | ------------- | ---------------- | -- | ---------------- | ---------------- | -------------- |
| 10 | Checagens por hora | Rajada de `usync` | `evolution_check_per_hour` | ✓ | `EVOLUTION_CHECK_PER_HOUR` | `60` | `lib/evolution/check-limits.ts` |
| 11 | Checagens por 24 h | Volume diário de consulta | `evolution_check_per_day` | ✓ | `EVOLUTION_CHECK_PER_DAY` | `300` | idem |
| 12 | Intervalo mínimo entre checagens | Cadência humana | `evolution_check_min_interval_seconds` | ✓ | `EVOLUTION_CHECK_MIN_INTERVAL_SECONDS` | `5` | idem |
| 13 | Checagens por execução do cron | Duração da rota (`maxDuration`) | `evolution_check_batch_size` | ✓ | `EVOLUTION_CHECK_BATCH_SIZE` | `25` | `lib/evolution/check-queue.ts` |
| 14 | Tentativas por item da fila | Item envenenado travando a fila | **não** | — | `EVOLUTION_CHECK_MAX_ATTEMPTS` | `3` | idem |
| 15 | Validade do item na fila | Fila crescendo para sempre | **não** | — | `EVOLUTION_CHECK_QUEUE_TTL_HOURS` | `168` | idem |
| 16 | Captação por execução | Lote noturno (R5) | `evolution_harvest_per_run` | ✓ | `EVOLUTION_HARVEST_PER_RUN` | `50` | `lib/evolution/harvest.ts` |
| 17 | Teto de captação por instância | R1(c) — quanto essa instância pode trazer | `evolution_harvest_max_per_instance` | ✓ *(é o campo do R1(c))* | `EVOLUTION_HARVEST_MAX_PER_INSTANCE` | `500` | idem |
| 18 | Hora de início da janela | Horário de baixa atividade | **não** | — | `EVOLUTION_HARVEST_WINDOW_START_HOUR` | `0` | `lib/evolution/harvest-window.ts` |
| 19 | Hora de fim da janela (exclusiva) | idem | **não** | — | `EVOLUTION_HARVEST_WINDOW_END_HOUR` | `6` | idem |
| 20 | Fuso da janela | "00–06" só significa algo com fuso | **não** | — | `EVOLUTION_HARVEST_TIMEZONE` | `America/Sao_Paulo` | idem |
| 21 | Validade do avatar | Re-download desnecessário (D-13) | **não** | — | `EVOLUTION_AVATAR_TTL_DAYS` | `30` | `lib/evolution/avatar.ts` |
| 22 | Tamanho máximo do avatar | Bucket e banda | **não** | — | `EVOLUTION_AVATAR_MAX_BYTES` | `1048576` | idem |
| 23 | Timeout de `/user/info`/`/user/avatar` | 🔴 Achado da F3, não previsto aqui originalmente: as duas endpoints medem ~75 s até o servidor Evolution desistir sozinho (D-14 #6) — o timeout genérico de conectividade (15 s) abortaria antes disso, e usar os 75 s medidos travaria o lote inteiro atrás de um contato ruim | **não** | — | `EVOLUTION_INFO_AVATAR_TIMEOUT_MS` | `20000` | `lib/evolution/user.ts`, `check-run.ts`, `avatar.ts` |

### 3.3 Tetos duros do deployment (D-7)

Clampam **níveis 1a e 1b**. Não clampam o `.env`.

| Eixo | Variável | Padrão de código | Sentido |
| ---- | -------- | ---------------- | ------- |
| Envio frio / hora | `EVOLUTION_COLD_SEND_PER_HOUR_MAX` | `40` | teto |
| Envio frio / dia | `EVOLUTION_COLD_SEND_PER_DAY_MAX` | `250` | teto |
| Intervalo mínimo | `EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS_MIN` | `10` | **piso** (menor = mais perigoso) |
| Aquecimento | `EVOLUTION_COLD_SEND_WARMUP_DAYS_MIN` | `0` | piso (0 = permite desligar, como hoje) |
| Checagem / hora | `EVOLUTION_CHECK_PER_HOUR_MAX` | `200` | teto |
| Checagem / dia | `EVOLUTION_CHECK_PER_DAY_MAX` | `2000` | teto |
| Intervalo de checagem | `EVOLUTION_CHECK_MIN_INTERVAL_SECONDS_MIN` | `1` | piso |
| Lote de checagem | `EVOLUTION_CHECK_BATCH_SIZE_MAX` | `100` | teto |
| Captação / execução | `EVOLUTION_HARVEST_PER_RUN_MAX` | `200` | teto |
| Captação / instância | `EVOLUTION_HARVEST_MAX_PER_INSTANCE_MAX` | `2000` | teto |

### 3.4 O desenho da cascata

```
                       ┌───────────────────────────────────────────────┐
resolveLimit(key, {    │ 1b  evolution_instances.limit_overrides->>key │  instância
  accountId,           ├───────────────────────────────────────────────┤
  channelId            │ 1a  plan_limit(account_id, key)               │  conta (plano + override)
})                     ├───────────────────────────────────────────────┤
                       │  2  process.env[entry.envVar]                 │  deployment
                       ├───────────────────────────────────────────────┤
                       │  3  entry.codeDefault                         │  sempre responde
                       └───────────────────────────────────────────────┘
                                        ↓
                              clamp(1a/1b) contra o teto duro
                                        ↓
                    { value, level: 'instance'|'account'|'env'|'code',
                      clamped: boolean, hardCap: number|null }
```

Regras invioláveis, e o teste que prende cada uma (§11):

1. **O nível 3 sempre responde.** Nunca existe "sem limite" por ausência de configuração.
2. **Valor inválido cai um nível, nunca vira ausência de limite.** Não inteiro, negativo, ou
   JSONB torto → `console.warn` e desce. É a mesma postura de `readColdSendLimits` hoje e de
   `retention/global-defaults.ts` (que é o precedente mais próximo, e cujo `parseConsoleDimension`
   vale reler antes de escrever este parser).
3. **`0` é valor, não ausência** — exceto em `silence_hours`, onde `0` cai no padrão, como hoje.
4. **O resolvedor devolve o nível que venceu.** A UI precisa dizer "herdando da conta"; sem esse
   campo, ela adivinha.
5. **Nenhum call site lê `process.env` para decidir limite.** Um `grep -rn "process.env.EVOLUTION_"
   src/` fora de `src/lib/limits/` e `src/lib/evolution/config.ts` (que só resolve conectividade,
   não limite) volta vazio. Este grep é um item do "Pronto quando" da F2.

---

## 4. Módulos novos em `src/lib/`

### 4.1 `src/lib/limits/registry.ts` — o catálogo

Uma constante por limite, com tudo o que a cascata precisa saber. É a fonte de verdade da
tabela do §3 — e é ela que faz "adicionar um limite" ser uma linha, e não uma caçada.

```ts
export interface LimitEntry {
  key: string;                       // 'evolution_cold_send_per_day'
  envVar: string;                    // 'EVOLUTION_COLD_SEND_PER_DAY'
  codeDefault: number;
  accountConfigurable: boolean;      // vira chave em QUOTA_KEYS
  instanceConfigurable: boolean;
  hardCap?: { envVar: string; codeDefault: number; kind: 'max' | 'min' };
  allowZero: boolean;                // ver correção abaixo — NÃO é só silence_hours
}
```

**Decide:** nada. É dado. A separação entre catálogo e resolvedor é o que permite testar o
resolvedor com entradas sintéticas.

**Correções feitas na F2**, contra o código real:

- **`allowZero: false` não é só `silence_hours`.** Vale também para os quatro valores que
  `evolution/config.ts` lê (`channels_whatsapp_qr`, `evolution_max_instances_total` e os dois
  timeouts): o `positiveInt` daquele módulo sempre descartou `<= 0`, e `config.test.ts` fixa
  isso desde a SPEC 048 (`it.each(['abc','-1','0','3.5',''])`). Um timeout de 0 ms ou um teto de
  0 instâncias no deployment é erro de digitação, não intenção — e tratar `0` como "bloquear"
  ali mudaria comportamento existente, que é exatamente o que o R7 promete não fazer.
- **A entrada nº 20 da §3.2 (`EVOLUTION_HARVEST_TIMEZONE`) não é um número.** O `LimitEntry` da
  §4.1 pressupõe `codeDefault: number`. O catálogo mantém as 22 linhas — tirar o fuso de lá
  deixaria metade da regra da janela fora da lista que existe para não haver limite escondido —
  mas com um discriminador `valueType: 'integer' | 'timezone'`, e um
  `resolveTimeZoneValue` irmão do `resolveLimitValue`. Fuso desconhecido pelo runtime cai no
  padrão em vez de fazer `Intl` lançar dentro do cron.
- **As chaves de segurança NÃO entram na tela de uso do cliente.** A §15.3 já pedia isso, mas
  `QUOTA_KEYS` é iterada com `.map()` em três lugares (`plans/account-plan.ts`,
  `components/plan/plan-catalog.tsx`, `admin/plans/page.tsx`): acrescentar onze chaves ali
  faria surgir onze barras de uso e onze linhas de catálogo, com `tQuota(key)` sem tradução.
  `plans/types.ts` passou a separar `USAGE_QUOTA_KEYS` (as 7 de uso, que as telas iteram) de
  `SAFETY_QUOTA_KEYS` (as 11 novas); `QUOTA_KEYS` é a união, e continua sendo o contrato que
  `validateCatalog`/`validateOverrides` e a rota de plano conferem. Sem isso a F2 mudaria a
  UI, e o "nenhuma UI nova" dela seria falso.

### 4.2 `src/lib/limits/resolve.ts` — módulo puro

`resolveLimitValue(entry, { instance, account, env })` → `{ value, level, clamped, hardCap }`.
Recebe os valores já lidos, não toca banco nem `process.env` diretamente (o `env` é parâmetro,
como em `readColdSendLimits` hoje).

**Decide:** qual nível vence, o que é valor inválido, e o clamp.

### 4.3 `src/lib/limits/load.ts` — a metade impura

`loadEvolutionLimits(db, { accountId, channelId })` lê `account_effective_limits(account_id)`
(uma chamada, não uma por chave) e `evolution_instances.limit_overrides`, e devolve o conjunto
inteiro já resolvido. Memoizado por `(accountId, channelId)` dentro da requisição — o cron
resolve **uma vez por instância por ciclo**, não uma vez por contato.

**Correção da F2:** o cache é um objeto **explícito do chamador** (`createLimitsCache()`,
passado adiante), e não um `Map` no escopo do módulo. Um cache de módulo num servidor Next de
vida longa serviria um limite VELHO por tempo indeterminado depois de o proprietário mudar o
plano: ele mexeria no painel, nada aconteceria, e concluiria que o produto está quebrado — o bug
que o D-8 existe para evitar, reinventado como cache. A vida do cache é a vida do ciclo.

**Aviso operacional (medido no `vn`):** `account_effective_limits()` devolve `'{}'` inteiro
quando `platform_settings.quotas_enforced` é `FALSE` — que é o estado atual do `vn`. Logo, o
**nível 1a inteiro fica inerte** enquanto as quotas estiverem desligadas, e a cascata resolve por
instância, `.env` e código. É o comportamento correto (e o que preserva o de hoje), mas quem
for vender teto por plano precisa ligar as quotas primeiro, senão o número comprado não vale — e
não haverá erro nenhum dizendo isso.

### 4.4 `src/lib/channels/cold-send-limit.ts` — o que muda, e o que não

Não muda: `isColdSend`, `effectiveDailyLimit`, `evaluateColdSend`, `describeDenial`,
`COLD_SEND_DEFAULTS`. São o cálculo, e o cálculo está certo.

Muda: `readColdSendLimits(env)` passa a ser implementada **sobre o registro** (níveis 2 e 3), e
ganha uma irmã `resolveColdSendLimits(db, { accountId, channelId })` que percorre a cascata
inteira. `cold-send-wiring.checkColdSend` passa a chamar a segunda. A primeira continua
exportada e testada — é o que prova a compatibilidade.

### 4.5 `src/lib/evolution/check-limits.ts`

Os mesmos três eixos, para checagem. Reusa `evaluateColdSend` (que é genérico o suficiente:
recebe limites e uso) com `ColdSendLimits` montado a partir das chaves `evolution_check_*` e
**`warmupDays` vindo do eixo de envio frio** (D-1 — uma rampa só por instância).

### 4.6 `src/lib/evolution/check-queue.ts` — módulo puro

`planCheckBatch({ pending, decision, batchSize, now })` → quais itens saem agora, quantos
ficam, e por quê. **Decide:** o corte do lote pelo menor entre `batchSize`, `remainingToday`
e `remainingThisHour`; a ordem (FIFO por `created_at`, mas item de campanha antes de item de
importação — a campanha tem alguém esperando); o que fazer com item que estourou
`max_attempts` (vira `failed`) ou `ttl` (vira `expired`).

### 4.7 `src/lib/evolution/check-run.ts` — a execução

Recebe o lote, chama `/user/check` por item, grava `channel_cold_sends (kind='check')`
**depois** de cada chamada bem-sucedida (mesmo princípio do `recordColdSend`: contar antes
transformaria falha de rede em cota consumida), aplica o veredito de D-2, e — só quando
`IsInWhatsapp` e o avatar está ausente/vencido (D-13) — chama `/user/avatar` e sobe o resultado.

> ✅ **Correção da F5, pós-D-14:** o texto original também previa `/user/info` no meio dessa
> cadeia. Removido: a F3 mediu que `/user/info` pode ficar pendurado por ~75 s (D-14 #6,
> provavelmente autoconsulta), e os únicos campos que ele traria — `VerifiedName` (já vem de
> `/user/check`), `Status` (PRD 068 §5 exclui recado/status da UI) e `PictureID` (sem coluna
> para comparar) — não têm onde aterrissar no schema desta SPEC. Chamar um endpoint lento por um
> valor que não é persistido gastaria orçamento do lote (e uma consulta a mais de reputação) por
> nada. `fetchWhatsappUserInfo` existe em `user.ts`, testado, para o dia em que essa lacuna for
> fechada.

Sequencial item a item, com `sleep(min_interval_seconds)` ENTRE itens (não depois do último) — é
o que faz a cota de intervalo mínimo valer de verdade dentro de um único ciclo do cron, e não só
entre ciclos. Um `deadline` absoluto (calculado pelo chamador a partir do orçamento da rota)
impede que o lote comece a processar um item novo sem tempo de terminar; itens não alcançados
continuam `pending`, intocados, para o próximo ciclo.

`channel_unavailable` não consome tentativa: o item é revertido para `pending` sem incrementar
`attempts`, e o restante do lote **desta conta** é abortado no ato — os itens seguintes nem
chegam a ser reivindicados (claim por `UPDATE … WHERE status='pending'`, mesmo padrão de
`/api/broadcasts/cron`). Qualquer outra falha incrementa `attempts` e devolve o item a
`pending`; é `check-queue.ts`, no ciclo seguinte, quem decide se isso já estourou `max_attempts`.

### 4.8 `src/lib/evolution/avatar.ts`

Base64 → `Buffer` → detecção de tipo **pelos bytes** (D-14 #4) → limite de tamanho → upload no
bucket `contact-avatars` com caminho `account-<uuid>/contact-<uuid>.<ext>` → grava
`avatar_path` e `avatar_fetched_at`. **Decide:** se vale re-baixar (TTL), se o tipo é aceito,
e o caminho — que é o que a RLS do bucket casa.

### 4.9 `src/lib/evolution/harvest.ts` + `harvest-window.ts`

`harvest-window.ts` é puro: `isWithinHarvestWindow(now, { startHour, endHour, timeZone })`.
Existe separado porque a janela precisa ser verificada **no código**, não só no `cron`: um
agendamento mal copiado que rode de hora em hora o dia inteiro não pode virar captação o dia
inteiro.

`harvest.ts` decide o lote: quantos faltam para o teto da instância, quantos cabem na execução,
quais `Jid` já estão na triagem ou já viraram contato (dedupe), e o cursor.

### 4.10 `src/lib/broadcasts/partial-send.ts`

**Decide** a máquina de estados do R6: dada uma campanha em `awaiting_check`, o resultado da
checagem e a decisão de cota, ela (a) dispara para os validados, (b) volta a `awaiting_check`,
(c) conclui em `sent`, (d) adia por janela de horário (D-11), ou (e) **falha** quando nada foi
checado e nada saiu (§14). Puro, testável sem banco — é onde o R6 pode dar errado de forma
silenciosa, e por isso é onde os testes precisam morar.

`PartialSendState` (a entrada da máquina) tem seis contadores, todos derivados por consulta no
banco pela metade impura (`sweepAwaitingCheck`, em `/api/broadcasts/cron`) — nada é lido de um
campo que alguém precise lembrar de manter:

- `pendingChecks` — itens `pending` + `in_progress` da fila desta campanha.
- `readyToDispatch` — checados, com número válido, e ainda sem linha de destinatário: o lote de
  agora.
- `readyRemaining` — validados que ficaram de fora do lote **por falta de cota de envio** (o
  achado nº 3 da F8; sem ele a campanha encerraria como `sent` com parte da audiência nunca
  enviada).
- `unresolvedChecks` — itens `skipped`/`failed`/`expired` (§14).
- `everDispatched` — linhas de `broadcast_recipients` que a campanha já tem.
- `withinSendWindow` + `windowOverride` — a MESMA regra de janela do cron comum (D-11).

---

## 5. Modelo de dados — migração 078

> ✅ **Aplicada no `vn` em 2026-09-03** (F1), com autorização explícita do mantenedor, e rodada
> duas vezes para provar idempotência. **O `rs` NÃO recebeu** — os dois estavam sincronizados
> até a 077 e a partir daqui divergem em uma migração.

> ⚠️ Existem dois projetos Supabase no contexto (`vn`, `rs`); aplicar migração
> exige autorização caso a caso do mantenedor (AGENTS.md).

### 5.0 Correções feitas na F1 contra o schema real

O SQL abaixo foi conferido linha a linha contra o `vn` antes de rodar. Quatro divergências
apareceram, e o arquivo em `supabase/migrations/078_qr_enrichment_and_limits.sql` é a versão
corrigida — **este documento e o arquivo estão de acordo**, mas o texto original está registrado
aqui porque cada uma das quatro é uma armadilha que vale documentar.

1. **Faltava `qr_check` no CHECK de `contacts.whatsapp_status_reason`.** O CHECK em vigor
   (`contacts_whatsapp_status_reason_check`, herdado da 044) aceita apenas
   `consecutive_failures`, `meta_error` e `manual`. O D-2 introduz `qr_check` como motivo
   novo, e a §5 não recriava esse CHECK: o primeiro UPDATE da F5 morreria em violação de
   constraint. A migração passa a recriá-lo com o quarto valor. `qr_check_conflict` **não**
   entra — pela regra 3 do D-2 a discordância vai para `whatsapp_check_note` e nunca vira
   status.

2. **§5.6 usava `LIMIT 1` para derrubar o CHECK de `broadcasts.status`.** O bloco existe
   justamente porque há duas formas anteriores possíveis; com `LIMIT 1`, um deployment que
   tivesse ficado com as duas teria só uma derrubada, e a sobrevivente continuaria recusando
   `awaiting_check` — em silêncio, porque o CHECK novo estaria lá, válido, ao lado do antigo.
   Um CHECK que sobra não substitui: soma. Virou `FOR … LOOP`, mais uma asserção na §5.8 de
   que resta **exatamente um** CHECK de valores. (No `vn` havia só a forma nomeada da 065,
   `broadcasts_status_streaming_check`.)

3. **§5.7 tinha um cast que LANÇA.** A expressão
   `NULLIF(replace((storage.foldername(name))[1], 'account-', ''), '')::uuid` levanta
   `22P02 invalid input syntax for type uuid` diante de qualquer caminho fora da convenção —
   medido no `vn`, não deduzido. Um erro dentro de uma policy derruba o **SELECT inteiro** em
   vez de negar aquela linha: um único objeto com nome torto cegaria o bucket para todo mundo.
   A policy passa a extrair o `account_id` dentro de um `CASE` guardado por `regexp` de UUID —
   `CASE`, e não `AND`, porque o Postgres só garante ordem de avaliação dentro de um `CASE`;
   um `AND` pode avaliar o cast antes da guarda, e aí a guarda não guarda nada. Caminho fora do
   padrão vira `NULL`, e `is_account_member(NULL)` é falso — nega a linha, não a consulta.

4. **`harvest_max_contacts` ganhava um CHECK anônimo.** Inline num `ADD COLUMN IF NOT EXISTS`,
   o CHECK nasce sem nome e não pode ser recriado por `DROP … CREATE`. Passou a ser
   `evolution_instances_harvest_max_contacts_check`, no padrão nomeado do resto da migração.

**Ainda em aberto para a F5** (não é correção, é aviso): `contact_check_queue.phone_normalized`
é `NOT NULL`, mas `contacts.phone_normalized` é **nulável**. A rota de enfileiramento precisa
cair para `contacts.phone` quando a coluna gerada estiver vazia, senão o INSERT falha para
contatos antigos.

```sql
-- ============================================================
-- 078_qr_enrichment_and_limits.sql — SPEC 069
--
-- 1) contacts: proveniência da checagem + avatar da instância
-- 2) evolution_instances: switches do R1, teto de captação, overrides
-- 3) channel_cold_sends: discriminador `kind` (D-1)
-- 4) contact_check_queue: a fila do R3/R6
-- 5) evolution_harvested_contacts: a triagem do R5 (D-3)
-- 6) broadcasts: status `awaiting_check` (D-4) + campos do R6
-- 7) bucket privado `contact-avatars` (D-12)
-- 8) asserções
--
-- Idempotente — seguro reexecutar. NADA aqui muda comportamento
-- sozinho: os dois switches nascem FALSE e a fila nasce vazia.
-- ============================================================

-- ------------------------------------------------------------
-- 1) contacts
-- ------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_source TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_fetched_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_checked_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_checked_channel_id UUID
  REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_check_note TEXT;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_avatar_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_avatar_source_check
  CHECK (avatar_source IS NULL OR avatar_source IN ('whatsapp_qr'));

COMMENT ON COLUMN contacts.avatar_path IS
  'Caminho no bucket privado contact-avatars (SPEC 069 D-12). Diferente de avatar_url, que é URL pronta: este precisa ser assinado antes de virar src.';
COMMENT ON COLUMN contacts.whatsapp_check_note IS
  'Discordância entre fontes de whatsapp_status (SPEC 069 D-2, regra 3). Sinal para o operador, nunca decisão automática.';

-- `harvest` é a origem do contato promovido da triagem (D-3). O CHECK
-- da 067 é nomeado, então basta recriar.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_created_via_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_created_via_check
  CHECK (created_via IN ('manual','import','api','audience','inbound','legacy','harvest'));

-- Só os contatos que ainda não foram checados interessam à fila.
CREATE INDEX IF NOT EXISTS idx_contacts_unchecked
  ON contacts (account_id) WHERE whatsapp_checked_at IS NULL;

-- ------------------------------------------------------------
-- 2) evolution_instances — R1 (a), (b), (c) e o nível 1b da cascata
--
-- Os dois switches nascem FALSE: ninguém é inscrito em risco de
-- banimento por atualização de versão (PRD 068 §6.2).
-- ------------------------------------------------------------
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS check_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvest_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- NULL = herda o teto resolvido pela cascata; valor = teto próprio
-- desta instância, clampado na escrita e na leitura (D-7).
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvest_max_contacts INTEGER
  CHECK (harvest_max_contacts IS NULL OR harvest_max_contacts >= 0);
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvested_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvest_cursor TEXT;
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvest_last_run_at TIMESTAMPTZ;
-- Nível 1b da cascata (D-8). Chaves validadas em src/lib/limits/registry.ts,
-- não por CHECK — mesma escolha da 067 §2.2 para plans.limits.
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS limit_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN evolution_instances.limit_overrides IS
  'Nível 1b da cascata de limites (SPEC 069 §3.4): instância > conta > .env > código. Chave ausente = herda; 0 = bloqueia aquele eixo.';

-- ------------------------------------------------------------
-- 3) channel_cold_sends.kind — cota de checagem separada (D-1)
--
-- DEFAULT 'send' é o que preserva a contagem existente: toda linha
-- gravada até aqui é envio, e loadColdSendUsage passa a filtrar
-- kind='send'. Nada muda para quem já usa.
-- ------------------------------------------------------------
ALTER TABLE channel_cold_sends
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'send';
ALTER TABLE channel_cold_sends DROP CONSTRAINT IF EXISTS channel_cold_sends_kind_check;
ALTER TABLE channel_cold_sends ADD CONSTRAINT channel_cold_sends_kind_check
  CHECK (kind IN ('send','check'));

-- O índice da 062 é (channel_id, sent_at DESC); com o filtro por kind
-- ele deixa de cobrir sozinho as três consultas do teto.
CREATE INDEX IF NOT EXISTS idx_cold_sends_channel_kind_time
  ON channel_cold_sends (channel_id, kind, sent_at DESC);

COMMENT ON COLUMN channel_cold_sends.kind IS
  'send = mensagem fria (SPEC 049). check = consulta /user/check (SPEC 069 D-1) — cota separada, mesmo livro-caixa.';

-- ------------------------------------------------------------
-- 4) contact_check_queue — a fila do R2/R3/R6
--
-- SEM policy de escrita pelo cliente, como channel_cold_sends: a fila
-- é enchida por rota server-side que já validou a conta, e consumida
-- pelo cron. Uma policy de UPDATE aqui deixaria o próprio freio
-- zerável (mesmo argumento da 062).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_check_queue (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id)  ON DELETE CASCADE,
  -- Congelado no enfileiramento: se o contato for editado depois, o
  -- que foi checado continua rastreável.
  phone_normalized TEXT NOT NULL,

  source         TEXT NOT NULL DEFAULT 'contacts_import'
                 CHECK (source IN ('contacts_import','broadcast')),
  broadcast_id   UUID REFERENCES broadcasts(id) ON DELETE CASCADE,
  -- Instância validadora escolhida no enfileiramento (D-10). NULL
  -- resolve na hora do consumo — instância pode ser trocada no meio.
  check_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,

  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','in_progress','done','failed','expired','skipped')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,

  requested_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at     TIMESTAMPTZ
);

-- Um contato não fica duas vezes na fila PELO MESMO motivo. Parcial
-- em (pending, in_progress) porque reenfileirar um contato já checado
-- meses depois é legítimo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_check_queue_dedupe
  ON contact_check_queue (account_id, contact_id, COALESCE(broadcast_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('pending','in_progress');

-- A consulta do cron: pendentes de uma conta, mais antigos primeiro.
CREATE INDEX IF NOT EXISTS idx_check_queue_pending
  ON contact_check_queue (account_id, created_at)
  WHERE status = 'pending';

-- A consulta do R6: quanto falta desta campanha.
CREATE INDEX IF NOT EXISTS idx_check_queue_broadcast
  ON contact_check_queue (broadcast_id, status)
  WHERE broadcast_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON contact_check_queue;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_check_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE contact_check_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_check_queue_select ON contact_check_queue;
CREATE POLICY contact_check_queue_select ON contact_check_queue
  FOR SELECT USING (is_account_member(account_id));

COMMENT ON TABLE contact_check_queue IS
  'Fila de checagem de número via instância QRCode (SPEC 069 R2/R3/R6). Sem policy de escrita: enchida por rota server-side, consumida por cron.';

-- ------------------------------------------------------------
-- 5) evolution_harvested_contacts — a triagem (D-3)
--
-- NÃO é contacts. Uma pessoa da agenda do dono do número não é lead
-- até alguém dizer que é — e a quota de contatos (trigger da 067) só
-- deve ser consumida quando há alguém na tela para ver o erro.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evolution_harvested_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

  jid           TEXT NOT NULL,
  phone_normalized TEXT,
  push_name     TEXT,
  full_name     TEXT,
  business_name TEXT,
  avatar_path   TEXT,

  -- Resposta crua da Evolution, para diagnóstico enquanto D-14 estiver
  -- aberta. Purgada junto com a linha.
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,

  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','promoted','ignored','duplicate')),
  promoted_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  promoted_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  promoted_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, channel_id, jid)
);

CREATE INDEX IF NOT EXISTS idx_harvested_triage
  ON evolution_harvested_contacts (account_id, status, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON evolution_harvested_contacts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON evolution_harvested_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE evolution_harvested_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS harvested_select ON evolution_harvested_contacts;
CREATE POLICY harvested_select ON evolution_harvested_contacts
  FOR SELECT USING (is_account_member(account_id));
-- Escrita (promover/ignorar) passa por rota que valida papel admin+ e
-- executa a promoção numa transação junto do INSERT em contacts —
-- por isso, service_role apenas.

COMMENT ON TABLE evolution_harvested_contacts IS
  'Triagem de contatos captados da agenda da instância QRCode (SPEC 069 D-3 / PRD 068 §3). Promoção para contacts é ato explícito de uma pessoa — base legal LGPD.';

-- ------------------------------------------------------------
-- 6) broadcasts — o estado "Em espera — disparo parcial" (D-4)
--
-- Mesmo padrão idempotente da 065 §1.2, com uma diferença: agora
-- existem DUAS formas anteriores possíveis do CHECK (a anônima da 001
-- e a nomeada da 065). O bloco reconhece as duas.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.broadcasts'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%draft%scheduled%sending%sent%failed%'
    AND pg_get_constraintdef(c.oid) NOT ILIKE '%awaiting_check%'
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.broadcasts DROP CONSTRAINT ' || quote_ident(v_conname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_status_awaiting_check_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_status_awaiting_check_check
      CHECK (status IN ('draft','scheduled','sending','sent','failed','streaming','awaiting_check'));
  END IF;
END $$;

COMMENT ON COLUMN broadcasts.status IS
  'draft/scheduled/sending/sent/failed = ciclo de uma campanha. streaming (065) = exclusivo de source=webhook. awaiting_check (078, SPEC 069 R6) = disparo parcial esperando o próximo ciclo de cota de checagem.';

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS check_before_send BOOLEAN NOT NULL DEFAULT FALSE;
-- D-10: a instância que CHECA é independente do canal que DISPARA.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS check_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS checked_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS check_resumed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_broadcasts_awaiting_check
  ON broadcasts (account_id, check_resumed_at)
  WHERE status = 'awaiting_check';

-- ------------------------------------------------------------
-- 7) Bucket privado `contact-avatars` (D-12)
--
-- Privado desde o nascimento, ao contrário de `avatars` (008, público)
-- — a foto de perfil de um terceiro que nunca falou com o CRM não é
-- material para leitura anônima. Mesmo regime que a 040 impôs a
-- chat-media/flow-media: URL assinada sob demanda.
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('contact-avatars','contact-avatars', FALSE, 2097152,
        ARRAY['image/png','image/jpeg'])
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Leitura por membro da conta dona do primeiro segmento do caminho
-- (`account-<uuid>`) — mesma convenção de chat-media.
DROP POLICY IF EXISTS "Members read own account contact avatars" ON storage.objects;
CREATE POLICY "Members read own account contact avatars"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'contact-avatars'
    AND is_account_member(
      NULLIF(replace((storage.foldername(name))[1], 'account-', ''), '')::uuid
    )
  );
-- Escrita: nenhuma policy. Só o cron (service_role) sobe avatar — não
-- existe upload manual de avatar de contato (R4 / PRD 068 §5).

-- ------------------------------------------------------------
-- 8) Asserções — falham alto (padrão 041/052/059/061/062)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'evolution_instances') THEN
    RAISE EXCEPTION '078: evolution_instances ausente — rode a 056 primeiro.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'channel_cold_sends') THEN
    RAISE EXCEPTION '078: channel_cold_sends ausente — rode a 062 primeiro.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'plan_limit') THEN
    RAISE EXCEPTION '078: plan_limit() ausente — rode a 067 primeiro.';
  END IF;

  -- O freio não pode ser zerável pelo cliente.
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename IN ('contact_check_queue','evolution_harvested_contacts')
               AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '078: fila e triagem nao podem ter policy de escrita pelo cliente.';
  END IF;

  -- Os switches TÊM que nascer desligados (PRD 068 §6.2).
  IF EXISTS (SELECT 1 FROM evolution_instances WHERE check_enabled OR harvest_enabled) THEN
    RAISE EXCEPTION '078: nenhuma instancia pode nascer com checagem/captacao ligada.';
  END IF;
END $$;
```

---

## 6. Contratos de rota

Mensagens de erro em **inglês** (`/api/**` é para integrações — AGENTS.md); a UI traduz.

### 6.1 `PATCH /api/channels/evolution/instances/[id]/enrichment`

> ✅ **Correção da F3–F7 (implementada fora da tabela de fases original, sem ela nada é
> alcançável por um cliente real):** caminho movido de `/api/evolution/instances/[id]/
> enrichment` para `/api/channels/evolution/instances/[id]/enrichment` — é onde TODA a família
> de ações de instância já mora (`disconnect`/`logout`/`pair`/`qr`/`reconnect`/`status`, SPEC
> 048), e `[id]` já é `evolution_instances.id` por convenção estabelecida ali, não `channel_id`.

Os switches e o teto de captação do R1. Papel: `admin+` da conta dona da instância.

```jsonc
// request
{ "checkEnabled": true, "harvestEnabled": false, "harvestMaxContacts": 300 }
// 200
{ "checkEnabled": true, "harvestEnabled": false,
  "harvestMaxContacts": 300, "harvestMaxContactsCeiling": 500,
  "harvestedCount": 0 }
```

- `harvestMaxContacts` acima do teto resolvido → `400 { "error": "harvestMaxContacts exceeds the ceiling of 500" }`.
- `null` em `harvestMaxContacts` = voltar a herdar.
- Ligar `checkEnabled` numa instância que nunca conectou → `409 { "error": "instance is not connected" }`.
  Ligar é uma promessa de que a checagem vai funcionar; deixar ligar sem sessão só empurra a
  frustração para o cron.

### 6.2 `POST /api/contacts/check-queue`

Enfileira. É o destino do checkbox do R2 nos dois caminhos. Papel: `admin+`.

```jsonc
// request — uma das duas formas
{ "contactIds": ["…"], "source": "contacts_import" }
{ "broadcastId": "…",  "source": "broadcast" }
// 202
{ "queued": 812, "skipped": 44, "skippedReason": "already_checked",
  "checkChannelId": "…", "estimatedHours": 27 }
```

- `403` se a conta não tem nenhuma instância validadora ligada — com
  `{ "error": "no instance enabled for number checking" }`, que é o que a UI traduz no estado
  desabilitado do checkbox (D-10).
- `estimatedHours` é calculado da cota resolvida. É a informação que impede o cliente de achar
  que a checagem travou: 812 contatos a 300/dia são quase três dias, e ele precisa saber disso
  **antes**.
- Validação de posse: todo `contactIds[i]` tem que pertencer à conta do chamador — a rota usa o
  cliente de sessão (RLS) para a conferência e `supabaseAdmin()` só para o INSERT na fila.

### 6.3 `GET /api/contacts/check/cron`

Cron da checagem (R3 e R6). Mesmo contrato das outras cinco rotas de cron: header
`x-cron-secret` conferido contra `AUTOMATION_CRON_SECRET`, **`503` deliberado** quando a
variável não está no servidor, `401` quando o segredo não bate, comparação em tempo constante
(`timingSafeEqual`, como `/api/broadcasts/cron`). `export const maxDuration = 300`.

```jsonc
// 200
{ "accountsProcessed": 3, "checked": 41, "invalid": 6, "avatarsFetched": 12,
  "skipped": [{ "accountId": "…", "reason": "hourly_limit" }],
  "broadcastsResumed": 1 }
```

### 6.4 `GET /api/contacts/harvest/cron`

Cron da captação (R5). Mesmo contrato de auth. Além do segredo, verifica a **janela horária no
código** (`isWithinHarvestWindow`) e devolve `{ "skipped": "outside_window" }` sem tocar a
Evolution quando fora — porque um agendamento mal copiado não pode virar captação diurna.

### 6.5 Triagem

- `GET /api/evolution/harvested?status=new&cursor=…&channelId=…` — lista paginada (keyset,
  reusa `lib/api/v1/pagination.ts` — mesmo mecanismo do resto do repositório, não um segundo
  cursor). Papel: `viewer` (leitura). `channelId` opcional filtra por instância de origem.
- `POST /api/evolution/harvested/promote` — `{ "ids": ["…"] }`. Papel: `admin+`. Cria os
  contatos com `created_via='harvest'`, `opt_in_status='unknown'`, vínculo ao canal de origem em
  `contact_identities`. Resposta: `{ "promoted": N, "blocked": [{id,reason}], "skipped": [{id,reason}] }`.
  - `blocked` cobre `quota_exceeded` (cota estourada — parcial é legítimo, os ids seguintes
    continuam sendo tentados) e `no_phone_number` (Jid `@lid` puro, sem telefone conhecido —
    `contacts.phone` é `NOT NULL`, não há o que promover sem número).
  - `skipped` cobre id que não pertence à conta ou já não está mais em `status='new'`.
  - ✅ **Achado da F7, não previsto no texto original:** um telefone já cadastrado como contato
    (criado por outro caminho entre a captação e a promoção) vira `status='duplicate'` na
    triagem, vinculado ao contato existente — em vez de tentar recriar e falhar num índice
    único.
  - Avatar buscado em `after()`, depois da resposta — ver a correção do §7.2 ponto 5.
- `POST /api/evolution/harvested/ignore` — `{ "ids": ["…"] }`, marca `ignored`. Papel: `admin+`.

### 6.6 `GET` / `PUT /api/admin/accounts/[accountId]/channel-limits`

O editor do nível 1a/1b (D-8, D-9). Protegida por `PLATFORM_ADMIN_SECRET`
(`requirePlatformAdminSecret`), como as demais rotas de `/api/admin`.

> ✅ **Correção da F10:** o texto original só previa esta porta secreta — mas
> `PLATFORM_ADMIN_SECRET` é um segredo de SERVIDOR, e o navegador do proprietário não pode
> carregá-lo. Sem uma segunda porta, o `ChannelLimitsPanel` (§8 ponto 8) não teria como
> existir. Existe também `PUT`/`GET /api/platform/accounts/[accountId]/channel-limits`,
> protegida por `requirePlatformOwner()` (sessão normal, mesma guarda de
> `/admin/accounts/[accountId]` e de `.../plan`) — é ESSA que o painel chama de verdade, e ela
> também grava `platform_audit_log` (ação `channel_limits.update`), coisa que a porta secreta
> não faz. As duas chamam a MESMA função (`lib/platform/channel-limits-actions.ts`), pelo
> mesmo motivo que `changeAccountPlan` já é compartilhada entre as duas portas do plano: "as
> duas produzem o mesmo resultado" só é verdade por construção quando é uma função só, não
> disciplina de manter duas cópias sincronizadas.

```jsonc
// GET 200
{ "account": { "evolution_cold_send_per_day": { "value": 60, "level": "env",
                                                "hardCap": 250, "override": null } },
  "instances": [ { "channelId": "…", "label": "Comercial",
                   "overrides": { "evolution_cold_send_per_day": 120 } } ] }
// PUT request
{ "account": { "evolution_cold_send_per_day": 150 },
  "instances": { "<channelId>": { "evolution_cold_send_per_day": null } } }
```

- `null` = remover o override (voltar a herdar). É a diferença que a §3.4 regra 3 exige.
- Valor acima do teto duro → `400`, nunca clamp silencioso na escrita (o clamp na leitura é
  defesa em profundidade, não a validação principal).
- Chave fora do registro → `400 { "error": "unknown limit key: …" }`.

### 6.7 O que muda em rotas existentes

- `PUT /api/admin/accounts/[accountId]/plan` — a validação contra `QUOTA_KEYS` passa a aceitar
  as onze chaves novas automaticamente (elas entram na constante). Ganha a validação de teto
  duro para chaves de segurança, que ela hoje não tem.
- `GET /api/evolution/instances` — a resposta ganha `checkEnabled`, `harvestEnabled`,
  `harvestMaxContacts`, `harvestedCount` e os limites resolvidos com o nível de origem, para o
  cartão poder dizer "herdando da conta".

---

## 7. Os dois crons

### 7.1 Cron de checagem — `/api/contacts/check/cron`, a cada 5 minutos

Cinco minutos porque é a granularidade que o R6 pede ("provavelmente um cron de 5 min") e
porque é o intervalo que já existe para `/api/broadcasts/cron` — um operador, um hábito.

Por ciclo, **por conta que tem fila pendente**:

1. Resolve a instância validadora (a da fila, ou a única com `check_enabled`; nenhuma → marca
   os itens como `skipped` com motivo, não os deixa apodrecendo).
2. Instância desconectada → **não consome tentativa**, sai da conta e segue para a próxima.
   Uma instância caída não pode envenenar a fila (armadilha §12.4).
3. Resolve os limites pela cascata — **uma vez**, não por contato.
4. `planCheckBatch` corta o lote pelo menor entre `batch_size`, `remainingToday`,
   `remainingThisHour`.
5. Para cada item, sequencialmente, respeitando `min_interval_seconds`:
   `/user/check` → grava `channel_cold_sends(kind='check')` → aplica D-2 → se
   `IsInWhatsapp` e (avatar ausente ou vencido) → `/user/info` + `/user/avatar` → bucket.
6. Se o item veio de campanha, avalia a retomada (§7.3).
7. Claim: `UPDATE … SET status='in_progress' WHERE status='pending'` — o mesmo lock por
   `UPDATE` condicional que `/api/broadcasts/cron` usa, sem `FOR UPDATE`. Item em
   `in_progress` há mais de uma hora volta a `pending` (o processo morreu no meio).

### 7.2 Cron de captação — `/api/contacts/harvest/cron`, de hora em hora entre 00:00 e 05:00

A janela é `[start, end)` — com os padrões `0` e `6`, seis execuções: 00, 01, 02, 03, 04, 05,
terminando antes das 06:00. O fuso é o do deployment (`EVOLUTION_HARVEST_TIMEZONE`, padrão
`America/Sao_Paulo`), **não** o do banco: o sentido de "madrugada" é o horário de baixa
atividade no Brasil, e o Supabase roda em UTC.

Por execução, por instância com `harvest_enabled`:

1. Confere a janela **no código** (D-14 / §7.4).
2. Confere `harvested_count < teto resolvido`; atingido → nada, e marca a instância como
   `harvest_complete` na resposta (a UI mostra "teto atingido", não "desligado").
3. `GET /user/contacts`, corta em `harvest_per_run` (padrão 50), pula `Jid` já presente na
   triagem ou já vinculado a contato existente.
4. Grava em `evolution_harvested_contacts` com `status='new'`. **Não** toca `contacts`.
5. ✅ **Correção da F7:** avatar do captado NÃO é buscado aqui, ao contrário do que este ponto
   previa. `/user/avatar` é uma consulta ao vivo por número (mesmo risco medido na F3, D-14 #6),
   e o harvest não tem `min_interval_seconds` nenhum protegendo-o — só o teto de
   `harvest_per_run`. Buscar foto para até 50 contatos por hora que talvez nunca sejam
   promovidos gastaria essa consulta à toa. A busca foi movida para
   `POST /api/evolution/harvested/promote` (§6.5), em `after()` — depois da resposta HTTP, para
   o admin não esperar uma consulta lenta por contato promovido.
6. Captação **não** grava em `channel_cold_sends` — não é envio nem consulta por contato (R5).

### 7.3 A máquina de estados do R6

```
  usuário marca "checar antes de disparar" no passo de audiência
                        ↓
        broadcast.status = 'awaiting_check', fila enchida
                        ↓
   ┌──────────── cron de 5 min ────────────┐
   │  cota disponível?                     │
   │    não → continua 'awaiting_check'    │
   │    sim → checa o lote                 │
   │           ↓                           │
   │  dentro da janela de envio? (D-11)    │
   │    não → continua, motivo na trilha   │
   │    sim → dispara para os validados    │
   │           ↓                           │
   │  fila desta campanha vazia?           │
   │    não → volta a 'awaiting_check'     │
   │    sim → 'sent'                       │
   └───────────────────────────────────────┘
```

O disparo parcial reusa `deliverBroadcast` com a audiência **já filtrada** pelos contatos
validados naquele ciclo — não há caminho de envio novo, e por isso não há segunda regra de
janela, de opt-out ou de quota para manter em sincronia.

#### ✅ Correções da F8 — três coisas que o diagrama acima não previa

1. 🔴 **Quem varre é o cron de CAMPANHAS, não o de checagem.** O §7.1 ponto 6 dizia "se o item
   veio de campanha, avalia a retomada", o que amarra a retomada a haver item processado
   naquele ciclo. Uma campanha cuja fila esvaziou — porque a última fatia caiu fora da janela
   de envio, ou porque a instância sumiu — não teria mais nenhum item para disparar o gatilho, e
   ficaria parada para sempre sem ninguém para reavaliá-la. A varredura é por ESTADO
   (`status = 'awaiting_check'`, índice `idx_broadcasts_awaiting_check` da 078), em
   `/api/broadcasts/cron`, e roda a cada ciclo independentemente do que a checagem fez.

   Como parte disso, o `return` antecipado daquele cron ("sem agendamento vencido, responde
   zero e sai") teve de cair: com ele, o disparo parcial só andaria nos ciclos em que, por
   coincidência, também houvesse um agendamento vencido — quase nunca. **Foi um teste que
   pegou isso**, não a leitura do código.

2. 🔴 **`deliverBroadcast` encerrava a campanha ao fim de CADA fatia.** Ele sempre gravou
   `status = sentCount > 0 ? 'sent' : 'failed'` no fim do fan-out. Numa campanha parcial, isso
   marcaria `sent` depois da PRIMEIRA fatia, com o resto da audiência nunca checado e nunca
   enviado — em silêncio, que é exatamente como o §4.10 diz que o R6 dá errado. Ganhou
   `DeliverOptions.finalizeStatus` (padrão `true`, comportamento de sempre); o disparo parcial
   passa `false`, e quem decide o status é `decidePartialSend`.

3. 🔴 **A cota de ENVIO também prende a campanha, não só a fila de checagem.** O diagrama
   pergunta apenas "fila desta campanha vazia?". Mas o lote de um ciclo é cortado pela cota de
   24 h da Meta: 30 validados com cota de 10 saem em três fatias, e nos dois primeiros ciclos a
   fila de checagem já está vazia. Pela regra do diagrama, a campanha viraria `sent` no primeiro
   ciclo com 20 pessoas validadas e nunca enviadas. `PartialSendState.readyRemaining` é o
   conserto: `sent` só quando não sobra **nada** — nem fila, nem resto de cota. **Também foi um
   teste que pegou** (o cenário de 30 contatos com cota de 10 do "pronto quando" da F8).

#### Quem entra em cada fatia, e por que nunca duas vezes

O lote é "checado (`done`), com número válido, e ainda SEM linha em `broadcast_recipients` desta
campanha". A ausência da linha do destinatário é a única fonte de verdade sobre o que já saiu —
não um estado a mais na fila — porque ela só existe se o INSERT aconteceu: um processo morto no
meio de um ciclo não deixa a fila mentindo sobre o que foi enviado.

`broadcasts.check_resumed_at` é uma marca d'água de PERFORMANCE sobre isso (só avança quando uma
fatia é despachada com sucesso), para a consulta não varrer os 100 mil itens já despachados de
uma campanha grande a cada 5 minutos. A correção continua sendo a subtração pelos destinatários.

Contato checado e **inválido** é filtrado na montagem do lote, não deixado para o pipeline de
disparo: ele nunca viraria destinatário, então continuaria "pronto" para sempre e a campanha
jamais chegaria a `complete`.

#### Como a campanha ENTRA em `awaiting_check`

`POST /api/contacts/check-queue` com `{broadcastId, source:'broadcast'}` (§6.2) — implementado na
F8, que é quando ele deixou de ser um `400` apontando para uma fase futura. Três decisões dessa
rota:

- **A audiência é resolvida no ENFILEIRAMENTO**, não no disparo. É o oposto da decisão 1 do
  `/api/broadcasts/cron` (§6.3 da SPEC 044: resolver no disparo, porque congelar a lista no
  agendamento produz um disparo correto e factualmente velho) — e é inevitável aqui: não dá para
  checar números que ainda não foram resolvidos. Quem entrar na etiqueta depois de a campanha
  entrar na fila não recebe. Trade-off inerente ao R6, registrado.
- **A campanha só vira `awaiting_check` DEPOIS de a fila existir.** Na ordem inversa, uma falha
  no INSERT deixaria a campanha esperando por uma fila que nunca foi criada — presa para sempre,
  sem nada para o cron drenar.
- **Teste A/B é recusado** (`400`). Um A/B divide a mesma audiência entre dois braços no
  disparo (§6.6 da SPEC 044); o disparo parcial entrega essa audiência em fatias ao longo de
  dias. Casar os dois exigiria decidir como dividir CADA fatia sem enviesar o teste — decisão de
  produto que esta SPEC não tomou. Deixar passar dispararia só o braço A e chamaria isso de teste
  A/B. O corolário do D-11 (variante B nunca varrida) continua valendo como segunda tranca, no
  filtro `parent_broadcast_id IS NULL` da varredura.

#### Duas peças de infraestrutura que o disparo parcial exigiu

- `AudienceConfig` ganhou o tipo **interno** `contact_ids` — é como "a audiência já filtrada"
  se expressa sem inventar um segundo caminho de envio. Ele NÃO está em `AUDIENCE_TYPES`
  (`lib/broadcasts/parse-input.ts`), a lista que valida o que chega pela rede: um cliente não
  deve poder postar uma lista arbitrária de ids e pular a resolução de audiência.
- `planDashboardBroadcast` ganhou `partialAppend`, que no UPDATE de adoção não reescreve
  `audience_filter` (a audiência de verdade é a original — gravar a fatia apagaria o que o
  usuário escolheu), `total_recipients` (acumula ao longo das fatias) nem `status` (quem manda é
  a máquina de estados).

### 7.4 Entradas em `supabase/setup/cron-jobs.sql`

Comentadas, como todas as outras — o agendamento é ato consciente do operador, e este arquivo
não é migração.

```sql
-- ============================================================
-- Checagem de números via instância QRCode (SPEC 069 §7.1)
-- ============================================================
-- SELECT cron.schedule(
--   'zapcrm-contact-check-cron',
--   '*/5 * * * *',
--   $job$
--   SELECT net.http_get(
--     url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_app_url')
--            || '/api/contacts/check/cron',
--     headers := jsonb_build_object(
--       'x-cron-secret',
--       (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_cron_secret')
--     ),
--     timeout_milliseconds := 30000
--   );
--   $job$
-- );

-- ============================================================
-- Captação de contatos da agenda da instância (SPEC 069 §7.2)
--
-- '0 0-5 * * *' no fuso do BANCO (UTC no Supabase). A janela real é
-- reconferida pela rota em EVOLUTION_HARVEST_TIMEZONE — se o seu banco
-- não está em America/Sao_Paulo, ajuste o range aqui para que os dois
-- coincidam, senão o cron acorda e a rota devolve outside_window.
-- ============================================================
-- SELECT cron.schedule(
--   'zapcrm-contact-harvest-cron',
--   '0 0-5 * * *',
--   $job$
--   SELECT net.http_get(
--     url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_app_url')
--            || '/api/contacts/harvest/cron',
--     headers := jsonb_build_object(
--       'x-cron-secret',
--       (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_cron_secret')
--     ),
--     timeout_milliseconds := 60000
--   );
--   $job$
-- );
```

> ⚠️ Memória do projeto: **`pg_cron` nunca foi instalado no `vn`**. Sem ele, os dois recursos
> ficam presos em silêncio — exatamente a armadilha do AGENTS.md. Confira `SELECT * FROM cron.job`
> antes de suspeitar de bug de código.

---

## 8. Pontos de UI

| # | Onde | O quê |
| - | ---- | ----- |
| 1 | `components/settings/whatsapp-qrcode-config.tsx` → `InstanceCard` | Os dois switches do R1 (com o aviso de risco ao lado do de checagem), o campo do teto de captação com o teto herdado visível, e o bloco "Limites em vigor" mostrando valor **e nível de origem** (D-8) |
| 2 | `components/contacts/import-modal.tsx` | Checkbox "Verificar estes números no WhatsApp" no passo de confirmação; ao concluir a importação, chama `POST /api/contacts/check-queue` com os ids recém-criados. Desabilitado com motivo quando não há instância validadora |
| 3 | `components/broadcasts/step2-select-audience.tsx` | O mesmo checkbox + seletor da instância validadora quando há mais de uma (D-10), e o "isto vai levar ~N horas" vindo de `estimatedHours` |
| 4 | `components/contacts/contact-detail-view.tsx` | **A metade que falta do R4** — `AvatarImage` com a URL assinada de `avatar_path`, caindo em `avatar_url` e depois nas iniciais que já existem. Mais o selo "Verificado em <data> por <instância>" |
| 5 | `components/inbox/conversation-list.tsx`, `contact-sidebar.tsx`, `assignment-board/conversation-card.tsx` | Já renderizam `avatar_url`; passam a preferir `avatar_path` assinado. **Metade do R4 já está pronta** — aqui é só a fonte |
| 6 | Nova tela de triagem (aba em Contatos, `?tab=harvested`) | Lista, filtro por instância, seleção múltipla, "Promover" e "Ignorar". Aviso de LGPD fixo no topo, não em tooltip |
| 7 | Lista de campanhas + detalhe | Badge `awaiting_check` ("Em espera — disparo parcial") com o progresso `checked_count / total` e a previsão da próxima retomada |
| 8 | `/admin/accounts/[accountId]` | `ChannelLimitsPanel` novo, no espírito do `AccountRetentionPanel`: um cartão por eixo, campo de três estados (D-6), teto duro visível, e o aviso "N instâncias com valor próprio" (D-8) |

**Estado desabilitado sempre com motivo.** Checkbox de checagem sem instância validadora não
some — aparece cinza dizendo por quê e com link para Configurações. É a mesma regra que fez a
aba QRCode aparecer desabilitada em vez de sumir quando a Evolution não está configurada
(`config.ts`, cabeçalho).

---

## 9. Chaves de i18n

Toda string nova entra em `messages/en.json` **e** `messages/pt-BR.json` (`npm run i18n:check`).
Árvores novas:

- `Settings.whatsappQrcode.enrichment.*` — `checkTitle`, `checkDescription`, `checkRiskWarning`,
  `harvestTitle`, `harvestDescription`, `harvestCap`, `harvestCapCeiling`, `harvestedCount`,
  `harvestComplete`, `limitsTitle`, `limitFromInstance`, `limitFromAccount`, `limitFromDefault`,
  `limitBlocked`, `notConnected`, `saveError`.
- `Contacts.check.*` — `enqueueLabel`, `enqueueHint`, `enqueueDisabledNoInstance`,
  `enqueueQueued`, `enqueueEstimate` (`{hours}`), `verifiedAt` (`{date}`, `{instance}`),
  `statusInvalidQr`, `statusConflict`.
- `Contacts.harvested.*` — `tabLabel`, `emptyTitle`, `emptyBody`, `lgpdNotice`, `promote`,
  `ignore`, `promoted` (`{count}`), `promoteQuotaError` (`{promoted}`, `{blocked}`),
  `sourceInstance`.
- `Broadcasts.status.awaiting_check` (**slug cru** — corrigido na F1: as chaves desse nó
  seguem o valor do banco, `streaming` e não `Streaming`) + `Broadcasts.awaitingCheck.*` — `badge`, `progress`
  (`{checked}`, `{total}`), `nextResume`, `outsideWindow`.
- `Platform.channelLimits.*` — `title`, `description`, `useDefault`, `ownValue`, `blockAxis`,
  `hardCapHint` (`{max}`), `instanceOverridesWarning` (`{count}`), `saveSuccess`, `aboveHardCap`,
  mais a subárvore `axis.*` (um rótulo por eixo de segurança, 11 chaves) — não prevista no texto
  original desta SPEC.

  > ✅ **Correção da F10:** o texto original desta seção previa o namespace `Admin.channelLimits.*`,
  > mas não existe (e nunca existiu) um namespace `Admin` no dicionário — a convenção real do
  > console do proprietário, já estabelecida antes desta SPEC, é o namespace `Platform.*`
  > (confirmado em runtime via `Object.keys(en.Platform)`). Corrigido em `messages/en.json` e
  > `messages/pt-BR.json` para `Platform.channelLimits.*`, em linha com o restante do console.

Placeholders ICU (`{count}`, `{hours}`) preservados idênticos nos dois arquivos — a armadilha
`INVALID_MESSAGE` do AGENTS.md não é pega pelo `typecheck`.

---

## 10. Segurança e privacidade

1. **Token da instância nunca sai do servidor.** Toda chamada nova à Evolution parte de rota
   server-side com `supabaseAdmin()`, lendo `evolution_instance_secrets` — a tabela sem
   nenhuma policy de SELECT (056 §2).
2. **Avatar em bucket privado, sem escrita pelo cliente** (§5.7). Não existe upload manual de
   avatar de contato, então não existe policy de INSERT — o que fecha a rota inteira de "subir
   arquivo arbitrário com nome de avatar".
3. **Escopo por conta em toda leitura da triagem.** `evolution_harvested_contacts` carrega dado
   pessoal de terceiro: RLS por `is_account_member`, e nenhuma rota aceita `accountId` do corpo
   da requisição.
4. **A fila não é zerável pelo cliente** (sem policy de escrita) — pelo mesmo motivo que
   `channel_cold_sends` não é: seria o freio com pedal do lado de fora.
5. **`raw` da Evolution é diagnóstico, não vitrine.** Não é exposto por nenhuma rota de leitura
   da UI; sai junto com a linha na purga.
6. **Purga da triagem.** Linha em `ignored` ou `duplicate` com mais de 90 dias é lixo com dado
   pessoal dentro. Função `purge_harvested_contacts(days)` e job comentado em `cron-jobs.sql`,
   no mesmo modelo da purga de `system_notifications` (SPEC 063).

---

## 11. Plano de testes

Vitest, co-locado (`*.test.ts` ao lado do fonte), como o resto do repositório.

### 11.1 O teste que a F2 existe para passar — compatibilidade

`src/lib/limits/resolve.test.ts`:

- **`env` vazio, sem override de conta, sem override de instância ⇒ o objeto resolvido é
  `deepEqual(COLD_SEND_DEFAULTS)`.** Este é o teste que prova a promessa do R7: refatoramos a
  origem do valor, não a política.
- Os mesmos casos que `cold-send-limit.test.ts` já cobre para `readColdSendLimits` (ausente,
  não numérico, negativo, `0`, `0` em `silenceHours`) reproduzidos **em cada nível** — porque a
  regra "valor inválido desce um nível" tem que valer para o JSONB da instância também, não só
  para o `.env`.
- Precedência: instância > conta > env > código, com um caso em que os quatro níveis têm valor
  diferente.
- Clamp: override de conta acima do teto duro → clampado, `clamped: true`; `.env` acima do teto
  → **não** clampado, mas com `console.warn`.
- Piso: `min_interval_seconds` abaixo do piso → elevado.

### 11.2 Módulos puros

| Módulo | Cobre |
| ------ | ------ |
| `check-queue.test.ts` | Corte do lote pelos três tetos; prioridade campanha > importação; `max_attempts`; TTL |
| `check-limits.test.ts` | A rampa compartilhada com o envio frio (D-1); os três eixos |
| `harvest-window.test.ts` | Dentro/fora da janela; virada de dia; fuso ≠ UTC (o caso que importa); `end` exclusivo |
| `harvest.test.ts` | Dedupe por `Jid`; teto por instância; cursor; agenda menor que o lote |
| `partial-send.test.ts` | Os quatro desfechos do R6 (§7.3), incluindo "fora da janela de envio" e "fila vazia ⇒ sent" |
| `avatar.test.ts` | Detecção de tipo pelos bytes; recusa de tipo não permitido; TTL; base64 corrompido |
| `whatsapp-status` (extensão) | D-2: Evolution não reverte `meta_error` nem `manual`; discordância vai para `whatsapp_check_note` sem mudar status |

### 11.3 Rotas

- As duas rotas de cron: `503` sem `AUTOMATION_CRON_SECRET`; `401` com segredo errado; `200`
  com segredo certo.
- `POST /api/contacts/check-queue` com `contactIds` de outra conta ⇒ `403`, e **nada
  enfileirado** (a asserção que importa é a segunda).
- `PUT .../channel-limits` com valor acima do teto ⇒ `400`; com chave desconhecida ⇒ `400`;
  com `null` ⇒ override removido.

### 11.4 Migração

Rodar `078` duas vezes seguidas em banco local: sem erro, sem duplicação de constraint, sem
duplicação de índice. Conferir que o CHECK de `broadcasts.status` resultante contém os sete
valores — a forma anterior pode ser a da 001 ou a da 065, e as duas precisam ser reconhecidas.

### 11.5 Manual (F10, contra número real)

Documento próprio `docs/spec-069-teste-manual.md`, no modelo dos da 056/062/064: ligar a
checagem, importar 20 números (sendo 3 inexistentes), conferir os `invalid`, conferir avatar no
inbox e no gerenciador, disparar campanha com checagem e **observar a campanha ficar em
`awaiting_check` e retomar**, desconectar a instância no meio de um lote e conferir que nenhuma
tentativa foi consumida.

---

## 12. Tabela de fases

Cada fase deixa a suíte verde e o app funcionando. Migração primeiro, UI por último. A cascata
do R7 é **infraestrutura** — vem antes de tudo que a usa, e a fase que a entrega tem que provar
que ninguém percebeu.

> ✅ **F1–F7 implementadas em 2026-09-03** (sessão única, cliente Sonnet 5, com verificação ao
> vivo contra `go.local.ia.br`/instância `bruno`). Gate completo verde (`typecheck && i18n:check
> && lint && test && format:check && build`, 3085 testes). Duas peças foram entregues fora da
> tabela original, porque sem elas o que a F5/F7 constrói não é alcançável por um cliente real:
> `PATCH /api/channels/evolution/instances/[id]/enrichment` (§6.1 — os switches; sem rota, só
> ligam por SQL direto) e as duas entradas comentadas em `supabase/setup/cron-jobs.sql` (§7.4 —
> nominalmente F10, mas um cron sem uma linha documentada de como agendá-lo não é testável pelo
> operador). `F8` (R6, disparo parcial) e `F9`/`F10` (UI) continuam **não implementadas**.

| Fase | Escopo | Pronto quando |
| ---- | ------ | ------------- |
| **F1** ✅ | Migração `078` completa (§5) + tipos em `src/types/index.ts` (`BroadcastStatus` ganha `awaiting_check`; `Contact` ganha os campos novos) | Migração roda **duas vezes** em banco local sem erro; CHECK de `broadcasts.status` com os sete valores; asserção dos switches desligados passa; `npm run typecheck` verde; **nenhum comportamento observável mudou** |
| **F2** ✅ | 🔑 A cascata: `src/lib/limits/{registry,resolve,load}.ts`; `QUOTA_KEYS` ganha as **onze** chaves de segurança (a §3.1 marca 5 eixos de envio frio e a §3.2 marca 6 de checagem/captação como nível 1a — a tabela manda, e são 11, não 10); `readColdSendLimits` reimplementada sobre o registro; `evolution/limits.ts` e `config.ts` passam a resolver pela cascata | `resolve.test.ts` prova `deepEqual(COLD_SEND_DEFAULTS)` sem nenhuma configuração; precedência dos quatro níveis coberta; clamp e piso cobertos; **`grep -rn "process.env.EVOLUTION_" src/` só retorna `src/lib/limits/` e `src/lib/evolution/config.ts`**; suíte inteira verde sem alterar nenhum teste existente |
| **F3** ✅ | Cliente Evolution: `/user/check`, `/user/info`, `/user/avatar`, `/user/contacts` em `EVOLUTION_KEY_SCOPE`; verificação das pendências D-14 contra o servidor real, com o resultado escrito nesta SPEC | Os seis itens de D-14 respondidos (5 medidos, 1 — instância desconectada — deliberadamente não testado contra sessão real em uso); parsers aceitam as formas medidas; testes com as respostas **reais** capturadas (dígitos trocados, forma idêntica), não inventadas. 🔴 Achado: o parser de `/user/check` em `contact-identity.ts` nunca reconheceu a forma real desde a SPEC 048 — corrigido no mesmo commit |
| **F4** ✅ | Módulos puros da checagem: `check-limits.ts`, `check-queue.ts`, `avatar.ts` + extensão de `whatsapp-status.ts` (D-2) | Tabelas de §11.2 cobertas; nenhuma rota ainda. *(O filtro `kind='send'` em `cold-send-usage.ts` saiu daqui e foi para a **F1**, junto da coluna: enquanto a coluna existe e o filtro não, a separação das duas cotas depende de ninguém inserir `kind='check'` — e "depende de ninguém fazer X" não é invariante.)* |
| **F5** ✅ | Rota de enfileiramento + cron de checagem + `check-run.ts` (execução, gravação de status e avatar). Sem UI | `503`/`401`/`200` do cron testados; enfileiramento recusa contato de outra conta sem enfileirar nada (testado); cron NÃO executado à mão contra instância real nesta sessão — só testes automatizados com a Evolution mockada. `/user/info` foi removido do fluxo (ver correção do §4.7) |
| **F6** ✅ | Avatar ponta a ponta: bucket, upload, assinatura, e o render nos **quatro** lugares (R4 — inbox já renderiza, gerenciador não) | Contato com avatar mostra a foto no inbox e no gerenciador (verificado ao vivo com contatos SEM avatar — mostram iniciais corretamente; nenhum contato COM avatar disponível para verificação visual completa nesta sessão); nenhum caminho de upload manual existe |
| **F7** ✅ | Captação: `harvest-window.ts`, `harvest.ts`, cron, triagem (tabela + três rotas) | Janela conferida no código (cron fora da janela devolve `outside_window` sem tocar a Evolution — testado); teto por instância respeitado (testado); promoção consome quota **e devolve resultado parcial** quando a quota estoura (testado); nada entra em `contacts` sem promoção. Avatar do captado movido da captação para a promoção (ver correção do §7.2 ponto 5) |
| **F8** ✅ | R6 — disparo parcial: `partial-send.ts`, `awaiting_check` no cron de campanhas, contadores | **Feita 2026-09-03.** Os CINCO desfechos cobertos por teste (os quatro + falha do §14); campanha de 30 contatos com cota de 10 completa em três ciclos (por cota de checagem E por cota de envio); variante B de A/B não é varrida (e o enfileiramento recusa A/B na entrada); fora da janela de envio, adia. Três achados corrigidos — ver §7.3. Gate completo verde. **Não commitado.** |
| **F9** | UI do cliente: switches, checkboxes nos dois uploads, aba de triagem, badge de campanha + i18n | `npm run i18n:check` verde; todo estado desabilitado mostra motivo; cartão da instância diz de qual nível cada limite veio |
| **F10** | UI do proprietário (`ChannelLimitsPanel`) + `.env.example` + `cron-jobs.sql` + `docs/spec-069-teste-manual.md` + índice do AGENTS.md | Editor de três estados salva, remove e recusa acima do teto; aviso de "N instâncias com valor próprio" aparece; gate completo verde (`typecheck && i18n:check && lint && test && format:check && build`) |

---

## 13. Bloco de `.env` pronto para colar

Inclui **toda variável nova e toda variável existente que a cascata passa a considerar**. Todas
são opcionais: sem nenhuma delas, o comportamento é o de hoje.

```bash
# ============================================================
# Evolution Go — enriquecimento e validação (SPEC 069)
#
# NENHUMA variável abaixo é obrigatória. O padrão de código (nível 3
# da cascata, SPEC 069 §3.4) sempre responde, e os valores comentados
# são exatamente os padrões atuais — descomentar sem mudar o número
# não altera nada.
#
# Precedência: instância > conta (painel do proprietário) > este
# arquivo > código. Valor ausente, não inteiro ou negativo cai um
# nível — nunca vira "sem limite". `0` significa BLOQUEAR aquele eixo
# (exceto SILENCE_HOURS, onde 0 cai no padrão).
# ============================================================

# ---- Conectividade (já existentes) ---------------------------------
# EVOLUTION_API_URL=
# EVOLUTION_GLOBAL_API_KEY=
# EVOLUTION_INSTANCE_PREFIX=zapcrm
# EVOLUTION_WEBHOOK_PUBLIC_URL=

# ---- Instâncias (já existentes) ------------------------------------
# EVOLUTION_MAX_INSTANCES_PER_ACCOUNT=3     # sobrescrito por plan_limit('channels_whatsapp_qr')
# EVOLUTION_MAX_INSTANCES_TOTAL=20          # teto da VPS; NENHUM override por conta o ultrapassa

# ---- Timeouts (já existentes; NÃO configuráveis por conta) ----------
# EVOLUTION_REQUEST_TIMEOUT_MS=15000
# EVOLUTION_MEDIA_REQUEST_TIMEOUT_MS=60000

# ---- Envio frio (já existentes; a partir da 069 também por conta) ---
# EVOLUTION_COLD_SEND_SILENCE_HOURS=24      # padrão de código: 24
# EVOLUTION_COLD_SEND_PER_HOUR=12           # padrão de código: 12  — o eixo da rajada
# EVOLUTION_COLD_SEND_PER_DAY=60            # padrão de código: 60
# EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS=45   # padrão de código: 45
# EVOLUTION_COLD_SEND_WARMUP_DAYS=14        # padrão de código: 14

# ---- Checagem de números (NOVO — cota separada do envio, D-1) -------
# EVOLUTION_CHECK_PER_HOUR=60               # padrão de código: 60
# EVOLUTION_CHECK_PER_DAY=300               # padrão de código: 300
# EVOLUTION_CHECK_MIN_INTERVAL_SECONDS=5    # padrão de código: 5
# EVOLUTION_CHECK_BATCH_SIZE=25             # padrão de código: 25  — por execução do cron
# EVOLUTION_CHECK_MAX_ATTEMPTS=3            # padrão de código: 3
# EVOLUTION_CHECK_QUEUE_TTL_HOURS=168       # padrão de código: 168 (7 dias)

# ---- Captação de contatos (NOVO) -----------------------------------
# EVOLUTION_HARVEST_PER_RUN=50              # padrão de código: 50   — R5
# EVOLUTION_HARVEST_MAX_PER_INSTANCE=500    # padrão de código: 500  — teto do campo do R1(c)
# EVOLUTION_HARVEST_WINDOW_START_HOUR=0     # padrão de código: 0
# EVOLUTION_HARVEST_WINDOW_END_HOUR=6       # padrão de código: 6    — EXCLUSIVO: última execução 05:00
# EVOLUTION_HARVEST_TIMEZONE=America/Sao_Paulo   # padrão de código: America/Sao_Paulo

# ---- Avatar de contato (NOVO) --------------------------------------
# EVOLUTION_AVATAR_TTL_DAYS=30              # padrão de código: 30
# EVOLUTION_AVATAR_MAX_BYTES=1048576        # padrão de código: 1048576 (1 MB; bucket aceita 2 MB)

# ---- Tetos duros do deployment (NOVO — D-7) ------------------------
# Clampam o override por CONTA e por INSTÂNCIA. Não clampam as
# variáveis acima: o nível 2 é a palavra do operador que define o teto.
# EVOLUTION_COLD_SEND_PER_HOUR_MAX=40
# EVOLUTION_COLD_SEND_PER_DAY_MAX=250
# EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS_MIN=10   # PISO — menor é mais perigoso
# EVOLUTION_COLD_SEND_WARMUP_DAYS_MIN=0             # PISO
# EVOLUTION_CHECK_PER_HOUR_MAX=200
# EVOLUTION_CHECK_PER_DAY_MAX=2000
# EVOLUTION_CHECK_MIN_INTERVAL_SECONDS_MIN=1        # PISO
# EVOLUTION_CHECK_BATCH_SIZE_MAX=100
# EVOLUTION_HARVEST_PER_RUN_MAX=200
# EVOLUTION_HARVEST_MAX_PER_INSTANCE_MAX=2000

# ---- Cron (já existente; as duas rotas novas usam o mesmo) ---------
# AUTOMATION_CRON_SECRET=
```

---

## 14. Armadilhas conhecidas

| Sintoma | Causa provável |
| ------- | -------------- |
| Checagem "não anda", sem erro na tela | `pg_cron` não instalado (**é o caso do `vn` hoje**) ou `AUTOMATION_CRON_SECRET` ausente — a rota devolve `503` de propósito e ninguém vê |
| Captação nunca roda, cron ativo | Fuso: o `cron.schedule` está em UTC e `EVOLUTION_HARVEST_TIMEZONE` é `America/Sao_Paulo`; a rota acorda e devolve `outside_window`. Alinhe os dois (§7.4) |
| Operador muda o limite da conta e nada acontece | A instância tem override próprio (nível 1b vence). O painel avisa — se não avisou, o aviso do D-8 não foi implementado |
| Contagem de envio frio "dobrou" depois da 078 | `loadColdSendUsage` sem o `.eq('kind','send')` — o filtro é obrigatório, não opcional |
| Avatar não aparece, sem erro no console | Caminho gravado sem o segmento `account-<uuid>`: a policy do bucket casa no primeiro segmento e recusa em silêncio (mesma armadilha da 020/023) |
| Avatar recusado no upload com "mime type not supported" | Tipo declarado com parâmetro (`image/jpeg; charset=…`) — o bucket compara **string literal**. Detectar pelos bytes, como manda a D-14 #4 |
| Campanha presa em `awaiting_check` para sempre | A instância validadora foi apagada ou desconectada; a fila fica pendente. O cron precisa marcar `skipped` e a campanha precisa cair para `failed` com motivo — item explícito da F8 |
| `npm run build` quebra depois da F1 | `BroadcastStatus` ganhou valor novo e algum `switch` exaustivo não o trata. É o comportamento desejado do TypeScript aqui |
| Quota de contatos estourando "do nada" | Alguém aprovou a opção (a) do PRD 068 §3 e a captação está inserindo direto em `contacts` de madrugada |

---

## 15. O que ficou de fora, e o que eu acho que falta na descrição

Esta seção é a leitura crítica pedida no fechamento: riscos não considerados, bordas e
interações que a descrição dos sete requisitos não fecha.

### 15.1 Riscos não considerados na descrição

1. **A checagem confirma "existe", não "recebe".** Um número pode estar no WhatsApp e ainda
   assim: ter bloqueado o remetente, ter saído do país, ou recusar mensagem de negócio. Se a UI
   disser "verificado" sem qualificar, o cliente vai atribuir ao produto a falha do disparo
   seguinte. O rótulo precisa ser "existe no WhatsApp", não "válido para receber".
2. **A checagem tem valor de reconhecimento.** Verificar um número diz ao WhatsApp que aquele
   número interessa a esta sessão. Feito em massa contra uma lista comprada, é exatamente o
   perfil que o antispam procura — e o dano recai sobre o número do **cliente**, não sobre a
   plataforma. Por isso os switches nascem desligados e a cota é própria. Vale considerar um
   teto adicional de "checagens no primeiro mês da instância" mais duro que a rampa geral.
3. **A instância validadora é um ponto único de falha compartilhado.** Uma conta com uma
   instância que valida, dispara e atende tem os três recursos morrendo juntos quando o número
   é banido. A UI deveria sugerir (não obrigar) uma instância dedicada à checagem.
4. **Foto de perfil de terceiro é dado pessoal, e ela some quando a pessoa apaga.** Guardamos
   uma cópia num bucket nosso, o que significa que o CRM passa a reter uma imagem que a pessoa
   pode ter removido do WhatsApp. O TTL de 30 dias mitiga; a exclusão do contato precisa apagar
   o objeto do bucket — item que **não** está no R4 e que a F6 tem que cobrir.
5. **Custo de armazenamento não foi orçado.** 50 mil contatos × ~30 KB de avatar ≈ 1,5 GB por
   conta. Num plano de storage do Supabase isso é dinheiro. Sugestão: `avatar_max_bytes` baixo
   (1 MB no padrão, mas o `preview: true` deve trazer bem menos) e a possibilidade de desligar
   avatar sem desligar a checagem — hoje os dois estão no mesmo switch.

### 15.2 Casos de borda que a descrição não fecha

1. **Evolution fora do ar no meio de um lote.** Postura desta SPEC: `channel_unavailable`
   **não** consome tentativa, não marca o contato, aborta o lote daquela conta e segue para a
   próxima. Um outage de 2 h não pode transformar 5 mil contatos em `failed`.
2. **Instância desconectada (QR expirado) no meio do lote.** Mesma postura, mais um efeito: a
   UI da campanha precisa dizer "aguardando reconexão da instância", não "em espera". Um
   estado que mente sobre a causa custa um chamado de suporte por cliente.
3. **Contato apagado enquanto está na fila.** `ON DELETE CASCADE` resolve o banco; o
   `checked_count` da campanha precisa continuar coerente (contar itens resolvidos, não subtrair
   do total).
4. **O mesmo contato em duas campanhas com checagem.** O índice parcial permite as duas linhas
   (motivos diferentes), o que significa **duas** consultas ao WhatsApp para o mesmo número.
   Mitigação barata: `check-run` pula item cujo contato foi checado nas últimas 24 h e
   reaproveita o resultado, marcando `skipped`.
5. **Importação de 100 mil contatos com o checkbox ligado.** A 300/dia são 11 meses. A UI
   precisa mostrar a estimativa **antes** de enfileirar e permitir enfileirar só os N primeiros.
6. **Troca de plano rebaixando o limite** com fila cheia. O próximo ciclo simplesmente usa o
   limite novo — comportamento correto, mas a estimativa mostrada ao usuário fica velha. Aceito,
   e registrado.
7. **Duas instâncias validadoras na mesma conta.** Nada distribui a fila entre elas nesta SPEC:
   o item carrega a instância escolhida. Distribuição automática é otimização futura, e
   fazê-la mal significa checar o mesmo número por duas sessões.
8. **Número que muda de dono.** `whatsapp_checked_at` de um ano atrás não vale nada. Não há
   re-checagem automática (PRD 068 §8), então a UI deveria esmaecer o selo depois de N meses em
   vez de exibir uma verdade vencida como se fosse fresca.

### 15.3 Interações com features existentes que precisam de atenção

- **SPEC 065 (seleção de canal por recurso):** a campanha agora tem **dois** canais
  (`channel_id` e `check_channel_id`). Toda tela que hoje diz "canal desta campanha" precisa
  ficar clara sobre qual dos dois está mostrando.
- **SPEC 060 (retenção):** avatar em bucket não é mensagem e **não** é varrido pela retenção.
  Se a intenção for que ele suma junto, isso é trabalho adicional e não está aqui.
- **SPEC 044 (triagem de audiência):** a triagem já classifica contato "problemático" por
  falhas. Com `whatsapp_status` recebendo uma terceira fonte, a explicação na tela precisa dizer
  **qual** fonte marcou — senão o usuário não sabe se reverte com segurança.
- **SPEC 059 (quotas):** as onze chaves novas entram em `QUOTA_KEYS`, que é lida pelo
  `catalog.test.ts` como teste de contrato e pela tela de plano do cliente. Chave de segurança
  **não** deve aparecer como barra de uso na tela do cliente junto de "contatos" — são coisas
  diferentes, e misturá-las faz o cliente achar que "envios frios" é o que ele comprou.
- **SPEC 063 (notificações):** três eventos merecem notificação e não estão no pedido: instância
  validadora desconectada com fila pendente; teto de captação atingido; campanha em
  `awaiting_check` há mais de 48 h.

### 15.4 Deliberadamente fora desta SPEC

- Checagem pela API pública `/api/v1` (PRD 068 §8).
- Distribuição automática da fila entre instâncias.
- Re-checagem periódica da base.
- Enriquecimento a partir do canal Cloud API — a Meta não expõe equivalente.
- Sincronização bidirecional da agenda (escrever contatos do CRM na agenda da instância). Além
  do escopo, é escrita num aparelho de terceiro.
