# SPEC 070 — Editar um disparo em rascunho

| Campo            | Valor                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Status           | **Proposta** — aguardando ratificação das decisões D-1…D-12                                                                        |
| Data             | 2026-09-03                                                                                                                         |
| Escopo           | Disparos — retomar, alterar, salvar e concluir uma campanha com `status = 'draft'`                                                 |
| Depende de       | SPEC 044 (triagem e agendamento), SPEC 057 (audiência persistente), SPEC 064/065 (canal por recurso), SPEC 069 (checar antes)      |
| Migração         | **Nenhuma.** Todas as colunas usadas já existem (001, 048, 051, 072, 076, 078) — ver §1.4                                          |
| Dependências npm | Nenhuma                                                                                                                            |

---

## Contexto

A lista de Disparos mostra campanhas com o badge **Rascunho**
(`broadcasts.status = 'draft'`). Elas existem, ocupam espaço na lista e
carregam uma audiência inteira já triada — mas **não há nenhum botão que
abra uma delas para continuar o trabalho**. Clicar na linha leva a
`/broadcasts/[id]`, uma tela de resultados com seis cartões zerados e uma
tabela de destinatários vazia: a foto de uma campanha que nunca aconteceu.

### De onde vem um rascunho hoje

Vale ler o ciclo real antes de projetar a edição, porque ele não é o que o
código sugere à primeira vista.

1. No passo **Audiência** (`step2-select-audience.tsx`), qualquer que seja
   a fonte escolhida — todos os contatos, etiquetas, campo personalizado,
   planilha local, Google Planilhas — o único botão de avanço chama
   `handleAnalyze`, que faz `POST /api/broadcasts/audience/stage`.
2. `stageAudience` (`src/lib/audience/stage.ts:485`) resolve o filtro em
   linhas e **cria a linha de `broadcasts`**:

   ```
   name: templateName        ← placeholder; "o nome real só é escolhido no passo 4"
   template_name / template_language
   channel_id
   status: 'draft'
   total_recipients: summary.valid
   ```

   e grava a audiência inteira em `broadcast_audience_staging` (045).
3. O usuário é levado para `/broadcasts/new/[draftId]/triage`, marca e
   desmarca linhas, e ao clicar "Continuar" volta para
   `/broadcasts/new?draftId=…` — onde o assistente reidrata **só** o
   template e o canal, e salta direto para **Personalizar**.
4. Se ele fechar a aba aqui, o rascunho fica na lista. Para sempre.

Ou seja: **todo rascunho é um rascunho de triagem**, criado no meio do
caminho, batizado com o nome do template, sem nome próprio, sem variáveis
e sem mídia de header — porque essas três coisas só são decididas depois.

### Três problemas concretos

**1. Não há porta de entrada.** O único jeito de retomar um rascunho é
conhecer e digitar `/broadcasts/new?draftId=<uuid>` na barra de endereço.
Nem a lista nem a tela de detalhe oferecem isso. Na prática, um rascunho
abandonado é lixo permanente: o usuário recomeça do zero e a triagem de
3 000 linhas que ele já revisou é jogada fora.

**2. A retomada é parcial e só anda para frente.** O efeito de retomada
(`new/page.tsx:160`) lê apenas `id, status, template_name,
template_language, channel_id`, força `audience = { type: 'staged',
draftId }` e posiciona o assistente em **Personalizar**. Consequências:

- **Nome, variáveis, mídia de header e "checar antes de disparar" voltam
  vazios**, mesmo que o usuário já os tivesse preenchido antes de fechar
  a aba — as colunas `name`, `template_variables`, `header_media_url` e
  `check_before_send` existem, mas ninguém as escreve enquanto o disparo
  não acontece.
- **Não dá para trocar a audiência.** O passo 2 é inalcançável a partir
  da retomada: o botão "Voltar" de Personalizar leva à triagem, e a
  triagem só sabe marcar/desmarcar o que já foi importado. Trocar
  "etiqueta Clientes" por "etiqueta Leads" exige começar outro disparo —
  e o rascunho antigo fica lá.
- **Trocar o template exige voltar dois passos**, o que hoje funciona,
  mas não há nada que sinalize que é permitido.

**3. "Salvar rascunho" é código morto.** O botão existe em
`step4-schedule-send.tsx:516`, mas `new/page.tsx:645` só passa
`onSaveDraft` quando `audience.type !== 'staged'` — e, pelo item 1 do
ciclo acima, **a audiência é sempre `staged`**. O botão nunca aparece. Pior:
se aparecesse, `handleSaveDraft` faz `INSERT`, não `UPDATE` — salvaria uma
segunda linha ao lado do rascunho de triagem que originou a sessão,
deixando dois rascunhos para a mesma campanha.

### O que já está pronto e deve ser reusado

O repositório **já tem** a peça mais difícil desta funcionalidade: a
**adoção** da linha do rascunho no disparo.
`materializeArm` (`broadcast-dispatch.ts:633`) e
`scheduleDashboardBroadcast` (`:1313`) fazem `UPDATE … WHERE id = draftId
AND status = 'draft'` em vez de `INSERT` quando a audiência é `staged`,
justamente para "não deixar um rascunho órfão ao lado de um broadcast
novo". Esta SPEC **não inventa um caminho de gravação novo** — ela estende
essa mesma adoção para os casos que hoje escapam dela e dá ao usuário a
porta de entrada que falta.

---

## Objetivo

### O que esta SPEC entrega

1. Um botão **"Editar"** em toda campanha com `status = 'draft'`: na linha
   da lista (`/broadcasts`) e no cabeçalho da tela de detalhe
   (`/broadcasts/[id]`).
2. Uma rota dedicada **`/broadcasts/[id]/edit`** que abre o assistente de
   5 passos com **tudo** reidratado: canal, template, audiência (com a
   fonte original pré-selecionada), variáveis, mídia de header, nome,
   "checar antes de disparar" e agendamento.
3. O assistente extraído para um componente compartilhado
   (`components/broadcasts/broadcast-wizard.tsx`), usado tanto por
   `/broadcasts/new` (criar) quanto por `/broadcasts/[id]/edit` (editar) —
   uma implementação só, dois modos.
4. **"Salvar rascunho" funcionando de verdade**: em ambos os modos ele faz
   `UPDATE` da linha que já existe, gravando nome, variáveis, mídia,
   `check_before_send` e a `AudienceConfig` original. Nunca um segundo
   `INSERT`.
5. **Trocar a audiência de um rascunho** sem criar outro: o passo 2 aceita
   uma nova fonte e re-estagia **na mesma linha** (`POST
   /api/broadcasts/audience/stage` com `draftId`), substituindo as linhas
   de `broadcast_audience_staging` e recalculando `total_recipients`.
6. **Disparar ou agendar o rascunho editado adota a linha existente** —
   inclusive quando a audiência deixou de ser `staged` — via um `draftId`
   explícito no corpo de `POST /api/broadcasts/send`. Uma campanha, uma
   linha, do rascunho ao relatório.
7. **Guardas de estado e concorrência**: um rascunho que outra aba já
   disparou, agendou ou apagou não pode ser salvo nem reenviado; o usuário
   recebe um erro tratado, não um 500.
