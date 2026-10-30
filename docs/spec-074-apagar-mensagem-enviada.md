# SPEC 074 — Apagar a mensagem enviada, sem perder o registro

| Campo            | Valor                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | **Proposta** — aguardando ratificação das decisões D-1…D-16                                                                                                                     |
| Data             | 2026-09-08                                                                                                                                                                      |
| Escopo           | Inbox — apagar no WhatsApp uma mensagem que o CRM enviou (canal oficial e canal QRCode), preservar o registro, permitir ao admin excluir a linha, registrar tudo em log e reenviar |
| Depende de       | SPEC 048 (canal QRCode / adaptador Evolution), SPEC 049 (inbox multicanal), SPEC 060 (retenção e favoritas), SPEC 062 (papéis e bloqueio), SPEC 064/065 (canal por recurso), SPEC 067 (exportação da conversa), SPEC 073 (ordem canônica de apagamento) |
| Migração         | **083** — seis colunas em `messages`, a tabela `message_deletion_log` e o aperto da política `messages_delete` (§3)                                                              |
| Dependências npm | Nenhuma                                                                                                                                                                         |

---

## Contexto

Hoje, uma mensagem enviada pelo inbox é definitiva. A barra de ações que
aparece ao passar o mouse sobre o balão
([message-actions.tsx](../src/components/inbox/message-actions.tsx))
oferece **reagir, responder, favoritar e copiar** — nada que desfaça o
envio. Quem manda o preço errado, o link errado ou a mensagem para o
contato errado tem duas saídas: pedir desculpa por escrito, ou abrir o
WhatsApp Web/celular por fora do CRM, apagar por lá — e deixar o CRM
mentindo, porque a linha em `messages` continua dizendo que a mensagem
está entregue e lida.

O comportamento pedido, nas palavras do mantenedor:

- **O agente que apaga**: a mensagem **só é marcada** como apagada — nada
  sai do banco — e **os endpoints dos canais são disparados** quando
  couber.
- **O admin que apaga**: a mesma coisa, **mais** uma escolha — manter a
  mensagem marcada, ou **excluí-la do ZAP CRM BR**. Em qualquer das duas,
  o endpoint do canal é disparado quando couber.
- **Tudo que envolver apagar mensagem fica registrado em log.**
- A mensagem marcada aparece na conversa com a moldura vermelha, para
  registro, e pode ser **reenviada** a partir do CRM.

---

## 1. O fato que decide o desenho inteiro: a Cloud API não revoga

Antes de qualquer linha de código, um fato que muda o produto e não pode
ser contornado por esforço de implementação.

### 1.1 Canal oficial (Meta Cloud API): não existe endpoint

A referência da Message API do WhatsApp Business expõe **um único método**
sobre `/{Phone-Number-ID}/messages`: `POST`, para enviar. Não há `DELETE`,
não há `POST … {status:"revoked"}`, não há nada que apague ou revogue uma
mensagem que a empresa já enviou. O que a Meta oferece com o nome
"revoke" é o **webhook de entrada**: um evento `messages[].type = "revoke"`
com `original_message_id`, que avisa quando **o usuário do WhatsApp**
apagou uma mensagem dele. É informação que chega, não ação que se
dispara.

Isso já estava escrito no repositório, e escrito certo, desde a SPEC 048:

```ts
// src/lib/channels/capabilities.ts — CLOUD
// Editar/apagar para todos não existe na Cloud API.
editMessage: false,
deleteForEveryone: false,
```

Nenhuma "integração melhor" contorna isso. Serviços que anunciam "apagar
mensagem" sobre a Cloud API estão apagando **da base de dados deles** — o
aparelho do contato continua exibindo a mensagem.

### 1.2 Canal QRCode (Evolution Go): revoga de verdade

O canal não-oficial fala whatsmeow, que implementa o protocolo do
aplicativo — e o aplicativo apaga para todos. A referência traz o
endpoint ([EVOLUTION_GO_REFERENCE.md §3](./references/EVOLUTION_GO_REFERENCE.md)):

```
POST /message/delete   (Token)   Deletar mensagem p/ todos
{ "chat": "5519999999999@s.whatsapp.net", "messageId": "MESSAGE_ID" }
```

E, de novo, a matriz já dizia: `deleteForEveryone: true` para
`whatsapp_qr`.

### 1.3 Consequência: um gesto só, resultado diferente por canal

**Apagar é uma ação, não um menu de modos** (D-1). O operador clica em
"Apagar"; o sistema faz o que aquele canal permite e **conta o que fez**.
"Quando couber" é decidido pela matriz de capacidades, não por um botão
que o usuário precisa entender.

O que sobra é o **resultado**, que o balão exibe:

| Resultado exibido        | O que aconteceu de fato                                                                                | Quando                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Revogada no WhatsApp** | O pedido de revogação foi entregue ao WhatsApp; o aparelho do contato mostra "Mensagem apagada"         | QRCode, endpoint aceito                       |
| **Apagada no CRM**       | Não existe endpoint de revogação neste canal — **a mensagem continua no aparelho do contato**          | Canal oficial (sempre)                        |
| **Apagada — revogação falhou** | O endpoint existia, foi chamado e recusou; o motivo fica visível e há "tentar de novo"            | QRCode, endpoint recusou (janela vencida etc.) |
| _(sem balão)_            | O admin excluiu a mensagem do sistema; só o log sobrevive                                              | Admin escolheu excluir (§7.2)                 |

