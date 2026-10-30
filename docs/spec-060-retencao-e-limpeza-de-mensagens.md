# SPEC 060 — Retenção e limpeza de mensagens

> **Status:** F1-F8 implementadas e testadas (2026-08-26) · migração 068 aplicada só em `vn` · 12/14 itens do §14 verificados contra dados reais (roteiro em `docs/spec-060-teste-manual.md`); rotas HTTP/UI seguem sem verificação visual (sem sessão logada)
> **Data:** 2026-08-26
> **Migração:** `068_message_retention.sql` (confira `ls supabase/migrations/` antes — a última hoje é a 067)
> **Insumo:** análise do fluxo de armazenamento por canal (documento do mantenedor, 2026-08-26) — expandida e corrigida nas §2 e §16
> **Sem PRD.** O PRD 058 existe porque plano é decisão **comercial** (preço, posicionamento, o que cada faixa inclui). Retenção aqui é **mecanismo**: o mantenedor já definiu escopo, gatilho, estrutura e permissão. O que sobra são decisões técnicas, e elas cabem nesta SPEC (§12).
>
> ⚠️ **Mudança de dono decidida em 2026-08-26 — leia antes de mexer nesta SPEC.**
> A política de retenção deixa de ser do **dono da conta** e passa a ser do
> **proprietário da plataforma**, assim que o login dele existir
> ([PRD 061 §4.1](./prd-061-console-do-proprietario-e-ciclo-de-plano.md)). Quem
> executa a virada é a **[SPEC 062 §3.8, §5.3 e §7.5](./spec-062-console-do-proprietario.md)**
> (migração 069, fase F7), e é lá que está o desenho atualizado. O que muda aqui:
> a RLS da §3.2 (as quatro policies caem — a tabela fica só `service_role`), as
> rotas `/api/account/retention*` da §7 (removidas), a aba de Configurações da
> §8.2 (sai do rail do cliente, vira tela do console) e a cadeia de precedência
> da §3.4 (ganha o elo "padrão global do console" acima do `.env`). O item 14 do
> teste manual da §14 é substituído pelos itens 13–15 da SPEC 062 §12.
>
> **Continuam valendo sem alteração:** o piso de idade, as três fases de
> `purge_channel_messages`, o `REVOKE`, a estrela de favoritar (§8.1, `agent+`) e
> o aviso neutro da thread esvaziada (§8.3).

---

## 1. Princípio que organiza tudo

> **Apagar é a única operação deste sistema que não tem desfazer. Todo o resto da SPEC é consequência disso.**

Três regras derivam daí, e nenhuma é negociável:

1. **Nasce desligado.** Sem `MESSAGE_RETENTION_ENABLED` no servidor, a varredura
   não roda — mesmo padrão de "falha alto em vez de abrir" que
   `AUTOMATION_CRON_SECRET` e `PLATFORM_ADMIN_SECRET` já praticam. Um `git pull`
   num fork nunca pode começar a apagar histórico de ninguém.
2. **Existe piso de idade.** Nenhuma política, por mais agressiva que seja,
   apaga mensagem mais nova que `MESSAGE_RETENTION_MIN_AGE_HOURS` (padrão 72 h).
   O piso não é conforto: é o que protege quatro invariantes do caminho quente
   de uma vez (§4.3).
3. **Existe prévia antes do estrago.** O painel do Proprietário mostra "isto
   apagaria N mensagens" **sem apagar nada** (`p_dry_run`). Um limite digitado
   com um zero a menos aparece como número na tela, não como histórico perdido.

O restante segue o padrão da casa: **o banco executa o conjunto, o TypeScript
decide os números.** O `DELETE` é uma sentença SQL sobre um conjunto — não um
laço em Node trazendo 40.000 UUIDs pela rede; a precedência de limites é um
módulo puro com teste co-locado — não um `COALESCE` escondido dentro de uma
função de banco.

---

## 2. O que a análise anexa acerta, e os cinco pontos que ela não considerou

A análise de partida está correta no diagnóstico dos filtros de descarte por
canal e no comparativo Evolution × Meta. Ela erra o alvo em um ponto e omite
cinco — todos com consequência direta no desenho.

**O ponto que ela erra.** A pergunta 3 ("o que deleta junto?") propõe a opção 2
como se fosse trabalho a fazer: apagar reações e zerar `reply_to`. **Já está
pronto no schema desde a migração 009** — `message_reactions.message_id` é
`ON DELETE CASCADE` e `messages.reply_to_message_id` é `ON DELETE SET NULL`.
`flow_runs.last_prompt_message_id` (010) também é `SET NULL`. Não há
código a escrever para o item 3: há uma verificação a fazer (§3.5) e uma
consequência a documentar.

**Os cinco pontos omitidos:**