8. Cobertura de teste co-locada em tudo que é puro: a reidratação da
   `AudienceConfig`, a decisão "adotar × inserir", as pré-condições de
   estado e o resumo do que mudou.

### Não-objetivos (explicitamente fora de escopo)

- **Editar campanha `scheduled`.** Reagendar/cancelar um agendamento é
  outra história de usuário, com trilha própria (`rescheduled`,
  `canceled` já existem em `broadcast_audit_log`) e uma corrida real com o
  cron. Fica registrada como próximo passo em §15.
- **Editar `sending`, `sent`, `failed`, `streaming` ou `awaiting_check`.**
  As quatro primeiras já aconteceram; `streaming` é um funil de webhook
  que nunca termina (SPEC 055); `awaiting_check` é uma campanha viva,
  fatiada pelo cron da SPEC 069.
- **Rascunho de teste A/B.** Hoje o assistente esconde "Salvar rascunho"
  quando há variante B, porque `broadcasts` guarda **um** template por
  linha e a variante B é uma segunda linha com `parent_broadcast_id`.
  Persistir um rascunho A/B exige criar as duas linhas antes do disparo —
  decisão de produto separada. Continua escondido (D-8).
- **Histórico de versões do rascunho.** Editar sobrescreve. Sem
  `draft_revisions`, sem "desfazer".
- **Edição simultânea por duas pessoas.** Não há bloqueio colaborativo;
  há detecção de conflito por pré-condição de estado (§7) — o último a
  salvar vence, e quem tentar disparar um rascunho já disparado recebe
  `draft_not_found`.
- **Rascunho na API pública `/api/v1/broadcasts`.** A rota pública só tem
  `GET` hoje; expor edição de rascunho por lá é outro contrato, com os
  três arquivos de documentação que ele obriga.

---

## Decisões a ratificar com o mantenedor

Nenhuma trava a escrita do código; todas mudam comportamento observável.
A recomendação está marcada com **→**.

| #    | Pergunta                                                                                         | Recomendação                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Rota dedicada `/broadcasts/[id]/edit` ou reaproveitar `/broadcasts/new?draftId=`?                | **→ rota dedicada**, com o assistente extraído para um componente. O `?draftId=` de hoje significa "voltei da triagem, pule para Personalizar"; sobrecarregá-lo com "abra tudo para edição" é exatamente o tipo de flag ambígua que vira bug. O link antigo continua funcionando (§2.3). |
| D-2  | Qual papel mínimo pode editar um rascunho?                                                       | **→ `agent`** (`useCan('send-messages')`), o mesmo que a RLS já exige para `UPDATE` em `broadcasts` (017) e o mesmo que cria o rascunho. `viewer` vê o botão desabilitado, via `GatedButton`, como no resto do módulo.                                            |
| D-3  | Ao salvar, gravar a `AudienceConfig` original em `audience_filter`?                              | **→ sim.** A coluna existe e hoje só é escrita no disparo. Sem ela, reabrir um rascunho mostra "3 000 contatos triados" e nada sobre a origem — o usuário não consegue nem conferir se filtrou pela etiqueta certa. Ver D-4 para o caso da planilha.              |
| D-4  | Audiência importada (`csv`): gravar as linhas em `audience_filter`?                               | **→ não.** Só o marcador `{ type: 'csv', importedRows: N }`. As linhas já vivem em `broadcast_audience_staging`, que é onde o disparo as lê; duplicá-las em JSONB inflaria a linha de `broadcasts` em megabytes e ninguém as leria de volta.                      |
| D-5  | Trocar a audiência de um rascunho: re-estagiar na mesma linha ou criar outro rascunho?            | **→ na mesma linha.** É o princípio "uma campanha, uma linha" (§1.3). `POST /api/broadcasts/audience/stage` ganha `draftId` opcional: com ele, apaga as linhas de staging daquele rascunho e grava as novas, dentro da mesma checagem de conta/estado.            |
| D-6  | A troca de audiência descarta a triagem já feita (as marcações do usuário)?                       | **→ sim, e com confirmação explícita.** A triagem é uma seleção sobre um conjunto que deixou de existir. O diálogo diz quantas linhas serão descartadas antes de o usuário confirmar.                                                                             |
| D-7  | Disparar um rascunho editado: adotar a linha ou inserir uma nova e apagar o rascunho?             | **→ adotar**, reusando `adoptBroadcastId` (`broadcast-dispatch.ts:201`), que já existe para o cron. Inserir+apagar perderia o `id` que o usuário talvez já tenha compartilhado e criaria uma janela em que a campanha existe duas vezes.                          |
| D-8  | Rascunho com teste A/B: habilitar?                                                                | **→ não** (ver Não-objetivos). O botão continua escondido quando há variante B, com o texto de ajuda explicando por quê — hoje ele simplesmente some, sem explicação.                                                                                             |
| D-9  | Registrar a edição em `broadcast_audit_log`?                                                      | **→ não.** O `CHECK` da coluna `event` (048) só aceita oito valores; um `draft_updated` exigiria migração para auditar algo que **não saiu para ninguém**. O que importa auditar — `dispatched` / `scheduled` — já é registrado no momento do disparo.            |
| D-10 | Rascunho antigo sem `audience_filter` (todos os de hoje): como reabre?                            | **→ modo "audiência triada"**: o passo 2 mostra o resumo lido de `broadcast_audience_staging` ("3 000 contatos já triados") e um botão "Trocar audiência". Nada de migração de dados retroativa — a informação de origem não existe e não pode ser inventada.     |
| D-11 | Limitar quantos rascunhos uma conta pode ter?                                                     | **→ não nesta SPEC.** O problema real ("a lista enche de rascunho abandonado") é resolvido justamente por poder concluí-los ou apagá-los. Uma varredura de rascunhos velhos entra em §15 como próximo passo, junto do teto por plano.                             |
| D-12 | Rascunho criado pelo caminho "checar antes de disparar" cuja fila falhou (§ `handleSendWithCheck`) | **→ editável como qualquer outro.** Ele é `status='draft'` de verdade, com `audience_filter` preenchido e sem linhas de staging — o caso que D-10 já cobre. Sair de `awaiting_check` é que fica fora (Não-objetivos).                                             |

---

## 1. Arquitetura

### 1.1 O caminho de uma edição

```
/broadcasts  (linha status=draft)
      │  botão "Editar"
      ▼
/broadcasts/[id]/edit
      │
      ├─ loadBroadcastDraft(supabase, {accountId, broadcastId})   ← §3
      │     • lê a linha, exige status='draft' e source≠'webhook'
      │     • resolve o template pelo WABA do canal (findTemplateRowForWaba)
      │     • reconstrói a AudienceConfig (audience_filter ou staging)
      │     • devolve DraftHydration | erro tipado
      ▼
<BroadcastWizard mode="edit" draft={hydration} />               ← §2
      │
      ├─ "Salvar rascunho"  → saveBroadcastDraft()  UPDATE       ← §4
      ├─ "Trocar audiência"  → POST /audience/stage {draftId}    ← §5
      └─ "Enviar" / "Agendar" → POST /broadcasts/send {draftId}  ← §6
                                     │
                                     └─ adoptBroadcastId = draftId
                                        UPDATE … WHERE id=? AND status='draft'
```