> **A honestidade fica no diálogo, não numa escolha jogada no colo do
> operador.** Antes de apagar no canal oficial, o texto diz: "Este número
> é oficial (Meta). A Meta não permite apagar uma mensagem já enviada do
> aparelho do contato — ela continuará visível para ele. Aqui no CRM, a
> mensagem ficará marcada como apagada."

### 1.4 Mesmo no QRCode, "revogada" é um pedido, não uma garantia

`POST /message/delete` responder `200` significa que a mensagem de
protocolo saiu, não que o aparelho do contato obedeceu. O WhatsApp aplica
uma janela de tempo para "apagar para todos" (historicamente uma hora,
depois estendida) e quem decide é o cliente do destinatário. Portanto:

- nada no CRM promete "removida do aparelho"; a etiqueta é **"Revogada no
  WhatsApp"**, e o texto de apoio diz "o pedido foi enviado";
- **não** bloqueamos por idade (D-5) — bloquear com base num prazo que a
  Meta muda sem avisar produziria "não deixa apagar" em caso que
  funcionaria. Acima de 48 h o diálogo **avisa** que provavelmente já não
  sai do aparelho.

---

## 2. O que já existe e será reusado (nada disto se reescreve)

| Peça                                                         | Onde                                                        | Papel aqui                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Matriz de capacidades (`deleteForEveryone`)                  | `src/lib/channels/capabilities.ts`                          | Já tem a resposta certa por canal — o código **lê**, não decide             |
| Resolução do canal da conversa                               | `resolveChannelForConversation` (`src/lib/channels/send.ts`) | Dá `ChannelContext` com credencial decriptada                               |
| Registro de adaptadores                                      | `src/lib/channels/registry.ts`                              | Ganha um método opcional `deleteMessage`                                    |
| Cliente Evolution (erros tipados, `flagAuthFailureIfNeeded`) | `src/lib/evolution/client.ts`, `adapters/evolution.ts`      | O `POST /message/delete` entra pelo mesmo `send()` interno                   |
| Rota-modelo de ação sobre uma mensagem                       | `src/app/api/whatsapp/react/route.ts`                       | Esqueleto: auth → conta → mensagem → canal → provedor → BD                  |
| Papéis e bloqueio                                            | `src/lib/auth/roles.ts`, `is_account_member(id,'admin')`     | Quem pode marcar (agent+) e quem pode excluir (admin+)                      |
| Barra de ações do balão                                      | `src/components/inbox/message-actions.tsx`                  | Ganha o item "Apagar"                                                       |
| Realtime de `messages` com `event: '*'`                      | `src/hooks/use-realtime.ts:96`                              | O `UPDATE` (marcar) e o `DELETE` (excluir) **já** chegam ao colega ao lado   |
| RLS `messages_update` / `messages_delete` (039)              | `can_write_conversation(conversation_id)`                   | Base a apertar: hoje qualquer agent+ pode **apagar linha** (§3.3)           |
| Estado "falhou" com motivo (`error_message`, 058)            | `messages`                                                  | Precedente de campo de diagnóstico por mensagem                             |
| Favorita (`is_favorite`, 068) e seu badge no PDF             | `messages`, `src/lib/inbox/export/model.ts:344`             | Precedente exato de "coluna nova em `messages` + reflexo em 060/067/API v1" |
| Ordem canônica de apagamento e tombstone                     | SPEC 073                                                    | Mesma disciplina, uma escala abaixo: apagar dado deixa rastro deliberado    |

---

## 3. Modelo de dados — migração 083

### 3.1 Colunas em `messages` (a mensagem marcada)

```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_scope  TEXT CHECK (deletion_scope IN ('revoked','not_supported','revoke_failed')),
  ADD COLUMN IF NOT EXISTS deletion_actor  TEXT CHECK (deletion_actor IN ('agent','contact')),
  ADD COLUMN IF NOT EXISTS deletion_error  TEXT,
  ADD COLUMN IF NOT EXISTS resent_from_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
```

**`deleted_at` é o interruptor; o resto é contexto.** Toda leitura de UI
pergunta uma coisa só (`deleted_at IS NOT NULL`); `scope`/`actor`/`error`
só mudam o texto exibido.

**`deletion_scope` descreve o PROVEDOR, não uma escolha do usuário.** Os
três valores são os três desfechos do §1.3 — e é por isso que o
vocabulário "local_only" não existe mais: com D-1, ninguém escolhe apagar
"só no CRM"; o canal é que revoga ou não.

**Não se toca em `status`.** Seria tentador acrescentar `'deleted'` ao
`CHECK (status IN ('sending','sent','delivered','read','failed'))`, e
seria errado: uma mensagem revogada **foi** entregue e lida — apagar não
desfaz isso, e sobrescrever o status apagaria o histórico de entrega que o
balão, o rótulo do PDF (`statusLabelFor`) e a API pública já usam. Apagar
é um eixo novo, não um valor a mais no eixo antigo.

**`resent_from_message_id` fecha o ciclo.** O reenvio (§8) cria uma linha
NOVA — nunca ressuscita a apagada.

**Nenhum índice novo aqui.** Nenhuma consulta filtra por `deleted_at`: a
thread já busca por `conversation_id`, e a varredura de retenção (060)
continua filtrando por `created_at`/`is_favorite`.

**Conteúdo NÃO é apagado quando a mensagem é marcada** (`content_text`,
`media_path`, `media_url` intactos). É o "para registro" do pedido, e é o
que torna o reenvio possível.

### 3.2 `message_deletion_log` — o registro que sobrevive à exclusão

