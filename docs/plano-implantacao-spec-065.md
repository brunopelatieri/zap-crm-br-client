# Plano de implantação — SPEC 065 (seleção de canal por recurso)

> **SPEC:** [`docs/spec-065-selecao-de-canal-por-recurso.md`](./spec-065-selecao-de-canal-por-recurso.md) — decisões **D-1 a D-11 ratificadas em 2026-08-31**
> **Migração desta SPEC:** `075_resource_channel_selection.sql` (a última hoje é a `074`)
> **Para que serve este arquivo:** dizer **em que ordem**, **com qual modelo** e **em qual sessão** cada fase é executada, e entregar o **prompt de abertura pronto** de cada uma. A SPEC continua sendo a fonte de verdade do *o quê*; este documento é o *como conduzir*.

---

## 1. Como usar

1. Abra a sessão indicada na fase (nova ou continuação), **na raiz do repo**
   `zap-crm-br-client`.
2. Troque o modelo **antes** de colar o prompt (§2.3).
3. Copie o bloco de prompt da fase (§6) inteiro, sem editar.
4. Ao final da fase, rode o gate (§2.2), marque o painel (§9) e **pare** — a
   fase seguinte é uma decisão sua, não uma continuação automática.

Uma fase = um PR. Nenhuma fase entrega "quase pronta" para a seguinte terminar.

---

## 2. Regras que valem para todas as sessões

### 2.1. As quatro invariantes do repositório

| Regra | Onde está escrita |
| --- | --- |
| **Migração nunca é aplicada pelo agente.** A entrega é o arquivo `.sql` revisável. Aplicar em `vn`/`rs` é sempre pedido explícito seu, projeto a projeto | AGENTS.md + SPEC 065 §4.5 |
| **Commit e push são manuais.** O agente entrega o comando pronto; quem executa é você | AGENTS.md |
| **Chave de i18n nova entra nos dois dicionários** (`en.json` é a fonte, `pt-BR.json` espelha) | AGENTS.md |
| **Mudança em `/api/v1/**` edita os três arquivos de contrato juntos** | AGENTS.md |

### 2.2. O gate — roda ao final de **toda** fase, sem exceção

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

A SPEC §14 acrescenta, por fase: **F1** = asserções da migração passando e app
idêntico ao de antes; **F2** = os testes novos falhando no código antigo;
**F3/F4** = suítes de motor verdes **sem** relaxar asserção existente; **F7** =
`npx @redocly/cli lint` nos dois `openapi*.json` + paridade estrutural.

### 2.3. Trocar de modelo

No app do Claude Code, use o seletor de modelo da interface. Em terminal
interativo, `/model` (`/model opus`, `/model sonnet`). O modelo indicado em cada
fase é o da SPEC §9.1 — a régua é: **erro silencioso ou irreversível → Opus 5**;
**extensão de padrão já fixado → Sonnet 5**.

### 2.4. Como abrir "sessão nova" vs. "continuar"

- **Sessão nova** = janela nova, contexto zerado. O prompt do §6 é auto-suficiente.
- **Continuar** = mesma sessão da fase anterior, com o contexto dela vivo. Nesse
  caso o prompt é curto de propósito: repetir o que a sessão já sabe só gasta
  contexto.

---

## 3. Mapa das fases

| # | Fase | Modelo | Sessão | Depende de | Entrega |
| --- | --- | --- | --- | --- | --- |
| **F1** | Migração `075` (§4 da SPEC) | **Opus 5** | Nova, dedicada | — | Arquivo `.sql` idempotente + asserções |
| **F2** | Núcleo TS (§5.1-5.3) | **Opus 5** | Nova | F1 aplicada em `vn` | `selectableChannels`, `templatesForChannel`, `assertTemplateChannelCompatible` + testes |
| **F3** | Motor de automações (§5.4 + §6) | **Opus 5** | **Continua a F2** | F2 | Automação escopada; envio sem conversa; fim do B2/B3 |
| **F4** | Motor de fluxos (§5.5, D-7) | **Opus 5** | **Continua a F3** | F3 | Escopo de fluxo; execução ativa por conversa |
| **F5** | Assistente de disparo (§7.1) | **Sonnet 5** | Nova | F2 | Passo "Enviar por" como passo 1, lista filtrada, teste de envio e rascunho |
| **F6** | Construtores + listas + i18n (§7.2-7.5) | **Sonnet 5** | **Continua a F5** | F5 | Campo "Vale para o número" em automação e fluxo |
| **F7** | API pública + MCP (§8) | **Sonnet 5** | Nova | F2 | `channel_id` na ingestão + três arquivos de contrato |
| **F8** | Observabilidade (§11) | **Sonnet 5** | **Continua a F7** | F7 | `channel_source` no log + consulta de auditoria |
| **F9** | Teste manual (§12) | — | — | Todas | Checklist de 20 itens assinado |

