# Prompt — Checagem de números e captação de contatos via WhatsApp QRCode (Evolution Go)

> **Duas funções deste arquivo:**
>
> 1. **Operacional** — o bloco entre `═══ INÍCIO DO PROMPT ═══` e `═══ FIM DO PROMPT ═══`
>    é para copiar e colar inteiro numa **sessão nova** do Claude Code aberta na raiz de
>    `zap-crm-br-client`. Ele pede a criação do PRD e/ou da SPEC desta feature.
> 2. **Didática** — a seção final, **Notas de prompting**, explica *por que* cada tag XML
>    está onde está, mapeando cada decisão para o guia de tags XML. Ela fica **fora** do
>    bloco de cópia de propósito: comentário sobre o prompt não pode virar instrução dentro
>    do prompt.
>
> **Modelo recomendado para a sessão que vai consumir este prompt:** Opus 5. Escrever
> PRD/SPEC é raciocínio de arquitetura sobre um repositório com 77 migrações e convenções
> rígidas — é exatamente o caso em que o custo maior do Opus se paga. Sonnet 5 dá conta da
> *implementação* depois, fase a fase, com a SPEC já escrita.
>
> Data de redação: 2026-09-02 · Última migração no repo nesta data: `077_conversation_exports.sql`

---

═══ INÍCIO DO PROMPT ═══

<role>
Você é um Engenheiro de Software Sênior especializado em arquitetura de integrações de
mensageria (WhatsApp), sistemas multi-tenant sobre Postgres com RLS e processamento
assíncrono por cron. Você escreve documentos de produto e de engenharia — PRD e SPEC — que
outra pessoa implementa depois, fase a fase, sem precisar te perguntar nada.
</role>

<context>
O sistema é o **ZAP CRM BR** (Next.js 16 + Supabase + RLS + i18n pt-BR/en). Ele já opera
dois tipos de canal de WhatsApp em paralelo:

- **Oficial** — Meta Cloud API, N números por conta (SPEC 064), selecionável por recurso
  (SPEC 065).
- **Não oficial** — instância conectada por QRCode contra um servidor **Evolution Go**
  auto-hospedado, cada instância virando um `channel` do sistema (PRD 047 / SPEC 048).

A feature descrita abaixo usa a **instância não oficial** como *ferramenta de enriquecimento
e validação da base de contatos* — um uso novo, diferente de tudo que ela faz hoje (que é
conversar). Isso levanta uma questão de produto real: consultar o WhatsApp em lote a partir
de uma sessão de número pessoal é comportamento que o antispam do WhatsApp pode punir com
banimento do número. O sistema já tem um módulo dedicado a esse risco
(`src/lib/channels/cold-send-limit.ts`), e esta feature precisa se posicionar em relação a ele.
</context>

<repository_state>
Estado do repositório em 2026-09-02 que **já existe** e que a SPEC precisa reaproveitar em
vez de reinventar. Confirme cada item lendo o arquivo antes de escrever sobre ele — este
bloco é um mapa, não uma fonte de verdade congelada.

- `src/lib/evolution/` — cliente HTTP (`client.ts`), CRUD de instâncias (`instances.ts`),
  limites de instância (`limits.ts`), configuração e defaults (`config.ts`), identidade de
  contato (`contact-identity.ts`).
- `contacts.avatar_url` — a **coluna já existe** no schema e já é renderizada no inbox
  (`conversation-list.tsx`, `contact-sidebar.tsx`, `assignment-board/conversation-card.tsx`).
  O **gerenciador de contatos NÃO renderiza**: `contact-detail-view.tsx` usa só
  `AvatarFallback` com iniciais, sem `AvatarImage`. Ou seja: metade do requisito R4 abaixo
  já está pronta, e a SPEC precisa dizer qual metade.
- `contacts.whatsapp_status` (`'valid' | 'invalid'`), `whatsapp_status_reason`,
  `whatsapp_status_updated_at` — SPEC 044 §6.4, `src/lib/contacts/whatsapp-status.ts`.
  Hoje têm **duas** fontes (erro 131026 da Meta; duas falhas consecutivas de entrega). A
  checagem via Evolution seria uma **terceira** fonte do mesmo campo.
- `BroadcastStatus` (`src/types/index.ts:530`) — hoje
  `draft | scheduled | sending | sent | failed | streaming`, com **CHECK constraint no banco**
  (veja como `'streaming'` foi adicionado na migração `065`, seção 1.2 — inclusive o padrão
  idempotente de reescrever o CHECK).