Nenhuma etapa cria uma segunda linha de `broadcasts`. Da criação do
rascunho na triagem até o relatório de entrega, é sempre o mesmo `id`.

### 1.2 O que muda, arquivo por arquivo

| Arquivo                                                    | Mudança                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/broadcasts/broadcast-wizard.tsx`           | **novo** — todo o corpo do assistente que hoje mora em `new/page.tsx`, parametrizado por `mode: 'create' \| 'edit'`                 |
| `src/app/(dashboard)/broadcasts/new/page.tsx`              | vira uma casca: lê `?draftId=` (compatibilidade) e renderiza `<BroadcastWizard mode="create" />`                                    |
| `src/app/(dashboard)/broadcasts/[id]/edit/page.tsx`        | **novo** — carrega a hidratação e renderiza `<BroadcastWizard mode="edit" />`                                                       |
| `src/lib/broadcasts/draft.ts`                              | **novo** — `loadBroadcastDraft`, `saveBroadcastDraft`, `hydrateAudienceConfig` (pura), `describeDraftAudience` (pura)               |
| `src/lib/broadcasts/draft.test.ts`                         | **novo** — testes das funções puras acima                                                                                          |
| `src/app/api/broadcasts/audience/stage/route.ts`           | aceita `draftId` opcional; valida conta + `status='draft'` antes de re-estagiar                                                     |
| `src/lib/audience/stage.ts`                                | `stageAudience` ganha `draftId?`: em vez de `INSERT`, apaga o staging antigo e faz `UPDATE` do rascunho                             |
| `src/app/api/broadcasts/send/route.ts`                     | aceita `draftId` opcional no corpo; repassa como `adoptBroadcastId` depois de validar estado e propriedade                          |
| `src/lib/whatsapp/broadcast-dispatch.ts`                   | `scheduleDashboardBroadcast` passa a honrar `adoptBroadcastId` (hoje só o ramo `staged` adota)                                      |
| `src/components/broadcasts/step2-select-audience.tsx`      | modo "audiência já triada" + botão "Trocar audiência" + diálogo de confirmação (D-6)                                                |
| `src/components/broadcasts/step4-schedule-send.tsx`        | rótulo do botão de rascunho por modo; texto de ajuda quando escondido por A/B (D-8)                                                 |
| `src/app/(dashboard)/broadcasts/page.tsx`                  | coluna de ação com "Editar" nas linhas `draft`                                                                                      |
| `src/app/(dashboard)/broadcasts/[id]/page.tsx`             | cabeçalho: "Editar" quando `status = 'draft'`; corpo: aviso em vez de seis cartões zerados                                          |
| `messages/en.json` + `messages/pt-BR.json`                 | chaves novas em `Broadcasts.edit`, `Broadcasts.audience.restage`, `Broadcasts.page.actions`                                         |

### 1.3 O princípio que governa tudo aqui: uma campanha, uma linha

O código já defende esse princípio em dois lugares, com o mesmo
comentário: adotar o rascunho existente "faz o `draftId` da triagem virar
o id de verdade do disparo em vez de deixar um rascunho órfão ao lado de
um broadcast novo" (`broadcast-dispatch.ts:539`).

Todo o resto desta SPEC é a aplicação consistente desse princípio aos
casos que hoje escapam dele:

| Situação                                      | Hoje                                        | Depois                     |
| --------------------------------------------- | ------------------------------------------- | -------------------------- |
| Disparar com audiência `staged`               | adota (correto)                             | adota                      |
| Agendar com audiência `staged`                | adota (correto)                             | adota                      |
| "Salvar rascunho"                             | `INSERT` (mas o botão nunca aparece)        | `UPDATE` da linha aberta   |
| Trocar a audiência de um rascunho             | impossível                                  | `UPDATE` + re-staging      |
| Disparar rascunho cuja audiência virou `tags` | `INSERT` novo, rascunho fica órfão          | adota via `draftId`        |

### 1.4 Por que não há migração

Cada campo que a edição precisa persistir já tem coluna:

| Campo                            | Coluna                                          | Origem                    |
| -------------------------------- | ----------------------------------------------- | ------------------------- |
| Nome escolhido pelo usuário      | `broadcasts.name`                               | 001                       |
| Template e idioma                | `template_name`, `template_language`            | 001                       |
| Mapeamento de variáveis          | `template_variables` (JSONB)                    | 001                       |
| Audiência de origem              | `audience_filter` (JSONB)                       | 001                       |
| Mídia do header                  | `header_media_url`                              | 048                       |
| Agendamento e fuso               | `scheduled_at`, `scheduled_timezone`            | 001 / 048                 |
| Canal e procedência do canal     | `channel_id`, `channel_source`                  | 072 / 076                 |
| Checar antes de disparar         | `check_before_send`, `check_channel_id`         | 078                       |
| Audiência triada                 | `broadcast_audience_staging`                    | 045                       |

O `CHECK` de `status` (078) já aceita `'draft'`. A RLS de `UPDATE`
(017, `is_account_member(account_id, 'agent')`) já cobre a edição. **Não
crie migração para esta SPEC** — se durante a implementação parecer que
falta uma coluna, releia esta tabela antes de escrever SQL.

---

## 2. O assistente compartilhado — `components/broadcasts/broadcast-wizard.tsx`

### 2.1 Por que extrair

`new/page.tsx` tem 665 linhas e concentra: navegação por chave de passo,
elegibilidade de canal, reidratação da triagem, teste A/B, "checar antes
de disparar", disparo e salvamento. Duplicar isso em `[id]/edit/page.tsx`
garantiria divergência na primeira correção de bug. Copiar é a única
alternativa pior do que extrair.

A extração é **mecânica**: o corpo da função vira o componente, e o que
hoje sai de `useSearchParams()` passa a vir por props.

```ts
export type WizardMode = 'create' | 'edit';