```sql
CREATE TABLE IF NOT EXISTS message_deletion_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- SEM FK — ver "por que sem FK" abaixo.
  conversation_id     UUID,
  message_id          UUID,
  provider_message_id TEXT,
  channel_id          UUID,
  channel_type        TEXT,

  action              TEXT NOT NULL CHECK (action IN ('mark','purge','revoke_retry')),
  provider_outcome    TEXT NOT NULL CHECK (provider_outcome IN ('revoked','not_supported','revoke_failed','not_attempted')),
  provider_error      TEXT,

  actor               TEXT NOT NULL CHECK (actor IN ('agent','contact')),
  actor_user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role          TEXT,

  content_type        TEXT,
  content_preview     TEXT,   -- 120 caracteres, truncado (D-15)
  had_media           BOOLEAN NOT NULL DEFAULT FALSE,
  media_path          TEXT,
  media_removed       BOOLEAN,

  message_created_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_msg_deletion_log_account
  ON message_deletion_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_deletion_log_message
  ON message_deletion_log (message_id);
```

**Por que uma tabela, e não mais colunas em `messages`.** Porque o admin
pode **excluir a linha**. Um registro guardado na própria linha some
exatamente no evento que ele existe para registrar. O log é a única peça
desta SPEC que precisa sobreviver ao `DELETE`.

**Por que `message_id` sem FK.** `ON DELETE CASCADE` mataria o log junto
com a exclusão; `ON DELETE SET NULL` apagaria o id que costura as duas
linhas do log da mesma mensagem (`mark` do agente, `purge` do admin
depois). É o mesmo raciocínio que a 068 usou para `channel_type` ser texto
e não FK: a coluna aponta para algo que pode deixar de existir, e o
apontamento vale mais do que a integridade referencial. Idem
`conversation_id` e `channel_id`.

**`account_id` COM FK e CASCADE**, ao contrário: o log é dado **da
conta**. Se a conta inteira é excluída (SPEC 073), ele vai junto — nada
de resíduo órfão sobrevivendo ao direito do titular.

**Append-only.** RLS: `SELECT` para `is_account_member(account_id,
'admin')`; **nenhuma** política de `INSERT`/`UPDATE`/`DELETE` — quem
grava é a rota, com `service_role`. Log que o auditado pode editar não é
log.

**`provider_outcome = 'not_attempted'`** cobre a mensagem que nunca chegou
ao provedor (status `sending`/`failed`, sem `message_id`) e a revogação
vinda do contato, onde não há endpoint nosso a disparar.

### 3.3 Aperto de `messages_delete` — o buraco que a exclusão abre

Hoje a política é:

```sql
CREATE POLICY messages_delete ON messages FOR DELETE
  USING (can_write_conversation(conversation_id));   -- agent+
```

Ou seja: **qualquer agente já pode apagar a linha direto do navegador**,
sem passar por rota nenhuma. Enquanto ninguém oferecia o botão, era teoria
— com esta SPEC, a exclusão vira gesto de produto, e uma política que
permite ao agente o que o produto reserva ao admin é uma regra escrita em
dois lugares com respostas diferentes.

A 083 aperta:

```sql
DROP POLICY IF EXISTS messages_delete ON messages;
CREATE POLICY messages_delete ON messages FOR DELETE
  USING (is_account_member(
    (SELECT c.account_id FROM conversations c WHERE c.id = messages.conversation_id),
    'admin'
  ));
```

Verificado antes de escrever: **nenhum código do app faz
`.from('messages').delete()`** — a única remoção em massa é a
`purge_channel_messages` da 068, que roda por `service_role` e não passa
por RLS, e a exclusão de conta (073), que desce por CASCADE. O aperto não
quebra caminho existente.

---

## 4. A regra de decisão vive em `src/lib/messages/delete.ts`

Função pura, sem Supabase e sem `fetch`, testável sem navegador —
convenção do repositório ("lógica de negócio vive em `src/lib/`").

```ts
export type DeletePlan =
  | {
      action: 'delete';
      /** Dispara o endpoint do provedor? Só quando o canal revoga E há id do provedor. */
      revoke: boolean;
      /** Já marcada: ao admin resta só excluir do sistema. */
      alreadyMarked: boolean;
      /** O papel permite remover a linha (admin+). */
      canPurge: boolean;
      /** Mais de 48 h: o WhatsApp provavelmente não removerá do aparelho. */
      warnStaleness: boolean;
    }
  | { action: 'refuse'; reason: DeleteRefusal };

export type DeleteRefusal =
  | 'not_outbound' // mensagem do contato — não se revoga o que não é seu
  | 'no_permission' // viewer, ou conta bloqueada
  | 'nothing_to_do'; // já marcada e o papel não pode excluir

export function planDeletion(input: {
  channelType: ChannelType;
  senderType: Message['sender_type'];
  status: Message['status'];
  providerMessageId: string | null;
  deletedAt: string | null;
  ageHours: number;
  role: AccountRole;
}): DeletePlan;
```

Regras, na ordem:

1. `canSendMessages(role) === false` (viewer) ou conta bloqueada →
   `refuse: no_permission`.
2. `senderType === 'customer'` → `refuse: not_outbound` (D-4).
3. `deletedAt` preenchido **e** `hasMinRole(role,'admin') === false` →
   `refuse: nothing_to_do`.
4. Senão `action: 'delete'`, com:
   - `revoke = can(channelType,'deleteForEveryone') && !!providerMessageId
&& status ∉ {sending, failed}` — sem id do provedor não há o que
     revogar, e a mensagem ainda assim pode ser **marcada** (foi um envio
     que falhou; sumir com o entulho é legítimo);
   - `alreadyMarked = !!deletedAt`;
   - `canPurge = hasMinRole(role,'admin')` (D-14, D-16);
   - `warnStaleness = revoke && ageHours > 48` (D-5).