- Cinco rotas de cron já existem e seguem o mesmo contrato — header `x-cron-secret`
  (`AUTOMATION_CRON_SECRET`), `503` deliberado quando a variável não está no servidor:
  `/api/broadcasts/cron`, `/api/automations/cron`, `/api/flows/cron`,
  `/api/messages/retention/cron`, `/api/plans/lifecycle/cron`. O agendamento fica em
  `supabase/setup/cron-jobs.sql` (**não** é migração).
- **Motor de quotas** (SPEC 059) — quota de contatos por plano é enforçada por *trigger* no
  Postgres. Toda inserção em massa de contatos passa por ela.
- `src/lib/storage/upload-media.ts` — helper de upload para bucket Supabase.
- Próxima migração livre: **078** (confirme com `ls supabase/migrations/` antes de nomear).

### Como os limites da instância QRCode estão discriminados hoje

Levantado no código em 2026-09-02. São **dois eixos independentes, resolvidos de formas
diferentes** — e é essa assimetria que o R7 vem corrigir.

**Eixo A — quantas instâncias QRCode uma conta pode ter.** `src/lib/evolution/limits.ts`
(`checkInstanceLimit`) + `src/lib/evolution/config.ts`. **Já tem a cascata de três níveis
completa** (SPEC 059 §4.2):

| Nível | Fonte | Padrão |
| --- | --- | --- |
| 1 — por conta | `plan_limit(account_id, 'channels_whatsapp_qr')` (plano + `account_plans.limit_overrides`) | — |
| 2 — deployment | `EVOLUTION_MAX_INSTANCES_PER_ACCOUNT` | — |
| 3 — código | `config.ts:59` | `3` |

Mais um **teto global do deployment**, `EVOLUTION_MAX_INSTANCES_TOTAL` (código: `20`), que é
checado **primeiro** e que nenhum override por conta ultrapassa — ele protege a VPS, não o
cliente. A mensagem de recusa por teto de deployment é distinta da de conta
(`describeLimitDenial`), de propósito.

**Eixo B — quanto cada instância pode enviar a frio.** `src/lib/channels/cold-send-limit.ts`
(cálculo puro) + `cold-send-wiring.ts` (leitura de uso e execução). Três tetos simultâneos,
janela deslizante de 24 h, rampa de aquecimento (piso `WARMUP_FLOOR = 5`). **Só tem os níveis
2 e 3 — `.env` global e default de código. Não existe nível por conta nem por instância:**

| Variável de ambiente | Padrão no código | O que é |
| --- | --- | --- |
| `EVOLUTION_COLD_SEND_SILENCE_HOURS` | `24` | Silêncio a partir do qual o envio conta como frio |
| `EVOLUTION_COLD_SEND_PER_HOUR` | `12` | Teto por hora corrida — é o que impede a rajada |
| `EVOLUTION_COLD_SEND_PER_DAY` | `60` | Teto por 24 h corridas (janela deslizante, não meia-noite) |
| `EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS` | `45` | Intervalo mínimo entre dois envios frios |
| `EVOLUTION_COLD_SEND_WARMUP_DAYS` | `14` | Dias até a cota diária chegar ao `perDay` cheio |

Semântica de leitura já implementada em `readColdSendLimits`, que a cascata nova precisa
preservar: valor **ausente, não numérico ou negativo cai no padrão** (um `.env` com erro de
digitação nunca pode virar "sem limite"); **`0` é aceito e significa bloquear aquele eixo**
(exceto `silenceHours`, onde `0` cai no padrão).

**Consequência prática do estado atual:** duas contas no mesmo deployment são obrigadas a
compartilhar exatamente os mesmos tetos de envio frio. Não há como dar 200/dia para um
cliente com número maduro e 30/dia para um número recém-criado de outro cliente.

**Outros limites e timeouts da mesma família, hoje só `.env` + código:**
`EVOLUTION_REQUEST_TIMEOUT_MS` (`15000`), `EVOLUTION_MEDIA_REQUEST_TIMEOUT_MS` (`60000`).

**Estado do painel do proprietário** (`/admin/accounts/[accountId]`, SPEC 062,
`src/app/(platform)/admin/accounts/[accountId]/page.tsx`): renderiza `PlanUsageBars`,
`BlockToggle`, `ChangePlanDialog` e `AccountRetentionPanel`. A rota
`PUT /api/admin/accounts/[accountId]/plan` **já aceita** `limitOverrides` e valida contra
`QUOTA_KEYS` — mas **nenhum componente de UI expõe um editor de overrides** hoje
(`change-plan-dialog.tsx` só troca plano e status). Ou seja: o override por conta existe no
banco e na API, e só é alcançável por `curl`. O `AccountRetentionPanel` é o precedente mais
próximo do que o R7 pede na tela — configuração por conta **× tipo de canal**, com "usar o
padrão" como estado explícito.