export interface BroadcastWizardProps {
  mode: WizardMode;
  /**
   * Estado inicial já reidratado. Obrigatório em 'edit', ausente em
   * 'create' — exceto na compatibilidade do `?draftId=` (§2.3), que
   * entra em 'create' com uma hidratação parcial.
   */
  draft?: DraftHydration;
  /** Passo em que abrir. 'edit' abre em 'template'; a retomada de
   *  triagem abre em 'personalize', como hoje. */
  initialStep?: StepKey;
}
```

### 2.2 O que muda de comportamento por modo

| Aspecto                        | `create`                                                   | `edit`                                                                     |
| ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Título                         | "Novo disparo"                                             | "Editar rascunho" + nome atual do rascunho no subtítulo                    |
| Passo inicial                  | `sendFrom` (2+ canais) ou `template`                       | `template`, com todos os passos anteriores marcados como concluídos        |
| Navegação livre entre passos   | só para frente e para trás pelos botões                    | **igual** — o indicador de passos continua não sendo clicável (§2.4)       |
| "Salvar rascunho"              | `UPDATE` do rascunho de triagem que a sessão já criou      | `UPDATE` do rascunho aberto                                                |
| Passo Audiência                | escolhe a fonte e vai para a triagem                       | mostra a audiência atual + "Trocar audiência" (§5)                          |
| Disparar / agendar             | envia `draftId` quando a sessão tem um rascunho de triagem | envia sempre `draftId`                                                     |
| Sair sem salvar                | rascunho de triagem permanece (como hoje)                  | confirmação "descartar alterações?" se houver mudança não salva            |

### 2.3 Compatibilidade do `?draftId=`

`/broadcasts/new?draftId=<id>` continua funcionando **com o
comportamento de hoje** — é o retorno da triagem, e mudá-lo quebraria o
fluxo de criação inteiro. A diferença é que a hidratação passa a ser
completa (nome, variáveis, mídia e `check_before_send` voltam
preenchidos, se já existirem), e o passo inicial continua sendo
`personalize`.

O bug que isso corrige de passagem: hoje a retomada **força**
`audience = { type: 'staged', draftId }` sem olhar `audience_filter`.
Para o fluxo de triagem isso é correto por acidente (toda audiência
passa pelo stage), mas é uma suposição não verificada em cima de um
campo que esta SPEC passa a preencher — deixá-la de pé faria um rascunho
salvo com `audience_filter` reabrir apontando para linhas de staging que
podem ter sido substituídas. `hydrateAudienceConfig` (§3.2) decide com
base no que existe, não por presunção.

### 2.4 O indicador de passos continua não clicável

Tentador em modo de edição ("já preenchi tudo, deixa eu pular para o
passo 4"), mas o assistente tem dependências reais entre passos: trocar o
canal limpa o template (`handleChannelChange`), trocar o template limpa a
variante e invalida o mapeamento de variáveis. Um salto direto para
Personalizar depois de trocar o canal renderizaria placeholders de um
template que já não é o selecionado. Fica para uma SPEC de navegação, se
a demanda aparecer.

---

## 3. Reidratação — `src/lib/broadcasts/draft.ts` (novo)

### 3.1 `loadBroadcastDraft`

```ts
export type DraftLoadError =
  | 'not_found'        // id inexistente, ou de outra conta (RLS não devolve)
  | 'not_a_draft'      // scheduled / sending / sent / failed / awaiting_check
  | 'webhook_funnel'   // source = 'webhook' — não é campanha editável
  | 'ab_variant'       // variant_label / parent_broadcast_id preenchidos (D-8)
  | 'template_missing'; // o template foi apagado ou saiu do WABA do canal

export interface DraftHydration {
  broadcastId: string;
  name: string;
  template: MessageTemplate;
  channelId: string | null;
  audience: AudienceConfig;
  /** Resumo do que está em staging, para o passo 2 (D-10). */
  audienceSummary: DraftAudienceSummary;
  variables: VariableMap;
  headerMediaUrl: string;
  checkBeforeSend: boolean;
  scheduledAt: string | null;
}

export async function loadBroadcastDraft(
  db: SupabaseClient,
  params: { accountId: string; broadcastId: string }
): Promise<{ ok: true; draft: DraftHydration } | { ok: false; error: DraftLoadError }>;
```

Pontos que a implementação **não pode** simplificar:

- **Cliente de sessão, sempre.** A leitura roda no navegador com
  `createClient()` — a RLS de `broadcasts` (017) é a autorização. Nunca
  `supabaseAdmin` aqui: um `broadcastId` colado à mão de outra conta
  precisa voltar `not_found`, não a linha.
- **`accountId` no filtro, além da RLS.** Mesmo raciocínio de
  `resolveStagedAudience` (`resolve.ts:486`): o `draftId` vem da URL, e o
  filtro explícito é o que mantém a garantia igual quando a mesma função
  for chamada de um contexto de servidor.
- **Template resolvido pelo WABA do canal.** Reusar
  `wabaIdOfChannel` + `findTemplateRowForWaba` (SPEC 065 §2.A A4). Um
  `.eq(name).eq(language).maybeSingle()` quebra com "multiple rows" assim
  que dois WABAs têm um template de mesmo nome — o bug que a 065 já
  corrigiu na retomada da triagem e que não pode voltar aqui.
- **`template_missing` é recuperável, não fatal.** O rascunho abre no
  passo **Template** com um aviso ("o template deste rascunho não está
  mais disponível neste canal — escolha outro"), preservando audiência,
  nome e agendamento. Descartar o rascunho porque a Meta reprovou um
  template seria jogar fora a triagem junto.

### 3.2 `hydrateAudienceConfig` — função pura, testada

```ts
export function hydrateAudienceConfig(input: {
  broadcastId: string;
  audienceFilter: unknown;         // broadcasts.audience_filter cru
  stagedRowCount: number;          // COUNT de broadcast_audience_staging
}): AudienceConfig;
```

A árvore de decisão, na ordem:

1. `audienceFilter` é uma `AudienceConfig` válida **e** `type !== 'csv'`
   **e** `type !== 'contact_ids'` → devolve-a como está. É a origem
   verdadeira (tags, campo personalizado, todos), e o passo 2 consegue
   reabrir a fonte pré-selecionada.
2. `audienceFilter.type === 'csv'` (marcador de D-4) **e**
   `stagedRowCount > 0` → `{ type: 'staged', draftId: broadcastId }`, com
   o resumo indicando que veio de importação. As linhas estão no staging;
   o marcador só serve para rotular a fonte na tela.
3. `stagedRowCount > 0` (sem filtro registrado — todos os rascunhos de
   hoje, D-10) → `{ type: 'staged', draftId: broadcastId }`.
4. Nenhum dos dois → `{ type: 'all' }` **com sinalização de audiência
   vazia**: o passo 2 abre exigindo uma escolha, e o passo 4 não deixa
   disparar. É o caso do rascunho de D-12 cuja fila de checagem falhou
   antes de qualquer staging.

**`contact_ids` nunca é reidratado.** Ele é interno do disparo parcial
(SPEC 069 R6) e, por desenho, não está em `AUDIENCE_TYPES` — devolvê-lo
para o cliente reabriria por outra porta exatamente o que
`parse-input.ts` recusa na fronteira. Cai no caso 3 ou 4.

### 3.3 `describeDraftAudience` — função pura, testada

Produz o texto do passo 2 em modo edição, a partir da `AudienceConfig`
reidratada e dos contadores de staging: `{ selected, total, invalid }`.
Três formas possíveis — "Etiquetas: Clientes, VIP", "Planilha importada —
2 840 de 3 000 selecionados", "3 000 contatos já triados" (D-10) — mais
o caso vazio. É pura para poder ser testada sem banco e sem navegador,
como todo o resto de `src/lib/`.

---

## 4. Salvar — `saveBroadcastDraft`

```ts
export async function saveBroadcastDraft(
  db: SupabaseClient,
  params: {
    accountId: string;
    broadcastId: string;
    name: string;
    template: MessageTemplate;
    channelId: string | null;
    audience: AudienceConfig;
    variables: VariableMap;
    headerMediaUrl: string;
    checkBeforeSend: boolean;
  }
): Promise<{ ok: true } | { ok: false; error: 'draft_not_found' | 'db_error' }>;
```

O `UPDATE`:

```ts
await db.from('broadcasts')
  .update({
    name: name.trim() || template.name,
    template_name: template.name,
    template_language: template.language ?? 'en_US',
    template_variables: variables,
    audience_filter: persistableAudience(audience),   // D-4
    header_media_url: headerMediaUrl || null,
    channel_id: channelId,
    channel_source: channelId ? 'resource' : 'default',
    check_before_send: checkBeforeSend,
  })
  .eq('id', broadcastId)
  .eq('account_id', accountId)
  .eq('status', 'draft')      // ← a pré-condição, não um detalhe
  .select('id')
  .single();