Repare no que **sumiu** em relação à versão anterior: não existe mais
`local_only` como opção, nem `never_sent` como recusa. Apagar sempre marca;
o que varia é se há endpoint a disparar.

O canal é o **da mensagem** — `messages.channel_id` quando preenchido (o
desvio da SPEC 049 F6.3), senão o da conversa. Revogar pela instância
errada é impossível: o `messageId` pertence à sessão que enviou.

---

## 5. Adaptadores — um método opcional a mais

`src/lib/channels/types.ts`:

```ts
export interface DeleteMessageParams {
  /** Telefone do contato (E.164 sem '+'), como nos demais métodos. */
  to: string;
  /** Id da mensagem NO PROVEDOR. */
  providerMessageId: string;
}

export interface ChannelAdapter {
  // …
  /** Presente quando `capabilities.deleteForEveryone` é true. */
  deleteMessage?(ctx: ChannelContext, p: DeleteMessageParams): Promise<void>;
}
```

- **`whatsapp-cloud.ts`**: **não implementa**. Ausência é a documentação —
  quem chama consulta a capacidade antes, como manda o cabeçalho de
  `types.ts` ("nunca deve descobrir a ausência por um `undefined`").
- **`evolution.ts`**: implementa via o `send()` interno que já trata erro,
  log de depuração e `flagAuthFailureIfNeeded`.

### 5.1 O que precisa ser MEDIDO antes de escrever a F3

A SPEC 048 aprendeu isto do jeito caro (`/send/button` documentado, 405 na
prática; `Info.ID` aninhado; `SendMessage` ≠ `SEND_MESSAGE`). A referência
da Evolution Go é reconhecidamente incompleta. Antes de dar a F3 por
pronta, medir contra a instância real e **anotar o resultado no código**:

1. `chat` é **JID** (`5519…@s.whatsapp.net`) e não `number` — nenhum
   helper do repositório monta JID de saída hoje (`toEvolutionNumber`
   devolve E.164 puro). O adaptador precisa de um `toEvolutionJid()`, e é
   preciso confirmar se o servidor também aceita o número cru.
2. O endpoint exige `fromMe`/`participant`? (`/message/react` **não**
   exigia, ao contrário de outras implementações da Evolution.)
3. O que volta em sucesso, e o que volta ao tentar revogar mensagem
   antiga/inexistente — para mapear em `deletion_error`/`provider_error`.
4. O servidor **ecoa** a própria revogação num evento `SendMessage` com
   `protocolMessage`? Se sim, a F7 tem de ignorá-lo (§9.3).

---

## 6. Rota — `POST /api/inbox/messages/[id]/delete`

Corpo: `{ "purge": false }` (padrão) ou `{ "purge": true }` — este último
**só para admin+**; qualquer outro papel recebe `403`.

Resposta: `{ ok: true, purged: boolean, provider_outcome: 'revoked' |
'not_supported' | 'revoke_failed' | 'not_attempted', provider_error?: string }`.

Sequência (o esqueleto de `/api/whatsapp/react/route.ts`, sem invenção):

1. `createClient()` → `auth.getUser()`; 401 sem usuário.
2. `checkRateLimit('msgdelete:<user>', RATE_LIMITS.msgDelete)` — bucket
   novo, `{ limit: 30, windowMs: 60_000 }`: apagar é ação rara e
   deliberada; 30/min é folgado para humano e fecha a porta do script.
3. `profiles.account_id` + `account_role`; 403 sem conta.
4. Carrega a mensagem (`id, message_id, conversation_id, sender_type,
status, content_type, content_text, media_path, created_at, channel_id,
deleted_at`) e a conversa **filtrando por `account_id`** — 404 se não for
   da conta.
5. `assertAccountNotBlocked` (062) → `planDeletion(...)` (§4). `refuse` →
   400/403 com `code` legível. `purge: true` sem `canPurge` → 403.
6. **Disparo do endpoint, quando `revoke === true`** —
   `getAdapter(type).deleteMessage!(ctx, …)`:
   - sucesso → `provider_outcome = 'revoked'`;
   - falha → `provider_outcome = 'revoke_failed'`, motivo guardado. **A
     falha não aborta o resto**: o operador pediu para apagar, e apagar
     no CRM continua sendo feito (D-6). O que a falha faz é aparecer, com
     motivo, e habilitar "tentar de novo".
   - `revoke === false` → `'not_supported'` (canal oficial) ou
     `'not_attempted'` (sem id do provedor).
7. **Persistência**, em ordem:
   - `purge === false` → `UPDATE messages SET deleted_at = now(),
deleted_by = <user>, deletion_scope = <outcome>, deletion_actor =
'agent', deletion_error = <erro|NULL>`;
   - `purge === true` → grava o log **antes**, depois remove a mídia do
     bucket (quando houver `media_path`) e por fim
     `DELETE FROM messages WHERE id = …`. Log primeiro porque um `DELETE`
     que acontece antes do registro é um apagamento sem rastro — a mesma
     ordem canônica que a SPEC 073 fixou para a conta.
8. **`INSERT` em `message_deletion_log`** — sempre, nos dois caminhos,
   com `action = 'mark' | 'purge'`, ator, papel, canal, desfecho do
   provedor, tipo de conteúdo e `content_preview` (D-15).
9. Se a mensagem apagada era a **última** da conversa, atualizar
   `conversations.last_message_text` para o marcador de apagada (D-10).