`QUOTA_KEYS` (`src/lib/plans/types.ts`) hoje: `contacts`, `members_total`, `members_admin`,
`members_agent`, `members_viewer`, `channels_whatsapp_qr`, `channels_whatsapp_cloud`.
`plan_limit()` devolve `INTEGER`, e **`NULL` significa ilimitado** — o que colide com a
semântica de `0` do cold-send (`0` = bloqueia). Ver D-6.
</repository_state>

<documents>
<document>
<source>AGENTS.md</source>
<note>Convenções obrigatórias do repositório — leia primeiro, inteiro.</note>
</document>
<document>
<source>docs/prd-047-canais-e-whatsapp-qrcode.md</source>
<note>Camada de canais + decisão de produto sobre WhatsApp não oficial, incluindo §10.3 (risco de banimento).</note>
</document>
<document>
<source>docs/spec-048-canal-whatsapp-qrcode.md</source>
<note>SPEC do canal QRCode. O §1 avisa que a referência da Evolution Go é incompleta — vale aqui também.</note>
</document>
<document>
<source>docs/references/evolution_go_crm_spec.md</source>
<note>Os quatro endpoints da Evolution Go desta feature: POST /user/check, POST /user/avatar (base64), GET /user/contacts, POST /user/info.</note>
</document>
<document>
<source>docs/references/EVOLUTION_GO_REFERENCE.md</source>
<note>Referência geral da API — use para o que o arquivo acima não cobrir (autenticação, escopo por instância, erros).</note>
</document>
<document>
<source>docs/spec-059-motor-de-quotas.md</source>
<note>Como a quota de contatos é enforçada — R5 insere contatos em massa e esbarra nisso.</note>
</document>
<document>
<source>docs/spec-044-audiencia-multiformato-e-triagem.md</source>
<note>§6.4 — semântica atual de `whatsapp_status`, que R2/R6 vão passar a escrever.</note>
</document>
</documents>

<feature_requirements>
Os seis requisitos da feature, como o mantenedor os descreveu. São **dados de entrada** para
o documento que você vai escrever — não são passos de execução.

<requirement id="R1" name="Habilitar a instância como validadora">
No gerenciador de conexão WhatsApp QRCode (em Configurações), cada instância ganha:
(a) um switch "usar esta instância para checagem de números"; (b) um switch independente
"permitir captar contatos desta instância"; (c) um input numérico com quantos contatos podem
ser captados dessa instância para dentro da base do CRM. A checagem respeita o limite de
segurança da instância — é operação que pode causar bloqueio do número.
</requirement>

<requirement id="R2" name="Marcar lista para checagem no upload">
Ao fazer upload de lista de contatos — tanto no gerenciador de contatos quanto no
gerenciador de disparos (broadcast) — o usuário pode marcar que aqueles contatos devem
passar pela checagem via instância QRCode.
</requirement>

<requirement id="R3" name="Checagem em fundo pelo caminho do gerenciador de contatos">
Upload no gerenciador de contatos + marcação de R2 ⇒ um cron consome a fila aos poucos,
respeitando o limite de segurança da instância e só se o switch de R1 estiver ligado. Além
de verificar se o número existe no WhatsApp, a checagem busca a imagem de avatar e os demais
dados disponíveis (conforme os endpoints da referência) e **atualiza a base**.
</requirement>

<requirement id="R4" name="Avatar de contato vindo da instância">
Contato pode ter avatar vindo da instância não oficial, guardado em bucket Supabase. Regras:
exibir a imagem no gerenciador de contatos e no inbox **quando ela existir**; quando não
existir, manter exatamente o comportamento atual (iniciais). **Não** existe upload manual,
edição nem substituição de avatar por usuário — em nenhum dos dois tipos de canal.
</requirement>

<requirement id="R5" name="Cron exclusivo de captação de contatos">
Um cron **separado**, dedicado a captar contatos das instâncias QRCode: 50 contatos por
execução (número, dados, avatar), rodando de hora em hora entre 00:00 e 06:00. Captação
**não** consome o limite de envio frio da instância — não é mensagem, é leitura. Contato
captado nasce vinculado ao canal (instância) de onde veio.
</requirement>

