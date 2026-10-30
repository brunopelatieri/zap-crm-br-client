# SPEC 065 — Seleção de canal por recurso (campanha, automação, fluxo)

> **Status:** decisões **D-1 a D-11 ratificadas pelo mantenedor em 2026-08-31** — liberado para a **F1** (§9). As recomendações de cada `D-n` são, a partir daqui, a decisão vigente. Aplicar a migração em `vn`/`rs` continua exigindo autorização explícita, projeto a projeto (AGENTS.md)
> **Data:** 2026-08-31 (escrita e ratificada no mesmo dia)
> **Migração:** `075_resource_channel_selection.sql` (confira `ls supabase/migrations/` antes — a última hoje é a `074`)
> **Depende de:** [SPEC 064](./spec-064-multiplos-numeros-oficiais.md) (N números oficiais por conta) · [SPEC 049](./spec-049-inbox-multicanal-e-motores.md) (inbox multicanal e motores cientes de canal) · [PRD 047](./prd-047-canais-e-whatsapp-qrcode.md) (camada de canais) · [SPEC 055](./spec-055-webhook-de-entrada-de-contatos.md) (webhook de entrada) · [SPEC 056](./spec-056-transferencia-entre-canais.md) (desvio/transferência)
> **Como executar:** [`docs/plano-implantacao-spec-065.md`](./plano-implantacao-spec-065.md) — ordem das fases, modelo e sessão de cada uma, prompts de abertura prontos e painel de progresso
> **Fecha a dívida:** SPEC 064 **D-6** ("automações, flows e IA por canal — fora daquela SPEC") e §14 daquela SPEC
> **Não muda:** SPEC 060 (retenção) e SPEC 063 (notificações) — já são por tipo de canal e por conta

---

## 0. Por que esta SPEC existe

O pedido do mantenedor, na íntegra:

> Nas etapas do broadcast, escolher por qual integração WhatsApp oficial (quando
> houver mais de uma) será feito o disparo, **sem depender do que está configurado
> como padrão em Configurações**. A conexão padrão sempre aparece selecionada,
> mas em algum lugar — **com certeza uma etapa antes de selecionar o template** —
> dá para trocar. O mesmo nas **automações** e nos **fluxos**. No chat de conversa
> essa flexibilidade por canal e template já existe: **esse paradigma deve se
> estender aos outros recursos.**

A SPEC 064 entregou a capacidade (N números oficiais, credencial por canal,
template por WABA) e **adiou de propósito** a parte de produto: o D-6 daquela SPEC
diz, com todas as letras, que escopar automação e flow por canal "é produto novo,
não desbloqueio" e ficaria "para uma SPEC seguinte, depois que o segundo número
estiver em produção". É esta.

O que a 064 deixou pronto e esta SPEC aproveita inteiro:

- `broadcasts.channel_id` já existe, com FK e `ON DELETE SET NULL` (migração 072);
- `sendAndPersistOutbound` já aceita canal explícito (`input.channel`);
- `resolveCloudConfig` / `resolveDefaultChannelId` já resolvem credencial **por
  canal**, com a regra D-7/D-11 (explícito → conversa → padrão do tipo → erro);
- `templateBelongsToWaba` e `findTemplateRowForWaba` (`lib/whatsapp/template-waba.ts`)
  já são a regra única de "este template serve para este canal?";
- `findOrCreateConversation(db, accountId, contactId, channelId, ownerUserId)`
  (`lib/whatsapp/resolve-conversation.ts`) já abre conversa **num canal
  específico**, tratando a corrida do índice único.

Ou seja: as peças existem. O que falta é **quem escolhe, onde a escolha é
gravada, e quem a honra** — em três superfícies que hoje não perguntam nada.

### 0.1. Por que não houve PRD

Pelo mesmo motivo da 064 §0: **a decisão de produto já estava tomada** — o PRD 047
definiu que a unidade do sistema é o canal, e a 064 D-6 já nomeou este trabalho e
o adiou por sequenciamento, não por dúvida. Não há mercado a dimensionar nem
alternativa de produto em aberto: há um comportamento implícito (o padrão de
Configurações decidindo por todo mundo) a ser tornado explícito.

O que um PRD guardaria — as escolhas com efeito observável para o cliente — está
no **§3**, no mesmo formato `D-n` + recomendação que os PRDs deste repositório
usam. **As onze decisões foram ratificadas pelo mantenedor em 2026-08-31**, na
forma recomendada, e valem como decisão de produto vigente. Divergir de qualquer
uma delas durante a implementação exige editar esta SPEC primeiro — não um
comentário no código explicando por que se fez diferente.

---

## 1. Princípio que organiza tudo

> **Onde há saída, há escolha de canal — e o canal vem ANTES do template.**

Três corolários, que valem como critério de revisão:

1. **A escolha mora no recurso, não em Configurações.** Trocar o número padrão da
   conta nunca reescreve o que uma campanha, automação ou fluxo já decidiu. O
   padrão só decide quando ninguém escolheu — é a mesma regra do D-7 da 064,
   aplicada uma camada acima.
2. **Template pertence ao WABA, então lista de template sem canal é promessa
   quebrada.** Toda tela que lista `message_templates` sem filtrar pelo WABA do
   canal que vai enviar está oferecendo algo que a Meta recusa depois com
   `(#132001) Template name does not exist in the translation`. Isso já foi
   corrigido no inbox e na ficha do contato; as três telas restantes estão no §2.
3. **A resposta sai pelo canal da conversa.** Escolher canal num recurso
   **reativo** (automação disparada por mensagem, fluxo) é **escopo** — "para
   quais conversas este recurso vale" —, não rota de saída. Trocar de canal no
   meio de um diálogo continua existindo só como desvio explícito
   (`fallback_channel` das automações, transferência da SPEC 056). Sem essa
   distinção, "escolher canal na automação" viraria "responder no número B a
   quem escreveu para o número A".

---

## 2. Inventário: o que hoje ignora a escolha