**Ação `revoke_retry`.** Quando a revogação falhou, o balão oferece
"tentar de novo": a mesma rota, com a mensagem já marcada, refaz **só** o
passo 6 e grava mais uma linha de log com `action = 'revoke_retry'`.

### Por que `/api/inbox/…` e não `/api/whatsapp/…`

`/api/whatsapp/react` nasceu antes da camada de canais e ficou com um nome
que hoje mente (ela atende os dois canais). O endereço novo dos recursos
multicanal do inbox já é `/api/inbox/**` (`conversations/[id]/export`,
`conversations/transfer`). Uma rota que apaga em canal não-Meta não deve
nascer dentro de `whatsapp/`. Renomear a de reação está **fora de escopo**
(D-7).

### Por que a rota é obrigatória (e antes não era)

Na versão anterior desta SPEC, marcar poderia ser um `UPDATE` direto do
navegador, como a estrela de favorita (060 §7). Agora **não pode**: o log
é append-only e gravado por `service_role`, e a exclusão precisa remover
mídia do bucket. Um caminho de cliente que pulasse a rota produziria
exatamente o que o mantenedor proibiu — apagamento sem registro. Por isso
o aperto de `messages_delete` no §3.3 acompanha a rota: os dois juntos
fazem da rota o **único** caminho.

---

## 7. Interface

### 7.1 O balão apagado

Regra de ouro: **o registro continua legível**. Mesma posição, mesmo
horário, mesmo status de entrega — o que muda é a moldura.

- Borda e faixa superior em vermelho (`border-destructive`), fundo com
  leve tinta `destructive/5`.
- Conteúdo em `line-through` com opacidade reduzida (D-2).
- Faixa de rodapé com ícone e frase, por desfecho:
  - `revoked` + `agent`: **"Revogada no WhatsApp — apagada por {nome} às {hora}"**
  - `not_supported` + `agent`: **"Apagada no CRM — continua visível para o contato"**
  - `revoke_failed` + `agent`: **"Apagada no CRM — a revogação falhou: {motivo}"** + botão **Tentar de novo**
  - qualquer um + `contact`: **"O contato apagou esta mensagem"**
- Mídia: a miniatura **não** é renderizada; entra a moldura vermelha com o
  rótulo do tipo (`[imagem]`, `[documento]`). Abrir o lightbox de algo que
  se acabou de apagar é ruído.
- Ações que somem no balão apagado: reagir, responder. Ficam: copiar,
  favoritar (protege o registro da varredura de retenção), **Reenviar** e,
  **para admin+**, **Excluir do sistema**.
- Mensagem excluída não tem balão: ela sai da thread para todo mundo (o
  `DELETE` chega pelo realtime que já existe).

### 7.2 Os dois diálogos

**Agente** — um `AlertDialog`, sem opções:

- QRCode: título "Apagar mensagem?"; corpo "A mensagem será apagada no
  WhatsApp do contato e ficará marcada como apagada aqui, para registro.";
  se `warnStaleness`, acrescenta "Esta mensagem tem mais de 48 h — o
  WhatsApp pode não removê-la do aparelho do contato."
- Oficial: título "Apagar mensagem?"; corpo com o texto do §1.3 (a Meta
  não remove do aparelho do contato).
- Ações: **Apagar** / Cancelar.

**Admin/owner** — o mesmo diálogo, **mais** uma escolha explícita
(`RadioGroup`, primeira opção pré-selecionada):

1. **Manter na conversa, marcada como apagada** _(recomendado)_ — "o
   registro continua visível para a equipe e a mensagem pode ser
   reenviada."
2. **Excluir do ZAP CRM BR** — "a mensagem e a mídia dela serão removidas
   do sistema. Não poderá ser reenviada nem aparecerá na conversa, no PDF
   ou na API. **O registro da exclusão fica no log.**"

Em **qualquer** das duas, a linha de apoio do diálogo diz o que vai
acontecer no canal: "A revogação será enviada ao WhatsApp" (QRCode) ou "A
Meta não permite revogar; a mensagem continuará no aparelho do contato"
(oficial). É a garantia pedida: **o endpoint é disparado quando couber,
independentemente da escolha**.

A confirmação da opção 2 usa o botão destrutivo e a palavra "Excluir" —
nunca "Apagar", que é o gesto reversível.

### 7.3 Onde entra o botão

Em `message-actions.tsx`, ao lado de copiar, com `Trash2` — e **só**
quando `planDeletion` não devolve `refuse`. Botão que erra ao clicar é o
que a matriz de capacidades existe para evitar.

---

## 8. Reenviar

Botão **Reenviar** (`RotateCcw`) no balão marcado, visível para quem tem
permissão de envio. (Mensagem excluída do sistema não tem balão nem
conteúdo — não há o que reenviar.)

- **Texto**: preenche o composer com `content_text` e devolve o foco —
  não envia sozinho. Reenvio automático repetiria o erro que motivou a
  exclusão em metade dos casos; o operador quase sempre quer _corrigir_ e
  mandar. (D-8)
- **Mídia**: reenvia o **mesmo objeto** do bucket (`media_path`),
  reassinando a URL, com a legenda no composer para edição. Se
  `media_path` for nulo (mídia recebida, ou anterior à 040) ou o objeto
  não existir mais (varredura da 060, ou exclusão de outra mensagem que
  apontava para ele), o botão **não aparece** — melhor ausente do que
  quebrado. (D-9)