<requirement id="R6" name="Disparo parcial no Broadcast">
No disparador, com a checagem de R2 habilitada, a checagem começa **imediatamente** em
segundo plano, respeitando o limite seguro. Ao atingir o limite, para de checar; dispara para
os números já validados e enriquecidos; entra em espera até o próximo ciclo de limite
(provavelmente lido por um cron de 5 min); retoma a checagem de onde parou, dispara de novo,
e assim por diante até esgotar a lista. Isso cria um estado novo de campanha:
**"Em espera — disparo parcial"**.
</requirement>

<requirement id="R7" name="Cascata única de resolução de limites — três níveis">
**Transversal a R1–R6 e ao que já está implantado.** Todo limite relacionado à instância
QRCode — os que já existem hoje (envio frio, número de instâncias, timeouts) e os novos
desta feature (checagens por execução, teto de captação, tamanho do lote, janela horária do
cron) — passa a ser resolvido por **uma única cascata, na mesma ordem, em todos os pontos**:

1. **Por conta, pelo painel do proprietário** — `/admin/accounts/[accountId]`, no formato já
   implantado na SPEC 059 (`account_plans.limit_overrides` lido por `plan_limit()`),
   apresentado junto dos demais limites por canal. **Se estiver definido aqui, vale este.**
2. **Padrão do deployment, por variável de ambiente** — se a conta não define, vale o `.env`.
   Todo limite precisa ter a sua variável, inclusive os que hoje só existem no código.
3. **Padrão do código** — se não há `.env`, vale a constante do código: os valores atuais de
   `COLD_SEND_DEFAULTS` e `config.ts` para o que já existe, e os números descritos neste
   prompt para o que é novo (50 contatos por execução de R5, janela 00:00–06:00 de hora em
   hora, teto de captação por instância de R1).

O sistema **nunca fica sem limite** por ausência de configuração: o nível 3 sempre responde.
O painel do proprietário precisa distinguir visualmente "esta conta usa o padrão" de "esta
conta tem valor próprio", e permitir voltar ao padrão — o mesmo comportamento que o painel de
retenção por canal já tem.
</requirement>
</feature_requirements>

<task>
Produzir a documentação que permite implementar esta feature: um **PRD** (somente se o
escopo justificar — julgue e defenda a decisão) e uma **SPEC** técnica completa, pronta para
implementação em fases, seguindo o padrão dos documentos existentes em `docs/`.
</task>

<instructions>
1. Leia `AGENTS.md` inteiro. Depois leia os documentos listados em `<documents>`, e os
   arquivos citados em `<repository_state>` que forem tocados pela feature.
2. Antes de escrever qualquer documento, **decida e justifique em uma linha**: esta feature
   precisa de PRD próprio, ou o PRD 047 já cobre a decisão de produto e basta uma SPEC?
   Você tem autonomia para dizer "não precisa de PRD" — o mantenedor pediu sinceridade
   explicitamente, não concordância.
3. Levante as **decisões em aberto** que a descrição não fecha, e numere-as `D-1`, `D-2`, …
   Para cada uma: as opções reais, o trade-off de cada opção e a **sua recomendação**.
   Comece por estas quatro, que já estão identificadas — e acrescente as que você encontrar:
   - **D-1** — checar número (`POST /user/check`) consome a cota de envio frio de
     `cold-send-limit.ts`, consome uma cota separada, ou nenhuma? A resposta muda o
     comportamento inteiro de R3 e R6.
   - **D-2** — a checagem via Evolution escreve em `contacts.whatsapp_status` (terceira
     fonte do campo existente) ou em campo novo? Se escreve no existente, qual
     `whatsapp_status_reason` novo, e o que acontece quando Evolution e Meta discordam?
   - **D-3** — contato captado por R5 entra na base como contato pleno (consumindo quota de
     plano e aparecendo em audiências de marketing) ou em uma área de triagem? Qual
     `opt_in_status` ele recebe — e como isso conversa com a LGPD, já que essa pessoa nunca
     falou com o CRM?
   - **D-4** — o estado de R6 é um valor novo no CHECK de `broadcasts.status`, ou um par
     "status + flag"? Cheque como `'streaming'` foi introduzido na migração 065 antes de
     recomendar.
   - **D-5 (R7)** — os limites de envio frio viram **chaves novas em `QUOTA_KEYS`**
     (`evolution_cold_send_per_day`, `…_per_hour`, …), reaproveitando `plan_limit()` e o
     editor de overrides inteiro, ou viram uma **tabela própria por conta × instância**? A
     favor de `QUOTA_KEYS`: um mecanismo só, uma UI só, cascata já existente. Contra: quota é
     "quanto você pode ter" e cold-send é "com que taxa você pode agir" — e o nível "por
     instância" não existe em `account_plans`, que é por conta. Recomende considerando que o
     R1 já pede configuração **por instância** (o switch e o teto de captação).
   - **D-6 (R7)** — colisão de semântica do "vazio": em `plan_limit()`, **`NULL` = ilimitado**;
     em `readColdSendLimits`, **`0` = bloqueia** e ausente = padrão. Três estados
     (herda o padrão / valor próprio / bloqueia) não cabem em dois. Como representar sem
     ambiguidade, e o que acontece se um operador digitar `0` esperando "sem limite"?
   - **D-7 (R7)** — existe teto máximo absoluto que o override por conta **não** pode
     ultrapassar, como `EVOLUTION_MAX_INSTANCES_TOTAL` já faz no eixo A? Um `perDay` de 5.000
     configurado no painel não fura só a política comercial — fura o número do cliente e a
     reputação da VPS. Recomende se o `.env` passa a ter também um **teto duro** por eixo, e
     o que a UI mostra quando o operador tenta ultrapassá-lo.
   - **D-8 (R7)** — o nível 1 é **por conta** (`account_plans`) ou **por instância**
     (`evolution_instances`)? Duas instâncias da mesma conta podem ter maturidades muito
     diferentes — uma com 2 anos de uso, outra criada ontem. Se a resposta for "os dois",
     defina a ordem: instância > conta > `.env` > código, e diga o que a UI de cada nível
     mostra sobre o nível acima.