Levantado no código, não presumido. Cada item é um ponto verificado.

### 2.A. Campanha — o seletor existe, no lugar errado

| # | Onde | O quê |
| --- | --- | --- |
| **A1** | `src/components/broadcasts/step4-schedule-send.tsx:105-141, 326-360` | O seletor "Enviar por" existe e funciona, mas está no **passo 4** — depois de template, audiência e personalização. O pedido é explícito: precisa vir **antes do template** |
| **A2** | `src/components/broadcasts/step1-choose-template.tsx:83-89` | Lista **todos** os templates `APPROVED` da conta, sem filtro de WABA. Com dois WABAs, o operador escolhe no passo 1 um template do WABA A e no passo 4 um número do WABA B — combinação que só falha na Meta |
| **A3** | `src/components/broadcasts/step1-choose-template.tsx:66-73` | Os candidatos a **variante B** do teste A/B saem da mesma lista não filtrada: um teste A/B pode nascer com braços de WABAs diferentes |
| **A4** | `src/app/(dashboard)/broadcasts/new/page.tsx:105-110` | A **retomada de rascunho** reidrata o template com `.eq(name).eq(language).maybeSingle()`. Com o mesmo nome aprovado em dois WABAs isso devolve `PGRST116` e o wizard manda "rascunho não encontrado" — falha alto, com a mensagem errada. Além disso, o rascunho **não** reidrata `broadcasts.channel_id`, que a 064 grava |
| **A5** | `src/components/broadcasts/test-send-dialog.tsx:128-137` | O **teste de envio** não manda `channelId` no corpo, embora `POST /api/broadcasts/test-send` (`route.ts:87`) e `sendBroadcastTestMessage` (`broadcast-test-send.ts:91,130`) já aceitem. Resultado: o teste sai pelo número padrão e a campanha pelo número escolhido — o teste deixa de testar a campanha |

### 2.B. Automações — não sabem o que é canal

| # | Onde | O quê |
| --- | --- | --- |
| **B1** | `automations` (migração 006/017) | **Não existe coluna de canal.** Uma automação de "Suporte" responde também às conversas do número de "Vendas", e não há como dizer o contrário sem trocar o padrão da conta |
| **B2** | `src/lib/automations/engine.ts:762-776` (`resolveConversationId`) | Resolve a conversa do contato com `.maybeSingle()` **sem canal**. Desde a migração 059 o índice único é `(account_id, contact_id, channel_id)` — um contato que fala com dois números da conta tem **duas** conversas, e a query erra com "multiple rows". Hoje o efeito é `conversation lookup failed`, que o motor registra como passo falho: **falha alto, motivo obscuro** |
| **B3** | mesmo ponto | Sem conversa nenhuma, lança `no conversation for contact`. É o que hoje impede um gatilho **"Baseado em horário"** (SPEC 046) ou **"Contato criado"** de enviar template para contato frio: não há conversa, e o motor não tem como saber por qual número abri-la |
| **B4** | `src/components/automations/automation-builder.tsx:405-412` | Lista de templates do passo `send_template` sem filtro de WABA — mesma classe do **A2** |
| **B5** | `src/components/automations/automation-builder.tsx:812-860` | **O precedente que valida o desenho desta SPEC**: o desvio `fallback_channel` já é um seletor de canal dentro do construtor, alimentado por `useFallbackChannels()`. A peça de UI existe; falta ela existir no **cabeçalho** da automação, não só num passo |

### 2.C. Fluxos — sempre reativos, e um só por contato

| # | Onde | O quê |
| --- | --- | --- |
| **C1** | `flows` (migração 010/017) | **Não existe coluna de canal.** Um fluxo de menu ativo responde igual nos dois números — não dá para ter "menu de Vendas" no número A e "menu de Suporte" no número B |
| **C2** | `supabase/migrations/017_account_sharing.sql:337-340` | `idx_one_active_run_per_contact` é `UNIQUE (account_id, contact_id) WHERE status='active'`. Com dois números, o mesmo contato conversando nos dois só consegue **uma** execução: a segunda colide (23505) e `startNewRun` (`flows/engine.ts:1233-1237`) devolve `duplicate_inbound_ignored`. **Falha em silêncio** — o cliente escreve no segundo número e o fluxo simplesmente não responde |
| **C3** | `src/lib/flows/engine.ts:181` (`loadActiveRunForContact`) | Mesma premissa "uma execução por contato" no código que lê. Anda junto com o índice do C2 |

### 2.D. Webhook de entrada / ingestão (SPEC 055)

| # | Onde | O quê |
| --- | --- | --- |
| **D1** | `src/app/api/v1/ingest/contact/route.ts:319-325` | Chama `sendIngestTemplate` **sem `channelId`**, embora `lib/ingest/send.ts:73,96,135` já aceite. O template é resolvido por **id** (`send.ts:103-107`) — e o id carrega `waba_id`. Resultado: o template pode ser do WABA B e a credencial do canal padrão (WABA A). **Mismatch silencioso**, que só aparece como `(#132001)` no log de falhas do webhook |

### 2.E. O paradigma que já está certo — é este que se estende

Duas superfícies já fazem exatamente o que o mantenedor descreveu, e são o modelo
a copiar (não a reinventar):

| Onde | Como faz |
| --- | --- |
| `src/components/inbox/template-picker.tsx:29-43, 128-140` | Recebe `channelId` da thread, resolve o `waba_id` daquele canal e filtra a lista com `templateBelongsToWaba`. O cabeçalho documenta o bug que isso corrige |
| `src/components/contacts/contact-detail-view.tsx:108-130` | `effectiveTemplateChannelId` — **uma** variável que alimenta ao mesmo tempo o filtro da lista **e** o `channel_id` do envio. O comentário registra o achado de review: usar uma para listar e outra para enviar reproduz o `#132001` que o filtro existia para evitar |

**A regra que sai daí, e que esta SPEC promove a invariante:** a variável que
filtra a lista de templates e a que vai no `channel_id` do envio são **a mesma
variável**. Sempre.