**Custo, em uma linha:** Opus nas quatro primeiras (migração e motores — onde o
erro não aparece como erro, aparece como mensagem entregue pelo número errado ou
fluxo que não responde), Sonnet nas quatro últimas (UI, contrato e log, onde o
padrão já está fixado e o gate pega o desvio).

---

## 4. Ordem de execução

```
        ┌────────────────── trilha do núcleo (Opus 5) ──────────────────┐
F1 ────►│ F2 ──► F3 ──► F4 │                                            │
        └───┬──────────────────────────────────────────────────────────┘
            │
            ├──► F5 ──► F6      trilha da interface (Sonnet 5, sessão própria)
            │
            └──► F7 ──► F8      trilha de contrato e log (Sonnet 5, sessão própria)

                                            todas ──► F9 (você)
```

- **Nada antes da F1.** As colunas precisam existir no `vn` antes de qualquer
  código escrever nelas.
- **F5/F6 e F7/F8 dependem só da F2** e podem correr **em paralelo** com F3/F4,
  em sessões distintas — inclusive ao mesmo tempo, se você quiser tocar duas
  janelas.
- **F9 exige todas**, e exige a conta de teste com dois números oficiais
  conectados, de preferência em WABAs diferentes.

**Sequência mínima recomendada, se for tocar uma coisa de cada vez:**
F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8 → F9.

---

## 5. Por que estas fronteiras de sessão

- **F1 sozinha.** É a única fase irreversível, e mexe em concorrência (o índice
  do D-7). Uma sessão que só tem a `075` no contexto não confunde "o que o banco
  vai virar" com "o que o código já faz".
- **F2+F3+F4 na mesma sessão.** F3 e F4 são os **consumidores** das funções que a
  F2 define. Separar faria a sessão seguinte redescobrir assinaturas que a
  anterior acabou de desenhar — e é assim que nasce a segunda implementação da
  mesma regra.
- **F5+F6 juntas.** Consomem o mesmo hook e o mesmo vocabulário (D-10). O rótulo
  "Vale para o número" tem que sair idêntico nas três telas.
- **F7+F8 juntas.** O contrato e o log que provam o contrato.

---

## 6. Prompts de abertura

### F1 — Migração `075` · Opus 5 · sessão nova dedicada

```text
Leia primeiro AGENTS.md (raiz do repo) e depois docs/spec-065-selecao-de-canal-por-recurso.md
inteira. As decisões D-1 a D-11 foram ratificadas pelo mantenedor em 2026-08-31 — não
pergunte sobre regra de negócio, implemente o que está escrito.

Você vai implementar SÓ a F1: a migração de schema. Nada de TypeScript, nada de UI.

Arquivo a criar: supabase/migrations/075_resource_channel_selection.sql

Antes de nomear, rode `ls supabase/migrations/`. Se já existir uma 075 que eu não sei
(outra sessão pode ter avançado), PARE e pergunte. Quando este prompt foi escrito, a
última era 074_remove_account_member_plan_fix.sql.

O conteúdo está no §4 da SPEC, e as quatro subseções são todas obrigatórias:

  §4.1 — automations.channel_id e flows.channel_id + os dois FKs ON DELETE SET NULL
         + COMMENT em cada coluna. SEM BACKFILL: NULL significa "todos os canais",
         que é exatamente o comportamento atual. Isso é decisão (D-4/D-6), não
         esquecimento.
  §4.2 — os dois índices parciais de despacho.
  §4.3 — deactivate_resource_on_channel_loss() + gatilho BEFORE UPDATE OF channel_id
         nas duas tabelas. BEFORE, não AFTER: é a única forma de alterar NEW.
  §4.4 — DROP de idx_one_active_run_per_contact e criação de
         idx_one_active_run_per_conversation. A ORDEM IMPORTA: o DROP vem primeiro,
         senão o índice antigo continua barrando a segunda execução e o novo não tem
         efeito observável. Não há backfill a fazer — leia o D-7 para entender por quê.
  §4.5 — bloco de asserções (RAISE EXCEPTION por invariante) + NOTIFY pgrst.

Convenções: migração idempotente (IF NOT EXISTS em toda ADD COLUMN/CREATE INDEX;
DROP+CREATE para função e trigger). Leia uma das migrações 052/067/068/072 antes de
escrever, para o estilo das asserções sair consistente com a casa.

NÃO aplique a migração em nenhum projeto Supabase (vn, rs). Sua entrega é o arquivo
.sql revisável — nem apply_migration via MCP, nem execute_sql. Aplicar é decisão
explícita do mantenedor.

Ao terminar, rode o gate:
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build

Nesta fase (só SQL) o esperado é tudo verde e ZERO mudança de comportamento — é o
critério de pronto da F1. Commit e push são manuais: deixe o comando pronto, não
execute. Ao final, resuma o que criou, aponte qualquer desvio do texto literal da
SPEC (e por quê), e pare. Não avance para a F2.
```