4. Monte o **inventário completo de limites** (R7) como tabela, antes de escrever a solução:
   uma linha por limite, com as colunas *limite · o que protege · chave por conta (nível 1) ·
   variável `.env` (nível 2) · padrão no código (nível 3) · onde é lido hoje*. Inclua os que
   **já existem** (os cinco de envio frio, os dois de instância, os dois timeouts) e os
   **novos** desta feature. Um limite que fica de fora dessa tabela é um limite que continua
   escondido no código — a tabela é o que define "pronto" para o R7, do mesmo jeito que a
   §4 da SPEC 059 define para as quotas.
5. Escreva a SPEC cobrindo, no mínimo: modelo de dados (com o SQL da migração 078 e as
   policies RLS), contratos das rotas, os módulos puros novos em `src/lib/` com o que cada um
   decide, o desenho dos dois crons (o de checagem e o de captação de R5) incluindo a entrada
   correspondente em `supabase/setup/cron-jobs.sql`, os pontos de UI, as chaves de i18n novas,
   o plano de testes e a tabela de fases.
6. Quebre a implementação em **fases numeradas** (F1, F2, …), cada uma com um "Pronto quando"
   verificável, na ordem em que devem ser implementadas — migração primeiro, UI por último,
   cada fase deixando a suíte verde e o app funcionando. A cascata do R7 é **infraestrutura
   das outras fases**: ela vem cedo, e a fase que a entrega precisa provar que o
   comportamento atual não mudou para ninguém que não configurou nada.
7. Ao final, em seção própria, liste o que **você** acha que está faltando na descrição do
   mantenedor: riscos não considerados, casos de borda, interações com features existentes,
   e o que fazer quando a Evolution estiver fora do ar ou a instância desconectada no meio de
   um lote.
</instructions>

<constraints>
- **Não escreva código de implementação.** A entrega desta sessão é documento em `docs/`.
  A única exceção é o SQL da migração **dentro** da SPEC, como bloco de código.
- **Não aplique migração** em nenhum projeto Supabase (`vn`, `rs`) — o mantenedor autoriza
  isso caso a caso, e esta sessão não tem essa autorização.
- **Não rode git.** Commits e push são manuais do mantenedor; entregue o comando pronto.
- Reaproveite os módulos e conceitos listados em `<repository_state>`. Um segundo sistema de
  limites paralelo ao `cold-send-limit.ts` é retrabalho e vira bug de segurança do número.
- **A cascata do R7 é implementada uma vez e usada por todos.** Um único ponto resolve
  "conta → `.env` → código" e devolve o valor efetivo; nenhum call site lê `process.env`
  direto para decidir limite. Se dois lugares resolverem a cascata, um deles vai divergir do
  outro no primeiro limite novo.
- **Compatibilidade é requisito, não cortesia:** um deployment que não configurou nada — nem
  painel, nem `.env` — tem que se comportar **exatamente** como hoje, com os mesmos números.
  A entrega do R7 é refatoração de origem do valor, não mudança de política.
- Toda string visível ao usuário exige chave nova em `messages/en.json` **e**
  `messages/pt-BR.json` (`npm run i18n:check` quebra se divergirem). Mensagens de `/api/**`
  permanecem em inglês.