- **Template** (`content_type = 'template'`): reenvio abre o seletor de
  templates com o template original pré-selecionado; variáveis são
  redigitadas. Reconstruir `components` a partir de `template_preview` é
  reconstrução de dado derivado — fora de escopo.
- O envio passa **inteiro** pelo caminho normal (`/api/whatsapp/send`):
  janela de 24 h, `cold-send`, quotas (059), canal bloqueado, limite de
  mensagens. Reenviar é enviar. (D-12)
- A linha nova grava `resent_from_message_id = <id da apagada>`; o balão
  novo exibe um selo discreto "reenviada", e a apagada ganha, no rodapé,
  "reenviada às {hora}" quando existir filha.

---

## 9. Quando quem apaga é o contato

Simetria que sai quase de graça e que fecha um buraco antigo: hoje, se o
cliente apaga a mensagem dele, o CRM continua exibindo o texto original
para sempre, sem nenhum sinal.

### 9.1 Canal oficial

A Meta entrega `messages[].type = "revoke"` com `original_message_id`.
Em `src/app/api/whatsapp/webhook/route.ts`, ao lado do `case 'reaction'`
já existente na normalização: localizar a mensagem por
`message_id = original_message_id` **dentro da conta** e marcar
`deleted_at = now(), deletion_scope = 'revoked', deletion_actor =
'contact'`, `deleted_by = NULL`. Não cria mensagem, não mexe em
`unread_count`.

### 9.2 Canal QRCode

O whatsmeow entrega revogação como evento `Message` cujo `Message` carrega
`protocolMessage` (`type: REVOKE`), com a chave da mensagem alvo — não é
família de evento própria. Hoje isso cai em `extractMessageContent`, volta
`null` e é descartado com o aviso "proto de mensagem não reconhecido". O
tratamento entra **exatamente onde `reactionMessage` já é tratado**
(`webhook/[secret]/route.ts`), antes da extração de conteúdo.

### 9.3 Duas guardas obrigatórias

1. Se a mensagem alvo **já tem `deleted_at`**, o webhook não sobrescreve
   `deletion_actor` — a primeira gravação vence. Sem isto, o eco da nossa
   própria revogação viraria "apagada pelo contato".
2. Eco (`fromMe`/`SendMessage`) de `protocolMessage` é ignorado — mesma
   decisão já tomada para a reação dada pelo aparelho do operador.

### 9.4 Isso também vai para o log

`action = 'mark'`, `actor = 'contact'`, `actor_user_id = NULL`,
`provider_outcome = 'not_attempted'` (não houve endpoint nosso a
disparar). "Tudo que envolver apagar mensagem" inclui o que o contato
apaga — e é justamente o caso em que ninguém da equipe estava olhando.

---

## 10. O que mais precisa saber que a mensagem foi apagada

| Lugar                                                  | Mudança                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview da conversa (`conversations.last_message_text`) | Vira o marcador de apagada quando a última mensagem é apagada ou excluída (D-10)                                                                                                                                           |
| Exportação em PDF (SPEC 067, `export/model.ts`)        | Badge "Apagada"/"Revogada" ao lado do de favorita (`badges.push`), conteúdo riscado. O PDF é registro — omitir seria falsificar. Excluída não aparece (não existe mais)                                                     |
| Retenção (SPEC 060, `retention/sweep.ts`)              | **Nenhuma.** Apagada não é favorita: a varredura leva a linha no prazo normal da conta                                                                                                                                      |
| API pública v1 (`serializeMessage`)                    | Ganha `deleted_at`, `deletion_scope`, `deletion_actor` (leitura). Precedente idêntico ao de `is_favorite` na 060. **Obriga as três edições juntas**: `docs/public-api.md`, `public/openapi.json`, `public/openapi.pt-BR.json` |
| API pública v1 — apagar por endpoint                   | **Fora de escopo** (D-11)                                                                                                                                                                                                  |
| Automações / flows / IA                                | **Nenhuma.** Nada apaga sozinho (D-13)                                                                                                                                                                                     |
| Busca de mensagens                                     | Apagadas continuam encontráveis — são registro                                                                                                                                                                             |

### 10.1 O que a exclusão arrasta junto (`purge`)

Verificado no schema — três chaves estrangeiras apontam para
`messages(id)`, e nenhuma delas perde dado do cliente:

| Referência                                | Comportamento             | Efeito                                                     |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `message_reactions.message_id` (009)      | `ON DELETE CASCADE`       | As reações à mensagem excluída somem junto — correto        |
| `messages.reply_to_message_id` (009)      | `ON DELETE SET NULL`      | A resposta continua na thread, sem a citação                |
| `flow_executions.last_prompt_message_id`  | `ON DELETE SET NULL`      | Execução de fluxo sobrevive                                 |
| `messages.resent_from_message_id` (083)   | `ON DELETE SET NULL`      | O reenvio sobrevive à exclusão do original                  |

**Mídia no bucket.** Nada no aplicativo remove objetos de `chat-media`
hoje — nem a varredura de retenção. Uma exclusão que deixasse o arquivo lá
seria meia-verdade, e o objeto continuaria acessível por URL assinada. A
rota remove o objeto e grava `media_removed` no log. Se a remoção falhar,
`media_removed = false` e a mensagem some assim mesmo — a falha fica
registrada em vez de bloquear o pedido do admin.

---

## 11. i18n