### F2 — Núcleo TypeScript · Opus 5 · sessão nova

```text
Leia AGENTS.md e docs/spec-065-selecao-de-canal-por-recurso.md inteira (decisões
D-1..D-11 já ratificadas). A migração 075 (F1) já está escrita e aplicada no projeto
Supabase `vn` — confirme com `ls supabase/migrations/` antes de assumir isso; se o
arquivo não existir, PARE.

Você vai implementar a F2 — só o núcleo TypeScript do §5.1 ao §5.3. Nenhuma rota,
nenhum componente, nenhum motor. F3 e F4 vêm depois, NESTA MESMA SESSÃO, quando o
mantenedor pedir.

  §5.1 — src/lib/channels/selectable.ts (novo): selectableChannels(channels, purpose).
         Antes de escrever, LEIA os quatro lugares que hoje reimplementam essa regra:
         components/broadcasts/step4-schedule-send.tsx:105-141,
         components/contacts/contact-detail-view.tsx:108-130,
         hooks/use-fallback-channels.ts e hooks/use-transfer-channels.ts.
         O comentário do step4 explica o bug que a divergência causou — a nova função
         precisa preservar aquele comportamento: exclui só `disabled`, NUNCA filtra por
         status='connected', e ordena connected antes de default.
  §5.2 — src/lib/whatsapp/templates-for-channel.ts (novo) + hook useChannelTemplates.
         A regra de decisão continua sendo templateBelongsToWaba (template-waba.ts) —
         não escreva uma segunda. Template legado (waba_id NULL) aparece em toda lista.
  §5.3 — assertTemplateChannelCompatible em lib/whatsapp/template-waba.ts, com
         TemplateChannelMismatchError (código template_waba_mismatch, HTTP 400).
         Nesta fase só a função e os testes; ligar os chamadores é F3 em diante.

Testes co-locados (*.test.ts ao lado do fonte), cobrindo no mínimo: mismatch de WABA,
template legado (waba_id NULL), canal disabled, canal de outra conta, e a ordenação do
seletor com o padrão em `error`.

CRITÉRIO DE PRONTO desta fase, além do gate: os testes novos precisam FALHAR no código
antigo. Se um teste passa antes e depois, ele está testando a suposição de quem o
escreveu, não a mudança — foi exatamente a lição registrada na SPEC 048 F4.

Gate completo ao final. Commit manual (deixe o comando pronto). Não avance para a F3
sem o mantenedor pedir.
```

### F3 — Motor de automações · Opus 5 · **continua a sessão da F2**