- A referência da Evolution Go é **incompleta** (SPEC 048 §1). Onde ela não cobrir o que a
  feature precisa, marque explicitamente como *pendência de verificação contra a API real* em
  vez de inventar o contrato.
- Escreva em **português do Brasil**, no tom dos documentos existentes em `docs/`: explique o
  *porquê* das decisões, não só o *o quê*.
</constraints>

<examples>
Dois exemplos do formato esperado, extraídos do padrão das SPECs existentes do repositório.
Eles calibram **forma**, não conteúdo — não copie o assunto.

<example name="decisao_em_aberto">
<output>
**D-7 — Retenção conta por canal ou por conta?**

*Opções:* (a) uma política por conta, simples de explicar e de administrar; (b) uma política
por `channel_type`, porque a Meta já retém mídia por 30 dias e a instância QRCode não retém
nada — o mesmo prazo nos dois trata como iguais dois canais que não são.

*Recomendação:* (b). O custo é uma linha a mais na tabela de políticas; o benefício é não
apagar cedo demais o único lugar onde a mídia do canal não oficial existe.

*Impacto se mudarmos depois:* migração de dados e reescrita da varredura — decida agora.
</output>
</example>

<example name="linha_da_tabela_de_fases">
<output>
| **F3** | Rota `POST /api/contacts/check-queue` + módulo puro `src/lib/evolution/check-queue.ts` (decide o próximo lote respeitando `cold-send-limit`). **Pronto quando:** testes do módulo puro cobrem os três tetos e a rampa de aquecimento; rota devolve `503` sem `AUTOMATION_CRON_SECRET`; nenhuma UI ainda. |
</output>
</example>
</examples>

<output_format>
Entregue **arquivos** em `docs/`, seguindo a numeração sequencial livre no diretório
(confirme com `ls docs/` — na data deste prompt, a última SPEC é a 067):

- `docs/prd-0NN-<slug>.md` — **somente se** você concluiu no passo 2 que ele se justifica.
- `docs/spec-0NN-<slug>.md` — sempre.

A SPEC deve conter, nesta ordem: sumário de uma frase · decisões a ratificar (D-1…D-n) ·
**inventário de limites (a tabela do passo 4) e o desenho da cascata** · modelo de dados e
migração · contratos de rota · módulos de `src/lib/` · desenho dos crons · pontos de UI ·
chaves de i18n · plano de testes · tabela de fases (F1…Fn) com "Pronto quando" · armadilhas
conhecidas · o que ficou de fora e por quê.

Junto da SPEC, entregue o **bloco de `.env` pronto para colar**, com toda variável nova e
toda variável existente que a cascata passa a considerar, cada uma comentada com o padrão de
código que ela sobrescreve.

Na resposta do chat (fora dos arquivos), devolva só: as decisões D-1…D-n com sua
recomendação em uma linha cada, o veredito sobre o PRD, e a linha do `git add`/`git commit`
pronta para o mantenedor rodar.

**Pare depois de escrever os documentos.** Não comece a implementar; o mantenedor ratifica as
decisões primeiro.
</output_format>

═══ FIM DO PROMPT ═══

---

## Notas de prompting — por que o prompt acima está estruturado assim

Esta seção existe porque o arquivo tem dupla função: pedir o documento **e** servir de estudo.
Cada nota amarra uma escolha do prompt a uma regra do guia de tags XML.

### 1. O erro central da versão anterior: tudo dentro de `<task>`

A primeira versão deste prompt tinha um `<context>` de uma frase e um `<task>` com seis
parágrafos longos que misturavam, no mesmo bloco: descrição da feature, decisões de UI,
regras de negócio, restrições ("não vai ter edição de imagem") e instruções de entrega
("criar o PRD e a SPEC"). É exatamente o **erro comum** que o guia lista — colocar dentro de
uma tag conteúdo que pertence a outra.

Por que importa na prática: um `<task>` de 900 palavras não é mais um objetivo, é um
documento. O modelo tem que inferir sozinho o que ali é "o que entregar" e o que é "o que a
feature faz" — e essa inferência é onde escopo se perde. Na versão acima, `<task>` tem **duas
linhas**: produzir PRD (se justificar) e SPEC. Tudo o mais migrou para a tag que corresponde
à sua natureza.

### 2. `<feature_requirements>` com `<requirement id>` — dados, não tarefas