```

Três coisas que a implementação precisa respeitar:

1. **`.eq('status','draft')` é obrigatório.** É a mesma defesa de
   `materializeArm` ("um rascunho já enviado não pode ser reenviado por
   uma segunda aba"). Zero linhas casadas → `draft_not_found` → a UI
   avisa e leva para `/broadcasts/[id]`, onde o usuário vê o que
   aconteceu com a campanha.
2. **Nunca escreva os contadores.** `sent_count`, `delivered_count`,
   `read_count`, `replied_count` e `failed_count` pertencem ao trigger
   agregador (003/005). `total_recipients` só muda no re-staging (§5) e
   no disparo.
3. **`persistableAudience`** aplica D-4: para `type === 'csv'` grava
   `{ type: 'csv', importedRows: csvContacts.length }` e **descarta
   `csvContacts`**; para `contact_ids`, não grava nada (não vem do
   cliente). É pura e testada.

### 4.1 O botão volta a existir

Em `step4-schedule-send.tsx`, `onSaveDraft` passa a ser fornecido sempre
que houver um `broadcastId` para atualizar — o que, em `create`, é o
rascunho de triagem da própria sessão, e em `edit` é o rascunho aberto. A
única exclusão que permanece é o teste A/B (D-8), agora com texto
explicando o motivo em vez de o botão simplesmente sumir.

Rótulos: `create` → "Salvar rascunho"; `edit` → "Salvar alterações".

---

## 5. Trocar a audiência de um rascunho

### 5.1 Na tela

O passo **Audiência** em modo edição abre em estado de resumo:

```
Audiência atual
Planilha importada — 2 840 de 3 000 contatos selecionados
[ Rever triagem ]   [ Trocar audiência ]
```

- **Rever triagem** → `/broadcasts/new/[id]/triage` (a tela que já
  existe), de onde o "Continuar" volta para o assistente.
- **Trocar audiência** → diálogo de confirmação (D-6):
  _"Trocar a audiência descarta as 3 000 linhas já importadas e a
  seleção da triagem. O template, as variáveis e o nome são
  preservados."_ Confirmado, o passo volta ao seletor de fontes normal.

### 5.2 No servidor — `stageAudience` com `draftId`

`POST /api/broadcasts/audience/stage` aceita `draftId?: string`. Quando
presente:

1. Carrega a linha com o **cliente de sessão** e exige
   `account_id = accountId`, `status = 'draft'` e `source !== 'webhook'`.
   Falhou → `404 draft_not_found` (nunca 500, nunca sucesso silencioso).
2. `DELETE FROM broadcast_audience_staging WHERE broadcast_id = draftId`.
3. Insere as linhas novas nos mesmos chunks de hoje (`INSERT_CHUNK`).
4. `UPDATE broadcasts SET template_name, template_language, channel_id,
   total_recipients = summary.valid WHERE id = draftId AND status =
   'draft'` — em vez do `INSERT` do caminho de criação.
5. Devolve o **mesmo `draftId`** e o mesmo `summary` de hoje, para a
   triagem e o `saveStageSummary` continuarem funcionando sem alteração.

**Ordem importa e não é a intuitiva.** Apagar antes de inserir deixa uma
janela em que o rascunho tem zero linhas; se o `INSERT` falhar no meio, o
tratamento existente marca o rascunho como `failed`
(`stage.ts:519`) — comportamento que, em uma **troca**, destruiria uma
audiência que estava boa. Em modo `draftId`, a falha de inserção deve:

- **não** marcar `failed` (o rascunho não é novo);
- apagar as linhas parciais que já entraram;
- devolver `500 restage_failed`, com a mensagem "a audiência anterior foi
  perdida; importe novamente" — honesta sobre o que aconteceu.

Alternativa considerada e descartada: inserir as novas com um marcador de
geração e só apagar as antigas ao final. Exigiria coluna nova em
`broadcast_audience_staging` (migração) para resolver um caso de falha
raro em um rascunho que o usuário está justamente refazendo.

### 5.3 Limite de linhas e cota

Vale o mesmo teto de hoje (`MAX_AUDIENCE_ROWS`) e a mesma revalidação de
cota de disparo — o re-staging passa pelo mesmo caminho de validação da
rota, sem exceções para "é só uma edição".

---

## 6. Disparar ou agendar um rascunho editado

### 6.1 O corpo ganha `draftId`

`POST /api/broadcasts/send` aceita `draftId?: string`. Validação, na
ordem:

1. `typeof draftId === 'string'` e formato UUID; senão `400 bad_request`.
2. Leitura com o **cliente de sessão** (`supabase`, não `supabaseAdmin`):
   `select('id, status, source, variant_label, parent_broadcast_id')
   .eq('id', draftId).eq('account_id', accountId).maybeSingle()`.
3. Ausente → `404 draft_not_found`. `status !== 'draft'` → `409
   draft_not_editable` com o status atual no corpo, para a UI dizer o que
   houve ("esta campanha já foi disparada"). `source === 'webhook'` ou
   variante A/B → `400 bad_request`.
4. Só então repassa `adoptBroadcastId: draftId` a
   `planDashboardBroadcast` / `scheduleDashboardBroadcast`.

> **A validação acima não é redundante com a RLS.** O planejamento roda
> com o cliente de sessão (`send/route.ts:403`), então a RLS **já** barra
> um id de outra conta. O que ela não faz é distinguir "não é seu" de "já
> foi disparado" — e é essa distinção que separa um erro compreensível de
> um `draft_not_found` genérico. O `.eq('status','draft')` do `UPDATE`
> continua sendo a defesa final contra a corrida entre duas abas; esta
> checagem é a que produz a **mensagem** certa.

### 6.2 `scheduleDashboardBroadcast` precisa honrar `adoptBroadcastId`

Hoje ela adota **apenas** quando `audience.type === 'staged'`
(`broadcast-dispatch.ts:1313`). Um rascunho cuja audiência foi trocada
para `tags` e depois agendado cairia no `else` e faria `INSERT`,
deixando o rascunho órfão ao lado do agendamento — exatamente o que a
§1.3 proíbe.

A correção espelha o que `materializeArm` já faz:

```ts
const adoptId =
  adoptBroadcastId ??
  (input.audience.type === 'staged' ? input.audience.draftId : undefined);