```text
Continue nesta sessão com a F3 da SPEC 065: motor de automações (§5.4) e as rotas do
§6 que dizem respeito a automação.

Reaproveite o que você acabou de escrever na F2 — não reimplemente regra nenhuma.

Pontos, na ordem:
  1. DispatchInput ganha channelId (lib/automations/engine.ts:58); quem preenche é
     lib/channels/ingest.ts:521-534, que já tem o canal em mãos.
  2. Seleção de automações filtra channel_id IS NULL OR = <id>. Sem channelId no
     despacho (o POST manual de /api/automations/engine), rodam SÓ as channel_id IS
     NULL — nunca "todas".
  3. resolveConversationId (engine.ts:762-776) é o ponto mais delicado: hoje usa
     .maybeSingle() sem canal, e o índice único é (account_id, contact_id, channel_id)
     desde a 059 — com duas conversas ele erra. Com canal: .eq('channel_id') +
     findOrCreateConversation (lib/whatsapp/resolve-conversation.ts) quando não existe
     (D-5). SEM canal: .order('last_message_at', desc).limit(1), nunca .maybeSingle().
  4. schedule-scan.ts e window-scan.ts passam o channel_id da automação adiante.
  5. validate.ts recusa ativar automação com canal inexistente, de outra conta,
     disabled, ou incapaz do passo configurado.
  6. Rotas: channel_id entra na lista de campos aceitos em POST /api/automations e
     PATCH /api/automations/[id] (route.ts:86-94), validado contra a conta.
  7. Ligar assertTemplateChannelCompatible em lib/automations/meta-send.ts.

REGRA QUE NÃO PODE SER QUEBRADA (§1, corolário 3): channel_id na automação é ESCOPO do
gatilho. Em conversa existente a resposta sai SEMPRE pelo canal da conversa. Se em
algum ponto você se vir escrevendo "trocar o canal da resposta", pare — isso é o
fallback_channel, que já existe e não muda.

Não relaxe nenhuma asserção de engine.test.ts, engine.window.test.ts ou
engine.fallback-channel.test.ts para fazer a suíte passar. Se um teste existente
quebrar, ou a mudança está errada, ou o teste codificava a premissa "uma conversa por
contato" — nesse caso, corrija o teste explicando no comentário qual premissa caiu.

Gate completo. Commit manual. Pare antes da F4.
```

### F4 — Motor de fluxos · Opus 5 · **continua a sessão da F3**

```text
Continue nesta sessão com a F4 da SPEC 065: motor de fluxos (§5.5 + D-7).

  1. dispatchInboundToFlows (lib/flows/engine.ts:954) filtra channel_id IS NULL OR
     = <id>. Precedência do D-6: FLUXO ESCOPADO GANHA DO GENÉRICO quando os dois casam
     a mesma palavra-chave. Um fluxo feito para o número de Suporte não pode perder
     para o menu geral só por ter sido criado depois.
  2. loadActiveRunForContact (engine.ts:181) vira loadActiveRunForConversation, e
     isDuplicateInbound passa a chavear por conversa. O índice já mudou na F1 (D-7) —
     este passo é o código alcançando o schema.
  3. flows/validate.ts: mesma validação de canal da F3.
  4. Rotas de flows aceitam channel_id, validado contra a conta.

Por que isto importa, para você não "simplificar" de volta: hoje
idx_one_active_run_per_contact permite UMA execução ativa por contato. O mesmo cliente
escrevendo para os dois números da conta faz a segunda colidir em 23505, que
startNewRun engole como duplicate_inbound_ignored — o fluxo simplesmente não responde,
sem erro nenhum em lugar nenhum. É o achado C2 do §2 da SPEC.

Escreva um teste que reproduza exatamente isso: mesmo contato, duas conversas em canais
diferentes, dois fluxos escopados — as duas execuções coexistem e ambas respondem.

Gate completo. Commit manual. Ao terminar, resuma as três fases (F2, F3, F4) juntas
para o mantenedor.
```

### F5 — Assistente de disparo · Sonnet 5 · sessão nova