Os seis itens numerados do original pareciam tarefas, mas não são: ninguém quer que o modelo
*implemente* R1..R6 nesta sessão, quer que ele *escreva sobre* R1..R6. Colocá-los em
`<task_1>…<task_6>` (padrão 2 do guia) teria sido literalmente pedir seis execuções.

Container `<feature_requirements>` com filhos `<requirement id="R1" name="...">` é o **padrão 3
do guia** — hierarquia real do conteúdo — usado para *dados*, não para objetivos. O ganho
concreto vem dos ids: as `<instructions>` e as `<constraints>` conseguem escrever "o
comportamento inteiro de R3 e R6" em vez de "aquela parte sobre o disparador", e a SPEC
gerada pode rastrear cobertura requisito a requisito. Um id é um endereço — e endereço é o
que transforma prosa em algo referenciável.

### 3. `<repository_state>` — a tag que não está no guia, e por que ela precisa existir

O guia diz explicitamente que **não existe conjunto canônico de tags**: o que vale é o nome
descrever o conteúdo e ser usado com consistência. `<repository_state>` foi criada porque o
conteúdo dela não é nem contexto de negócio (`<context>`) nem documento de referência
(`<documents>`) — é o estado verificável do código hoje.

É também a parte de maior valor prático do prompt. Sem ela, uma sessão nova pediria uma
migração para adicionar `contacts.avatar_url` — que **já existe** — e proporia um sistema de
rate limit do zero, ignorando o `cold-send-limit.ts` que já resolve o problema com três tetos
e rampa de aquecimento. Prompt bom não é o mais bem formatado; é o que carrega o fato que
impede a decisão errada. A frase "confirme lendo o arquivo antes de escrever sobre ele"
completa a ideia: o bloco é um mapa que envelhece, e o prompt admite isso.

### 4. `<documents>` com `<source>` e `<note>` — referência por caminho, não por conteúdo

O guia mostra `<documents>` com `<document_content>` inline. Aqui os documentos **não** foram
colados: o alvo é o Claude Code, que lê arquivos por conta própria, e os sete documentos
somados passam de 100 mil tokens. Inline seria desperdício.

A adaptação é o `<note>` em cada `<document>`: uma linha dizendo *para que serve aquele
arquivo nesta tarefa*. Isso transforma uma lista de caminhos em uma ordem de leitura com
propósito — o modelo sabe que vai ao PRD 047 pelo §10.3 (risco de banimento), não para
resumi-lo inteiro. Quando o conteúdo não cabe no prompt, o que se coloca no lugar dele é a
*razão de ir buscá-lo*.

### 5. `<constraints>` separado de `<instructions>`

O guia distingue: `<instructions>` são passos a seguir, `<constraints>` são limites rígidos.
No original, "não vai ter capacidade de editar a imagem" estava enterrado no meio do item 4,
junto com a descrição do comportamento — restrição travestida de requisito.

Na versão nova a fronteira é limpa: as instruções dizem *o que fazer, em ordem* (ler, decidir
sobre o PRD, levantar D-x, escrever a SPEC, fasear, criticar); as restrições dizem *o que
nunca acontece nesta sessão* (não implementar, não migrar, não rodar git, não duplicar o
módulo de limites). Restrição misturada com passo tende a ser lida como sugestão — e "não
aplique migração em Supabase" não pode ser sugestão.

Note também a aplicação de **"diga o que fazer, não o que não fazer"** onde ela cabe: em vez
de "não invente o contrato da API", o prompt diz *"marque explicitamente como pendência de
verificação contra a API real"*. Proibir sem dar destino deixa o modelo sem saída; dar o
destino resolve.

### 6. `<examples>` calibrando forma, não conteúdo

O guia recomenda 3–5 exemplos para consistência. Aqui são **dois**, e a diferença é
deliberada: few-shot com muitos exemplos serve para ensinar uma *tarefa* (classificar,
extrair, transformar). Aqui a tarefa não precisa ser ensinada — o que precisa ser calibrado é
o **formato de duas estruturas** que o repositório usa e que não se adivinham: o bloco de
decisão em aberto e a linha da tabela de fases com "Pronto quando".

Dois exemplos bem escolhidos disso valem mais que cinco genéricos, e a linha *"calibram
forma, não conteúdo — não copie o assunto"* evita o efeito colateral clássico do few-shot: o
modelo herdando o tema dos exemplos (retenção de mensagens) em vez de só a estrutura.

### 7. Ordem das tags: contexto no topo, `<task>` depois do meio

O guia recomenda, em prompts longos, documentos e contexto **no início** e a `<task>` **no
fim**. A ordem aqui é: `role` → `context` → `repository_state` → `documents` →
`feature_requirements` → **`task`** → `instructions` → `constraints` → `examples` →
`output_format`.

