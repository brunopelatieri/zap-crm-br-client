# SPEC 064 — Múltiplos números oficiais (WhatsApp Cloud API) por conta

> **Status:** aguardando ratificação das decisões **D-1 a D-12** (§2). Depois delas, começar pela F1 (§8)
> **Data:** 2026-08-28 (duas rodadas de revisão no mesmo dia — ver §16)
> **Migração:** `072_multi_cloud_channels.sql` (confira `ls supabase/migrations/` antes — a última hoje é a `071`)
> **Depende de:** [PRD 047](./prd-047-canais-e-whatsapp-qrcode.md) (camada de canais) · [SPEC 048](./spec-048-canal-whatsapp-qrcode.md) (adaptadores) · [SPEC 049](./spec-049-inbox-multicanal-e-motores.md) (inbox multicanal e motores) · [SPEC 059](./spec-059-motor-de-quotas.md) (quotas) · [SPEC 062](./spec-062-console-do-proprietario.md) (planos e bloqueio)
> **Não muda:** SPEC 060 (retenção) e SPEC 063 (notificações) — já são por tipo de canal e por conta

---

## 0. Por que uma SPEC e não um PRD novo

A decisão de produto já foi tomada — e está escrita no banco. A migração `055`
criou o índice que hoje impede o segundo número oficial com este comentário:

> `-- Um canal Cloud por conta, enquanto whatsapp_config for singleton`
> `-- (UNIQUE(account_id) desde a 017). Quando o produto suportar múltiplos`
> `-- números oficiais, este índice cai junto com aquela restrição.`

O PRD 047 já definiu que a unidade do sistema é o **canal**, que capacidades são
declarativas e que os motores falam com adaptadores. O que falta não é visão: é o
**inventário exato do que quebra**, a migração que troca as restrições sem perder
dado, e a ordem de execução. Isso é uma SPEC.

As escolhas com efeito comercial ou de comportamento observável (o que o plano
vende, onde o template vive, se a campanha escolhe número, o que "remover número"
faz) estão no **§2**, no formato `D-n` + recomendação que os PRDs deste
repositório usam. Elas precisam da sua ratificação antes de qualquer linha de
código.

---

## 1. Princípio que organiza tudo

> **A credencial oficial deixa de ser propriedade da CONTA e passa a ser
> propriedade do CANAL.**

Hoje, todo caminho de saída faz a mesma pergunta errada:

```ts
.from('whatsapp_config').select('*').eq('account_id', accountId).single()
```

Depois desta SPEC, a pergunta certa é **por qual canal** — e `account_id` sozinho
só decide quando ninguém escolheu; aí a resposta é o canal padrão **do tipo**
exigido pela operação (D-11).

Três corolários que valem como critério de revisão:

1. **Nenhum `.single()` / `.maybeSingle()` sobre `whatsapp_config` filtrado só por
   `account_id` sobrevive.** Com duas linhas, o PostgREST devolve erro em ambos —
   ou seja, esses pontos falham **alto**, não em silêncio. Isso é sorte, não
   projeto: são 20 pontos, e um esquecido derruba o envio da conta inteira.
2. **O que falha em SILÊNCIO é o SQL — e são DOIS pontos, não um** (§1.1.C). Toda
   agregação que hoje casa `whatsapp_config` por `account_id`, ou que conta
   volume por conta contra um limite que a Meta impõe **por número**, passa a
   misturar os dois números sem erro nenhum. Procurar por mais ocorrências dessa
   classe é parte da F1.
3. **Multiplicar número não pode multiplicar produto.** Um segundo número oficial
   é mais uma linha em `channels` com `type='whatsapp_cloud'` — e, por
   construção, herda broadcast, IA, automações, flows, janela de 24 h, templates
   e métricas. Se alguma dessas superfícies precisar de um `if` novo por tipo de
   canal, a abstração da SPEC 048 vazou, e o lugar de corrigir é `lib/channels/`,
   não a superfície.

---

## 1.1. Inventário: o que exatamente quebra

Levantado no código, não presumido. Cada linha abaixo é um ponto que **hoje**
assume "um número oficial por conta".

### A. Restrições de banco que impedem a segunda linha

| Onde | O quê |
| --- | --- |
| `017_account_sharing.sql:326` | `whatsapp_config_account_id_key UNIQUE (account_id)` |
| `055_channels_foundation.sql` | `idx_channels_one_cloud_per_account` — único parcial `WHERE type='whatsapp_cloud'` |
| `055_channels_foundation.sql` | `idx_channels_one_default_per_account` — **um padrão por conta, através de todos os tipos**; numa conta com QR e dois oficiais, "o Cloud padrão" não existe (D-11) |
| `014_message_templates_meta_integration.sql:190` | `message_templates_user_name_language_key UNIQUE (user_id, name, language)` — dois WABAs não podem ter o mesmo nome de template |

### B. Consultas que resolvem credencial por conta (falham alto com 2 linhas)

| Arquivo | Linha | Papel |
| --- | --- | --- |
| `src/lib/channels/send.ts` | 222 | **O ponto central** — `resolveChannelContext` para `whatsapp_cloud` **ignora** o `channelId` recebido e cai no `.single()` |
| `src/lib/channels/send.ts` | 338 | `resolveDefaultChannelId` — padrão da conta, sem noção de tipo |
| `src/lib/whatsapp/resolve-conversation.ts` | 96 | canal de uma conversa nova aberta por telefone |
| `src/lib/whatsapp/broadcast-dispatch.ts` | 209, 1034 | credenciais do disparo do painel |
| `src/lib/whatsapp/messaging-limit-server.ts` | 59, 120 | tier de mensagens da Meta (leitura **e** cache) |
| `src/lib/ingest/send.ts` | 111 | disparo originado de ingestão |
| `src/lib/api/v1/contacts.ts` | 82 | `resolveAuditUserId` — dono para colunas de auditoria |
| `src/app/api/whatsapp/broadcast/route.ts` | 139 | rota de campanha |
| `src/app/api/whatsapp/config/route.ts` | 89, 223, 287, 409, 426, 504 | CRUD da configuração |
| `src/app/api/whatsapp/config/verify-registration/route.ts` | 56 | diagnóstico |
| `src/app/api/whatsapp/media/[mediaId]/route.ts` | 106 | proxy de mídia recebida |
| `src/app/api/whatsapp/templates/submit/route.ts` | 79, 165 | submissão à Meta (+ `onConflict: 'user_id,name,language'`) |
| `src/app/api/whatsapp/templates/sync/route.ts` | 156 | sincronização a partir do WABA |
| `src/app/api/whatsapp/templates/[id]/route.ts` | 165, 341 | edição e exclusão |
| `src/app/(dashboard)/inbox/page.tsx` | 344 | selo "WhatsApp conectado" |
| `src/components/settings/settings-overview.tsx` | 146 | resumo das configurações |
| `src/components/settings/whatsapp-config.tsx` | 124, 429 | a aba inteira (formulário de um número só) |

### C. O que falha em silêncio — os dois pontos

**C.1 — Cooldown de campanha.** `050_broadcast_cooldown.sql:227 / :313 / :398`:
as três funções de triagem de audiência fazem
`LEFT JOIN whatsapp_config wc ON wc.account_id = b.account_id` e resolvem
`broadcast_cooldown_days` com `SELECT … INTO`. Com duas configs, pegam **uma
linha arbitrária** e a triagem aplica o cooldown de um número às campanhas do
outro. Sem erro, sem log.

**C.2 — Cota de 24 h da Meta.** `044_messaging_limit_and_quota.sql:88-125`:
`broadcast_quota_usage(p_account_id, p_window_hours)` conta
`COUNT(DISTINCT br.contact_id)` sobre `broadcast_recipients` **de todas as
campanhas da conta**. Mas o *tier* (`messaging_limit_tier`) é da Meta e vale
**por número**. Com dois números:

- o consumo dos dois é somado contra o tier de um só → o painel alerta e o
  operador segura audiência que caberia;
- se os números estão em tiers diferentes — o normal, porque cada um aquece
  sozinho —, o número exibido não corresponde a nenhum dos dois.

`messaging-limit-server.ts:72` chama a RPC com `accountId`. **É a mesma classe do
C.1**, e por isso §3.9 corrige os dois na mesma migração.

### D. Superfícies que não sabem escolher número

| Superfície | Estado hoje |
| --- | --- |
| Disparo em massa | `broadcasts` **não tem** `channel_id`; `deliverBroadcast` monta o contexto uma vez via `cloudChannelContext()` a partir do plano (`broadcast-core.ts:387`) |
| Templates | escopo por conta; na Meta pertencem ao **WABA** |
| Tier e cota de mensagens | por conta (C.2) |
| Cooldown de campanha | por conta (C.1) |
| Canal padrão | `is_default` é por conta, não por tipo (D-11) |
| Aba "WhatsApp Oficial" | formulário único, não lista |

### E. Os dois bugs que já existem hoje (e esta SPEC conserta de graça)

**E.1** `POST /api/whatsapp/config` **nunca cria linha em `channels`**. Todo canal
Cloud em produção veio do backfill da `055`. Uma conta criada **depois** dele que
conecta o número oficial fica com `whatsapp_config.channel_id = NULL` e sem canal
— e `resolveDefaultChannelId` lança `ChannelNotConfiguredError`. A rota de
instância QRCode (`lib/evolution/instances.ts`) já faz certo desde a SPEC 048 F3.