```text
Leia AGENTS.md e docs/spec-065-selecao-de-canal-por-recurso.md (D-1..D-11 ratificadas).
As fases F1 e F2 já estão feitas: a migração 075 existe e lib/channels/selectable.ts,
lib/whatsapp/templates-for-channel.ts e o hook useChannelTemplates já estão no repo —
confirme e USE-OS, não reimplemente.

Você vai implementar a F5: §7.1 da SPEC, o assistente de disparo, ponta a ponta.

  1. "Enviar por" vira o PASSO 1 (D-1). Template passa a 2, audiência 3, personalizar 4,
     enviar 5. Arquivos: src/app/(dashboard)/broadcasts/new/page.tsx (o array `steps` e o
     indicador de etapas) + um componente novo em src/components/broadcasts/.
  2. Com UM canal elegível o passo NÃO aparece e o assistente continua com quatro
     etapas, exatamente como hoje. Com dois ou mais, aparece com o canal padrão
     PRÉ-SELECIONADO. Elegibilidade vem de selectableChannels(..., 'broadcast') — não
     escreva o filtro à mão, e não filtre por status='connected' (leia o comentário em
     step4-schedule-send.tsx:105-141 antes: esse filtro já causou o bug oposto do que
     pretendia evitar).
  3. O passo de template consome useChannelTemplates(channelId). O seletor de variante
     B do teste A/B sai da mesma lista filtrada.
  4. Trocar o canal LIMPA template e variante, com aviso — mesmo cuidado que
     handleTemplateSelect já toma com a variante B (new/page.tsx:139-148).
  5. O seletor do passo de envio SAI e vira linha de resumo ("Enviar por: … / alterar"
     que volta ao passo 1). Dois seletores para a mesma decisão é a segunda fonte de
     verdade que sempre diverge.
  6. test-send-dialog.tsx:128-137 passa a mandar o MESMO channelId no corpo (a rota
     /api/broadcasts/test-send já aceita desde a 064).
  7. Retomada de rascunho (new/page.tsx:105-110): lê broadcasts.channel_id e reidrata o
     template com findTemplateRowForWaba, não com .eq(name).eq(language).maybeSingle()
     — hoje isso quebra com o mesmo nome aprovado em dois WABAs e mostra "rascunho não
     encontrado", que é a mensagem errada para o problema certo.

Toda string visível é traduzida, nos DOIS dicionários. Reaproveite
Broadcasts.wizard.scheduleSend.sendFrom / sendFromDefault / sendFromUnhealthy, que já
existem em en.json e pt-BR.json.

Gate completo (npm run i18n:check faz parte). Commit manual. Pare antes da F6.
```

### F6 — Construtores, listas e i18n · Sonnet 5 · **continua a sessão da F5**

```text
Continue nesta sessão com a F6 da SPEC 065: §7.2, §7.3, §7.4 e §7.5.

  1. Construtor de automações (src/components/automations/automation-builder.tsx):
     campo "Vale para o número" no cabeçalho, com "Todos os números" como primeira
     opção e padrão. O componente de seleção de canal JÁ EXISTE ali — o desvio
     fallback_channel (linhas 812-860) é o precedente; siga o mesmo padrão visual.
  2. A lista de templates do passo send_template (linhas 405-412) passa a usar
     useChannelTemplates. Com "Todos os números", mostra os templates de todos os WABAs
     COM O SELO do WABA de cada um — quem protege o envio nesse caso é o
     assertTemplateChannelCompatible da F2/F3.
  3. Aviso de capacidade quando o canal escolhido não sabe fazer o passo configurado —
     reaproveite ChannelCapabilityWarning (automation-builder.tsx:1266-1290).
  4. Editor de fluxos (src/components/flows/header.tsx): mesmo campo, mesmo rótulo.
     Mais o aviso de conflito de palavra-chave entre fluxo escopado e genérico,
     explicando a precedência do D-6 onde ela acontece.
  5. Cartões das listas de automação, fluxo e campanha ganham o selo do número — só
     quando a conta tem mais de um canal (com um só, é ruído em toda linha, mesma regra
     do selo do inbox).
  6. Vocabulário do D-10, idêntico nas três telas. Chaves novas em en.json E pt-BR.json.

Gate completo. Commit manual. Ao terminar, resuma F5+F6 juntas.
```

### F7 — API pública e MCP · Sonnet 5 · sessão nova

```text
Leia AGENTS.md (especialmente a seção "API pública (/api/v1)") e
docs/spec-065-selecao-de-canal-por-recurso.md. As fases F1 e F2 já estão no repo.

Você vai implementar a F7: §8 da SPEC.

  1. POST /api/v1/ingest/contact aceita channel_id opcional, validado contra a conta —
     id de outra conta responde 400, NUNCA 404 (404 confirmaria que o id existe; é a
     regra que resolveConversationByPhone já segue, resolve-conversation.ts:71-90).
  2. Quando channel_id vem ausente E há template_id, derive o canal do WABA do template,
     se existir exatamente um canal Cloud daquele WABA; havendo zero ou mais de um, cai
     no padrão e o assertTemplateChannelCompatible decide (D-9).
     O ponto de chamada é app/api/v1/ingest/contact/route.ts:319-325, que hoje chama
     sendIngestTemplate SEM channelId embora lib/ingest/send.ts:73 já aceite.
  3. POST /api/v1/broadcasts já aceita channel_id — o que muda é a DOCUMENTAÇÃO: dizer
     que a compatibilidade template×WABA é validada e qual erro volta
     (template_waba_mismatch).
  4. mcp-server/: as ferramentas que criam campanha e automação expõem channel_id
     opcional.

Os TRÊS arquivos de contrato mudam JUNTOS, na mesma alteração (AGENTS.md):
docs/public-api.md (prosa, fonte de verdade), public/openapi.json (en) e
public/openapi.pt-BR.json (espelho pt-BR: mesmos paths/operationIds/schemas/$ref/enum/
required/exemplos — só summary e description em português; exemplos permanecem em
inglês nos dois, é o que trafega na rede).

Valide os dois: npx @redocly/cli lint public/openapi.json e o mesmo para o pt-BR.
Depois confira a paridade estrutural de chaves entre eles antes de dar por concluído.

Gate completo. Commit manual. Pare antes da F8.
```