Namespace `Inbox.delete` em `messages/en.json` (fonte da verdade) e
`messages/pt-BR.json`: `action`, `dialogTitle`, `bodyRevoke`,
`bodyNoRevoke`, `stalenessWarning`, `channelNoteRevoke`,
`channelNoteNoRevoke`, `optionMark`, `optionMarkHint`, `optionPurge`,
`optionPurgeHint`, `confirm`, `confirmPurge`, `badgeRevoked`,
`badgeNotSupported`, `badgeRevokeFailed`, `badgeByContact`, `deletedBy`
(`{name}`, `{time}`), `retryRevoke`, `retryOk`, `resend`, `resentBadge`,
`resentAt`, `previewDeleted`, `purgedToast`.
Erros de `/api/**` em **inglês** (são para integrações); a UI traduz pelo
`code`. `npm run i18n:check` fecha a paridade.

---

## 12. Decisões que precisam de ratificação

| #        | Decisão                                                                | Resolução                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-1**  | Oferecer "apagar só no CRM" como modo separado?                        | **Não** (decidido pelo mantenedor). Apagar é um gesto só: marca sempre, e dispara o endpoint quando o canal permite. O canal oficial não vira uma opção diferente — vira uma frase diferente no diálogo                                                        |
| **D-2**  | O conteúdo marcado continua visível (riscado) ou atrás de "mostrar"?   | **Visível riscado** — é o "para registro" do pedido                                                                                                                                                                                                           |
| **D-3**  | Quem pode apagar?                                                      | Marcar: quem pode enviar (owner/admin/agent), **qualquer** mensagem de saída da conta. Excluir do sistema: **admin+** (D-14)                                                                                                                                   |
| **D-4**  | Dá para apagar mensagem **recebida**?                                  | **Não.** Não há o que revogar no aparelho alheio; "sumir com a fala do cliente" é adulteração de registro. (A exclusão pelo admin, se um dia valer para inbound, é decisão à parte)                                                                            |
| **D-5**  | Bloquear revogação por idade?                                          | **Não bloquear**; avisar acima de 48 h                                                                                                                                                                                                                        |
| **D-6**  | O que acontece quando o endpoint recusa?                               | **Marca assim mesmo** e mostra o motivo no balão, com "tentar de novo". Consequência direta de D-1: sem modos, não há segundo diálogo — mas a falha nunca é silenciosa                                                                                         |
| **D-7**  | Endereço da rota                                                       | `/api/inbox/messages/[id]/delete`; **não** renomear `/api/whatsapp/react` agora                                                                                                                                                                               |
| **D-8**  | Reenviar dispara sozinho ou preenche o composer?                       | **Preenche** o composer                                                                                                                                                                                                                                       |
| **D-9**  | Reenvio de mídia cuja origem sumiu                                     | Botão **ausente**                                                                                                                                                                                                                                             |
| **D-10** | Preview da lista quando a última mensagem é apagada                    | Vira "Mensagem apagada"                                                                                                                                                                                                                                       |
| **D-11** | `DELETE` na API pública v1                                             | **Fora de escopo**; só os campos de leitura                                                                                                                                                                                                                   |
| **D-12** | Reenvio passa por janela de 24 h / cold-send / quota?                  | **Sim**, integralmente                                                                                                                                                                                                                                        |
| **D-13** | Automação/flow/IA podem apagar?                                        | **Não**                                                                                                                                                                                                                                                       |
| **D-14** | O admin escolhe entre manter marcada e excluir do sistema?             | **Sim** (decidido pelo mantenedor). Escolha explícita no diálogo, padrão "manter marcada"; o endpoint do canal é disparado nas duas. Agente não vê a escolha: para ele, apagar sempre marca                                                                    |
| **D-15** | O log guarda um trecho do conteúdo?                                    | **Recomendo `content_preview` de 120 caracteres**, sempre — é o que faz o log responder "o que foi apagado", que é o ponto de existir. Alternativa, se o objetivo da exclusão for eliminar o conteúdo: só metadados, sem preview. **Precisa da sua ratificação** |
| **D-16** | "Admin do sistema" = admin **da conta** ou proprietário da plataforma? | **Assumi admin/owner da CONTA** — é quem usa o inbox onde o gesto acontece. Se a intenção era o proprietário da plataforma (console `/admin`, SPEC 062), a exclusão vira tela do console e não item do balão: **muda a fase F5 inteira**                       |

---

## 13. Fases

| Fase    | Entrega                                                                                                                        | Verificação                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **F1**  | Migração 083 (colunas, `message_deletion_log` + RLS, aperto de `messages_delete`) + tipos em `src/types/index.ts`               | `typecheck`; tabela e políticas presentes                            |
| **F2**  | `src/lib/messages/delete.ts` + `delete.test.ts` (as quatro regras do §4, dois canais, três recusas, `revoke` verdadeiro/falso)  | `test`                                                               |
| **F3**  | Medições do §5.1 → `DeleteMessageParams`, `deleteMessage?` no `ChannelAdapter`, implementação Evolution + testes                | `test`; chamada real contra a instância                              |
| **F4**  | Rota + `route.test.ts` + bucket `msgDelete` + gravação do log nos dois caminhos + remoção de mídia no `purge`                   | `test`; `curl` autenticado como agent e como admin                   |
| **F5**  | UI: balão vermelho, diálogo do agente, diálogo do admin com a escolha, "tentar de novo", realtime de `UPDATE` **e de `DELETE`** | Navegador, dois canais, dois papéis                                  |
| **F6**  | Reenviar (texto, mídia, template) + `resent_from_message_id` + selo                                                             | Navegador                                                            |
| **F7**  | Revogação vinda do contato nos dois webhooks + guardas do §9.3 + linha de log do §9.4                                          | `test` dos webhooks; teste real apagando no celular                  |
| **F8**  | Preview, PDF (067), `serializeMessage` + **as três edições** de API pública                                                    | `npx @redocly/cli lint` nos dois `openapi*.json` + paridade de chaves |
| **F9**  | i18n (en + pt-BR) e gate completo                                                                                              | `typecheck && i18n:check && lint && test && format:check && build`   |
| **F10** | Teste manual (§14) contra número real                                                                                          | Checklist assinado pelo mantenedor                                   |