A `<task>` não é literalmente a última tag, e isso é intencional: `<instructions>`,
`<constraints>` e `<output_format>` são *modificadores da tarefa* e ficam melhor logo depois
dela, enquanto todo o material de leitura — o que é longo — ficou antes. A regra do guia é
sobre não enterrar o objetivo debaixo de dados; ela não obriga a tarefa a ser o último
caractere do prompt.

### 8. O que o prompt pede que o modelo *discorde*

Três pontos foram escritos para autorizar divergência explicitamente: "julgue e defenda" no
`<task>`, "você tem autonomia para dizer que não precisa de PRD — o mantenedor pediu
sinceridade, não concordância" na instrução 2, e a instrução 6 inteira (liste o que está
faltando na descrição do mantenedor).

O original terminava com "caso esteja esquecendo algo, me fale" — intenção certa, posição
errada: uma linha solta depois do fechamento de `</task>`, sem estrutura, fácil de tratar
como despedida educada. Virou passo numerado com entregável próprio, dentro de
`<instructions>`. **Se você quer crítica, ela precisa ser um item da lista de entregas, não
um post-scriptum.**

### 9. O que ficou fora de propósito

- **`<thinking>` / `<answer>`** — o guia oferece esse par para chain-of-thought manual. Não
  foi usado porque o Claude Code de hoje já raciocina nativamente, e forçar as tags acaba
  produzindo raciocínio performático dentro do documento entregue. A instrução 2 ("antes de
  escrever qualquer documento, decida e justifique") consegue o mesmo efeito — pensar antes —
  sem poluir a saída.
- **`<data>` / `<input>`** — não há dados dinâmicos aqui; os requisitos são o input, e já
  estão em `<feature_requirements>`.
- **Placeholders de variável** — este prompt é usado uma vez, colado à mão. Templatizar o que
  não se repete é cerimônia sem retorno.

### 10. O requisito transversal (R7) e por que ele não virou uma tag nova

O R7 — cascata de três níveis para *todos* os limites — não pertence à mesma categoria dos
outros seis: R1 a R6 descrevem telas e fluxos novos, enquanto o R7 **atravessa** todos eles e
ainda alcança código já implantado. A tentação era criar `<cross_cutting_requirement>` ou um
bloco `<architecture>` separado.

Não foi feito, por uma razão do guia: **nesting deve refletir hierarquia real, não ser
decorativo.** O R7 é um requisito da mesma feature, dito pelo mesmo mantenedor, no mesmo
nível de abstração — ele é irmão dos outros, não pai. O que marca a diferença é a **primeira
linha do próprio requisito** ("Transversal a R1–R6 e ao que já está implantado"), que custa
nove palavras e não custa uma estrutura nova. Estrutura nova só se paga quando o modelo
precisaria tratar aquele conteúdo de um jeito diferente — e aqui não precisa: ele lê tudo
como requisito e escreve tudo na mesma SPEC.

O acréscimo pesado do R7 não foi no `<feature_requirements>` — foi no `<repository_state>`,
com a tabela de como os limites estão discriminados hoje. É a diferença entre pedir "faça uma
cascata de limites" e pedir "estes cinco limites hoje só existem no `.env`, com estes
padrões, nestes arquivos, e este outro eixo **já tem** a cascata pronta — unifique". A
primeira versão gera um design plausível; a segunda gera um design que *encaixa*. **O trabalho
que faz um prompt funcionar quase nunca é escrever melhor o pedido: é levantar o fato que
transforma o pedido em decisão.**

Vale ver o que esse levantamento produziu de graça: quatro decisões novas (D-5 a D-8) que a
descrição original não continha e que ninguém teria enxergado sem ler o código — a colisão
entre `NULL = ilimitado` do `plan_limit()` e `0 = bloqueia` do cold-send; o teto duro que
impede o painel de furar a segurança do número; e o fato de o nível "por conta" não conseguir
expressar "por instância", que é o que o R1 realmente pede. Cada uma dessas viraria retrabalho
descoberto no meio da implementação.

### 11. Portabilidade

Como observa o guia, a estrutura é portável: para um modelo menos habituado a XML, troque
cada tag por um header Markdown (`## Contexto`, `## Requisitos`, `## Tarefa`) e o prompt
continua funcionando. O que faz este prompt bom não são os colchetes angulares — é a decisão
de que cada bloco de informação tem **um** lugar certo, e que esse lugar diz ao leitor o que
fazer com ele. As tags só tornam a fronteira visível.