### 2.F. O que **não** muda (verificado, para ninguém "consertar" à toa)

- **Resolução de credencial.** `resolveCloudConfig`, `resolveChannelContext` e
  `resolveDefaultChannelId` já fazem o certo desde a 064 F2/F3. Esta SPEC só passa
  a **dizer qual canal** em pontos que hoje ficam calados.
- **Inbox.** Seletor de canal, selo por conversa, composer por capacidade e
  filtro de templates já existem (SPEC 049 §4 + 064 D-2).
- **Envio pela API pública.** `POST /api/v1/messages` e `POST /api/v1/broadcasts`
  já aceitam `channel_id` (`app/api/v1/broadcasts/route.ts:86-99`).
- **Desvio de canal e transferência.** `fallback_channel` (automações) e SPEC 056
  já trabalham com `channels.id` explícito — e continuam sendo o **único** jeito
  legítimo de trocar de canal no meio de um diálogo (§1, corolário 3).
- **Webhook de entrada da Meta.** Roteia por `phone_number_id`; dois números da
  mesma conta já chegam certo (064 §1.1.F).
- **RLS.** Nenhuma política muda: `automations`/`flows` continuam escopadas por
  conta, e `channels_select` já é `is_account_member`.

---

## 3. Decisões que precisam da sua aprovação

### D-1 — Onde a campanha escolhe o número · **recomendação: passo novo, o primeiro do assistente**

| Opção | A favor | Contra |
| --- | --- | --- |
| **A. "Enviar por" vira o passo 1; template passa a 2** (recomendada) | É literalmente o pedido; o passo seguinte já nasce filtrado pelo WABA certo; teste A/B, teste de envio e rascunho herdam o canal sem regra extra | Renumera os passos e mexe no indicador de etapas |
| B. Manter no passo 4 e filtrar o passo 1 pelo canal padrão | Zero mudança de navegação | O operador escolhe template do padrão e depois troca de número — a lista fica errada **para trás**, que é o bug que se quer matar |
| C. Seletor fixo no topo do assistente, fora dos passos | Sempre visível | Some no scroll do passo 2/3; e "sempre visível" com um número só é ruído |