| # | O que foi omitido | Consequência no desenho |
| --- | --- | --- |
| 1 | **Trigger não lê `process.env`.** O mantenedor pediu limites padrão em variável de ambiente *e* limpeza por cron. Se a limpeza fosse uma função SQL agendada no `pg_cron`, ela não teria como conhecer o padrão global | A varredura é disparada pelo **TypeScript**, que lê o `.env` e passa números explícitos para a função SQL. A função nunca resolve precedência sozinha (§4.1) |
| 2 | **`messages` não tem `account_id` nem tipo de canal.** O escopo pedido (conta × tipo de canal) só existe via `conversations.account_id` + `conversations.channel_id → channels.type` | Todo predicado de limpeza é um `JOIN` de três tabelas, e o desempenho depende de dois índices novos (§3.6). E `messages.channel_id` **não serve** para isto: desde a 063 ela significa outra coisa — o selo de desvio (D-2) |
| 3 | **A idempotência de reentrega consulta `messages`.** `ingest.ts:245-259` decide "já armazenei isto?" procurando a linha. Apagar uma mensagem que o provedor ainda pode reentregar a faz **renascer** | É a razão nº 1 do piso de idade da §4.3: a Evolution reentrega por ~2,5 min (5 × 30 s); 72 h de piso põem três ordens de grandeza entre o risco e a política |
| 4 | **A conversa sobrevive à última mensagem dela.** `conversations` guarda negociação, etiquetas, atribuição, `last_customer_message_at` (a janela de 24 h) e `last_message_at` (a ordenação do inbox) — **nenhum desses campos é derivado de `messages` em tempo de leitura** | Apagar todas as mensagens de uma conversa **não** quebra o inbox nem a janela de 24 h. Quebra a *tela*: a thread abre vazia sem explicação. Daí a §8.3 |
| 5 | **A thread carrega o histórico inteiro.** `message-thread.tsx:351-357` faz `select('*')` por `conversation_id` **sem `limit`** | Retenção não é só custo de banco: hoje é o teto de escala da tela de conversa. Vale citar isso na justificativa da feature |

**Sobre os descartes silenciosos que a análise levanta** (LID sem vínculo, proto
não reconhecido, mídia que não baixou): são reais e valem uma SPEC própria —
mas são o **oposto** desta. Aquilo é mensagem que nunca entrou; isto é mensagem
que entrou e vai sair. Misturar os dois assuntos numa entrega só produz um
diagnóstico impossível: "sumiu" passa a ter duas causas com o mesmo sintoma.
Fica registrado na §13.

---

## 3. Modelo de dados — migração `068_message_retention.sql`

Idempotente (`IF NOT EXISTS`, `DROP … CREATE` para policies e funções) e com o
bloco de asserções finais que falha alto, no padrão das 041/052/061/067.

### 3.1. `messages.is_favorite` — a mensagem que a limpeza não leva

```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_favorite  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS favorited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS favorited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Parcial: favorita é a exceção. O índice tem o tamanho do conjunto de
-- favoritas, não o da tabela — e é ele que faz o `NOT is_favorite` do
-- predicado de limpeza e a contagem do teto saírem baratos.
CREATE INDEX IF NOT EXISTS idx_messages_favorite
  ON messages (conversation_id, created_at)
  WHERE is_favorite;
```

**Coluna, não tabela** (contra a leitura literal da pergunta 5 da análise, que
pedia "tabelas separadas" — aquilo era sobre a política, não sobre a
favoritagem). Favorita entra no `WHERE` de **toda** sentença de limpeza; como
tabela seria mais um `LEFT JOIN … IS NULL` em cada uma delas, e o índice
parcial deixaria de existir. `favorited_by` é auditoria — quem marcou —, não
dono: a favorita é **da conta** (D-6), então o mesmo ícone aparece marcado para
o colega ao lado.

### 3.2. `channel_retention_policies` — o ajuste por conta e canal

```sql
CREATE TABLE IF NOT EXISTS channel_retention_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_type   TEXT NOT NULL CHECK (channel_type IN ('whatsapp_cloud','whatsapp_qr')),

  -- Os três limites. NULL e 0 querem dizer coisas DIFERENTES — §3.4.
  max_messages   INTEGER CHECK (max_messages   IS NULL OR max_messages   >= 0),
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days >= 0),
  max_favorites  INTEGER CHECK (max_favorites  IS NULL OR max_favorites  >= 0),

  updated_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, channel_type)
);

CREATE INDEX IF NOT EXISTS idx_channel_retention_account
  ON channel_retention_policies (account_id);

DROP TRIGGER IF EXISTS set_updated_at ON channel_retention_policies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON channel_retention_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

`channel_type` é **texto com CHECK**, e não FK para `channels.id`, de propósito:
a política vale para o **tipo** de canal na conta, não para uma instância. Uma
conta com três instâncias QRCode tem uma política de QRCode — que é exatamente
o que o mantenedor descreveu ("ambos os canais dela compartilham o mesmo
servidor"). Ligar em `channels.id` faria a política morrer junto com a instância
pareada, de novo, a cada QR expirado.

**RLS — só Proprietário, e só da própria conta:**

```sql
ALTER TABLE channel_retention_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY channel_retention_select ON channel_retention_policies FOR SELECT
  USING (is_account_member(account_id, 'owner'));
CREATE POLICY channel_retention_insert ON channel_retention_policies FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));
CREATE POLICY channel_retention_update ON channel_retention_policies FOR UPDATE
  USING (is_account_member(account_id, 'owner'));
CREATE POLICY channel_retention_delete ON channel_retention_policies FOR DELETE
  USING (is_account_member(account_id, 'owner'));