Migração 083 **só depois de confirmar com o mantenedor** em qual projeto
Supabase aplicar (`vn` e `rs` estão sincronizados; a regra do AGENTS.md
vale).

---

## 14. Teste manual (§F10) — 15 itens, número real, dois canais, dois papéis

1. **QRCode, revogação feliz (agente).** Enviar "teste 074", apagar como
   agente. Esperado: no celular do contato, "Esta mensagem foi apagada";
   no CRM, balão vermelho "Revogada no WhatsApp" com o texto riscado
   legível; **nenhuma opção de excluir foi oferecida**.
2. **QRCode, mídia.** Mesma coisa com uma imagem. Miniatura some, moldura
   vermelha com `[imagem]`, lightbox não abre.
3. **Oficial (agente).** Enviar pelo número oficial e apagar. Diálogo
   avisa que a Meta não remove do aparelho; balão fica "Apagada no CRM —
   continua visível para o contato"; **conferir no celular** que a
   mensagem continua lá.
4. **Revogação recusada.** Apagar, no QRCode, uma mensagem antiga o
   bastante para o WhatsApp recusar. Esperado: a mensagem **é marcada
   assim mesmo**, o balão mostra o motivo e o botão "Tentar de novo"
   aparece.
5. **Admin mantém marcada.** Como admin, apagar escolhendo a opção 1.
   Resultado idêntico ao do agente — e uma linha `action = 'mark'` no log.
6. **Admin exclui do sistema.** Como admin, apagar escolhendo a opção 2.
   Esperado: a mensagem **some da thread**; a linha sumiu de `messages`; o
   objeto de mídia sumiu do bucket; **existe linha `action = 'purge'` no
   log** com ator, papel, canal e desfecho do provedor.
7. **Excluir uma já marcada.** Sobre a mensagem do item 1, o admin usa
   "Excluir do sistema". Log fica com **duas** linhas para o mesmo
   `message_id` (`mark` e `purge`), na ordem.
8. **Agente não exclui.** O agente não vê "Excluir do sistema"; o
   `POST … {"purge":true}` feito à mão devolve 403; e o `DELETE` direto
   pelo cliente Supabase é **barrado pela RLS** apertada.
9. **Propagação.** Conversa aberta em dois navegadores: marcar em um
   atualiza o outro; excluir em um faz o balão sumir no outro.
10. **Reenvio de texto.** "Reenviar" na marcada: composer preenchido, não
    enviado. Editar, enviar. Balão novo com selo "reenviada"; o antigo
    mostra "reenviada às …".
11. **Reenvio de mídia.** Mesmo fluxo com a imagem do item 2; a imagem
    chega íntegra ao contato.
12. **Reenvio fora da janela.** Conversa oficial com mais de 24 h sem
    resposta: o reenvio é barrado pela faixa de janela expirada, e a saída
    oferecida é template/transferência — **não** um erro cru.
13. **Revogação pelo contato (dois canais).** O contato apaga uma
    mensagem dele. CRM marca "O contato apagou esta mensagem" **e grava
    log com `actor = 'contact'`**. Conferir que a mensagem do item 1
    continua com `deletion_actor = 'agent'` — o eco não pode ter
    reescrito.
14. **Preview e PDF.** Apagar a última mensagem: a lista mostra "Mensagem
    apagada". Exportar a conversa (067): o PDF traz o badge e o conteúdo
    riscado; a mensagem excluída no item 6 **não** aparece.
15. **Log imutável.** Como admin, tentar `UPDATE`/`DELETE` em
    `message_deletion_log` pelo cliente do navegador: barrado pela RLS
    (só `SELECT`).

SQL de conferência:

```sql
-- estado das mensagens
SELECT id, sender_type, status, deleted_at, deletion_scope,
       deletion_actor, deletion_error, resent_from_message_id
FROM messages
WHERE conversation_id = '<uuid>'
ORDER BY created_at DESC
LIMIT 20;

-- o log, que é o que sobrevive à exclusão
SELECT created_at, action, actor, actor_role, provider_outcome,
       provider_error, channel_type, content_type, content_preview,
       had_media, media_removed, message_id
FROM message_deletion_log
WHERE account_id = '<uuid>'
ORDER BY created_at DESC
LIMIT 30;
```

---

## 15. Fora de escopo

- **Tela de leitura do log.** A tabela nasce completa e com RLS de leitura
  para admin+, então uma aba "Auditoria" em `/settings` (ou uma seção no
  console do proprietário) é construível depois **sem migração nenhuma**.
  Nesta SPEC o log é gravado e consultável por SQL/API.
- **Editar** mensagem enviada (o QRCode suporta, `editMessage: true`; o
  oficial não). Merece SPEC própria — o balão editado precisa de
  histórico de versões, que é outro modelo de dados.
- Apagar/excluir **em massa** (a conversa inteira, ou uma campanha
  inteira). No canal QRCode é exatamente o gesto que queima a instância.
- `DELETE` na API pública v1 (D-11).
- Renomear `/api/whatsapp/react` para `/api/inbox/…` (D-7).
- Apagar por automação, flow ou IA (D-13).