**Recomendação: A.** Com **um** canal elegível, o passo **não aparece** e o
assistente continua com quatro etapas exatamente como hoje — a conta de um número
só não vê diferença nenhuma. Com dois ou mais, aparece como passo 1, com o canal
padrão **pré-selecionado** (é o que o pedido descreve: "sempre aparecerá como
selecionado").

**Critério de elegibilidade** — o mesmo que o passo 4 já usa hoje, e pelo mesmo
motivo documentado lá (`step4-schedule-send.tsx:109-116`): `type='whatsapp_cloud'`
e `status <> 'disabled'`. **Nunca** filtrar por `status='connected'`: o padrão em
`error` precisa aparecer na lista, com o selo de "não conectado", para que o
operador possa **trocar** para o número saudável. Esconder o quebrado atrás de
"só há uma opção" foi o bug que aquele comentário registra.

O seletor do passo 4 **sai** — vira um resumo somente leitura no card de
confirmação ("Enviar por: Vendas — +55 11 …"), com um link "alterar" que volta ao
passo 1. Dois seletores para a mesma decisão é a segunda fonte de verdade que
sempre acaba divergindo.

### D-2 — Lista de templates sempre derivada do canal · **recomendação: um hook único, três telas convertidas**

Hoje a regra "este template serve para este canal?" está implementada em
`lib/whatsapp/template-waba.ts` (certo) e **reimplementada ou ignorada** em quatro
telas. A recomendação é um único hook cliente —
`useChannelTemplates(channelId)` — que resolve `canal → whatsapp_config.waba_id →
templates` e filtra com `templateBelongsToWaba`, usado por:

- passo "escolher template" da campanha (A2) e o seletor de variante B (A3);
- construtor de automações (B4);
- o `TemplatePicker` do inbox e a ficha do contato (que hoje fazem isso à mão —
  passam a consumir o hook, sem mudar de comportamento).

Templates **legados** (`waba_id IS NULL`) continuam aparecendo em todas as listas:
`templateBelongsToWaba` já os trata como pertencentes a qualquer WABA, e a 064 D-2
decidiu que nada some da lista de ninguém.

### D-3 — Compatibilidade template×canal validada no servidor · **recomendação: erro nosso, legível, antes da Meta**

Filtrar a lista resolve o caminho feliz. Não resolve: rascunho antigo, chamada de
API, automação cujo canal foi trocado depois, campanha agendada cujo template foi
recriado em outro WABA.

**Recomendação:** uma função `assertTemplateChannelCompatible(db, { accountId,
channelId, templateName, templateLanguage })` em `lib/whatsapp/`, chamada no
início de todo caminho de saída com template (campanha, teste de envio,
automação, ingestão, `/api/v1`). Falha com código estável
**`template_waba_mismatch`** e mensagem que nomeia as duas pontas:

> `Template 'promo_agosto' pertence à conta do WhatsApp Business 1234…, e o canal
> 'Vendas' envia pela 9876…. Escolha um template do mesmo WABA ou outro número.`

Mensagens de `/api/**` ficam em inglês (AGENTS.md); a UI traduz.

**Por que é o servidor que valida:** é o único ponto por onde os cinco caminhos
passam, e é onde a campanha agendada — criada há três dias — é finalmente
disparada.

### D-4 — O que "canal" significa numa automação · **recomendação: uma coluna, com as duas funções, e a regra de saída inalterada**

| Opção | A favor | Contra |
| --- | --- | --- |
| **A. `automations.channel_id` — NULL = todos os canais** (recomendada) | Uma coisa só para explicar na UI: "esta automação vale para o número X". Quando definido: (1) o gatilho **só dispara** em eventos daquele canal; (2) os passos de envio **sem conversa** abrem a conversa naquele canal (D-5) | Junta duas semânticas numa coluna; um caso exótico ("dispara em qualquer conversa mas responde pelo B") fica sem expressão |
| B. Duas colunas: `trigger_channel_id` + `send_channel_id` | Expressa o caso exótico | O caso exótico é **trocar de canal no meio do diálogo**, que já tem nome e caminho próprio (`fallback_channel`). Duas colunas convidariam o operador a construir esse cruzamento por acidente |

**Recomendação: A.** E a invariante do §1 continua valendo sem exceção: **em
conversa existente, a resposta sai pelo canal da conversa** — `channel_id` na
automação nunca redireciona uma resposta, só decide se aquela automação é da conta
daquele número.

Efeito prático para o mantenedor: para ter comportamentos diferentes por número,
duplica-se a automação e escopa-se cada cópia — sem nunca mais tocar no padrão de
Configurações.

### D-5 — Automação sem conversa passa a poder enviar · **recomendação: sim, e só quando o canal foi escolhido**

Hoje "Baseado em horário" e "Contato criado" morrem em `no conversation for
contact` (B3). Com `automations.channel_id` definido, `resolveConversationId`
passa a chamar `findOrCreateConversation(db, accountId, contactId, channelId,
automation.user_id)` — a função que já existe, com o tratamento de corrida já
escrito.

**Sem `channel_id`, o comportamento não muda: continua falhando com o mesmo
motivo.** Abrir conversa no canal padrão "porque sim" é exatamente o
comportamento implícito que esta SPEC existe para eliminar — e, num contato frio,
significaria iniciar diálogo por um número que ninguém escolheu.

Duas guardas herdadas, que **não** são relaxadas:

- **janela de 24 h**: conversa recém-criada não tem `last_customer_message_at`,
  então só passo de **template** atravessa; texto livre cai na guarda de janela
  (SPEC 045) e no `fallback_channel`, se configurado;
- **teto de envio frio** (`checkColdSend`, SPEC 049 §6.2) continua valendo para
  canal sem janela — negar é SKIP, não falha.

E o B2 é corrigido de graça: com canal conhecido, a busca de conversa ganha
`.eq('channel_id', …)` e o `PGRST116` desaparece. **Sem canal escolhido**, a busca
passa a ordenar por `last_message_at DESC` e pegar a primeira (`.limit(1)`), em vez
de `.maybeSingle()` — a conversa mais recente é a resposta menos surpreendente, e
nunca um erro.

### D-6 — Escopo de canal em fluxos · **recomendação: `flows.channel_id`, NULL = todos**

Fluxo é 100% reativo (gatilhos `keyword` / `first_inbound_message`), então aqui
**só** existe a função de escopo — não há "enviar por" a decidir, porque a
resposta sempre sai pelo canal da conversa. O filtro entra em
`dispatchInboundToFlows`, junto do `channel_id` que `lib/channels/ingest.ts` já
tem em mãos.

Regra de precedência quando dois fluxos casam a mesma palavra-chave: **o escopado
ganha do genérico**. Um fluxo criado para o número de Suporte não pode perder para
o menu geral só porque foi criado depois.

### D-7 — Execução ativa de fluxo passa a ser por conversa · **recomendação: sim — é o C2, e ele falha calado**

`idx_one_active_run_per_contact` vira:

```sql
CREATE UNIQUE INDEX idx_one_active_run_per_conversation
  ON flow_runs (account_id, conversation_id)
  WHERE status = 'active' AND conversation_id IS NOT NULL;
```

`conversation_id` é `NULL`-able (`ON DELETE SET NULL`, migração 010) — daí o
predicado. Uma execução cuja conversa foi apagada está órfã de qualquer forma; o
varredor do cron a encerra por tempo.

**Não há backfill a fazer:** o índice antigo garantia no máximo uma execução ativa
por contato, então nenhuma linha existente viola o novo.

`loadActiveRunForContact` (C3) vira `loadActiveRunForConversation`, e
`isDuplicateInbound` passa a chavear pela conversa. Sem esta decisão, o D-6 fica
pela metade: dois fluxos escopados a dois números nunca rodariam em paralelo para
o mesmo cliente.

### D-8 — O que acontece quando o canal escolhido some · **recomendação: desativar o recurso, nunca "voltar a valer para todos"**

FK `ON DELETE SET NULL` sozinho tem um efeito perverso: apagar o canal faria a
automação escopada voltar **silenciosamente** a valer para todos os números.

**Recomendação:** `ON DELETE SET NULL` **+** trigger que, ao ver `channel_id` ir
de preenchido para `NULL`, marca o recurso como inativo (`automations.is_active =
FALSE`, `flows.status = 'draft'`) e registra o motivo. O operador reativa
conscientemente, escolhendo outro número.

O caso é raro por construção: pela 064 D-12, canal **com** conversas nunca é
apagado — vira `disabled`. Para esse caso, a regra é a mesma da campanha
(064 D-3): **o motor recusa disparar por canal `disabled`**, com motivo legível
(`channel_unavailable`) no log da automação, e a UI mostra o aviso no cartão do
recurso. Nunca trocar de número sozinho.

### D-9 — Webhook de entrada / ingestão · **recomendação: aceitar `channel_id` e, na ausência, derivar do template**

Duas mudanças em `POST /api/v1/ingest/contact` (SPEC 055):

1. aceita **`channel_id`** opcional no corpo, validado contra a conta (mesmo
   tratamento de `resolveConversationByPhone`: id de outra conta → 400, nunca 404);
2. quando ausente **e** há `template_id`, deriva o canal do **WABA do template** —
   se exatamente um canal Cloud daquele WABA existir. Havendo mais de um, ou
   nenhum, cai no canal padrão e a validação do D-3 decide.

É o que fecha o D1 do inventário sem obrigar toda integração existente a mudar de
payload. Exige as três edições de contrato do AGENTS.md (`docs/public-api.md`,
`public/openapi.json`, `public/openapi.pt-BR.json`).

### D-10 — Vocabulário da interface · **decisão sua, é o que o cliente lê**

O código diz "canal"; o mantenedor disse "conexão"; o cliente final pensa em
"número". Sugestão para ratificar:

| Contexto | Rótulo sugerido |
| --- | --- |
| Campanha (saída) | **"Enviar por"** — já existe em `Broadcasts.wizard.scheduleSend.sendFrom` |
| Automação / fluxo (escopo) | **"Vale para o número"**, com a opção padrão **"Todos os números"** |
| Item da lista | `{nome do canal} — {telefone}` + selos "padrão" / "não conectado" (já existem: `sendFromDefault`, `sendFromUnhealthy`) |

Chave nova exige a mesma chave em `en.json` e `pt-BR.json` (`npm run i18n:check`).

### D-11 — Fora do escopo, com dívida registrada · **recomendação: manter fora**

- **IA (rascunho e resposta automática).** Já responde pelo canal da conversa. Um
  *agente por número* ("IA de Vendas" ≠ "IA de Suporte") é produto novo:
  `ai_configs.channel_id`, fila própria de prompts, e uma tela que ainda não
  existe. Fica registrado no §13.
- **Nó de template em fluxos.** Fluxos não têm `send_template` hoje (só
  `send_message`/`buttons`/`list`/`media`), então não há lista de template a
  filtrar ali. Se um dia houver, ele nasce consumindo o hook do D-2.
- **Métricas por número.** O painel continua por conta. A campanha já grava
  `channel_id`, então o corte existe no dado — falta só a tela, e ela não é
  pré-requisito de nada aqui.

---

## 4. Modelo de dados — migração `075_resource_channel_selection.sql`

Idempotente, com bloco de asserções final que falha alto, no padrão das
`055`/`067`/`071`/`072`.

### 4.1. Canal do recurso

```sql
ALTER TABLE automations ADD COLUMN IF NOT EXISTS channel_id UUID;
ALTER TABLE flows       ADD COLUMN IF NOT EXISTS channel_id UUID;

-- ON DELETE SET NULL + trigger de desativação (D-8). SET NULL sozinho
-- faria a automação escopada voltar a valer para TODOS os canais sem
-- ninguém pedir.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'automations_channel_id_fkey'
                    AND conrelid = 'public.automations'::regclass) THEN
    ALTER TABLE automations
      ADD CONSTRAINT automations_channel_id_fkey
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'flows_channel_id_fkey'
                    AND conrelid = 'public.flows'::regclass) THEN
    ALTER TABLE flows
      ADD CONSTRAINT flows_channel_id_fkey
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN automations.channel_id IS
  'SPEC 065 D-4. NULL = vale para todos os canais (comportamento anterior). Preenchido: o gatilho so dispara em eventos deste canal E os envios sem conversa abrem a conversa nele. NUNCA redireciona resposta de conversa existente.';
COMMENT ON COLUMN flows.channel_id IS
  'SPEC 065 D-6. NULL = vale para todos os canais. Escopo do gatilho apenas — flow sempre responde pelo canal da conversa.';
```

**Backfill: nenhum, de propósito.** `NULL` significa "todos os canais", que é
exatamente o comportamento de hoje. Toda automação e todo fluxo existentes
continuam funcionando sem tocar em uma linha de dado. É o que torna esta migração
reversível de verdade (§10).

### 4.2. Índices de despacho

O motor passa a filtrar `channel_id IS NULL OR channel_id = $1` no caminho quente
(uma consulta por mensagem recebida):

```sql
CREATE INDEX IF NOT EXISTS idx_automations_active_trigger_channel
  ON automations (trigger_type, channel_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_flows_active_trigger_channel
  ON flows (account_id, trigger_type, channel_id) WHERE status = 'active';
```

### 4.3. Desativação ao perder o canal (D-8)

```sql
CREATE OR REPLACE FUNCTION deactivate_resource_on_channel_loss()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.channel_id IS NOT NULL AND NEW.channel_id IS NULL THEN
    IF TG_TABLE_NAME = 'automations' THEN
      NEW.is_active := FALSE;
    ELSE
      NEW.status := 'draft';
    END IF;
    RAISE NOTICE '065: % % desativada — canal % foi removido.',
      TG_TABLE_NAME, OLD.id, OLD.channel_id;
  END IF;
  RETURN NEW;
END $$;
```

`BEFORE UPDATE OF channel_id` nas duas tabelas. `BEFORE`, não `AFTER`: só ali dá
para alterar `NEW`. A ação do FK (`SET NULL`) é um `UPDATE` como qualquer outro,
então o gatilho vê.

### 4.4. Execução ativa de fluxo por conversa (D-7)

```sql
DROP INDEX IF EXISTS idx_one_active_run_per_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_conversation
  ON flow_runs (account_id, conversation_id)
  WHERE status = 'active' AND conversation_id IS NOT NULL;
```

⚠️ **A ordem importa e o `DROP` vem primeiro** — enquanto o índice antigo existir,
a segunda execução (outro canal, mesmo contato) continua colidindo, e o novo
índice não teria efeito observável.

### 4.5. Asserções finais

No padrão da casa, `RAISE EXCEPTION` para cada invariante: as duas colunas
existem, os dois FKs existem com `ON DELETE SET NULL`, os dois gatilhos existem,
`idx_one_active_run_per_conversation` existe, `idx_one_active_run_per_contact`
**não** existe mais, e nenhuma linha de `automations`/`flows` aponta para canal de
**outra conta**:

```sql
IF EXISTS (SELECT 1 FROM automations a JOIN channels c ON c.id = a.channel_id
            WHERE c.account_id <> a.account_id)
  THEN RAISE EXCEPTION '065: automacao apontando para canal de outra conta.'; END IF;
```

Fecha com `NOTIFY pgrst, 'reload schema';` — as colunas novas precisam entrar no
cache do PostgREST, senão o primeiro `PATCH` com `channel_id` volta `PGRST204`.

> ⚠️ Aplicar **primeiro em `vn`**, só depois em `rs`, e **sempre com autorização
> explícita do mantenedor** (AGENTS.md).

---

## 5. Núcleo TypeScript

### 5.1. `src/lib/channels/selectable.ts` (novo) — a regra única de elegibilidade

Hoje "quais canais podem aparecer neste seletor" está escrito quatro vezes, com
critérios sutilmente diferentes (`step4-schedule-send.tsx:118-132`,
`contact-detail-view.tsx:108-114`, `use-fallback-channels.ts`,
`use-transfer-channels.ts`). O bug que o comentário do passo 4 registra nasceu
exatamente dessa divergência.

```ts
export type ChannelPurpose = 'broadcast' | 'templates' | 'scope';

/** Canais que podem ser ESCOLHIDOS para um propósito, na ordem em que
 *  a UI deve mostrá-los. `connected` antes de `default`: um padrão em
 *  `error` não pode ganhar de um número saudável só por ser o padrão. */
export function selectableChannels(
  channels: Channel[],
  purpose: ChannelPurpose
): Channel[];
```

Regras, iguais para todo mundo: exclui `status='disabled'`; **não** exclui
`error`/`disconnected` (eles aparecem com selo, para poderem ser trocados); filtra
por capacidade (`can(type, 'broadcast' | 'templates')`); `'scope'` aceita qualquer
tipo, porque escopar automação a uma instância QRCode é legítimo.

### 5.2. `src/lib/whatsapp/templates-for-channel.ts` (novo) + hook

```ts
/** waba_id do canal — `null` para canal não-Cloud ou config sem WABA. */
export async function wabaIdOfChannel(db, accountId, channelId): Promise<string | null>;

/** Templates APPROVED visíveis para este canal, aplicando
 *  `templateBelongsToWaba` (legados entram). */
export function templatesForChannel(all: MessageTemplate[], wabaId: string | null): MessageTemplate[];
```

E o hook cliente `useChannelTemplates(channelId)` em `src/hooks/`, que as quatro
telas do D-2 consomem. A regra de decisão continua sendo **uma só**:
`templateBelongsToWaba`, já testada em `template-waba.test.ts`.

### 5.3. `assertTemplateChannelCompatible` (D-3)

Em `src/lib/whatsapp/template-waba.ts`, ao lado da regra que ela usa. Lança
`TemplateChannelMismatchError` (código `template_waba_mismatch`, HTTP 400), que
as rotas mapeiam. Chamadores: `broadcast-core.ts` (planejamento), `broadcast-dispatch.ts`
(disparo, inclusive o agendado que o cron acorda), `broadcast-test-send.ts`,
`automations/meta-send.ts`, `ingest/send.ts`.

### 5.4. Motor de automações

| Arquivo | Mudança |
| --- | --- |
| `engine.ts` — `DispatchInput` | ganha `channelId?: string \| null`, preenchido por `lib/channels/ingest.ts` (que já o tem) |
| `engine.ts` — seleção de automações | `.or('channel_id.is.null,channel_id.eq.<id>')`. Sem `channelId` no despacho (POST manual do `/api/automations/engine`), só as `channel_id IS NULL` rodam — nunca "todas" |
| `engine.ts:762-776` — `resolveConversationId` | passa a receber o canal efetivo: com canal, `.eq('channel_id', …)` + `findOrCreateConversation` quando não existe (D-5); sem canal, `.order('last_message_at', desc).limit(1)` em vez de `.maybeSingle()` (fim do B2) |
| `schedule-scan.ts` / `window-scan.ts` | passam o `channel_id` da automação adiante — as duas varreduras já chamam `runSingleAutomation`, então herdam sem lógica nova |
| `validate.ts` | canal inexistente, de outra conta, `disabled`, ou incapaz do passo configurado → erro de ativação, **não** falha silenciosa no disparo |

### 5.5. Motor de fluxos

| Arquivo | Mudança |
| --- | --- |
| `flows/engine.ts` — `dispatchInboundToFlows` | filtra por `channel_id IS NULL OR = <id>`; **escopado ganha do genérico** (D-6) na ordenação de candidatos |
| `flows/engine.ts:181` | `loadActiveRunForContact` → `loadActiveRunForConversation` (D-7) |
| `flows/engine.ts` — `isDuplicateInbound` | chaveia por conversa, não por contato |
| `flows/validate.ts` | mesma validação de canal do 5.4 |

---

## 6. Rotas de API

| Rota | Mudança |
| --- | --- |
| `POST /api/automations`, `PATCH /api/automations/[id]` | `channel_id` entra na lista de campos aceitos (`[id]/route.ts:86-94`) e é validado contra a conta antes do `UPDATE` |
| `POST /api/flows`, `PUT /api/flows/[id]` | idem |
| `POST /api/broadcasts/test-send` | nenhuma (já aceita `channelId`) — quem muda é a UI (A5) |
| `POST /api/whatsapp/broadcast` | passa a rodar `assertTemplateChannelCompatible` antes de planejar |
| `POST /api/v1/ingest/contact` | aceita `channel_id`; deriva do WABA do template quando ausente (D-9) |
| `GET /api/channels` (ou equivalente já usado pelos hooks) | nenhuma — a lista já vem por RLS |

Erros novos, com código estável para a UI traduzir: `template_waba_mismatch`,
`channel_not_in_account`, `channel_unavailable` (este último já existe na
campanha desde a 064 D-3).

---

## 7. Interface

### 7.1. Assistente de disparo

- Passo **1 "Enviar por"** (D-1), presente só com ≥ 2 canais elegíveis; padrão
  pré-selecionado; cartão por canal com nome, telefone e selos.
- Passo de template consome `useChannelTemplates(channelId)`; trocar o canal
  **limpa** template e variante selecionados, com aviso — o mesmo cuidado que
  `handleTemplateSelect` já toma com a variante B (`new/page.tsx:139-148`).
- Passo 4: "Enviar por" vira linha do resumo, com link "alterar".
- Teste de envio manda o mesmo `channelId` (A5).
- Retomada de rascunho lê `broadcasts.channel_id` e reidrata o template **por
  WABA** com `findTemplateRowForWaba`, não com `.maybeSingle()` (A4).

### 7.2. Construtor de automações

- Campo **"Vale para o número"** no cabeçalho (ao lado de nome/gatilho), com
  "Todos os números" como primeira opção e padrão.
- Lista de templates do passo `send_template` filtrada pelo canal escolhido; com
  "Todos os números", a lista mostra os templates de todos os WABAs com o selo do
  WABA de cada um — e o D-3 protege o envio.
- Aviso quando o canal escolhido não é capaz do passo configurado — reaproveita o
  `ChannelCapabilityWarning` que já existe (`automation-builder.tsx:1266-1290`).

### 7.3. Editor de fluxos

- Mesmo campo "Vale para o número" no cabeçalho (`components/flows/header.tsx`).
- Aviso de escopo quando o fluxo escopado tem palavra-chave em conflito com um
  fluxo genérico ativo (a precedência do D-6 explicada onde ela acontece).

### 7.4. Listas

Cartão de automação, de fluxo e de campanha ganham o selo do número quando a
conta tem mais de um canal — mesma regra do selo do inbox: com um canal só, é
ruído em toda linha.

### 7.5. i18n

Chaves novas em `messages/en.json` **e** `messages/pt-BR.json`, mesma árvore.
Reaproveitar `Broadcasts.wizard.scheduleSend.sendFrom*`, que já existe nos dois.
`npm run i18n:check` faz parte do gate.

---

## 8. API pública e integrações

- `POST /api/v1/ingest/contact` ganha `channel_id` (D-9).
- `POST /api/v1/broadcasts` já aceita `channel_id`; a documentação passa a dizer
  **que a compatibilidade template×WABA é validada** e qual erro volta.
- Os três arquivos de contrato mudam **juntos, na mesma alteração**:
  `docs/public-api.md`, `public/openapi.json`, `public/openapi.pt-BR.json` —
  com `npx @redocly/cli lint` nos dois e conferência de paridade estrutural
  (só `summary`/`description` divergem).
- **MCP** (`mcp-server/`): as ferramentas que criam campanha/automação passam a
  expor `channel_id` opcional. Sem isso, o assistente só consegue operar o canal
  padrão — exatamente a limitação que esta SPEC remove na UI.

---

## 9. Plano de implementação — fases, modelo e sessão

Cada fase é **um PR** e passa o gate do §14 antes de virar candidato a commit.
Commits e push são manuais (o agente entrega o comando pronto).

### 9.1. Como o modelo foi escolhido

Mesma régua da 064 §8.1 — a primeira pergunta que responder "sim" decide:

1. **Erro silencioso ou irreversível?** (migração, índice de concorrência,
   roteamento de credencial) → **Opus 5**.
2. **Padrão já fixado, fase é extensão dele?** → **Sonnet 5**.
3. **Mecânico e verificável por ferramenta?** (i18n, contrato, log) → **Sonnet 5**.

### 9.2. As fases

| # | Fase | Escopo | Entrega verificável | Modelo | Sessão |
| --- | --- | --- | --- | --- | --- |
| **F1** | Migração | `075` inteira (§4) + asserções + `NOTIFY pgrst` | Aplicada em **vn** só após sua autorização; `rs` depois. Automação e fluxo existentes continuam disparando | **Opus 5** | Nova, dedicada |
| **F2** | Núcleo | §5.1-5.3: `selectableChannels`, `templatesForChannel`, `assertTemplateChannelCompatible` + testes que **falham antes** | Suíte cobrindo mismatch, legado (`waba_id NULL`) e canal `disabled` | **Opus 5** | Nova |
| **F3** | Motor de automações | §5.4 + rotas do §6 + o fim do B2/B3 | Automação escopada só dispara no seu número; "Baseado em horário" envia para contato frio pelo canal escolhido | **Opus 5** | Continua a F2 |
| **F4** | Motor de fluxos | §5.5 + D-7 (índice já criado na F1) | Mesmo contato mantém execução ativa **em cada** número, em paralelo | **Opus 5** | Continua a F3 |
| **F5** | Assistente de disparo | §7.1 inteiro (passo novo, filtro, resumo, teste de envio, rascunho) | Campanha sai pelo número escolhido, com template do WABA certo, e o teste sai pelo mesmo | **Sonnet 5** | Nova |
| **F6** | Construtores | §7.2, §7.3, §7.4 + i18n (§7.5) | Escolher número em automação e fluxo pela interface, com aviso de capacidade | **Sonnet 5** | Continua a F5 |
| **F7** | API pública + MCP | §8 e os três arquivos de contrato | `redocly lint` verde nos dois `openapi*.json` + paridade estrutural | **Sonnet 5** | Nova |
| **F8** | Observabilidade | §11 | Consulta de auditoria devolvendo zero linhas em produção | **Sonnet 5** | Continua a F7 |
| **F9** | Teste manual | §12 | Checklist assinado | — | Você |

### 9.3. Caminho crítico

```
F1 → F2 → F3 → F4 → F9
          ↘ F5 → F6 ↗
          ↘ F7 → F8 ↗
```

F5/F6 (interface) e F7/F8 (contrato e log) só dependem da F2 e podem correr em
paralelo com F3/F4, em sessões distintas. **F9 exige todas.** Nada antes da F1.

### 9.4. Fronteiras de sessão

- **F1 sozinha** — é a única fase irreversível, e o índice do D-7 mexe em
  concorrência de execução.
- **F2+F3+F4 juntas** — F3 e F4 são os consumidores das funções que a F2 define;
  separar faria a sessão seguinte redescobrir assinaturas.
- **F5+F6 juntas** — as duas consomem o mesmo hook e o mesmo vocabulário (D-10).

---

## 10. Reversão e ponto sem retorno

**Esta SPEC é quase inteiramente reversível**, e isso é projeto, não sorte:
`channel_id NULL` = comportamento de hoje. Reverter o código sem reverter a
migração deixa duas colunas ignoradas e nada quebrado.

Um ponto exige atenção: **o índice do D-7**. Depois que dois fluxos ativos
coexistirem para o mesmo contato em canais diferentes, recriar
`idx_one_active_run_per_contact` falha (violação de unicidade). A reversão
naquele ponto passa por encerrar as execuções excedentes antes:

```sql
UPDATE flow_runs SET status = 'timed_out', ended_at = NOW(), end_reason = 'reverting_065'
WHERE status = 'active' AND id NOT IN (
  SELECT DISTINCT ON (account_id, contact_id) id FROM flow_runs
  WHERE status = 'active' ORDER BY account_id, contact_id, started_at DESC);
```

---

## 11. Observabilidade

- `logOutboundSend` (`lib/channels/send-log.ts`) já grava canal e origem. Passa a
  registrar também **de onde veio a escolha**: `channel_source: 'resource' |
  'conversation' | 'default'`. É a única forma de responder depois "esta mensagem
  saiu pelo número B porque alguém escolheu, ou porque caiu no padrão?".
- `automation_logs` ganha o motivo estável `channel_unavailable` quando o canal
  gravado está `disabled` (D-8).
- Consulta de auditoria que deve devolver **zero linhas** em produção depois da
  F4 — recurso escopado a canal de outra conta:

```sql
SELECT 'automation' AS kind, a.id, a.channel_id FROM automations a
  JOIN channels c ON c.id = a.channel_id WHERE c.account_id <> a.account_id
UNION ALL
SELECT 'flow', f.id, f.channel_id FROM flows f
  JOIN channels c ON c.id = f.channel_id WHERE c.account_id <> f.account_id;
```

- Sinal de saúde: proporção de envios com `channel_source='default'` **caindo**
  depois da F5/F6 é a evidência de que a escolha está sendo usada.

---

## 12. Teste manual (F9) — contra número real

Pré-requisito: conta com **dois** números oficiais conectados (WABAs distintos, de
preferência), cada um com pelo menos um template aprovado exclusivo.

| # | O quê | Esperado |
| --- | --- | --- |
| 1 | Conta com **um** número: abrir o assistente de disparo | Quatro passos, sem "Enviar por" — idêntico a hoje |
| 2 | Conta com dois: abrir o assistente | Passo 1 "Enviar por", com o **padrão pré-selecionado** |
| 3 | Escolher o número B e avançar | Lista de templates mostra só os do WABA de B (+ legados) |
| 4 | Voltar, trocar para A | Template e variante limpos, com aviso; lista agora é a de A |
| 5 | Enviar teste no passo 3 | Mensagem chega **pelo número escolhido**, não pelo padrão |
| 6 | Disparar a campanha | `broadcasts.channel_id` = canal escolhido; a mensagem chega por ele |
| 7 | Agendar por B, trocar o padrão da conta para A, esperar o cron | Sai por **B** |
| 8 | Desativar B e disparar campanha agendada nele | Falha legível `channel_unavailable`; **não** troca de número sozinha |
| 9 | Automação escopada a A; cliente escreve para B | Automação **não** dispara |
| 10 | Mesma automação; cliente escreve para A | Dispara e responde por A |
| 11 | Automação "Todos os números" | Dispara nos dois, cada um respondendo por si |
| 12 | Automação escopada a B, gatilho "Baseado em horário", contato **sem** conversa | Conversa criada em B, template entregue |
| 13 | Mesma automação sem canal escolhido | Não envia; log diz "sem conversa para o contato" (comportamento de hoje) |
| 14 | Fluxo escopado a A e fluxo genérico com a mesma palavra-chave; cliente escreve para A | Vence o **escopado** |
| 15 | Mesmo contato escreve nos dois números, dois fluxos escopados | **Duas** execuções ativas, uma por conversa; ambas respondem |
| 16 | Apagar um canal **sem** conversas usado por uma automação ativa | Automação fica inativa, com motivo; **não** volta a valer para todos |
| 17 | `POST /api/v1/ingest/contact` com `channel_id` de outra conta | 400, sem revelar se o id existe |
| 18 | Mesmo endpoint, sem `channel_id`, template do WABA de B | Sai por B (derivação do D-9) |
| 19 | Campanha via API com template de A e `channel_id` de B | 400 `template_waba_mismatch`, antes de qualquer envio |
| 20 | Toda a interface em `pt-BR` e `en` | Sem chave crua na tela |

---

## 13. Deixado para depois (dívida registrada)

1. **Agente de IA por número** (`ai_configs.channel_id`) — D-11.
2. **Nó `send_template` em fluxos** — quando existir, consome o hook do D-2.
3. **Painel por número** — o dado já está em `broadcasts.channel_id` e
   `messages.channel_id`; falta a tela.
4. **Caso "dispara em qualquer conversa, responde por X"** — deliberadamente sem
   expressão (D-4, opção B). Se aparecer demanda real, é `send_channel_id` como
   coluna adicional, não como reinterpretação de `channel_id`.
5. **Escopo por canal em outros recursos** (webhooks de saída, exportações,
   políticas de retenção por canal) — nenhum deles envia mensagem, então nenhum
   sofre do problema que esta SPEC resolve.

---

## 14. Validação antes de entregar cada fase

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

Além do gate, por fase:

- **F1** — migração aplicada em `vn` (com sua autorização) e as asserções passando;
  automação e fluxo existentes disparando no mesmo deploy.
- **F2** — os testes novos **falham** no código antigo (é o que prova que testam
  a mudança, não a suposição de quem escreveu).
- **F3/F4** — `engine.test.ts`, `engine.fallback-channel.test.ts` e os testes de
  fluxo verdes **sem** relaxar asserção existente.
- **F7** — `npx @redocly/cli lint` nos dois `openapi*.json` + paridade estrutural
  de chaves.

Commits e push seguem manuais: o agente entrega o comando pronto, o mantenedor
executa.