**E.2** `channels.identifier` de canal Cloud guarda `phone_number_id`, e
`transfer-channel-dialog.tsx:212` já roda `formatPhoneForDisplay()` nesse valor —
o diálogo de transferência exibe um id interno da Meta formatado como se fosse
telefone. D-9 resolve.

### F. O que **não** muda (verificado, para ninguém "consertar" à toa)

- **Webhook de entrada da Meta.** `webhook/route.ts:284-320` já resolve a conta
  por `phone_number_id` (`UNIQUE` global desde a `013`) e já trata o resultado
  como **lista**. Dois números da mesma conta chegam por linhas diferentes e ambos
  resolvem certo. O `verify_token` (`:142`) já é comparado varrendo todas as
  linhas. **Zero mudança.**
- **Ingestão, janela de 24 h, envio frio, retenção.** `channel_cold_sends` (`062`),
  `conversations.channel_id` (`059`), `messages.channel_id` (`063`) e
  `message_retention_policies.channel_type` (`068`) já são por canal ou por tipo.
- **Inbox.** Seletor de canal na URL, selo por conversa e composer sensível a
  capacidade já existem (SPEC 049 §4). Com dois números oficiais eles passam a
  mostrar dois canais — sem código novo.
- **API pública.** `POST /api/v1/messages` **já aceita** `channel_id`, e
  `resolveConversationByPhone` já o valida contra a conta
  (`resolve-conversation.ts:66-90`). O que falta é o resolvedor de credencial
  honrar esse id (item B, `send.ts:222`).
- **Adoção de canal por número.** `bindChannelToPhone` (`instances.ts:718-728`)
  filtra `type='whatsapp_qr'`, então D-9 não cria colisão de `identifier` entre um
  QR e um Cloud do mesmo telefone.
- **RLS.** `channels_select` e `whatsapp_config_select` são ambas
  `is_account_member(account_id)`. As funções `SECURITY INVOKER` de §3.6 não
  ganham nem perdem alcance ao passar a ler `channels`.
- **Transferência entre canais** (SPEC 056) e **desvio de canal** em automações
  (`fallback_channel`) já trabalham com `channels.id` explícito.

---

## 2. Decisões que precisam da sua aprovação

### D-1 — Onde ficam as credenciais do segundo número · **recomendação: uma linha de `whatsapp_config` por canal**

| Opção | A favor | Contra |
| --- | --- | --- |
| **A. `whatsapp_config` vira N por conta, 1:1 com `channels`** (recomendada) | A tabela já tem `channel_id` (055); o backfill já existe; **nenhum** dos 43 arquivos que a citam muda de nome | O nome envelheceu: "config" no singular sugere singleton |
| B. Tabela nova `whatsapp_cloud_channels`, espelhando `evolution_instances` | Simetria com o canal QRCode | Migração de dados + reescrita de 43 arquivos + risco alto, por zero ganho funcional |

A simetria da opção B é estética. `evolution_instances` nasceu tabela separada
porque **não havia** tabela anterior — não porque separar seja melhor.

**Efeito:** `whatsapp_config.channel_id` passa a `NOT NULL UNIQUE`, e o FK
`ON DELETE CASCADE` (já existente) faz "apagar canal" apagar a credencial.

### D-2 — Escopo dos templates · **recomendação: por WABA, não por canal**

Na Meta, template pertence ao **WABA**, não ao número: dois números do mesmo WABA
enxergam exatamente os mesmos templates aprovados. Guardar por `channel_id`
duplicaria cada template na lista e faria a sincronização criar duas linhas locais
para uma única entidade remota.

**Recomendação:** `message_templates.waba_id TEXT`, com índice único
`(account_id, COALESCE(waba_id,''), name, language)`. A UI mostra um seletor
**"Conta do WhatsApp Business"** apenas quando a conta tem mais de um WABA
distinto; o envio resolve `canal → whatsapp_config.waba_id → templates`.

**`waba_id` nulo (linha legada — `config/route.ts:375` documenta que ele nem
sempre existiu):** o template continua válido e é tratado como pertencente ao
**WABA do canal Cloud padrão** para listagem e envio. A tela exibe o selo
"sem conta do WhatsApp Business — sincronize para corrigir", e a próxima
sincronização daquele WABA preenche a coluna. Nada some da lista de ninguém.

Consequência aceita: um template aprovado no WABA A **não** pode ser usado por um
número do WABA B. É a regra da Meta — a interface diz isso antes, em vez de deixar
a Meta rejeitar o envio depois.

### D-3 — A campanha escolhe o número · **recomendação: resolver e GRAVAR na criação**

`broadcasts.channel_id` é NULLABLE no schema, mas **toda campanha criada a partir
da F6 grava um valor** — inclusive as da API pública sem `channel_id`, que gravam
o canal padrão **resolvido no momento da criação**. `NULL` significa uma coisa só:
"campanha anterior à F6".

Resolver na criação, e não no disparo, é o que evita o pior caso: uma campanha
agendada para daqui a três dias sair por um número diferente porque alguém trocou
o padrão da conta no meio do caminho.

Se, na hora de disparar, o canal gravado estiver `disabled` ou desconectado, a
campanha **falha com motivo legível** (`channel_unavailable`) e não troca de
número sozinha.

O assistente de disparo ganha um passo **"Enviar por"**, visível só quando a conta
tem mais de um canal capaz de broadcast. Com um número, a tela não muda.

### D-4 — Cooldown, tier e **cota** por canal · **recomendação: por canal, com uma assinatura nova de RPC**

`broadcast_cooldown_days`, `messaging_limit_tier` e `messaging_limit_checked_at`
já vivem **na linha** de `whatsapp_config` — que passa a ser por canal. Não há
coluna nova: muda **por onde se lê**.

O que exige mudança de verdade é a **cota** (§1.1.C.2):
`broadcast_quota_usage` ganha `p_channel_id` e passa a contar só os destinatários
das campanhas daquele número (§3.9). Sem isso, o medidor de 24 h mistura os dois
números — e nenhum teste automatizado pegaria, porque o número exibido continua
"plausível".

### D-5 — Enforcement da quota de canais · **recomendação: trigger em `channels`, cobrindo os dois tipos**

Hoje a quota de canal é checada em **TypeScript**, em dois lugares e de duas
formas diferentes: `config/route.ts:296` (só compara `=== 0`) e
`evolution/instances.ts:199`. O princípio da SPEC 059 §1 — *o banco decide, o app
explica* — pede uma trigger (§3.7).

Três ganhos: (1) `channels_whatsapp_cloud` passa a valer **N**, não `0|1`; (2) o
buraco do QRCode fecha junto — hoje um `INSERT` direto em `channels` escapa da
checagem de rota; (3) enforcement e medidor passam a ler a mesma fonte.

**Canal `disabled` não ocupa vaga** — decorre do D-12: se desativar não libera a
vaga, o cliente que trocou de número fica preso ao teto sem entender por quê.
`src/lib/plans/usage.ts` precisa filtrar `status <> 'disabled'` na mesma fase,
senão o medidor volta a divergir do enforcement.

### D-6 — Automações, flows e IA por canal · **recomendação: fora desta SPEC**