### F8 — Observabilidade · Sonnet 5 · **continua a sessão da F7**

```text
Continue nesta sessão com a F8 da SPEC 065: §11.

  1. logOutboundSend (lib/channels/send-log.ts) passa a registrar channel_source:
     'resource' | 'conversation' | 'default'. É a única forma de responder depois "esta
     mensagem saiu pelo número B porque alguém escolheu, ou porque caiu no padrão?".
  2. automation_logs registra o motivo estável channel_unavailable quando o canal
     gravado está disabled (D-8).
  3. Deixe pronta, no §11 da SPEC e no resumo final, a consulta de auditoria que precisa
     devolver ZERO linhas em produção (recurso apontando para canal de outra conta).

Gate completo. Commit manual. Ao terminar, resuma F7+F8 e liste o que o mantenedor
precisa rodar em produção para conferir o item 3.
```

---

## 7. F9 — o que é seu

Checklist de 20 itens no **§12 da SPEC**, contra número real. Pré-requisito: conta
com **dois números oficiais** conectados, de preferência em WABAs distintos, cada
um com ao menos um template aprovado exclusivo.

Os itens que mais valem a pena rodar primeiro, porque são os que falham calados
hoje: **#5** (teste de envio pelo número escolhido), **#7** (campanha agendada não
troca de número quando o padrão muda), **#15** (duas execuções de fluxo em
paralelo) e **#16** (recurso não volta a valer para todos ao perder o canal).

---

## 8. Os pontos que exigem você, e só você

| Quando | O quê |
| --- | --- |
| Depois da F1 | **Autorizar a aplicação da `075`** — primeiro em `vn`, `rs` depois. O agente entrega o `.sql` e para |
| Ao fim de cada fase | **Rodar o commit** (o agente entrega o comando pronto) |
| Antes da F5 | Garantir que a conta de teste tem **dois números** conectados — sem isso a UI nova não tem o que mostrar |
| F9 | O checklist inteiro |
| A qualquer momento | Divergir de uma decisão `D-n`: isso exige **editar a SPEC**, não um comentário no código (§0.1) |

---

## 9. Painel de progresso

| Fase | Escrita | Gate verde | Migração aplicada | Commit |
| --- | --- | --- | --- | --- |
| F1 — migração 075 | ☐ | ☐ | ☐ `vn` ☐ `rs` | ☐ |
| F2 — núcleo | ☐ | ☐ | — | ☐ |
| F3 — automações | ☐ | ☐ | — | ☐ |
| F4 — fluxos | ☐ | ☐ | — | ☐ |
| F5 — assistente | ☐ | ☐ | — | ☐ |
| F6 — construtores | ☐ | ☐ | — | ☐ |
| F7 — API pública | ☑ | ☑ | — | ☐ |
| F8 — observabilidade | ☑ | ☑ | — | ☐ |
| F9 — teste manual | ☐ | — | — | — |

---

## 10. O que **não** antecipar (e por quê)

1. **Nenhuma fase de código antes da `075` estar aplicada no `vn`.** `PGRST204`
   no primeiro `PATCH` com `channel_id` é o sintoma, e ele aparece como bug de
   UI, não de schema.
2. **Não ligar os chamadores de `assertTemplateChannelCompatible` na F2.** A F2
   entrega a função e os testes; ligá-la em cinco caminhos de saída ao mesmo
   tempo mistura "a regra está certa?" com "os cinco pontos foram achados?".
3. **Não mexer em IA, nó `send_template` de fluxo ou painel por número.** Estão
   no §13 da SPEC como dívida deliberada — mexer neles agora aumenta a área do
   PR sem entregar o pedido.
4. **Não trocar o padrão de Configurações para "testar"** enquanto a F5 não
   estiver pronta: até lá, é o padrão que decide, e trocá-lo muda o
   comportamento de campanhas agendadas que já existem.