```

`is_account_member(account_id, 'owner')` cobre as duas exigências do mantenedor
numa expressão só: **admin e agente da própria conta não leem** (papel abaixo de
owner) e **ninguém de outra conta lê** (a função já é escopada por
`account_id`). A guarda de servidor em `/api/account/retention` repete a
checagem com `requireRole('owner')` — RLS é o chão, não o único andar.

### 3.3. `message_retention_state` — o relógio da varredura, não um log

O mantenedor dispensou log (pergunta 6), e esta tabela **não é um**: é uma linha
única, sobrescrita, com dois trabalhos que a varredura não consegue fazer sem
ela — saber quando rodou pela última vez e impedir duas execuções sobrepostas.

```sql
CREATE TABLE IF NOT EXISTS message_retention_state (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_run_at   TIMESTAMPTZ,
  running_since TIMESTAMPTZ,          -- claim; NULL = livre
  last_result   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO message_retention_state (id) VALUES (TRUE) ON CONFLICT DO NOTHING;
```

Linha única garantida pelo par `PRIMARY KEY` + `CHECK (id)`, o mesmo truque da
`platform_settings` (067). `last_result` guarda o agregado do último ciclo
(`{"accounts":12,"by_age":840,"by_count":120,"favorites_demoted":3,"truncated":false}`)
— é o que a §8.2 mostra como "última limpeza: hoje 03:07, 960 mensagens
removidas". RLS: `SELECT` para qualquer membro autenticado, escrita só
`service_role`.

O claim `running_since` segue o formato dos claims da 054: quem consegue o
`UPDATE … WHERE running_since IS NULL` roda; quem não consegue sai. Com um
vencimento de 30 min para não travar para sempre se um processo morrer no meio.

### 3.4. Precedência — e por que `NULL` e `0` são coisas diferentes

Esta é a regra que a §5 implementa em TypeScript e testa. Escrita uma vez, aqui:

| Valor na tabela | Significado |
| --- | --- |
| linha **inexistente** | usa o padrão global do `.env` para aquele tipo de canal |
| coluna **`NULL`** | usa o padrão global **daquela dimensão** (dá para fixar só `retention_days` e deixar `max_messages` no padrão) |
| coluna **`0`** | **sem limite** — a conta escolheu guardar para sempre naquela dimensão |
| coluna **> 0** | é o limite |

E o `.env` ausente para a dimensão significa **sem limite** também. A cadeia
completa, do mais específico ao mais geral:

> linha da política → *(reservado: chave do plano, §13)* → padrão do `.env` → sem limite

"Sem limite" ser o fim da cadeia é deliberado: **toda ausência de configuração
resulta em não apagar nada.** Um `.env` com erro de digitação no nome da
variável produz um sistema que não apaga — nunca um que apaga tudo.

### 3.5. O que o schema já resolve (e a asserção que confere isso)

A pergunta 3 da análise está respondida pelas migrações 009 e 010:

| Vínculo | Comportamento no `DELETE` | Origem |
| --- | --- | --- |
| `message_reactions.message_id` | `CASCADE` — reações somem junto | 009 |
| `messages.reply_to_message_id` | `SET NULL` — a resposta sobrevive, perde a citação | 009 |
| `flow_runs.last_prompt_message_id` | `SET NULL` | 010 |
| `messages.broadcast_id` | é a mensagem **apontando** para a campanha; apagá-la não toca `broadcasts` nem `broadcast_recipients` | 066 |
| `messages.media_path` / `media_id` | **nada acontece com o arquivo** — objeto órfão no bucket, por decisão do mantenedor (§9) | 040 |

A migração termina com uma asserção que **relê o catálogo** e falha se qualquer
uma dessas três FKs não estiver com a `delete_rule` esperada — porque a SPEC
inteira depende delas, e um fork que rodou as migrações fora de ordem
descobriria isso apagando dados:

```sql
DO $$
DECLARE v_rule TEXT;
BEGIN
  SELECT rc.delete_rule INTO v_rule
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage k ON k.constraint_name = rc.constraint_name
   WHERE k.table_name = 'message_reactions' AND k.column_name = 'message_id';
  IF v_rule IS DISTINCT FROM 'CASCADE' THEN
    RAISE EXCEPTION '068: message_reactions.message_id nao esta ON DELETE CASCADE (esta: %). A limpeza deixaria reacoes orfas.', v_rule;
  END IF;
  -- idem para messages.reply_to_message_id e
  -- flow_runs.last_prompt_message_id, ambas esperando 'SET NULL'
END $$;
```

### 3.6. Os dois índices que fazem a varredura ser viável

O predicado é `conversations.account_id` + `channels.type` + `messages.created_at`,
e hoje **nenhum** índice cobre esse caminho: `idx_messages_conversation` não tem
`created_at`, e `conversations` não tem índice por `(account_id, channel_id)`.

```sql
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conversations_account_channel
  ON conversations (account_id, channel_id);
```

**A saída de emergência, se um dia não bastar.** A alternativa seria
desnormalizar `account_id` e `channel_type` em `messages` e indexar direto. Não
fazemos agora porque duplicar tenancy numa tabela de milhões de linhas é fonte
permanente de divergência (a transferência entre canais da SPEC 056 teria de
manter os dois em dia), e porque a varredura é um **lote de madrugada**, não um
caminho de requisição. O gatilho para reconsiderar é medível e fica registrado
aqui: **`purge_channel_messages` passando de 30 s numa conta só.**

---

## 4. As funções SQL

### 4.1. `purge_channel_messages(...) → JSONB`

Uma chamada por par (conta × tipo de canal). **Recebe os números já resolvidos**
— não consulta `channel_retention_policies` nem conhece o `.env`. É essa
separação que permite ao TypeScript ler ambiente, testar precedência, e ainda
assim o `DELETE` ser uma sentença sobre um conjunto.

```sql
CREATE OR REPLACE FUNCTION purge_channel_messages(
  p_account_id     UUID,
  p_channel_type   TEXT,
  p_max_messages   INTEGER,               -- NULL = sem limite
  p_retention_days INTEGER,               -- NULL = sem limite
  p_max_favorites  INTEGER,               -- NULL = sem limite
  p_min_age_hours  INTEGER DEFAULT 72,
  p_batch_limit    INTEGER DEFAULT 5000,
  p_dry_run        BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
```

Retorna
`{"by_age":n,"by_count":n,"favorites_demoted":n,"favorites_total":n,"messages_total":n,"truncated":bool}`.
`truncated` fica verdadeiro quando alguma fase encostou em `p_batch_limit` — é o
sinal de que o próximo ciclo ainda tem trabalho, e é o que a §8.2 mostra como
"limpeza em andamento" em vez de fingir que terminou.

**Três fases, nesta ordem.** `v_floor := NOW() - make_interval(hours => p_min_age_hours)`.

**Fase 1 — por idade.** Só quando `p_retention_days > 0`:

```sql
v_cutoff := LEAST(NOW() - make_interval(days => p_retention_days), v_floor);

WITH doomed AS (
  SELECT m.id
    FROM messages m
    JOIN conversations c  ON c.id  = m.conversation_id
    JOIN channels      ch ON ch.id = c.channel_id
   WHERE c.account_id  = p_account_id
     AND ch.type       = p_channel_type
     AND m.is_favorite = FALSE
     AND m.created_at  < v_cutoff
   ORDER BY m.created_at
   LIMIT p_batch_limit
)
DELETE FROM messages WHERE id IN (SELECT id FROM doomed);
```

**Fase 2 — por contagem.** Só quando `p_max_messages > 0`. Ranqueia o conjunto e
apaga o excedente, **da mais antiga para a mais nova**:

```sql
WITH ranked AS (
  SELECT m.id, m.created_at,
         row_number() OVER (ORDER BY m.created_at DESC, m.id DESC) AS rn
    FROM messages m
    JOIN conversations c  ON c.id  = m.conversation_id
    JOIN channels      ch ON ch.id = c.channel_id
   WHERE c.account_id  = p_account_id
     AND ch.type       = p_channel_type
     AND m.is_favorite = FALSE
),
doomed AS (
  SELECT id FROM ranked
   WHERE rn > p_max_messages
     AND created_at < v_floor          -- o piso vale AQUI também
   ORDER BY rn DESC
   LIMIT p_batch_limit
)
DELETE FROM messages WHERE id IN (SELECT id FROM doomed);
```

O desempate por `id DESC` não é enfeite: `created_at` empata de verdade quando o
webhook grava um lote, e sem desempate o `row_number()` é não-determinístico
entre execuções — a mesma linha ora entra, ora sai do corte.

**Consequência aceita, e ela precisa estar na tela:** com o piso ativo, uma
conta muito movimentada **fica acima do teto** enquanto o excedente for mais
novo que 72 h. O teto é um alvo, não uma barreira — quem quer barreira precisa
de checagem no `INSERT`, que é justamente o que o mantenedor descartou ao
escolher a estratégia por cron (pergunta 4, opção B).

**Fase 3 — favoritas acima do teto.** Só quando `p_max_favorites > 0`.
`UPDATE`, não `DELETE` (D-1): as excedentes mais antigas **perdem a estrela** e
voltam para o conjunto comum, onde as fases 1 e 2 as tratam **no ciclo
seguinte** — um ciclo de carência entre "deixou de ser favorita" e "sumiu".

```sql
WITH ranked AS (
  SELECT m.id, row_number() OVER (ORDER BY m.created_at DESC, m.id DESC) AS rn
    FROM messages m
    JOIN conversations c  ON c.id  = m.conversation_id
    JOIN channels      ch ON ch.id = c.channel_id
   WHERE c.account_id = p_account_id
     AND ch.type      = p_channel_type
     AND m.is_favorite
),
doomed AS (
  SELECT id FROM ranked WHERE rn > p_max_favorites ORDER BY rn DESC LIMIT p_batch_limit
)
UPDATE messages
   SET is_favorite = FALSE, favorited_at = NULL, favorited_by = NULL
 WHERE id IN (SELECT id FROM doomed);
```

Rodar a fase 3 **por último** é o que cria a carência. Rodá-la primeiro faria a
favorita rebaixada ser apagada na mesma execução — e o dono da estrela veria a
mensagem desaparecer no mesmo instante em que ela perdeu o destaque.

**`p_dry_run`.** Cada fase troca o `DELETE`/`UPDATE` por `SELECT count(*)` sobre
a **mesma** CTE. Uma CTE por fase, dois desfechos — nunca duas consultas
parecidas que podem divergir com o tempo.

### 4.2. `SECURITY DEFINER` e por que ele é seguro aqui

A função apaga linhas de `messages` ignorando RLS, então quem pode chamá-la
importa mais do que o que ela faz:

```sql
REVOKE ALL ON FUNCTION purge_channel_messages(
  UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated;
```

Só `service_role` executa — ou seja, só a varredura de servidor e o SQL Editor
do painel. A prévia do painel do Proprietário **não** chama a função direto do
navegador: passa por `/api/account/retention/preview`, que já resolveu quem é o
chamador e injeta o `account_id` dele. Sem esse `REVOKE`, um agente com o
DevTools aberto teria um `rpc()` capaz de apagar o histórico da conta — e a RLS
da §3.2 não o impediria, porque a barreira dela é a *política*, não a *função*.

### 4.3. O piso de idade protege quatro coisas de uma vez

`MESSAGE_RETENTION_MIN_AGE_HOURS` (padrão **72**) é um parâmetro só, e cada uma
destas invariantes justificaria sozinha a existência dele:

| # | O que quebraria sem o piso |
| --- | --- |
| 1 | **Mensagem zumbi.** `ingest.ts` decide reentrega procurando a linha (`conversation_id`, `message_id`). Apagada, uma reentrega da Evolution (5 × 30 s) ou da Meta a **reinsere** — e ela reaparece no topo da conversa, com data nova |
| 2 | **Fluxo esperando resposta.** `flow_runs.last_prompt_message_id` vira `NULL` e a execução perde a âncora do passo em que parou |
| 3 | **Atribuição de resposta a campanha.** `hydrate-reply.ts` (SPEC 057) liga a resposta do cliente à mensagem da campanha que a provocou. Sem a linha, a resposta chega sem origem |
| 4 | **Contexto de IA.** `ai/context.ts` monta o prompt com as últimas mensagens da thread. Uma limpeza por contagem agressiva faria o rascunho automático responder sem saber o que foi dito hoje de manhã |

O piso **prevalece sobre a política**: `LEAST(cutoff_da_política, piso)` na fase
1, `AND created_at < v_floor` na fase 2.

---

## 5. Núcleo TypeScript — `src/lib/retention/`

Puro e com teste co-locado, no padrão de `src/lib/plans/` e `cold-send-limit.ts`.

| Arquivo | Responsabilidade |
| --- | --- |
| `types.ts` | `RetentionChannelType` (`'whatsapp_cloud' \| 'whatsapp_qr'`), `RetentionPolicyRow`, `EffectivePolicy`, `RetentionDefaults`, `RetentionRunResult` — **fonte de verdade das chaves** |
| `defaults.ts` | `readRetentionDefaults(env)`: lê e valida o `.env`. Valor não numérico, negativo ou ausente → dimensão **sem limite** + `console.warn`. **Nunca lança** — um `.env` torto não pode derrubar o cron que também drena automações |
| `policy.ts` | `resolveEffectivePolicy(row, defaults, channelType)` — a tabela da §3.4 em código. É o arquivo mais importante da SPEC e o mais barato de testar |
| `schedule.ts` | `shouldRunNow(lastRunAt, intervalHours, now)` e `isClaimStale(runningSince, now)` — puros, sem `Date.now()` por dentro |
| `sweep.ts` | **Server-only.** Orquestra: claim → enumera pares → resolve → chama a RPC → agrega → grava `last_result` → solta o claim. Usa `@/lib/supabase/admin` |
| `format.ts` | "1.240 mensagens", "30 dias", `0` → "Sem limite", herdado → "Padrão do sistema (5.000)". Consumido pelo painel e pela prévia |

`sweep.ts` enumera os pares a partir de `SELECT DISTINCT account_id, type FROM channels`
— e não de `conversations` — porque é a lista curta (uma conta tem 1–3 canais,
não 40.000 conversas), e porque `conversations.channel_id` é FK sem `ON DELETE`
para `channels`: toda conversa tem canal vivo, então nenhum par se perde.

### 5.1. Testes obrigatórios

`defaults.test.ts` — `.env` vazio (tudo sem limite), valor inválido (ignora, não
lança), zero explícito, todas as seis variáveis preenchidas.

`policy.test.ts` — **a matriz inteira da §3.4**: linha ausente; `NULL` numa
dimensão e valor na outra; `0` como "sem limite" e não como "apagar tudo" (é o
teste que impede a pior regressão possível desta SPEC); política presente com
`.env` ausente; `.env` presente com política ausente.

`schedule.test.ts` — nunca rodou (`lastRunAt = null` → roda), dentro do
intervalo, um minuto antes e um minuto depois da borda, claim vencido × claim
fresco.

`format.test.ts` — pt-BR e en, sem limite, herdado.

---

## 6. Onde a varredura é disparada

**Duas portas, uma implementação** — `runMessageRetention()` de `sweep.ts`.

**Porta 1 (padrão, sem ação do operador): fase 4 de `/api/automations/cron`.**
Pendurada no `after()` que já existe, depois das varreduras de janela e de
agendamento, e **protegida por `shouldRunNow(last_run_at, MESSAGE_RETENTION_INTERVAL_HOURS)`**:
a rota é pingada a cada 5 min, mas a varredura só executa quando o intervalo
(padrão 6 h) venceu.

O argumento é o mesmo que a SPEC 045 §5.5.1 e a SPEC 046 §6.1 já usaram, e vale
aqui inteiro: **rota nova significa um quarto `cron.schedule`**, ou seja, uma
ação manual de todo operador já em produção — inclusive forks. Quem não a
fizesse veria o painel de retenção funcionando, salvaria a política, e nada
nunca aconteceria, sem erro em lugar nenhum.

A diferença — e ela é o motivo de o interruptor existir — é que aqui a feature
que "aparece sozinha no deploy" **apaga dados**. Por isso `MESSAGE_RETENTION_ENABLED`
ausente é o padrão e não roda nada. As duas decisões se equilibram: o operador
não precisa mexer no `pg_cron`, mas precisa dizer "sim" uma vez no `.env`.

**Porta 2 (explícita): `GET /api/messages/retention/cron`.** Mesmo `x-cron-secret`
das outras três rotas, `maxDuration = 300`, e **ignora o intervalo** — quem
agenda explicitamente já decidiu a cadência. Serve a quem quer a limpeza às
03:00 com `cron.schedule('zapcrm-retention-cron', '0 3 * * *', …)`, e serve de
gatilho manual durante o teste da F8. Vai para `supabase/setup/cron-jobs.sql`
como bloco **OPCIONAL comentado**, no formato que a purga de
`webhook_ingest_logs` já usa.

**Por que não uma função SQL agendada direto no `pg_cron`**, que seria mais
simples: ela não lê o `.env` (§2, ponto 1). Reproduzir a precedência dentro do
SQL com `COALESCE` daria duas implementações da regra da §3.4 — e no dia em que
divergissem, a que apaga dados seria a que ninguém testou.

> Vale lembrar o que a memória do projeto já registrou: **o `pg_cron` não está
> instalado em todo projeto Supabase deste app**. É mais um motivo para a porta
> 1 ser a padrão e a porta 2 ser opcional.

---

## 7. Rotas de API

| Rota | Método | Quem | O quê |
| --- | --- | --- | --- |
| `/api/account/retention` | GET | **owner** | políticas dos canais da conta + padrões efetivos + uso atual (total e favoritas por canal) + `last_run_at` |
| `/api/account/retention` | PUT | **owner** | grava/limpa a política de um `channel_type` |
| `/api/account/retention/preview` | POST | **owner** | prévia com `p_dry_run = true` sobre os limites **enviados no corpo** — o que aconteceria se salvasse aquilo |
| `/api/messages/retention/cron` | GET | `x-cron-secret` | varredura global (porta 2 da §6) |

As três primeiras usam `requireRole('owner')` de `@/lib/auth/account`. A prévia
é `POST` porque recebe limites ainda **não salvos** — é o ponto inteiro dela.

Favoritar **não ganha rota**: a política `messages_update` da 017 já permite
`UPDATE` a membro `agent+` da conta, e a estrela é um
`supabase.from('messages').update({ is_favorite })` direto do cliente, como as
outras ações da bolha. Rota nova aqui seria cerimônia sem ganho de segurança.

---

## 8. Interface

### 8.1. A estrela na barra de ações da bolha

`src/components/inbox/message-actions.tsx` ganha o quarto botão, ao lado de
reagir / responder / copiar, com ícone `Star` do `lucide-react` (preenchido
quando marcada). Estado otimista, revertido no erro — mesmo formato do
`handleReact`. `message-thread.tsx` já assina `postgres_changes` de `UPDATE`;
a estrela entra na mesma assinatura para o colega ao lado ver a marcação
aparecer.

Na bolha (`message-bubble.tsx`), favorita ganha um selo discreto — sem ele, sair
da barra de ações apaga a única evidência de que a mensagem está protegida.

### 8.2. Aba "Retenção" em Configurações — só Proprietário

- `settings-sections.ts`: seção `'retention'` no grupo `account`, ícone
  `Archive` (ou `Trash2`), rótulo pelo dicionário. **A seção só entra na lista
  quando o papel é `owner`** — envolvida em `<RequireRole min="owner">`, que já
  falha fechada durante o `profileLoading` e nunca pisca o conteúdo.
- `src/components/retention/retention-panel.tsx` — orquestra;
  `retention-channel-card.tsx` — um cartão por tipo de canal presente na conta,
  com os três campos e o que está herdado do padrão global;
  `retention-preview.tsx` — o botão "Ver o que seria removido" e o resultado;
  `retention-usage.tsx` — "12.480 de 50.000 mensagens · 37 de 200 favoritas".
- Deep-link `?tab=retention` sai de graça (o roteamento por query já existe).

**Três coisas que o painel é obrigado a dizer**, porque sem elas o número na
tela mente:

1. **Prévia antes de salvar.** Salvar um limite sem ter visto o impacto é a
   forma mais provável de perder histórico nesta SPEC.
2. **O piso.** "Mensagens dos últimos 3 dias nunca são removidas" — senão o
   dono vê o total acima do teto e reporta como bug (§4.1).
3. **Herdado × explícito.** Campo vazio mostrando `5.000` em cinza com
   "padrão do sistema" é diferente de `5.000` digitado. Sem essa distinção,
   ninguém entende por que o número mudou sozinho depois de um deploy.

### 8.3. A conversa que ficou vazia

Quando a limpeza leva todas as mensagens de uma conversa, ela **permanece**
(D-3): carrega negociação, etiquetas, atribuição e os carimbos da janela de
24 h — nenhum deles derivado de `messages`. Mas a thread abre em branco, e
branco sem explicação é indistinguível de bug.

`message-thread.tsx`, quando a lista volta vazia **e** `conversation.last_message_at`
não é nulo (ou seja: já houve mensagem), mostra uma linha neutra —
"Mensagens antigas removidas pela política de retenção" — **sem os números**.
Agente e viewer não têm acesso à política (§3.2); a UI diz *que* houve limpeza,
não *qual* é a regra.

### 8.4. i18n

Chaves novas em `messages/en.json` (fonte) e `messages/pt-BR.json` (espelho),
sob `Settings.retention.*` (painel, cartões, prévia, uso), `Inbox.actions.*`
(`favorite`, `unfavorite`, `favorited`) e `Inbox.thread.retentionNotice`.
Mensagens de `/api/**` permanecem **em inglês**. `npm run i18n:check` entra no
gate de conclusão de cada fase que toca a UI.

---

## 9. Arquivos no bucket — fora de escopo, com o comando pronto

Por decisão do mantenedor, a limpeza **não toca no Storage**: apagar a linha
deixa o objeto de `chat-media` órfão. É a opção mais segura (nenhum risco de
apagar mídia ainda referenciada) e a mais barata (nenhuma chamada assinada por
mensagem).

A contrapartida é honesta e precisa estar escrita: **o bucket só cresce.** Para
fechar o ciclo, a F7 entrega `supabase/setup/orphan-media-cleanup.sql` — não é
migração, é operação de ambiente, no mesmo formato do bloco opcional de
`cron-jobs.sql`: um `SELECT` de conferência (quantos objetos de `chat-media` não
têm mais `media_path` correspondente em `messages`), o `DELETE` correspondente
comentado, e o aviso de rodar o `SELECT` primeiro. Vale para `chat-media`
apenas; `flow-media` não é mídia de conversa e não entra.

---

## 10. Impacto na API pública `/api/v1`

Uma mudança de contrato — e a regra do `AGENTS.md` vale integralmente: as
**três** edições saem juntas (`docs/public-api.md`, `public/openapi.json`,
`public/openapi.pt-BR.json`), com `npx @redocly/cli lint` nos dois JSON e
conferência de paridade estrutural depois.

`GET /api/v1/conversations/{id}/messages` passa a devolver **`is_favorite`**
(booleano, somente leitura) — é o único endpoint público que lista mensagens;
não existe `GET /api/v1/messages` (esse caminho é `POST`-only, para enviar).
Campo novo em resposta é compatível, e uma integração que arquiva histórico
precisa saber o que o CRM protegeu.

Vale documentar em prosa, na seção de conversas do `docs/public-api.md`, que o
histórico **pode ser podado** pela política da conta — uma integração que pagina
esperando histórico imutável precisa saber disso antes de descobrir por
diferença de contagem.

---

## 11. Fases

Cada fase é implementável, testável e commitável isolada. **Nenhuma apaga
mensagem enquanto `MESSAGE_RETENTION_ENABLED` estiver ausente.**

| Fase | Entrega | Pronto quando |
| --- | --- | --- |
| **F1** | Migração 068: colunas de favorita, `channel_retention_policies` + RLS, `message_retention_state`, os dois índices, `purge_channel_messages` + `REVOKE`, asserções (inclusive as de FK da §3.5) | Suíte verde; asserções passam; app se comporta exatamente como antes |
| **F2** | `src/lib/retention/**` + os quatro arquivos de teste (§5.1) | `npm run test` verde |
| **F3** | Favoritar: estrela na barra de ações, selo na bolha, `Message.is_favorite` em `src/types/index.ts`, realtime, i18n | Marcar numa aba aparece na outra; `i18n:check` verde |
| **F4** | `sweep.ts`, rota `/api/messages/retention/cron`, fase 4 em `/api/automations/cron` | Com o interruptor **desligado**: rota responde `{"skipped":"disabled"}` e nada é apagado. Ligado num projeto de teste: apaga o esperado |
| **F5** | Painel "Retenção" (owner), prévia, uso, i18n | Agente e admin **não veem** a aba; owner de outra conta não lê a política (conferido por SQL, não só pela tela) |
| **F6** | Estado vazio da conversa + aviso de teto de favoritas na UI | Conversa esvaziada abre com o aviso neutro, sem números |
| **F7** | Operação: `cron-jobs.sql` (bloco opcional), `orphan-media-cleanup.sql`, `.env` documentado no README, API pública (§10) | `redocly lint` verde nos dois JSON; paridade estrutural conferida |
| **F8** | Teste manual ponta a ponta com o interruptor **ligado** num projeto de teste, roteiro em `docs/spec-060-teste-manual.md` | Os 14 itens da §14 verificados contra banco real |

**Migração:** a F1 aplica a 068 — e, pela regra do `AGENTS.md`, **só depois de
confirmar com o mantenedor**, projeto por projeto (`vn`, `rs`, `jh`).

---

## 12. Decisões a ratificar

As respostas do mantenedor às seis perguntas da análise estão incorporadas
(tabela por conta+canal com padrão em `.env`, escopo conta × tipo de canal,
cascatas do schema, limpeza por cron, tabela separada, sem log). Estas nove são
as que a implementação **abriu** e que ainda dependem de ratificação:

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| **D-1** | Favorita acima do teto: **apagar** ou **rebaixar** (perder a estrela e cair na regra comum no ciclo seguinte)? | **Rebaixar** | Favoritar é ato explícito. Rebaixar libera a vaga do mesmo jeito e dá um ciclo para o dono perceber e reagir. Apagar direto faz o clique de favoritar virar o gatilho da perda |
| **D-2** | O canal de uma mensagem, para efeito de escopo, é o da **conversa** ou o de `messages.channel_id`? | **Da conversa** | `messages.channel_id`, desde a 063, significa outra coisa: o **selo de desvio** (SPEC 049 F6.3), preenchido só quando a mensagem saiu por canal diferente. Usá-lo aqui daria à mensagem de desvio uma política diferente da thread em que ela vive |
| **D-3** | Conversa que perdeu todas as mensagens: apagar ou manter? | **Manter** | Carrega negociação, etiquetas, atribuição e a janela de 24 h. Apagar seria uma segunda feature destrutiva escondida dentro desta |
| **D-4** | Piso de idade padrão | **72 h** | Cobre com folga a reentrega da Evolution (~2,5 min) e o ciclo de um fluxo esperando resposta. Configurável por `.env` |
| **D-5** | Ordem de rebaixamento das favoritas: por `created_at` da mensagem ou por `favorited_at`? | **`created_at`** | "A partir da mais antiga", como o mantenedor descreveu, e coerente com as outras duas fases. `favorited_at` produziria uma ordem que ninguém consegue prever olhando a tela |
| **D-6** | Favorita é **da conta** ou **de cada usuário**? | **Da conta** | O inbox é compartilhado. Por usuário exigiria tabela própria, e a pergunta "esta mensagem está protegida?" passaria a ter uma resposta por pessoa — inviável para um motor de retenção |
| **D-7** | Interruptor global no `.env` ou em `platform_settings` (como `quotas_enforced`)? | **`.env`** | Aqui não há trigger; quem lê é sempre TypeScript. `platform_settings` só existiu na 067 porque **trigger não lê `process.env`** |
| **D-8** | Intervalo padrão entre varreduras | **6 h** | Dentro da faixa que o mantenedor indicou (6–12 h) e mais previsível para o teste manual da F8 |
| **D-9** | Limite de retenção vira chave de plano (SPEC 059)? | **Ainda não** — só o furo na cadeia de precedência (§3.4) | Amarrar retenção a plano antes de o plano estar em uso comercial acopla duas features que ainda não foram validadas separadamente |

---

## 13. Deixado para depois

- **Mensagens descartadas antes de entrar** (LID sem vínculo, proto não
  reconhecido, mídia que não baixou) — o outro lado do diagnóstico da análise
  anexa. SPEC própria: o sintoma que o usuário relata é o mesmo ("sumiu"), e
  misturar as duas causas na mesma entrega torna o diagnóstico impossível.
- **Exportar antes de apagar** — "baixe o histórico dos últimos 30 dias" na
  véspera de uma política nova. Encaixa no caminho de `contact_exports` (064).
- **Retenção por conversa** — uma negociação fechada há dois anos podendo ter
  regra diferente de uma ativa. Nada no schema impede; falta demanda.
- **Limpeza de mídia órfã automatizada** — a §9 entrega o comando; automatizar
  exige percorrer o Storage, e isso é uma rota de cron própria.
- **`is_favorite` como filtro no inbox** — "mostrar só favoritas" cai de graça
  do índice parcial da §3.1, mas é feature de navegação, não de retenção.

---

## 14. Teste manual (F8) — o que precisa ser verificado contra banco real

Nenhum destes é verificável por teste unitário; todos apagam, ou deixam de
apagar, dados de verdade. O roteiro executável vai para
`docs/spec-060-teste-manual.md`, no formato do `docs/spec-056-teste-manual.md`.

1. Interruptor ausente → a rota responde sem apagar nada; `count(*)` de
   `messages` idêntico antes e depois.
2. `.env` com valor inválido (`abc`) → dimensão vira "sem limite", `console.warn`
   no log, e o cron **não** quebra as fases de automação que rodam antes.
3. Política com `retention_days = 0` → **nada** é apagado por idade (é "sem
   limite", não "apagar tudo"). O teste que mais importa da SPEC inteira.
4. Política só em `max_messages`, `retention_days` `NULL` → dias vêm do `.env`.
5. Conta A com política, conta B sem → B usa o padrão global; nenhuma mensagem
   de A é contada no escopo de B.
6. QRCode e Cloud na mesma conta, limites diferentes → cada um respeita o seu;
   uma mensagem de desvio (SPEC 049 F6.3) segue a política da **conversa** (D-2).
7. Favorita mais antiga que `retention_days` → **sobrevive**.
8. Favoritas acima do teto → as mais antigas perdem a estrela; nenhuma é apagada
   **nesse** ciclo; são apagadas no seguinte.
9. Piso de idade → mensagem de 1 h atrás sobrevive mesmo com o teto estourado.
10. Reação e resposta: apagar a mensagem citada → a resposta sobrevive sem a
    citação e a reação some junto (confere as cascatas da §3.5 no banco real).
11. Conversa esvaziada → continua na lista, ordenada por `last_message_at`, com
    o aviso neutro na thread; a janela de 24 h continua correta.
12. Prévia → o número previsto bate com o que a execução real apaga em seguida.
13. `truncated` → com `MESSAGE_RETENTION_BATCH_LIMIT` baixo, dois ciclos
    terminam o serviço e o painel mostra "em andamento" no primeiro.
14. Permissão → agente e admin da conta não veem a aba **e** recebem `403` na
    rota; owner de outra conta recebe `0` linhas via SQL direto (RLS).

---

## 15. Variáveis de ambiente

```bash
# Interruptor. Ausente = nada é apagado, em nenhuma conta.
MESSAGE_RETENTION_ENABLED=true

# Padrões por tipo de canal. Ausente = sem limite naquela dimensão.
MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES=5000
MESSAGE_RETENTION_WHATSAPP_QR_DAYS=30
MESSAGE_RETENTION_WHATSAPP_QR_MAX_FAVORITES=200

MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES=50000
MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS=365
MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_FAVORITES=2000

# Trilhos de segurança e ritmo.
MESSAGE_RETENTION_MIN_AGE_HOURS=72      # nada mais novo que isto é apagado
MESSAGE_RETENTION_INTERVAL_HOURS=6      # só a porta 1 (§6) respeita
MESSAGE_RETENTION_BATCH_LIMIT=5000      # teto por fase, por par conta×canal
```

---

## 16. Armadilhas específicas desta SPEC

| Sintoma | Causa provável |
| --- | --- |
| Mensagem apagada **reaparece** com data nova | Piso de idade baixo demais + reentrega do provedor (§4.3, ponto 1) |
| Política salva e nada é apagado | Interruptor ausente; ou `0` interpretado como "sem limite" (§3.4) — que é o correto |
| Conta segue acima do teto depois da varredura | Excedente mais novo que o piso — comportamento esperado, precisa estar na tela (§8.2) |
| Conversa some da lista do inbox | Não é esta SPEC: `conversations` nunca é apagada aqui (D-3). Procurar outro caminho |
| Thread abre vazia sem explicação | Falta a §8.3 |
| Varredura demora e o cron de automações atrasa | `MESSAGE_RETENTION_BATCH_LIMIT` alto demais, ou os índices da §3.6 não foram criados |
| Rascunho de IA responde sem contexto do dia | Limpeza por contagem agressiva demais (§4.3, ponto 4) |
| Favorita sumiu logo depois de perder a estrela | Fase 3 rodando antes das fases 1 e 2 — a ordem da §4.1 é o que cria a carência |
| Agente enxerga a política | `RequireRole min="owner"` ausente na aba, ou RLS com `'admin'` no lugar de `'owner'` |
| Duas varreduras ao mesmo tempo | Claim `running_since` não conferido, ou vencimento curto demais |
| Tela quebrada só em pt-BR | Chave nova em um dicionário só — `npm run i18n:check` |

---

## 17. Validação antes de entregar cada fase

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```