```

E, como lá, a pré-condição `.eq('status','draft')` **permanece** no
caminho vindo do cliente. (O cron não passa por aqui: ele adota linhas
`scheduled` em `materializeArm`, com o claim próprio.)

### 6.3 Coerência entre `draftId` e `audience.draftId`

Quando a audiência é `staged`, `audience.draftId` e o `draftId` do corpo
**devem ser o mesmo id**. Divergência é erro de programação do cliente,
não estado do sistema: `400 bad_request` com
`"draftId does not match audience.draftId"`. Aceitar em silêncio faria o
disparo adotar uma linha e ler a audiência de outra.

### 6.4 O que acontece com o rascunho depois do disparo

Nada de novo: o `UPDATE` de adoção já o transforma na campanha
(`status = 'sending'`, `total_recipients`, `audience_filter`) e o purge
de `broadcast_audience_staging` já roda em seguida
(`broadcast-dispatch.ts:690`). O usuário continua na mesma URL de
detalhe, agora com números.

---

## 7. Guardas de estado e concorrência

| Cenário                                                                   | Comportamento esperado                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Abrir `/broadcasts/[id]/edit` de campanha `sent` (URL colada)              | Tela de aviso "esta campanha já foi disparada e não pode ser editada" + link para o detalhe. Sem redirecionamento automático. |
| Abrir `/edit` de `scheduled`                                              | Mesma tela, com o texto de agendamento (fora de escopo — §15).                                                                |
| Abrir `/edit` de `awaiting_check`                                          | Mesma tela, com o progresso "checado X de Y" e o texto da SPEC 069.                                                            |
| Abrir `/edit` de funil de webhook (`source='webhook'`)                     | Aviso próprio: um funil não tem passo de audiência.                                                                            |
| Outra aba disparou o rascunho enquanto este estava aberto → "Salvar"       | `draft_not_found` → toast + navegação para `/broadcasts/[id]`.                                                                 |
| Outra aba apagou o rascunho → "Salvar"                                     | Idem, mas a navegação vai para `/broadcasts` (o detalhe também não existe mais).                                              |
| Outra aba disparou → "Enviar"                                              | `409 draft_not_editable` na rota, antes de resolver audiência ou consumir cota.                                               |
| Duas abas salvando o mesmo rascunho                                        | O último `UPDATE` vence. Sem bloqueio (Não-objetivos) — as duas veem `status='draft'` e as duas são válidas.                  |
| Template do rascunho foi apagado / mudou de WABA                           | Abre no passo Template com aviso; o resto é preservado (§3.1).                                                                |
| Canal do rascunho foi removido da conta                                    | `channelId` volta `null`, o passo "Enviar por" abre exigindo escolha, e o template é revalidado contra o novo WABA.           |
| Sair da edição com alterações não salvas                                   | `beforeunload` + confirmação na navegação interna. Só quando há diferença real em relação ao carregado.                       |

O "há diferença real" merece uma função pura testada
(`hasDraftChanges(loaded, current)`): comparar objetos por referência
dispararia a confirmação em toda saída, e o usuário aprenderia a ignorá-la.

---

## 8. UI

### 8.1 Lista `/broadcasts`

Uma coluna de ação à direita, visível **só** em linhas `draft`:

```tsx
{broadcast.status === 'draft' && (
  <GatedButton
    canAct={canCreate}
    gateReason="edit drafts"
    onClick={(e) => { e.stopPropagation(); router.push(`/broadcasts/${broadcast.id}/edit`); }}
  >
    <Pencil className="h-3.5 w-3.5" />
    {t('actions.edit')}
  </GatedButton>
)}
```

`stopPropagation` não é detalhe cosmético: a linha inteira já tem
`onClick` que navega para o detalhe (`page.tsx:311`). Sem ele, o clique
em "Editar" dispara os dois destinos.

### 8.2 Detalhe `/broadcasts/[id]`

Para `status = 'draft'`, a tela hoje mostra seis cartões zerados, um
funil vazio e "nenhum destinatário" — a foto de uma campanha que não
aconteceu, sem dizer que ainda **pode** acontecer. Passa a mostrar, no
lugar do bloco de estatísticas:

> **Rascunho** — esta campanha ainda não foi enviada.
> Audiência: 2 840 contatos triados · Template: `boas_vindas` (pt_BR)
> **[ Continuar edição ]** [ Excluir ]

O botão "Excluir" continua sendo o que já existe (`:471`), sem mudança de
comportamento — apagar um rascunho já funciona.

### 8.3 O que **não** muda

O badge `draft` (`broadcast-status.ts:28`), o polling da lista (rascunho
não é estado vivo), a triagem e a tela de detalhe das campanhas enviadas.

---

## 9. i18n

Chaves novas — `messages/en.json` é a fonte da verdade, `pt-BR.json`
espelha a árvore. `npm run i18n:check` falha se divergirem.

```
Broadcasts.page.actions.edit               "Edit" / "Editar"
Broadcasts.edit.title                      "Edit draft" / "Editar rascunho"
Broadcasts.edit.subtitle                   "{name} — not sent yet" / "{name} — ainda não enviado"
Broadcasts.edit.saveChanges                "Save changes" / "Salvar alterações"
Broadcasts.edit.saved                      "Draft updated" / "Rascunho atualizado"
Broadcasts.edit.notEditable.title          por status: sent/scheduled/sending/awaiting_check/webhook
Broadcasts.edit.notEditable.body           …
Broadcasts.edit.gone                       "This draft no longer exists or was already sent."
Broadcasts.edit.templateMissing            "The template of this draft is no longer available on this channel. Choose another."
Broadcasts.edit.discardChanges             "Discard unsaved changes?" / "Descartar alterações não salvas?"
Broadcasts.edit.abTestNoDraft              explica D-8 no lugar do botão escondido
Broadcasts.audience.current.title          "Current audience" / "Audiência atual"
Broadcasts.audience.current.staged         "{selected} of {total} contacts triaged"
Broadcasts.audience.current.tags           "Tags: {names}"
Broadcasts.audience.current.customField    "{field} {operator} {value}"
Broadcasts.audience.current.imported       "Imported spreadsheet — {selected} of {total} selected"
Broadcasts.audience.current.empty          "No audience selected yet"
Broadcasts.audience.restage.button         "Change audience" / "Trocar audiência"
Broadcasts.audience.restage.confirmTitle   …
Broadcasts.audience.restage.confirmBody    "{rows} imported rows and the triage selection will be discarded."
Broadcasts.audience.restage.reviewTriage   "Review triage" / "Rever triagem"
Broadcasts.audience.stageError.restage_failed  "…the previous audience was lost; import again."
```

Placeholders (`{name}`, `{selected}`, `{total}`, `{rows}`) preservados
nos dois arquivos. Mensagens de `/api/**` continuam em **inglês** — a UI
traduz pelo código do erro, como em `STAGE_ERROR_CODES`.

---

## 10. Permissões e segurança

- **Papel mínimo `agent`** (D-2), pela mesma predicado que o botão "Novo
  disparo" já usa (`useCan('send-messages')`), com `GatedButton` para o
  estado desabilitado. Isso casa com a RLS de `UPDATE` em `broadcasts`
  (`is_account_member(account_id, 'agent')`) — a UI não promete o que o
  banco recusaria.
- **Toda leitura e escrita do rascunho usa o cliente de sessão.**
  `supabaseAdmin` continua restrito ao fan-out do disparo, pelo motivo
  já documentado em `send/route.ts` (o token SSR não se renova durante um
  envio longo). Nenhuma rota nova desta SPEC precisa de service-role.
- **`draftId` é entrada não confiável.** Chega da URL e do corpo do POST.
  Em todos os pontos: filtro explícito por `account_id`, exigência de
  `status = 'draft'`, e `.select().single()` para que "nenhuma linha
  casou" seja um erro, nunca um sucesso silencioso sobre o registro
  errado.
- **Nada de novo é exposto ao navegador.** A edição lê e escreve as
  mesmas colunas que a criação já lia e escrevia.
- **LGPD:** editar um rascunho não envia nada a ninguém. A exclusão de
  contatos em opt-out continua acontecendo no disparo (§6.8 da SPEC 044),
  não aqui — o rascunho guarda intenção, não destinatários.

---

## 11. Fases de execução

| Fase   | Entrega                                                                                                          | Verificável por                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **F1** | `src/lib/broadcasts/draft.ts` — `hydrateAudienceConfig`, `describeDraftAudience`, `persistableAudience`, `hasDraftChanges` (puras) + testes | `npm run test`                                           |
| **F2** | `loadBroadcastDraft` / `saveBroadcastDraft` (acesso a dados) + testes com cliente falso                           | `npm run test`                                            |
| **F3** | Extração de `broadcast-wizard.tsx`; `new/page.tsx` vira casca. **Sem mudança de comportamento**                   | `npm run typecheck` + criar um disparo do zero, ponta a ponta |
| **F4** | Rota `/broadcasts/[id]/edit` + hidratação completa + telas de "não editável"                                     | abrir rascunho, `sent`, `scheduled`, funil de webhook     |
| **F5** | "Salvar rascunho/alterações" via `UPDATE` nos dois modos; botão volta a aparecer                                  | salvar, dar F5, conferir que tudo voltou                  |
| **F6** | Troca de audiência: `draftId` em `stageAudience` + rota + diálogo de confirmação                                  | trocar planilha por etiqueta no mesmo rascunho            |
| **F7** | `draftId` em `POST /api/broadcasts/send` + `adoptBroadcastId` em `scheduleDashboardBroadcast` + testes            | disparar e agendar um rascunho editado; **conferir que a lista não ganhou uma segunda linha** |
| **F8** | UI da lista e do detalhe + i18n (en/pt-BR) + guardas de saída sem salvar                                          | `npm run i18n:check` + navegação                          |
| **F9** | Checklist de teste manual (§13), executado pelo mantenedor em navegador                                          | §13                                                       |

F1→F2→F3 são pré-requisitos duros. F4 depende de F2+F3. F5, F6 e F7 são
independentes entre si depois de F4. F8 pode andar em paralelo a F6/F7.

**Fronteira de sessão sugerida:** F1–F3 em uma sessão (refatoração +
puras), F4–F5 em outra, F6–F8 na terceira. F3 sozinha já é um diff
grande; misturá-la com comportamento novo dificulta a revisão de ambos.

---

## 12. Plano de testes (Vitest, co-locados)

`src/lib/broadcasts/draft.test.ts`

| Caso                                                                                  | Assertiva                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `audience_filter` com `tags` e staging vazio                                          | devolve `{type:'tags', tagIds:[…]}` — não `staged`                        |
| `audience_filter` com `tags` **e** staging cheio                                       | devolve o filtro (caso 1 vence): a origem é mais informativa               |
| `audience_filter` nulo + staging com 3 000 linhas (rascunho de hoje, D-10)             | devolve `{type:'staged', draftId}`                                        |
| `audience_filter` nulo + staging vazio (D-12)                                          | devolve `{type:'all'}` marcado como vazio                                 |
| `audience_filter` com `type:'contact_ids'`                                             | **nunca** devolve `contact_ids` — cai em `staged` ou vazio                |
| `audience_filter` com JSON corrompido / tipo desconhecido                              | não lança; cai no caminho do staging                                      |
| `persistableAudience` com `csv` + 3 000 linhas                                         | grava `{type:'csv', importedRows:3000}`, sem `csvContacts`                |
| `persistableAudience` com `contact_ids`                                                | devolve `null` (não persiste)                                             |
| `describeDraftAudience` nas quatro formas + vazio                                      | chave de i18n e argumentos corretos                                       |
| `hasDraftChanges` com objetos equivalentes mas referências distintas                   | `false` — não pede confirmação à toa                                      |
| `hasDraftChanges` com uma variável trocada                                             | `true`                                                                    |

`src/lib/whatsapp/broadcast-dispatch.test.ts` (acrescentar)

| Caso                                                                              | Assertiva                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `scheduleDashboardBroadcast` com `adoptBroadcastId` e audiência `tags`             | faz `UPDATE` na linha, **não** `INSERT`                                    |
| Idem, com o rascunho já `sending` (a pré-condição não casa)                        | lança `draft_not_found` (404), sem inserir nada                            |
| `scheduleDashboardBroadcast` sem `adoptBroadcastId` e audiência `tags`             | segue inserindo (regressão do caminho de criação)                          |
| `materializeArm` com `adoptBroadcastId` divergente de `audience.draftId`           | a rota rejeita antes (teste na rota); aqui, o adotado é o explícito        |

`src/app/api/broadcasts/send/route.test.ts` (se não existir, criar)

| Caso                                                | Assertiva                                     |
| --------------------------------------------------- | --------------------------------------------- |
| `draftId` de outra conta                            | `404`, sem tocar em cota nem em audiência     |
| `draftId` de campanha `sent`                        | `409 draft_not_editable`, com o status no corpo |
| `draftId` de funil `webhook`                        | `400 bad_request`                             |
| `draftId` ≠ `audience.draftId` em audiência `staged` | `400 bad_request` (§6.3)                       |
| `draftId` ausente                                   | comportamento de hoje, intacto                |

`src/lib/audience/stage.test.ts` (acrescentar)

| Caso                                                | Assertiva                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `stageAudience` com `draftId` válido                | apaga staging antigo, insere novo, `UPDATE` de `total_recipients`, **sem** `INSERT` em `broadcasts` |
| `stageAudience` com `draftId` de campanha `sent`    | erro `draft_not_found`; staging antigo intacto                     |
| Falha no `INSERT` das linhas com `draftId`          | **não** marca o rascunho como `failed` (§5.2)                      |
| `stageAudience` sem `draftId`                       | comportamento de hoje, intacto                                     |

---

## 13. Checklist de teste manual (F9, em navegador)

Contra a conta de teste, com um rascunho real. Marque cada item.

1. **Porta de entrada.** Lista → linha `Rascunho` mostra "Editar";
   clicar no botão abre `/broadcasts/[id]/edit`; clicar no **resto da
   linha** continua abrindo o detalhe.
2. **Reidratação completa.** Abrir um rascunho salvo com nome,
   variáveis e imagem de header: os três voltam preenchidos, e o passo
   "Enviar por" mostra o canal correto.
3. **Rascunho antigo (D-10).** Abrir um rascunho criado **antes** deste
   deploy (sem `audience_filter`): o passo 2 mostra "N contatos já
   triados" e os botões "Rever triagem" / "Trocar audiência".
4. **Salvar alterações.** Trocar o nome e uma variável, salvar, dar F5 na
   rota de edição: as duas mudanças persistiram. A lista **continua com
   uma única linha** para esta campanha.
5. **Trocar template.** Escolher outro template do mesmo canal: o
   mapeamento de variáveis é limpo, a audiência é preservada. Salvar e
   reabrir confirma.
6. **Trocar canal (conta com 2+ números).** Trocar em "Enviar por": o
   template é limpo com aviso; escolher um do novo WABA; salvar; reabrir
   mostra o novo canal e o novo template.
7. **Trocar audiência (D-6).** "Trocar audiência" → o diálogo diz quantas
   linhas serão descartadas → confirmar → importar uma planilha nova →
   triagem → voltar. Conferir no banco que
   `SELECT count(*) FROM broadcast_audience_staging WHERE broadcast_id =
   '<id>'` bate com a nova planilha, e que `broadcasts.total_recipients`
   foi atualizado.
8. **Disparo adota a linha (o item mais importante).** Disparar o
   rascunho editado. Conferir:
   `SELECT id, status, total_recipients FROM broadcasts WHERE account_id
   = '<conta>' ORDER BY created_at DESC LIMIT 3;` — a campanha enviada
   tem **o mesmo `id`** do rascunho, e **não** há uma segunda linha nova.
9. **Agendamento adota a linha.** Repetir o item 8 agendando para daqui a
   10 minutos; conferir mesmo `id`, `status = 'scheduled'`,
   `scheduled_at` e `scheduled_timezone` preenchidos. Deixar o cron
   disparar e conferir que continua o mesmo `id`.
10. **Corrida entre abas.** Abrir o mesmo rascunho em duas abas.
    Disparar na aba A. Na aba B, clicar "Salvar alterações": toast de
    erro e navegação para o detalhe — **sem 500 no console**. Repetir
    clicando "Enviar" na aba B: erro tratado, nenhuma segunda campanha.
11. **Estados não editáveis.** Colar `/broadcasts/<id>/edit` de uma
    campanha `sent`, de uma `scheduled` e de um funil de webhook: as três
    telas de aviso, com o texto certo em cada caso.
12. **Template sumido.** Apagar (ou deixar reprovar) o template de um
    rascunho e reabri-lo: abre no passo Template com o aviso, audiência e
    nome preservados.
13. **Sair sem salvar.** Alterar algo e navegar para fora: pede
    confirmação. Salvar e navegar: **não** pede.
14. **Papel `viewer`.** Entrar como `viewer`: o botão "Editar" aparece
    desabilitado com o motivo, e a URL de edição colada à mão não permite
    salvar.
15. **pt-BR e en.** Trocar o idioma e revisitar as telas novas: nenhuma
    chave crua na tela, nenhum `INVALID_MESSAGE` no console.

---

## 14. Validação local (obrigatória — não há CI)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

`i18n:check` é o que pega a chave nova esquecida em um dos dicionários —
e é justamente a falha que só aparece em produção, num idioma só.

---

## 15. Riscos e limites conhecidos

| Risco / limite                                                                                    | Mitigação / registro                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **F3 é uma refatoração grande** (665 linhas mudam de arquivo)                                     | Fase própria, sem mudança de comportamento, validada criando um disparo ponta a ponta antes de seguir para F4                                |
| Perda de audiência se o re-staging falhar no meio (§5.2)                                          | Erro explícito `restage_failed` com instrução de reimportar; a alternativa transacional exigiria migração para um caso raro                  |
| Duas pessoas editando o mesmo rascunho                                                            | Último a salvar vence, por decisão (Não-objetivos). O disparo é protegido pela pré-condição de estado, que é onde o dano seria real          |
| Rascunho velho acumulando na lista                                                                | Fora de escopo (D-11). Próximo passo: varredura de rascunhos sem atividade há N dias, e teto de rascunhos por plano (motor de quotas, SPEC 059) |
| Editar campanha `scheduled`                                                                       | Fora de escopo. Próximo passo natural desta SPEC: exige `claim` contra o cron e os eventos `rescheduled`/`canceled` que a 048 já previu       |
| Rascunho de teste A/B                                                                             | Fora de escopo (D-8). Exige criar as duas linhas antes do disparo, o que muda o significado de `parent_broadcast_id` em estado de rascunho    |
| `template_variables` de um template trocado                                                       | O assistente já limpa o mapeamento na troca; o risco residual é o usuário salvar sem repreencher — o passo 4 valida antes de disparar        |

---

## 16. Git

Commits e push são **manuais do mantenedor** (AGENTS.md). Comando pronto,
após a validação de §14 passar inteira:

```bash
git add -A && git commit -m "feat: SPEC 070 — editar disparo em rascunho (F1-F8)

Retomar, alterar e concluir uma campanha com status 'draft' sem criar
uma segunda linha em broadcasts:

- rota /broadcasts/[id]/edit com o assistente extraido para
  components/broadcasts/broadcast-wizard.tsx (create | edit)
- reidratacao completa do rascunho (nome, template, canal, audiencia,
  variaveis, midia de header, checar-antes) em lib/broadcasts/draft.ts
- 'Salvar rascunho' passa a fazer UPDATE (antes: INSERT, e o botao
  nunca aparecia porque a audiencia e sempre 'staged')
- trocar a audiencia re-estagia na MESMA linha (stage aceita draftId)
- disparar/agendar adota a linha via draftId; scheduleDashboardBroadcast
  passa a honrar adoptBroadcastId fora do ramo 'staged'
- guardas de estado: draft_not_found / draft_not_editable em vez de 500

Sem migracao: todas as colunas ja existiam (001, 045, 048, 072, 076, 078).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Referências

- [`docs/spec-044-audiencia-multiformato-e-triagem.md`](./spec-044-audiencia-multiformato-e-triagem.md) — §3.3 (o rascunho de triagem), §6.1 (audiência resolvida no servidor), §6.3 (agendamento e janela), §6.6 (teste A/B), §6.8 (trilha)
- [`docs/spec-057-audiencia-persistente-e-rastreabilidade.md`](./spec-057-audiencia-persistente-e-rastreabilidade.md) — o que o staging persiste do contato
- [`docs/spec-065-selecao-de-canal-por-recurso.md`](./spec-065-selecao-de-canal-por-recurso.md) — §2.A A4 (template × WABA na retomada), §11 (`channel_source`)
- [`docs/spec-069-checagem-captacao-e-cascata-de-limites.md`](./spec-069-checagem-captacao-e-cascata-de-limites.md) — R6 (`check_before_send`, `awaiting_check`, disparo parcial)
- `src/lib/whatsapp/broadcast-dispatch.ts:199` — `adoptBroadcastId`, a peça reusada
- `src/lib/audience/stage.ts:485` — onde o rascunho nasce
- `supabase/migrations/017_account_sharing.sql:482` — RLS de `broadcasts`