Os três já **respondem** pelo canal da conversa (SPEC 049 §5): uma automação
disparada numa conversa do número B responde pelo número B, sem mudança nenhuma.
O que **não** existe é *escopar* uma automação a um canal ("esta só vale para o
número de Suporte") nem ter um agente de IA por número.

Isso é produto novo, não desbloqueio. Recomendo `automations.channel_id NULL`
(= todos) e `ai_configs.channel_id` numa SPEC seguinte, depois que o segundo
número estiver em produção e o uso real disser se a demanda existe. §14 registra
a dívida.

### D-7 — Saída sem canal explícito · **recomendação: canal padrão DO TIPO exigido**

Regra final, nesta ordem: **canal explícito > canal da conversa > canal padrão do
tipo exigido pela operação > `ChannelNotConfiguredError`**. Nunca "o primeiro que
aparecer". O que é "padrão do tipo" está no D-11.

### D-8 — Um número, uma conta · **recomendação: manter**

`whatsapp_config.phone_number_id` continua `UNIQUE` global (`013`). É o que
permite ao webhook da Meta rotear sem ambiguidade, e a rota de config continua
respondendo com o conflito explícito quando o número já pertence a outra conta
(`config/route.ts:223`).

### D-9 — `channels.identifier` passa a guardar o telefone · **recomendação: sim, com reconciliação explícita**

O backfill da `055` gravou `identifier = phone_number_id` (§1.1.E.2). A migração
**não** troca o valor — converter exige falar com a Graph API, e migração que
precisa de token da Meta não é migração. A troca acontece em dois pontos que já
chamam `verifyPhoneNumber` e recebem `display_phone_number`:

1. todo `POST /api/whatsapp/config` (salvar/reconectar);
2. o `GET` de diagnóstico, que passa a **reconciliar** `channels.identifier`
   quando o valor salvo diferir do que a Meta devolve.

A F7 mostra o telefone quando ele existe e o rótulo do canal quando não —
nenhuma tela exibe `phone_number_id` formatado como telefone.

### D-10 — O que o plano vende · **decisão comercial, sua**

A chave `channels_whatsapp_cloud` já existe em `src/lib/plans/types.ts` e nos
seeds; hoje vale `0` (Essencial) e `1` (demais). Com esta SPEC passa a aceitar
qualquer inteiro. Sugestão para ratificar junto com os preços — **os seeds são
seus e não vão em migração** (SPEC 059 D-2):

| Plano | hoje | sugerido |
| --- | --- | --- |
| Essencial | 0 | 0 |
| Profissional | 1 | 1 |
| Avançado | 1 | **2** |
| Enterprise | 1 | **5** |

### D-11 — Canal padrão passa a ser **por tipo** · **recomendação: sim, e a conta prefere o oficial**

`idx_channels_one_default_per_account` é `ON channels (account_id) WHERE
is_default` — **um padrão por conta, através de todos os tipos**. Numa conta que
marcou uma instância QRCode como padrão, "o número oficial padrão" simplesmente
não existe: campanha, template e tier ficariam sem resposta determinística.

**Recomendação:** o índice vira `(account_id, type) WHERE is_default` — um padrão
**por tipo**. E o "padrão da conta", que os caminhos genéricos usam (abrir conversa
nova pela API pública ou pelo inbox por `contact_id`), passa a ser **derivado**, não
armazenado:

> canal padrão da conta = padrão do `whatsapp_cloud` se a conta tiver algum Cloud
> conectado; senão o padrão do `whatsapp_qr`; senão erro.

Derivar em vez de guardar numa coluna nova (`accounts.default_channel_id`) evita
a segunda fonte de verdade que sempre acaba divergindo. A preferência pelo oficial
é regra de produto explícita: o número oficial é o canal de negócio; o QRCode é
complemento.

`resolveDefaultChannelId(db, accountId)` mantém a assinatura e passa a implementar
essa derivação; ganha um segundo parâmetro opcional `type` para os caminhos
específicos.

### D-12 — O que "remover número" faz · **recomendação: desativar, não apagar**

`conversations.channel_id` é `NOT NULL` **sem cascade** (`059`), então apagar um
canal com conversas viola o FK — a versão anterior desta SPEC prometia um `DELETE`
que o banco recusa. E, hoje, `DELETE /api/whatsapp/config` existe para um caso
específico: recuperar um token corrompido por `ENCRYPTION_KEY` trocada (botão
"Reset Configuration"). Apagar o canal mataria esse caminho de recuperação.

**Recomendação, espelhando o que `deleteEvolutionInstance` já faz:**

| Situação | O que acontece |
| --- | --- |
| Canal **com** conversas | **Apaga os segredos, não a linha**: `access_token = ''`, `verify_token = NULL`, e o canal vai a `status='disabled'` com `status_detail` explicando. Histórico, selos e filtros do inbox continuam funcionando; o canal some dos seletores de envio e **não ocupa vaga de quota** (D-5) |
| Canal **sem** conversas | Apagado de verdade — canal e config, liberando o `phone_number_id`. É o caso de quem conectou o número errado e quer refazer |
| Reconectar o mesmo `phone_number_id` | **Readota** o canal `disabled` (reativa e regrava os segredos) em vez de criar um segundo, preservando o histórico — mesma lógica de `bindChannelToPhone` |

**Por que preservar a linha, e não apagá-la.** `broadcast_cooldown_days`,
`messaging_limit_tier`, `messaging_limit_checked_at` e `waba_id` moram **só**
nessa linha (D-4 diz explicitamente "sem coluna nova"). Apagá-la faria a
reconexão nascer com o `DEFAULT 7` do cooldown — e §3.6 resolve
`COALESCE(wc.broadcast_cooldown_days, 7)`, então a próxima triagem de audiência
voltaria a incluir contatos em descanso, **sem aviso nenhum**. Guardar a
configuração e zerar só o segredo é o que faz "desativar" ser reversível de
verdade.

`access_token` é `NOT NULL` desde a `001`, daí a string vazia em vez de `NULL`. A
regra que impede um envio acidental é a mesma de sempre: **`resolveCloudConfig`
recusa canal `disabled` antes de chegar ao `decrypt()`** — nenhum caminho pode
descobrir a credencial vazia por uma exceção do decriptador.

**Três consequências, todas deliberadas:**

1. **O número continua reivindicado pela conta** enquanto o canal existir
   (`phone_number_id` é `UNIQUE` global, D-8). Mover um número entre contas do
   mesmo deployment exige apagar o canal — que só é possível sem conversas.
   Registrado em §14.
2. **Mensagem recebida num número desativado é ignorada, com log.** O webhook
   passa a checar `channels.status <> 'disabled'` antes de ingerir. É exatamente o
   que acontece hoje quando a config é apagada (`webhook/route.ts:306` registra
   "No config found"), só que agora o log diz o motivo certo — e não se cria
   conversa num canal que não pode responder.
3. **"Reset Configuration" passa a ser esta mesma operação**: zera o segredo,
   mantém canal, histórico e configuração, e o próximo salvamento reconecta. O
   caso que ele existe para resolver (`ENCRYPTION_KEY` trocada, ciphertext
   ilegível) fica melhor atendido do que hoje, porque o cooldown e o tier
   sobrevivem ao reparo.

---

## 3. Modelo de dados — migração `072_multi_cloud_channels.sql`

Idempotente, com bloco de asserções final que falha alto, no padrão das
`055`/`067`/`071`. **A ordem das seções importa** e está numerada de propósito:
3.1 derruba as restrições, 3.2 conserta os dados, 3.7 cria a trigger só no fim
(senão ela barra o próprio backfill).

### 3.1. Derrubar as restrições de singleton

```sql
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
DROP INDEX IF EXISTS idx_channels_one_cloud_per_account;

-- D-11: padrão passa a ser por (conta, tipo). O DROP vem ANTES do backfill de
-- padrões (3.2c) — marcar o padrão de um segundo tipo violaria o índice antigo.
DROP INDEX IF EXISTS idx_channels_one_default_per_account;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_one_default_per_account_type
  ON channels (account_id, type) WHERE is_default;
```

### 3.2. Toda config passa a ter canal (fecha §1.1.E.1)

**(a) Um canal por config órfã — em laço, não em `INSERT … SELECT`.**
O vínculo config→canal precisa ser 1:1 e determinístico. Um `INSERT … SELECT`
seguido de `UPDATE … FROM channels ON account_id AND type` casaria por chave
ambígua assim que a conta tiver dois canais Cloud — duas configs poderiam apontar
para o mesmo canal e violar o `UNIQUE (channel_id)` da etapa (c). O laço amarra
cada linha à que ele acabou de criar:

```sql
DO $$
DECLARE r RECORD; v_channel_id UUID; v_seq INT;
BEGIN
  FOR r IN SELECT id, account_id, user_id, phone_number_id, registered_at
             FROM whatsapp_config WHERE channel_id IS NULL
            ORDER BY created_at
  LOOP
    -- Rótulo distinto por número: o backfill da 055 nomeava tudo
    -- "WhatsApp Oficial", e dois itens homônimos na lista e no filtro do
    -- inbox são indistinguíveis para o operador.
    --
    -- Contador sequencial, e NÃO um sufixo derivado do phone_number_id:
    -- ele é um id opaco da Meta, e nada garante que dois números da mesma
    -- conta difiram nos últimos dígitos — o sufixo repetiria e recriaria
    -- a ambiguidade que ele existe para evitar. O operador renomeia na
    -- F7; aqui só precisa ser único e legível.
    SELECT count(*) INTO v_seq FROM channels
     WHERE account_id = r.account_id AND type = 'whatsapp_cloud';

    INSERT INTO channels (account_id, user_id, type, name, identifier,
                          status, is_default, connected_at)
    VALUES (r.account_id, r.user_id, 'whatsapp_cloud',
            CASE WHEN v_seq = 0 THEN 'WhatsApp Oficial'
                 ELSE 'WhatsApp Oficial ' || (v_seq + 1) END,
            r.phone_number_id,
            CASE WHEN r.registered_at IS NOT NULL THEN 'connected' ELSE 'disconnected' END,
            FALSE,                      -- padrão é decidido em (b), nunca aqui
            r.registered_at)
    RETURNING id INTO v_channel_id;

    UPDATE whatsapp_config SET channel_id = v_channel_id WHERE id = r.id;
  END LOOP;
END $$;
```

**(b) Um padrão por (conta, tipo), determinístico.** Mantém quem já é padrão e
elege onde falta — preferindo canal conectado, depois o mais antigo:

```sql
WITH faltando AS (
  SELECT c.id,
         ROW_NUMBER() OVER (PARTITION BY c.account_id, c.type
                            ORDER BY (c.status = 'connected') DESC, c.created_at ASC) AS rn
    FROM channels c
   WHERE NOT EXISTS (SELECT 1 FROM channels d
                      WHERE d.account_id = c.account_id
                        AND d.type = c.type AND d.is_default)
)
UPDATE channels SET is_default = TRUE
  FROM faltando WHERE channels.id = faltando.id AND faltando.rn = 1;
```

**(c) Apertar a coluna** — com a guarda de idempotência do padrão `017:320-327`,
porque `ADD CONSTRAINT` não aceita `IF NOT EXISTS`:

```sql
ALTER TABLE whatsapp_config ALTER COLUMN channel_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'whatsapp_config_channel_id_key'
                    AND conrelid = 'whatsapp_config'::regclass) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_channel_id_key UNIQUE (channel_id);
  END IF;
END $$;
```

### 3.3. `channels.identifier` (D-9)

Só `COMMENT ON COLUMN` registrando que o valor passa a ser o telefone E.164 de
exibição. A troca real é da aplicação (D-9, itens 1 e 2) — a F4 entrega a
reconciliação junto com a rota, para que nenhuma tela fique exibindo
`phone_number_id` depois que a F7 mostrar telefones.

### 3.4. Templates por WABA (D-2)

```sql
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS waba_id TEXT;

-- Backfill determinístico: a config mais antiga da conta. Quando esta migração
-- roda, toda conta ainda tem no máximo uma; o DISTINCT ON existe para a
-- migração continuar reexecutável depois que a segunda linha existir.
UPDATE message_templates t
SET waba_id = src.waba_id
FROM (SELECT DISTINCT ON (account_id) account_id, waba_id
        FROM whatsapp_config ORDER BY account_id, created_at) src
WHERE src.account_id = t.account_id AND t.waba_id IS NULL;
```

**Pré-checagem obrigatória antes de trocar o índice.** O índice antigo é por
`user_id`; dois membros da MESMA conta podem ter hoje, legalmente, um template com
o mesmo `name` + `language`. O índice novo é por conta e **falharia**, abortando a
migração inteira com um erro do Postgres que não diz o que fazer. Mesmo padrão
amigável das `013`/`014`:

```sql
DO $$
DECLARE v_dups TEXT;
BEGIN
  SELECT string_agg(format('%s | %s | %s (%s linhas)', account_id, name, language, n), E'\n  ')
    INTO v_dups
    FROM (SELECT account_id, COALESCE(waba_id,'') AS w, name, language, count(*) AS n
            FROM message_templates GROUP BY 1,2,3,4 HAVING count(*) > 1) d;
  IF v_dups IS NOT NULL THEN
    RAISE EXCEPTION E'072: nao e possivel criar UNIQUE(account_id, waba_id, name, language) — combinacoes duplicadas:\n  %\nApague as linhas que nao quer manter e rode a migracao de novo.', v_dups;
  END IF;
END $$;

DROP INDEX IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_waba_name_language_key
  ON message_templates (account_id, COALESCE(waba_id, ''), name, language);
```

⚠️ **`templates/submit/route.ts:79` usa `onConflict: 'user_id,name,language'`.**
Esse upsert passa a falhar com `42P10` no primeiro salvamento após a migração —
por isso a troca do `onConflict` **entra na F1, no mesmo PR da migração**, e não
na F5 (§8). Foi o erro de sequenciamento da primeira versão desta SPEC.

### 3.5. Campanha por canal (D-3)

```sql
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_channel ON broadcasts(channel_id);
```

Sem backfill e sem `NOT NULL`: `NULL` = campanha anterior à F6. Da F6 em diante,
toda campanha nasce com o canal gravado (D-3).

### 3.6. As três funções de triagem passam a resolver por canal (C.1)

`broadcast_audience_*` (`050`) recriadas com a **mesma assinatura**,
`SECURITY INVOKER` e `search_path` preservados, trocando só a resolução do
cooldown:

```sql
SELECT COALESCE(wc.broadcast_cooldown_days, 7) INTO v_cooldown_days
  FROM broadcasts b
  LEFT JOIN whatsapp_config wc
    ON wc.channel_id = COALESCE(
         b.channel_id,                       -- F6 em diante: sempre preenchido
         (SELECT c.id FROM channels c        -- campanhas legadas (NULL)
           WHERE c.account_id = b.account_id AND c.type = 'whatsapp_cloud'
           ORDER BY c.is_default DESC, c.created_at ASC LIMIT 1))
 WHERE b.id = p_draft_id;
```

### 3.7. Trigger de quota de canal (D-5)

```sql
CREATE OR REPLACE FUNCTION enforce_channel_quota() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_limit INTEGER; v_used INTEGER;
BEGIN
  v_limit := plan_limit(NEW.account_id, 'channels_' || NEW.type);
  IF v_limit IS NULL THEN RETURN NEW; END IF;   -- quota desligada ou ilimitada

  -- Serializa por (conta, tipo): sem isto, dois admins conectando ao mesmo
  -- tempo leem o mesmo count() e ambos passam no limite.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.account_id::text || ':' || NEW.type));

  -- `disabled` nao ocupa vaga (D-12) — usage.ts filtra igual, senao o medidor
  -- diverge do enforcement.
  SELECT count(*) INTO v_used FROM channels
   WHERE account_id = NEW.account_id AND type = NEW.type AND status <> 'disabled';

  IF v_used + 1 > v_limit THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED:channels_%:%:%', NEW.type, v_used + 1, v_limit
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION enforce_channel_quota() OWNER TO postgres;

CREATE TRIGGER enforce_channel_quota_trg BEFORE INSERT ON channels
  FOR EACH ROW EXECUTE FUNCTION enforce_channel_quota();

-- Reativar um canal desativado ocupa vaga de novo — senao o D-12 vira o
-- caminho para furar a quota (desativa, cria, reativa).
CREATE TRIGGER enforce_channel_quota_reactivate_trg BEFORE UPDATE ON channels
  FOR EACH ROW WHEN (OLD.status = 'disabled' AND NEW.status <> 'disabled')
  EXECUTE FUNCTION enforce_channel_quota();
```

O formato da mensagem é o que `src/lib/plans/errors.ts` já reconhece
(`QUOTA_EXCEEDED:<metric>:<used>:<limit>`) — a UI traduz sem código novo.

⚠️ `plan_limit` é `SECURITY DEFINER` de `postgres` com `EXECUTE` revogado de
`authenticated` (`067` §8). A trigger só a alcança porque também é
`SECURITY DEFINER` **e** pertence a `postgres` — daí o `ALTER FUNCTION … OWNER TO`
explícito acima. Copiar o cabeçalho de `enforce_contact_quota()`, não improvisar.

⚠️ Esta seção é a **última** da migração, depois de todo `INSERT INTO channels` de
3.2. Backfill não pode ser barrado por quota.

### 3.8. Asserções finais

Falham alto se: `whatsapp_config_account_id_key` ainda existir;
`idx_channels_one_cloud_per_account` ou `idx_channels_one_default_per_account`
ainda existirem; `idx_channels_one_default_per_account_type` estiver ausente;
sobrar `whatsapp_config` com `channel_id NULL`; existir conta com canal de um tipo
e nenhum padrão daquele tipo; `message_templates_account_waba_name_language_key`
estiver ausente; as duas triggers de quota estiverem ausentes; alguma das três
funções `broadcast_audience_*` tiver sumido; `broadcast_quota_usage` não tiver a
assinatura de 3 argumentos; `set_default_channel` estiver ausente.

**Último comando da migração, depois das asserções:**
`NOTIFY pgrst, 'reload schema';` — o `DROP`+`CREATE` de assinatura da §3.9 é
exatamente o caso em que o cache do PostgREST precisa de empurrão.

### 3.9. Cota de 24 h por número (C.2 / D-4)

A função ganha `p_channel_id`. **`CREATE OR REPLACE` não muda lista de
argumentos** — precisa de `DROP` + `CREATE`, e o `DROP` **apaga os privilégios**,
que têm de ser reaplicados (o `REVOKE` de `PUBLIC` **e** de `anon`
separadamente, conforme o comentário da `044:129-135`, que existe porque o
Supabase concede `EXECUTE` a `anon` por `ALTER DEFAULT PRIVILEGES`):

```sql
DROP FUNCTION IF EXISTS public.broadcast_quota_usage(UUID, INT);

CREATE FUNCTION public.broadcast_quota_usage(
  p_account_id UUID, p_window_hours INT DEFAULT 24, p_channel_id UUID DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count BIGINT;
BEGIN
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_window_hours IS NULL OR p_window_hours < 1 OR p_window_hours > 168 THEN
    p_window_hours := 24;
  END IF;
  -- Canal de outra conta nunca vira leitura.
  IF p_channel_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM channels WHERE id = p_channel_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(DISTINCT br.contact_id) INTO v_count
    FROM broadcast_recipients br
    JOIN broadcasts b ON b.id = br.broadcast_id
   WHERE b.account_id = p_account_id
     AND (p_channel_id IS NULL OR b.channel_id = p_channel_id)
     AND br.contact_id IS NOT NULL
     AND br.sent_at >= NOW() - make_interval(hours => p_window_hours)
     AND br.status IN ('sent','delivered','read','replied');
  RETURN COALESCE(v_count, 0);
END $$;

ALTER FUNCTION public.broadcast_quota_usage(UUID, INT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.broadcast_quota_usage(UUID, INT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.broadcast_quota_usage(UUID, INT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.broadcast_quota_usage(UUID, INT, UUID) TO authenticated, service_role;
```

⚠️ Campanhas legadas têm `channel_id NULL` e **não entram** na contagem de nenhum
número específico. É subcontagem conhecida, some sozinha em 24 h após o deploy da
F6, e é melhor do que atribuí-las a um número arbitrário. `loadAccountQuota` deve
registrar isso no log na primeira janela.

⚠️ **Trocar a assinatura invalida o cache de schema do PostgREST — e o erro é
engolido.** Entre aplicar a `072` e o PostgREST recarregar, a chamada existente
(`messaging-limit-server.ts:72`, dois argumentos nomeados) responde `PGRST202`.
E o código atual trata falha de cota como zero:

```ts
if (usageError) console.error('[messaging-limit] quota usage error:', usageError);
const usedLast24h = Number(usedRaw ?? 0);   // ← erro vira "0 usado"
```

O resultado não é uma tela quebrada: é a tela de disparo dizendo **"0 de 1.000
usados nas últimas 24 h"** para uma conta que já disparou 900 — e o operador monta
uma audiência que a Meta rejeita no meio do envio. Duas correções, ambas
obrigatórias e na mesma fase:

1. **Na migração**, `NOTIFY pgrst, 'reload schema';` como último comando da `072`
   (o `DROP`+`CREATE` de assinatura é exatamente o caso em que o event trigger
   padrão pode não bastar);
2. **No código** (F3), `loadAccountQuota` passa a devolver
   `usageUnavailable: true` em vez de `usedLast24h: 0` quando a RPC falha, e a UI
   mostra "consumo indisponível" — nunca um número que parece seguro. Ausência de
   dado e zero não podem continuar sendo a mesma coisa neste medidor.

---

## 4. Núcleo TypeScript

### 4.1. `src/lib/whatsapp/cloud-channels.ts` — o módulo novo

Um único lugar que sabe traduzir *conta + canal* em credencial Cloud. Todos os
pontos do §1.1.B passam a chamá-lo.

```ts
/** Todos os números oficiais da conta, do padrão para o mais novo. Exclui `disabled`. */
export async function listCloudChannels(
  db: SupabaseClient, accountId: string
): Promise<CloudChannelSummary[]>;

/**
 * A config de UM número. Regra do D-7 (explícito > padrão do tipo > erro).
 * `channelId` ausente = canal Cloud padrão (D-11).
 */
export async function resolveCloudConfig(
  db: SupabaseClient, accountId: string, channelId?: string | null
): Promise<{ channel: Channel; config: WhatsappConfigRow }>;

/** Quantos números oficiais ativos a conta tem — a UI decide se mostra seletor. */
export async function countCloudChannels(
  db: SupabaseClient, accountId: string
): Promise<number>;
```

`resolveCloudConfig` lança `ChannelNotConfiguredError` (a classe que já existe em
`channels/send.ts`) e **nunca** devolve "o primeiro que aparecer": sem canal
explícito e sem padrão do tipo, é erro.

⚠️ Escopo de conta em **toda** consulta, mesmo com `service_role`: um `channelId`
de outra conta vira erro, nunca leitura — como `resolve-conversation.ts:66-90` já
faz.

### 4.2. `resolveChannelContext` honra o `channelId` no ramo Cloud

O ramo `whatsapp_qr` já exige `channelId`; o ramo `whatsapp_cloud`
(`send.ts:222`) o ignora. Passa a:

```ts
const { channel, config } = await resolveCloudConfig(db, accountId, channelId);
return {
  ctx: cloudChannelContext({
    accountId,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    channelId: channel.id,
    userId: config.user_id,
    identifier: channel.identifier ?? config.phone_number_id,
    connected: channel.status === 'connected',
  }),
  configRow: config,
};
```

Com isso, **`resolveChannelForConversation` passa a funcionar para Cloud sem mais
nenhuma mudança** — ele já lê `conversations.channel_id` e já repassa o id.
O `assertAccountNotBlocked` no topo permanece intocado (SPEC 062 §4.3).

### 4.3. `resolveDefaultChannelId` implementa o D-11

```ts
export async function resolveDefaultChannelId(
  db: SupabaseClient, accountId: string, type?: ChannelType
): Promise<string>;
```

Sem `type`: padrão do `whatsapp_cloud` se houver Cloud conectado, senão padrão do
`whatsapp_qr`, senão `ChannelNotConfiguredError`. Com `type`: o padrão daquele
tipo, ou erro. O fallback atual por `whatsapp_config.channel_id` **sai** — depois
de 3.2 toda conta tem canal, e o fallback só mascararia inconsistência.

### 4.4. Os outros consumidores

| Módulo | Mudança |
| --- | --- |
| `messaging-limit-server.ts` | assinatura ganha `channelId`; leitura, **escrita do cache** (`UPDATE … .eq('channel_id')`, hoje `.eq('account_id')` — gravaria o tier de um número na linha do outro) e a chamada da RPC com `p_channel_id` (§3.9). **Falha da RPC deixa de virar `0`**: o retorno ganha `usageUnavailable: true` e a UI mostra "consumo indisponível" |
| `webhook/route.ts` | antes de ingerir, ignora canal `disabled` com log nomeando o número (D-12, consequência 2) — hoje o mesmo caso cai no genérico "No config found" (`:306`) |
| `broadcast-core.ts` / `broadcast-dispatch.ts` | `BroadcastPlan` carrega `channelId`, resolvido **na criação** (D-3); `deliverBroadcast` continua montando o contexto **uma vez** — não regredir isso |
| `ingest/send.ts` | resolve pelo canal do webhook de entrada, com fallback no padrão do tipo |
| `api/v1/contacts.ts` | `resolveAuditUserId` **deixa de consultar `whatsapp_config`** e usa o fallback que a própria função já tem: `accounts.owner_user_id` (`contacts.ts:88-96`). Não inventar terceira fonte — a versão anterior desta SPEC mandava derivar de `profiles.account_role`, o que mudaria a atribuição de autoria de tudo que a API cria |
| `media/[mediaId]/route.ts` | a busca de posse já existe e casa por `media_id` (`route.ts:64-72`); passa a selecionar também `channel_id` e resolver a credencial por ele. `channel_id` nulo (mensagem anterior à `063`) cai no padrão do tipo |
| `resolve-conversation.ts` | ramo sem `explicitChannelId` chama `resolveDefaultChannelId` direto |
| `plans/usage.ts` | conta canais com `status <> 'disabled'`, igual à trigger (D-5) |

### 4.5. Testes obrigatórios (co-locados, Vitest)

- `cloud-channels.test.ts` — padrão; explícito; explícito de **outra conta** (erro);
  conta sem canal (erro); dois canais e nenhum padrão do tipo (erro, não sorteio);
  conta cujo padrão é QR e que tem Cloud conectado (D-11: resolve o Cloud).
- `send.test.ts` — dois canais Cloud: conversa do canal B envia com o
  `phone_number_id` de B. **Este teste tem de falhar no código atual** — se passar
  antes da mudança, a fixture está errada (lição da SPEC 048 F4).
- `broadcast-core.test.ts` — campanha grava `channel_id` na criação; campanha com
  canal desconectado no disparo falha com `channel_unavailable`.
- `messaging-limit.test.ts` — cache gravado na linha do canal certo; cota chamada
  com `p_channel_id`.
- `plans/limits.test.ts` — caso `channels_whatsapp_cloud: 2` (hoje só cobre `0`) e
  canal `disabled` não ocupando vaga.

---

## 5. Rotas de API

| Rota | Hoje | Depois |
| --- | --- | --- |
| `GET /api/whatsapp/config` | um objeto | **lista** de números, servida pela rota (nunca lida do browser — §6.1), **sem** `access_token`/`verify_token` no payload; aceita `?channel_id=` para um só |
| `POST /api/whatsapp/config` | upsert por conta | `channel_id` no corpo → atualiza aquele número. Sem `channel_id`: se o `phone_number_id` **já pertence à conta**, atualiza aquele canal (idempotência — protege contra duplo clique e contra bundle antigo em cache, que sempre POSTa sem id); se o canal existente estiver `disabled`, **readota** (D-12); senão cria canal + config |
| `DELETE /api/whatsapp/config` | apaga a linha da conta | exige `channel_id`. Canal com conversas → apaga credenciais e marca `disabled`; sem conversas → apaga o canal (D-12). Continua atendendo o "Reset Configuration" |
| `POST /api/whatsapp/config/verify-registration` | diagnóstico da conta | por `channel_id`; **reconcilia `channels.identifier`** com o `display_phone_number` da Meta (D-9) |
| `GET/POST /api/whatsapp/templates/*` | por conta | aceitam `channel_id` **ou** `waba_id`; sem nenhum, o WABA do canal Cloud padrão |
| `GET /api/whatsapp/messaging-limit` | tier da conta | tier **e cota** por `channel_id` |
| `GET /api/whatsapp/media/[mediaId]` | config da conta | credencial pelo `messages.channel_id` da mensagem dona (§4.4) |
| `POST /api/whatsapp/broadcast` | canal implícito | aceita `channel_id`; grava em `broadcasts.channel_id` na criação |
| `POST /api/whatsapp/send` | já resolve por conversa | nada muda depois da §4.2 |

**Criação em duas escritas, sem transação.** `channels` e `whatsapp_config` são
dois `INSERT` e o supabase-js não tem transação: se o segundo falhar, sobra canal
órfão consumindo quota e aparecendo no filtro do inbox. A rota faz a compensação
explícita que `evolution/instances.ts:409-431` já faz — apaga o canal recém-criado
e, se nem isso der, marca `disabled` com o motivo.

**Rate limit:** `messagingLimit` (`rate-limit.ts:174`) continua por usuário, mas o
cache de 15 min agora é por canal — uma conta com 3 números faz até 3 chamadas à
Meta por janela. Aceitável; comentar no código para o próximo leitor não achar que
é bug.

---

## 6. Interface

### 6.1. Aba "WhatsApp Oficial" vira lista

`src/components/settings/whatsapp-config.tsx` deixa de ser um formulário único:

- **Lista de números**: rótulo, telefone (D-9), selo de status, badge "Padrão",
  tier, cota de 24 h daquele número, cooldown, e as ações **Editar · Diagnosticar
  · Definir como padrão · Remover**.
- **Botão "Conectar outro número"** — desabilitado com a razão visível quando a
  quota do plano está no teto, como a aba QRCode já faz.
- Com **um** número, a tela abre no detalhe dele: nenhuma conta existente vê uma
  lista de um item onde antes havia um formulário.

⚠️ **A lista vem da rota, não do banco.** Hoje o componente lê `whatsapp_config`
direto do navegador (`whatsapp-config.tsx:124`, `select('*')`), e a policy
`whatsapp_config_select` é `is_account_member` — **qualquer** membro, inclusive
`viewer`. Isso já entrega um token cifrado ao browser; com N números, entregaria
N. A F7 troca a leitura por `GET /api/whatsapp/config`, que não devolve segredo
nenhum.

⚠️ **"Definir como padrão" precisa de RPC — e ela é por TIPO.** Hoje **nada** no
código escreve `is_default` (só o backfill da `055`). Desmarcar o anterior e
marcar o novo sob um índice único parcial, sem transação no cliente, quebra na
ordem errada. A RPC entra na `072`, junto do resto:

```sql
CREATE OR REPLACE FUNCTION set_default_channel(p_channel_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_account UUID; v_type TEXT; v_status TEXT;
BEGIN
  SELECT account_id, type, status INTO v_account, v_type, v_status
    FROM channels WHERE id = p_channel_id;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF v_status = 'disabled' THEN
    RAISE EXCEPTION 'Cannot make a disabled channel the default'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ O `AND type = v_type` é o coração desta função. Sem ele, promover um
  -- número oficial desmarca também o padrão do WhatsApp QRCode, e a conta
  -- fica sem padrão daquele tipo: `resolveDefaultChannelId(account,'whatsapp_qr')`
  -- passa a lançar e o desvio `fallback_channel` das automações (SPEC 049 §5.1)
  -- para de funcionar — com o log da automação como único sintoma.
  UPDATE channels SET is_default = FALSE
   WHERE account_id = v_account AND type = v_type AND is_default;
  UPDATE channels SET is_default = TRUE WHERE id = p_channel_id;
END $$;

ALTER FUNCTION set_default_channel(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION set_default_channel(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_default_channel(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION set_default_channel(UUID) TO authenticated, service_role;
```

As duas escritas correm na mesma transação implícita da função, que é o que o
índice único parcial exige. `set_default_channel` é a **única** forma de escrever
`is_default` fora da migração — nenhuma rota faz `update` direto nessa coluna.

### 6.2. Templates

Seletor "Conta do WhatsApp Business" no topo, só quando há mais de um WABA
distinto. Template de outro WABA aparece esmaecido, com tooltip (D-2); template
sem `waba_id` aparece com o selo "sem conta do WhatsApp Business — sincronize".

### 6.3. Disparo em massa

Passo "Enviar por" no assistente, listando só canais com `capabilities.broadcast`
**e** status `connected`. Visível apenas com mais de um canal capaz. A tela de
detalhe mostra por qual número a campanha saiu (ou "canal padrão da época" para as
legadas, `channel_id NULL`).

### 6.4. Inbox, contatos, transferência

Nada a fazer: seletor de canal, selo por conversa, filtro por canal (migração
`061`) e o diálogo de transferência (SPEC 056) já são por `channels.id` e passam a
listar os dois números sozinhos. **Verificar** — não reimplementar. Canal
`disabled` continua rotulando conversas antigas e não aparece como destino.

### 6.5. Plano e uso

`src/lib/plans/usage.ts` já conta `channels_whatsapp_cloud`; passa a excluir
`disabled` (D-5) e a barra mostra `2 de 3` sem código novo.

### 6.6. i18n

Chaves novas em `messages/en.json` (fonte da verdade) e espelho em `pt-BR.json`:
lista de números, "Conectar outro número", "Definir como padrão", "Enviar por",
seletor de WABA, selo de template sem WABA, aviso de desativação (D-12) e o erro
de quota. Mensagens de `/api/**` permanecem em inglês; a UI traduz.
`npm run i18n:check` faz parte do gate de cada fase.

---

## 7. API pública `/api/v1` e integrações

| Endpoint | Mudança |
| --- | --- |
| `POST /api/v1/messages` | **nenhuma no contrato** — `channel_id` já é aceito e documentado; passa a funcionar para o segundo número |
| `POST /api/v1/broadcasts` | aceita `channel_id` (opcional; ausente = padrão resolvido e **gravado** na criação, D-3) |
| `GET /api/v1/broadcasts` / `/{id}` | serializam `channel_id` |
| `GET /api/v1/conversations` | já expõe `channel_id` (SPEC 049 §5.4) |
| `GET /api/v1/me` | passa a listar os canais (id, nome, tipo, status, telefone) |

⚠️ **Escopo de `/me`.** A lista inclui telefones. Uma chave com escopo só de
leitura de contatos não deve enxergá-los: a listagem de canais exige
`messages:send` **ou** `broadcasts:write` — quem não tem, recebe a resposta atual
de `/me`, sem o campo. Definir isso no `docs/public-api.md` junto com o resto.

**`mcp-server/` e `n8n_automation/`** consomem a API pública e continuam
funcionando pelo canal padrão sem alteração; só ganham a capacidade de escolher
número quando a F9 expuser `channel_id` em `/broadcasts` e canais em `/me`.

⚠️ Convenção obrigatória: qualquer mudança em `/api/v1/**` atualiza **os três
arquivos na mesma alteração** — `docs/public-api.md`, `public/openapi.json` e
`public/openapi.pt-BR.json` (só `summary`/`description` em pt-BR; exemplos em
inglês nos dois). Validar cada um com `npx @redocly/cli lint` e conferir paridade
estrutural.

---

## 8. Plano de implementação — fases, modelo e sessão

Cada fase é **um PR** e passa o gate do §15 antes de virar candidato a commit.
Commits e push são manuais (o agente entrega o comando pronto).

### 8.1. Como o modelo foi escolhido

Três perguntas, nesta ordem — a primeira que responder "sim" decide:

1. **Um erro aqui é silencioso ou irreversível?** (migração, roteamento de
   credencial, falha parcial) → **Opus 5**. Mandar pela credencial errada não
   quebra teste nenhum: entrega a mensagem pelo número errado.
2. **O padrão já está fixado e a fase é extensão dele?** → **Sonnet 5**. É a maior
   parte do volume desta SPEC, e o custo por token importa quando a fase mexe em
   dez arquivos parecidos.
3. **É mecânico e verificável por ferramenta?** (lint de contrato, i18n, log) →
   **Sonnet 5**, com o gate como rede.

Trabalho de humano não recebe modelo: teste contra número real e autorização de
migração são seus.

### 8.2. As fases

| # | Fase | Escopo | Entrega verificável | Modelo | Sessão |
| --- | --- | --- | --- | --- | --- |
| **F1** | Migração | `072` inteira (§3.1-3.9) + asserções + `NOTIFY pgrst` + **a troca do `onConflict` de `templates/submit`** no mesmo PR | Aplicada em **vn** só após sua autorização; `rs` depois. Salvar template continua funcionando no mesmo deploy | **Opus 5** | Nova, dedicada |
| **F2** | Roteamento | `cloud-channels.ts`, `resolveChannelContext` honrando `channelId`, `resolveDefaultChannelId` por tipo (§4.1-4.3) + os testes que **falham antes** | Conversa de cada número responde pelo próprio número | **Opus 5** | Nova |
| **F3** | Consumidores | §4.4: tier + **cota por canal** + `usageUnavailable`, mídia, ingest, auditoria, `usage.ts`, webhook ignorando `disabled` | Nenhuma leitura de credencial fora de `cloud-channels.ts`; medidor por número | **Opus 5** | Continua a F2 |
| **F4** | CRUD de número | Rotas `/api/whatsapp/config*`: lista sem segredo, idempotência do POST, D-12 (desativar preservando config), compensação de falha parcial, reconciliação de `identifier` | Conta nova conecta o oficial e aparece no inbox sem backfill manual | **Opus 5** | Nova |
| **F5** | Templates | Rotas `sync`/`submit`/`[id]` por WABA + UI (§6.2) | Dois WABAs com o mesmo nome de template convivem | **Sonnet 5** | Nova |
| **F6** | Campanha | `channel_id` gravado na criação, ponta a ponta + passo "Enviar por" (§6.3) | Campanha sai pelo número escolhido; cooldown e cota certos | **Sonnet 5** | Continua a F5 |
| **F7** | Interface | Aba "WhatsApp Oficial" como lista + uso da RPC `set_default_channel` + i18n (§6.1) | Conectar, renomear, definir padrão e desativar pela interface | **Sonnet 5** | Nova |
| **F8** | Quota | Rotas antecipam a mensagem legível + testes + seeds sugeridos (D-10) | Plano com 1 recusa o segundo número com texto legível | **Sonnet 5** | Continua a F7 |
| **F9** | API pública | §7 + os três arquivos de contrato + escopo de `/me` | `redocly lint` verde nos dois `openapi*.json` + paridade estrutural | **Sonnet 5** | Nova |
| **F10** | Observabilidade | §11: log estruturado, consulta de auditoria, sinais | Consulta devolvendo zero linhas em produção | **Sonnet 5** | Continua a F9 |
| **F11** | Teste manual | §12, 24 itens contra número real | Checklist assinado | — | Você |

### 8.3. Por que estas fronteiras de sessão

- **F1 sozinha.** Migração é a única fase irreversível. Uma sessão que só tem a
  `072` no contexto não confunde "o que o banco vai virar" com "o que o código já
  faz".
- **F2+F3 juntas.** F3 é a lista de chamadas de F2; separar em sessões faria a
  segunda redescobrir as assinaturas que a primeira acabou de definir.
- **F4 sozinha.** Concentra os casos de borda da SPEC (falha parcial,
  idempotência, D-12). Contexto limpo vale mais que continuidade aqui.
- **F5+F6 juntas** (templates e campanha compartilham a resolução WABA↔canal),
  **F7+F8 juntas** (a UI e a mensagem de quota que ela mostra), **F9+F10 juntas**
  (contrato e o log que o prova).

### 8.4. Caminho crítico e o que pode ser paralelizado

```
F1 → F2 → F3 → F4 → F7 → F8 → F11
              ↘ F5 → F6 ↗
              ↘ F9 → F10 ↗
```

F5/F6 (templates e campanha) e F9/F10 (API pública e observabilidade) só dependem
de F3 e podem correr em paralelo com F4/F7/F8, em sessões distintas. **F11 exige
todas.** O que não pode antecipar: nada antes da F1, e nenhuma fase de UI antes da
F4, que é quem cria o segundo número para elas terem o que mostrar.

### 8.5. Regra de segurança que atravessa todas as fases

`channels_whatsapp_cloud` fica em **1** em todos os planos até a F7 estar validada
em produção (§10, item 2). As fases entregam a capacidade; o interruptor comercial
decide quando o primeiro cliente pode cruzar o ponto sem retorno.

---

## 9. Armadilhas específicas desta SPEC

1. **`.single()` que vira `.limit(1)`.** A tentação, ao ver "multiple rows
   returned", é trocar por `.limit(1)`. Isso transforma falha alta em envio pelo
   número errado. Todo ponto do §1.1.B resolve por **canal**, ou lança.
2. **O `UPDATE` do tier.** `messaging-limit-server.ts:120` grava o cache com
   `.eq('account_id')`. Sem `channel_id`, passa a escrever o tier de um número em
   **todas** as linhas da conta — e a leitura seguinte "funciona".
3. **`onConflict` e o índice de templates.** Trocar o índice sem trocar o
   `onConflict` quebra o salvamento com `42P10`. Mesmo PR, F1.
4. **`DROP FUNCTION` apaga privilégios.** `broadcast_quota_usage` (§3.9) precisa do
   `REVOKE` de `PUBLIC` **e** de `anon` reaplicado, pelo motivo que a `044:129-135`
   documenta.
5. **`deliverBroadcast` monta o contexto uma vez.** É proposital (fan-out de
   milhares). Resolver o canal **antes** do laço.
6. **Cache de schema do PostgREST — colunas E assinaturas.** `broadcasts.channel_id`
   e `message_templates.waba_id` são colunas novas (embeds podem devolver
   `PGRST200`); a troca de assinatura de `broadcast_quota_usage` devolve
   `PGRST202` até o cache recarregar. `NOTIFY pgrst, 'reload schema'` fecha a
   migração (§3.9).
7. **Erro de cota lido como zero.** `loadAccountQuota` faz
   `Number(usedRaw ?? 0)`: qualquer falha da RPC vira "0 usado" numa tela que o
   operador usa para decidir tamanho de audiência. Ausência de dado tem de ser
   visível (§3.9).
8. **A trigger de quota e o backfill.** Criá-la antes dos `INSERT INTO channels` da
   própria migração faz a `072` abortar em conta cujo plano já limite canais.
9. **`is_default` sem transação, e por tipo.** Ver §6.1: RPC com
   `AND type = v_type`, não dois `update`.
10. **Canal órfão.** Criação em duas escritas exige compensação explícita (§5).
11. **Desativar não é apagar — e não é perder configuração.** Nenhuma tela some
    com conversas de um canal `disabled`, e a linha de `whatsapp_config`
    permanece: apagá-la levaria junto cooldown, tier e `waba_id` (D-12).
12. **Reverter exige desfazer o padrão por tipo primeiro** (§10). A `073` ingênua
    falha com duplicate key na primeira conta que tenha Cloud e QR.
13. **`i18n:check` não pega ICU quebrado.** Abrir as telas novas nos dois idiomas.
14. **Três projetos Supabase.** `vn` e `rs` sincronizados até a `071`. **Confirmar
    com o mantenedor antes de aplicar a `072`.**

---

## 10. Reversão e ponto sem retorno

**O ponto sem retorno não é a migração — é o primeiro segundo número conectado.**

| Momento | Reversível? | Como |
| --- | --- | --- |
| `072` aplicada, nenhum 2º número criado | **Sim, mas não trivialmente** | A `073` precisa **desfazer o padrão por tipo antes** de recriar o índice antigo (ver abaixo), além de recriar `whatsapp_config_account_id_key` e `idx_channels_one_cloud_per_account`. `waba_id` e `broadcasts.channel_id` podem ficar — colunas a mais não incomodam |
| Existe ≥ 1 conta com 2 configs | **Não sem perda** | `UNIQUE(account_id)` não volta a ser criável. Reverter exigiria escolher qual número descartar, e as conversas do descartado ficariam sem credencial |

⚠️ **A reversão ingênua falha já na primeira conta, mesmo sem nenhum segundo
número.** A `072` §3.2(b) marca um padrão **por tipo**: toda conta que tenha um
canal Cloud e uma instância QRCode passa a ter **dois** `is_default = TRUE`, e o
índice antigo (`idx_channels_one_default_per_account`, único por conta) recusa
isso com duplicate key. A `073` tem de derrubar os padrões dos tipos não-Cloud
primeiro:

```sql
-- 073, ANTES de recriar o índice por conta: preserva só o padrão do Cloud
-- (D-11 diz que ele vence), que é o que o índice antigo comporta.
UPDATE channels c SET is_default = FALSE
 WHERE c.is_default AND c.type <> 'whatsapp_cloud'
   AND EXISTS (SELECT 1 FROM channels d
                WHERE d.account_id = c.account_id
                  AND d.type = 'whatsapp_cloud' AND d.is_default);

DROP INDEX IF EXISTS idx_channels_one_default_per_account_type;
CREATE UNIQUE INDEX idx_channels_one_default_per_account
  ON channels (account_id) WHERE is_default;
```

Custo aceito da reversão: contas que só têm QRCode mantêm o padrão delas; contas
com os dois perdem o padrão do QR, e o desvio `fallback_channel` volta a depender
de escolha explícita até alguém remarcar.

Consequências operacionais, a seguir à risca:

1. O repositório é **forward-only**: não há down-migration. Reverter = escrever a
   `073` à mão. Deixá-la **pronta e testada** — com o passo acima — antes de
   aplicar a `072` em `vn`.
2. Manter `channels_whatsapp_cloud` em **1** em todos os planos até a F7 estar
   validada em produção. O interruptor comercial (D-10) é o que segura o ponto sem
   retorno — não o código.
3. Fazer a `072` em `vn` primeiro, com pelo menos um ciclo de uso real antes de
   `rs`.
4. As fases F2-F9 são reversíveis por deploy (só código) **desde que** o banco não
   tenha ganhado o segundo número. Essa é a razão da ordem do item 2.

---

## 11. Observabilidade

A classe de bug que esta SPEC pode causar é silenciosa: a mensagem sai pelo número
errado, o cliente recebe, o CRM grava, e ninguém percebe até alguém estranhar o
remetente. Três instrumentos, entregues na F10 (e o primeiro já na F2):

**11.1. Log estruturado em todo envio.** `sendAndPersistOutbound` passa a logar
`{ accountId, conversationId, channelId, channelType, phoneNumberId, origem }` —
`origem` ∈ `inbox | automation | flow | ai | broadcast | api_v1 | ingest`. É o que
permite responder "por qual número saiu?" sem consultar o banco.

**11.2. Consulta de auditoria** (rodar após cada fase e semanalmente no primeiro
mês): mensagens cujo canal diverge do canal da conversa — deve devolver **zero**.

```sql
SELECT m.id, m.created_at, m.conversation_id,
       m.channel_id AS canal_mensagem, c.channel_id AS canal_conversa
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
 WHERE m.channel_id IS NOT NULL
   AND m.channel_id IS DISTINCT FROM c.channel_id
   AND m.created_at > NOW() - INTERVAL '7 days'
 ORDER BY m.created_at DESC LIMIT 50;
```

**11.3. Sinais para acompanhar após cada deploy:** volume de
`ChannelNotConfiguredError` e `channel_unavailable` (um salto = a resolução de
padrão está errada em alguma conta); **erros de `broadcast_quota_usage`** (§3.9 —
enquanto eles existirem, o medidor de 24 h está cego, e antes da correção do
`usageUnavailable` ele mostrava zero); campanhas com `channel_id NULL` criadas
**depois** da F6 (deve ser zero); contas com canal de um tipo e **nenhum padrão
daquele tipo** (a mesma asserção da migração, agora como consulta periódica — é o
sintoma de uma RPC de padrão sem o filtro de tipo); canais `disabled` com
conversas ativas recentes (alguém desativou o número errado).

---

## 12. Teste manual (F11) — contra número real

Pré-requisito: **dois** números oficiais, de preferência um em WABA próprio e
outro compartilhando WABA com o primeiro (é o caso que o D-2 decide).

| # | Cenário | Esperado |
| --- | --- | --- |
| 1 | Conectar o 2º número | Aparece na lista; canal criado; padrão continua no 1º |
| 2 | Contato manda mensagem para o 2º | Conversa nasce com `channel_id` do 2º; selo correto |
| 3 | Responder pelo inbox | `messages.channel_id` = 2º; chega **do** 2º número |
| 4 | Responder conversa antiga (1º número) | Continua saindo pelo 1º — a regressão mais provável |
| 5 | Automação na conversa do 2º | Sai pelo 2º |
| 6 | Flow com botões na conversa do 2º | Sai pelo 2º, botões renderizados |
| 7 | IA responde na conversa do 2º | Sai pelo 2º |
| 8 | Campanha escolhendo o 2º | Sai do 2º; `broadcasts.channel_id` gravado **na criação** |
| 9 | Campanha agendada, trocar o padrão antes de disparar | Sai pelo canal gravado, não pelo novo padrão (D-3) |
| 10 | Campanha agendada cujo canal foi desativado | Falha com `channel_unavailable`, sem trocar de número |
| 11 | Cooldown 30 dias no 1º, 0 no 2º | Triagem do 2º não exclui quem recebeu há 3 dias |
| 12 | **Cota de 24 h** com envios nos dois números | Cada número mostra o próprio consumo, não a soma (C.2) |
| 13 | Templates: mesmo nome em dois WABAs | Ambos existem; cada número só oferece o do seu WABA |
| 14 | Template legado sem `waba_id` | Aparece com o selo, e envia pelo canal padrão |
| 15 | Tier de mensagens | Cada número mostra o seu; trocar de aba não contamina |
| 16 | Mídia recebida no 2º | Proxy abre com o token do 2º |
| 17 | Plano com `channels_whatsapp_cloud: 1` | "Conectar outro número" recusa com mensagem de quota |
| 18 | Definir o 2º como padrão | Troca atômica; o 1º deixa de ser padrão; QR mantém o padrão dele (D-11) |
| 19 | **Desativar** o 2º (com conversas) | Segredos zerados, canal `disabled`, conversas e histórico intactos, some dos seletores, **libera vaga de quota** |
| 20 | Definir cooldown 30 dias no 2º, desativar e reconectar | **Cooldown continua 30**, e o tier não volta a "nunca consultado" (D-12) |
| 21 | Contato manda mensagem para o número desativado | Ignorada, com log nomeando o canal — nenhuma conversa nova num canal que não pode responder |
| 22 | Reconectar o mesmo número desativado | Readota o canal, histórico preservado, não cria um terceiro |
| 23 | Remover canal **sem** conversas | Apagado de verdade; o `phone_number_id` volta a poder ser conectado |
| 24 | "Reset Configuration" no 1º número | Continua funcionando: zera segredo, mantém canal, histórico e configuração |
| 25 | Definir o 2º oficial como padrão numa conta que também tem QRCode | O padrão do QR **continua marcado** — a RPC só desmarca o do mesmo tipo (§6.1) |
| 26 | Transferir conversa do QRCode para o 2º oficial | Diálogo lista os dois oficiais, com telefone legível (D-9) |
| 27 | Conta com um único número (regressão) | Nenhuma tela mudou de forma perceptível |

SQL de conferência após o item 3:

```sql
SELECT m.id, m.direction, c.name AS canal, wc.phone_number_id
  FROM messages m
  JOIN channels c ON c.id = m.channel_id
  LEFT JOIN whatsapp_config wc ON wc.channel_id = c.id
 WHERE m.conversation_id = '<uuid>'
 ORDER BY m.created_at DESC LIMIT 10;
```

---

## 13. Configuração

**Nenhuma variável de ambiente nova.** O limite de números oficiais é comercial e
vive no plano (`channels_whatsapp_cloud`), não no `.env` — diferente do canal
QRCode, cujo teto também protege a VPS (`EVOLUTION_MAX_INSTANCES_TOTAL`). Um
número oficial a mais custa à Meta, não à sua infraestrutura.

---

## 14. Deixado para depois (dívida registrada)

- **Escopo por canal em automações, flows e IA** (D-6): `automations.channel_id`,
  `ai_configs.channel_id`. SPEC própria.
- **Roteamento de saída por regra** ("contatos da etiqueta X falam pelo número de
  Suporte"): depende do D-6.
- **Métricas por número** no painel: o dashboard agrega por conta. Campanhas
  anteriores à F6 (`channel_id NULL`) nunca entrarão num recorte por número — o
  histórico por número começa na F6.
- **Renomear `whatsapp_config`** (D-1): custo alto, ganho estético.
- **Mesclar templates de WABAs diferentes** numa visão única: só se a operação
  pedir.
- **Mover um número entre contas do mesmo deployment.** Enquanto o canal existir,
  o `phone_number_id` fica reivindicado (D-8, D-12 consequência 1); hoje a única
  saída é apagar o canal, que exige não haver conversas. Uma ação de operador no
  console (`/admin`) que transfira o número preservando histórico é trabalho
  próprio, e ninguém pediu ainda.

---

## 15. Validação antes de entregar cada fase

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

Mais, específico desta SPEC:

- `grep -rn "from('whatsapp_config')" src/` — depois da F3, as únicas ocorrências
  legítimas são `cloud-channels.ts` (leitura de credencial), a rota de CRUD
  (escrita, F4) e o cache do tier (escrita por `channel_id`). Qualquer outra é
  regressão.
- A consulta de auditoria do §11.2 deve devolver **zero linhas**.
- Abrir as telas novas em **pt-BR e en** (o `i18n:check` não pega ICU quebrado).
- Depois da F9: `npx @redocly/cli lint` nos dois `openapi*.json` + paridade
  estrutural.
- **Migração:** a `073` de reversão (§10) escrita e testada antes de aplicar a
  `072`; confirmar com o mantenedor antes de aplicar em `vn` ou `rs`.
- **Git:** commits e push são manuais — o agente entrega o comando pronto, não o
  executa.

---

## 16. Registro das revisões

Esta SPEC passou por **duas** revisões críticas antes da implementação.

### Segunda revisão (sobre o texto já corrigido)

| Achado | Onde entrou |
| --- | --- |
| A reversão do §10 já era impossível logo após a `072`: o padrão por tipo cria dois `is_default` por conta, que o índice antigo recusa | §10 (passo de desmarcação na `073`) |
| Desativar canal apagava `whatsapp_config` e levava junto cooldown, tier e `waba_id` — reconexão voltava silenciosamente ao default 7 | D-12 (zera segredo, preserva a linha) |
| Troca de assinatura da RPC de cota → `PGRST202` até o cache recarregar, e `loadAccountQuota` transforma erro em "0 usado" | §3.9 (`NOTIFY pgrst` + `usageUnavailable`), §4.4, §9.7 |
| `set_default_channel` sem escopo por tipo deixaria o QRCode sem padrão e quebraria o `fallback_channel` | §6.1 (RPC completa, com o `AND type = v_type` comentado) |
| §3.2 saltava a etapa (b) | §3.2 renumerada (a), (b), (c) |
| Sufixo de rótulo com 4 caracteres do `phone_number_id` podia repetir | §3.2(a) (contador sequencial) |

### Primeira revisão

| Achado | Onde entrou |
| --- | --- |
| Cota de 24 h por conta contra tier por número — mesma classe do cooldown, e estava fora do inventário | §1.1.C.2, D-4, §3.9 |
| Índice de templates na F1 e `onConflict` na F5 quebrariam produção entre as fases | §3.4, F1 |
| `CREATE UNIQUE INDEX` de templates podia abortar a migração em base existente | §3.4 (pré-checagem) |
| `is_default` é por conta, não por tipo — "Cloud padrão" não existia | D-11, §3.1, §4.3 |
| `DELETE` do canal viola FK de `conversations` e mataria o "Reset Configuration" | D-12, §5 |
| Backfill não determinístico e `is_default` duplicado no `INSERT…SELECT` | §3.2 (laço + CTE) |
| `ADD CONSTRAINT` sem guarda quebrava a idempotência prometida | §3.2(c) |
| Prescrição errada para `resolveAuditUserId` | §4.4 |
| Falha parcial na criação, duplo clique e cliente em cache | §5 |
| Token cifrado chegando ao browser, multiplicado por N | §6.1 |
| `is_default` sem escritor e sem transação | §6.1 (RPC) |
| Corrida na trigger de quota; canal `disabled` ocupando vaga | §3.7, D-5 |
| Critério de aceite da F3 inalcançável | F3 |
| Campanha agendada mudando de número sozinha | D-3, §12 itens 9-10 |
| `waba_id` nulo sem semântica definida | D-2 |
| Escopo de `/me` expondo telefones | §7 |
| Sem reversão e sem observabilidade | §10, §11 |
