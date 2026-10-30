# SPEC 073 — Excluir a conta pelo titular (Zona de risco em `/settings`)

**PRD:** [`docs/prd-072-exclusao-da-conta-pelo-titular.md`](./prd-072-exclusao-da-conta-pelo-titular.md)
**Reverte:** PRD 061 §3.3 e §9 · fecha o item "Exclusão de conta pelo console" da SPEC 062 §14
**Status:** aguardando ratificação de D-1…D-9 · **Data:** 2026-09-06

---

## 1. O problema, em uma frase

Apagar uma conta hoje é `DELETE` digitado à mão em produção; o cascade do
Postgres cobre 47 tabelas, mas **não** cobre os arquivos no Storage, **não**
desliga as instâncias Evolution na VPS, **não** remove o login do titular e
**não** devolve a conta pessoal aos colegas de equipe. Esta SPEC transforma
essa sequência em um caminho único, testado e auditado, disparado por um botão
que só o dono da conta enxerga.

### 1.1. O que já existe e vai ser reaproveitado (não reescrever)

| Peça | Onde | Papel aqui |
| --- | --- | --- |
| `requireRole(min)` | `src/lib/auth/account.ts:259` | Guarda de papel; devolve `accountId`, `userId` e o client de sessão |
| `remove_account_member(p_user_id)` | migração 018, corrigida na 074 | Desliga um membro **preservando o login** e criando conta pessoal com plano padrão (retorna o novo `account_id`) |
| `deleteEvolutionInstance()` | `src/lib/evolution/instances.ts` | Apaga a instância na VPS antes do banco |
| `logPlatformAction()` | `src/lib/platform/audit.ts` | Grava em `platform_audit_log` (`action` é `text`, sem CHECK — nome novo não exige migração) |
| `emitSystemEvent()` | `src/lib/notifications/emit.ts` | Outbox da SPEC 063 (`type` é `text`, sem CHECK) |
| `loadOwnerSelfRefs()` / `canBlockAccount()` | `src/lib/platform/owner-profile.ts` e `guards.ts` | Modelo da guarda "não faça isso com a sua própria conta de plataforma" |
| Confirmação por digitação | `src/components/settings/whatsapp-qrcode-config.tsx:1261` | Padrão de UI já adotado no projeto — copiar, não inventar |
| `minRole` em `SectionMeta` | `src/components/settings/settings-sections.ts:62` | Campo existente e hoje sem uso; é o gate da seção nova |

---

## 2. Decisões (ratificar antes de implementar)

| # | Decisão | Recomendação |
| --- | --- | --- |
| **D-1** | Exclusão imediata × carência agendada | **Imediata.** Carência exige varredura por cron, e `pg_cron` não está instalado no projeto de produção (armadilha do `AGENTS.md`): "agendado" viraria "nunca apagado", em silêncio. A proteção passa a ser a confirmação dupla, não o tempo |
| **D-2** | Destino dos membros não-donos | **Desligar via `remove_account_member` antes do apagamento** — cada um fica com conta pessoal vazia + plano padrão. O titular manda nos dados da empresa, não na credencial do colega |
| **D-3** | Destino do login do titular | **Apagar o `auth.users`** depois do `DELETE` da conta (ordem obrigatória: `accounts.owner_user_id` é `ON DELETE RESTRICT`). O e-mail volta a aceitar cadastro novo |
| **D-4** | Quem pode disparar | **Só `account_role = 'owner'`** (`requireRole('owner')`), nunca `admin`. A conta do proprietário da plataforma é barrada no servidor, espelhando `canBlockAccount` |
| **D-5** | Confirmação exigida | **Nome exato da conta digitado + senha atual** (reautenticação no servidor). Sessão aberta em notebook alheio não apaga empresa |
| **D-6** | Instâncias Evolution na VPS | **Melhor esforço, sem travar**: tenta apagar cada uma; falha vira linha no tombstone e no e-mail ao proprietário. VPS fora do ar não pode prender o cliente |
| **D-7** | Arquivos no Storage | **Apagar `account-<id>/` em `chat-media`, `flow-media` e `contact-avatars`, e `<owner_user_id>/` em `avatars`.** O cascade do Postgres não toca em Storage — é o vazamento clássico |
| **D-8** | Uma instrução `DELETE` × RPC ordenada | **Verificar primeiro (F1).** Se o cascade passar pelos quatro FKs `NO ACTION`, a entrega não tem migração nenhuma. Se falhar, migração `079` com RPC `delete_account()` em ordem explícita |
| **D-9** | Exportação prévia | **Não bloquear.** O modal linka as exportações que já existem (SPEC 051 contatos, SPEC 067 conversas) e exige o aceite "já exportei o que precisava". Pacote automático é job novo — fora de escopo (PRD §5) |

---

## 3. O terreno: o que o banco faz sozinho e o que não faz

Levantado no projeto **vn** em 2026-09-06 (`confdeltype` de todos os FKs de
`public`). Não repetir o levantamento: os fatos abaixo são o contrato.

### 3.1. O cascade cobre quase tudo

**47 tabelas** têm `account_id` e **todas** referenciam `accounts` com
`ON DELETE CASCADE`, com duas exceções deliberadas:

| Tabela | Regra | Consequência |
| --- | --- | --- |
| `platform_audit_log` | `SET NULL` | A auditoria **sobrevive** — mas perde o `account_id`. Por isso o tombstone precisa carregar o id no `payload` (§5.4) |
| `system_notifications` | `SET NULL` | A outbox sobrevive. Um evento emitido **com** `account_id` seria anulado no apagamento; emitir com `account_id = NULL` e o id no payload é mais previsível |

Tabelas sem `account_id` (`messages`, `broadcast_recipients`, `contact_tags`,
`contact_custom_values`, `flow_nodes`, `flow_run_events`, `pipeline_stages`,
`automation_steps`, `message_reactions`, `evolution_instance_secrets`) chegam ao
apagamento **pelo pai**, todas em `CASCADE`. `plans`, `platform_settings` e
`message_retention_state` são globais e não guardam nada da conta.

### 3.2. Os quatro FKs `NO ACTION` — o risco real do D-8

`conversations.channel_id → channels`, `deals.conversation_id → conversations`,
`deals.pipeline_stage_id → pipeline_stages` e `channels.created_by → auth.users`
são `NO ACTION`. Em teoria isso é inofensivo: `NO ACTION` é checado **no fim da
instrução**, e nesse instante as linhas filhas já foram apagadas pelo mesmo
cascade. Na prática, isso **tem que ser provado neste schema** antes de escrever
qualquer linha de UI — é o F1.

### 3.3. O que o banco não faz de jeito nenhum

1. **Storage.** Quatro buckets, caminhos achatados de um nível:
   `chat-media/account-<id>/…`, `flow-media/account-<id>/…`,
   `contact-avatars/account-<id>/contact-<id>.<ext>` e — por usuário, não por
   conta — `avatars/<user_id>/avatar-<ts>.<ext>`.
2. **`auth.users`.** `profiles` cascateia; o usuário do Auth, não. Como
   `profiles.user_id` é **UNIQUE**, cada pessoa tem exatamente uma conta: sem
   tratamento, todo membro vira login órfão apontando para nada.
3. **A VPS do Evolution.** A instância continua conectada ao WhatsApp,
   consumindo recurso e mandando webhook para um canal que não existe mais.
4. **`accounts.owner_user_id` é `ON DELETE RESTRICT`** — apagar o `auth.users`
   do titular **antes** da conta falha. A ordem da §4 não é estilo, é a única
   que funciona.

---

## 4. A ordem canônica (sete etapas)

O ponto de não-retorno é a etapa 4. Tudo que é **leitura** vem antes dela;
tudo que é **melhor esforço** vem depois. O motivo é assimétrico: arquivo órfão
no Storage é recuperável (o prefixo é derivável do id e um script limpa depois);
mídia apagada com a conta ainda de pé é inconsistência sem volta.

| # | Etapa | Client | Falha aqui significa |
| --- | --- | --- | --- |
| 1 | Guardas: `requireRole('owner')`, não ser a conta do proprietário da plataforma, nome digitado idêntico a `accounts.name`, senha reautenticada | sessão | 403/400/401 — nada aconteceu |
| 2 | Leitura: contagens para o tombstone + ids das instâncias Evolution + lista de membros não-donos | admin | 500 — nada aconteceu |
| 3 | `remove_account_member(p_user_id)` para cada membro não-dono | **sessão** (o RPC é `SECURITY DEFINER` e checa `auth.uid()`) | 500 — membros já desligados ficam desligados e a conta segue de pé. Estado estranho, porém seguro e visível na aba Equipe |
| 4 | **`DELETE FROM accounts WHERE id = :id`** — uma instrução, uma transação | admin | 500 e nada apagado (atômico) |
| 5 | `auth.admin.deleteUser(ownerUserId)` | admin | Login órfão; registrar no tombstone e responder 200 assim mesmo — a conta já não existe |
| 6 | Melhor esforço: 4 prefixos no Storage + cada instância na VPS | admin | Sobras registradas no tombstone; a resposta continua 200 |
| 7 | `logPlatformAction('account.delete')` + `emitSystemEvent('account.deleted')` | admin | Só log de erro (`emitSystemEvent` nunca lança, por contrato da SPEC 063) |

> **Depois da etapa 4 o client de sessão está morto** — o `profiles` do titular
> foi junto, e qualquer chamada com ele volta 401/403. As etapas 5 a 7 usam
> `supabaseAdmin()` obrigatoriamente. Trocar essa ordem é o erro mais fácil de
> cometer aqui.

---

## 5. Contratos

### 5.1. `src/lib/account/delete.ts` (novo) — o que é puro fica puro

```ts
export type DeleteGuardReason =
  | 'not_owner' // papel abaixo de owner
  | 'platform_owner_account' // é a conta do proprietário da plataforma
  | 'name_mismatch'; // o texto digitado não bate com accounts.name

export function checkDeleteGuards(input: {
  role: AccountRole;
  accountId: string;
  accountName: string;
  typedName: string;
  ownerEmail: string;
  platformOwnerEmail: string;
  platformOwnerAccountId: string | null;
}): { ok: true } | { ok: false; reason: DeleteGuardReason };

/** Os quatro prefixos da §3.3.1, na ordem em que serão varridos. */
export function storagePrefixesFor(
  accountId: string,
  ownerUserId: string
): { bucket: string; prefix: string }[];

export interface DeletionTombstone {
  accountId: string;
  accountName: string;
  ownerEmail: string;
  ownerUserId: string;
  counts: Record<string, number>; // contacts, conversations, messages, broadcasts, channels, members
  detachedMembers: { userId: string; newAccountId: string | null }[];
  storageRemoved: Record<string, number>;
  leftovers: string[]; // instância X não apagada, bucket Y falhou, login órfão…
  deletedAt: string; // ISO
}

export function buildDeletionTombstone(/* … */): DeletionTombstone;
```

Comparação de nome: `trim()` nos dois lados e comparação **sensível a
maiúsculas** — é a mesma régua do modal de instância QRCode, e afrouxar aqui
seria afrouxar justo onde a fricção é o recurso. A senha não entra em
`checkDeleteGuards` (é I/O), mas o `bad_password` é um código de erro da rota.

### 5.2. `src/app/api/account/delete/route.ts` (novo)

```
POST /api/account/delete
body: { confirmName: string; password: string }
200  { ok: true, deleted: { accountId, counts, detachedMembers, leftovers } }
400  { error, code: 'name_mismatch' }
401  { error, code: 'bad_password' }
403  { error, code: 'not_owner' | 'platform_owner_account' }
429  rate limit (RATE_LIMITS.adminAction, chave `account:delete:<userId>`)
500  { error }
```

`POST` e não `DELETE`: o corpo com a senha é obrigatório, e corpo em `DELETE` é
território cinzento em proxy e em `fetch`. Mensagens em inglês (`/api/**`); a UI
traduz — convenção do `AGENTS.md`.

**Reautenticação (etapa 1):** criar um client Supabase *isolado* (nunca o de
sessão, que gravaria cookie novo) e chamar
`signInWithPassword({ email, password })` com o e-mail do titular. Falhou → 401,
sem tocar em nada.

### 5.3. Storage

Para cada prefixo: `list(prefix, { limit: 100, offset })` em laço até esgotar e
`remove(paths)` em lotes de até 100 — usar o `chunkArray` de `src/lib/array.ts`
(extraído na revisão da SPEC 067; não escrever outro). Os caminhos são planos de
um nível: **não** é preciso recursão. Cada bucket devolve quantos objetos foram
removidos; falha em um bucket não interrompe os outros.

### 5.4. Rastro

```ts
await logPlatformAction(db, {
  actor: `self-service:${ownerEmail}`,
  action: 'account.delete', // adicionar ao union PlatformAuditAction
  accountId: null, // a linha ficaria NULL de qualquer forma
  targetUserId: null, // o auth.users também já foi
  payload: tombstone,
});
```

`emitSystemEvent({ type: 'account.deleted', accountId: null, payload: … })`.
O tipo novo obriga três edições que o `typecheck` cobra sozinho:
`SYSTEM_EVENT_TYPES` e a união `SystemEventPayload` em
`src/lib/notifications/types.ts`; o mapa exaustivo `RENDERERS` em
`src/lib/mailer/render.ts:197` (assunto: *"Conta excluída pelo titular"*, corpo
com nome, e-mail, contagens e as sobras); e `keyFor()` em
`src/lib/notifications/dedupe.ts` → **`null`** (sempre entrega; é evento único
por definição).

---

## 6. UI

**Seção nova em `/settings`:** `'danger'` acrescentada a `SETTINGS_SECTIONS`,
com
`SECTION_META.danger = { id: 'danger', label: 'Danger zone', icon: TriangleAlert, group: 'workspace', minRole: 'owner' }`.
É o primeiro uso real do campo `minRole` — o comentário do arquivo já previa
isso. Painel em `src/components/settings/danger-zone.tsx`.

O painel (só leitura) mostra o inventário; o botão vermelho abre
`delete-account-dialog.tsx`, que habilita o botão final **só** com as três
condições, nesta ordem de apresentação:

1. inventário lido (contagens vindas de `GET /api/account/delete/preview`);
2. caixa "já exportei o que precisava" marcada, com os dois links de exportação;
3. nome exato digitado **e** senha preenchida.

O aviso sobre colegas é textual e nominal quando há membros: *"N pessoa(s)
perderão o acesso a esta empresa e continuarão com o login, em uma conta pessoal
vazia"*. Sucesso → `supabase.auth.signOut()` → `router.replace('/login?deleted=1')`,
e a tela de login mostra o aviso de conclusão.

`GET /api/account/delete/preview` (mesma pasta, `requireRole('owner')`) devolve
só as contagens — o modal não pode inventar número, e contar no cliente exigiria
seis consultas sob RLS.

### 6.1. i18n

Chaves novas em `Settings.danger.*` nos **dois** dicionários
(`messages/en.json` é a fonte, `messages/pt-BR.json` espelha):
`title`, `description`, `inventoryTitle`, `contacts`, `conversations`,
`messages`, `broadcasts`, `channels`, `members`, `exportHint`,
`exportContacts`, `exportConversations`, `exportedAck`, `membersWarning` (com
`{count}`), `confirmNameLabel` (com `{name}`), `passwordLabel`, `irreversible`,
`button`, `dialogTitle`, `deleting`, `success`, `errorNameMismatch`,
`errorBadPassword`, `errorNotOwner`, `errorGeneric`, `leftovers`. Rodar
`npm run i18n:check`.

---

## 7. Segurança

1. **O servidor decide, a tela sugere.** O `minRole: 'owner'` só some com o item
   do menu; a rota repete as quatro guardas. Um `admin` com `curl` recebe 403.
2. **A conta do proprietário da plataforma nunca é apagável** — mesma lógica de
   `canBlockAccount` (`loadOwnerSelfRefs`), pelos dois caminhos (por id e pelo
   e-mail do dono). Ele não pode se trancar para fora nem se apagar.
3. **Reautenticação** fecha a janela de sessão sequestrada / notebook aberto.
4. **Rate limit** com a chave já existente `RATE_LIMITS.adminAction`.
5. **`supabaseAdmin()` só no servidor** — `route.ts` importa; o componente, não.
6. **Nada de log com senha.** O tombstone guarda e-mail e nome da conta (dado
   pessoal mantido por interesse legítimo de auditoria — o D-7 do PRD ratifica).

---

## 8. Testes

**Unitários** (`src/lib/account/delete.test.ts`), Vitest, sem I/O:
`checkDeleteGuards` em todos os desfechos (ok; `not_owner` para admin/agent/
viewer; `platform_owner_account` por id **e** pelo e-mail do dono;
`name_mismatch` com espaço sobrando e com caixa trocada);
`storagePrefixesFor` devolvendo exatamente os quatro pares da §3.3.1;
`buildDeletionTombstone` preservando `accountId` mesmo quando a linha de
auditoria vai com `accountId: null`, e listando as sobras.

**Rota** (`src/app/api/account/delete/route.test.ts`), com client falso no
padrão de `src/app/api/admin/accounts/[accountId]/channel-limits/route.test.ts`:

- admin autenticado → 403 e **nenhuma** chamada de escrita;
- nome errado → 400 antes de qualquer leitura pesada;
- senha errada → 401 e nenhuma escrita;
- caminho feliz → a ordem exata da §4 (assertar a **sequência**: membros antes
  do `DELETE`, `DELETE` antes do `deleteUser`, Storage depois de tudo);
- VPS fora do ar → 200 com a instância listada em `leftovers`;
- `emitSystemEvent` que rejeita → a resposta continua 200.

**Verificação de banco:** o SQL do F1 é o teste que nenhum mock substitui.

---

## 9. Fases

| Fase | Entrega | Como saber que acabou |
| --- | --- | --- |
| **F1** | **Prova do cascade** (§3.2) — conta de rascunho no **vn** com canal, conversa, negócio em estágio, mídia, membro e instância; depois `BEGIN; DELETE FROM accounts WHERE id = …; ROLLBACK;` | Sem erro de FK → o D-8 fecha em "sem migração". Com erro → escrever a migração `079` com RPC `delete_account()` ordenada e seguir |
| **F2** | `src/lib/account/delete.ts` + testes unitários | `npm run test` verde; nenhum import de Supabase no arquivo puro |
| **F3** | `POST /api/account/delete` + `GET …/preview` + teste de rota | Suíte verde; `curl` como admin devolve 403 |
| **F4** | Tipos e renderers: `account.delete` no union de auditoria; `account.deleted` na outbox, no `dedupe` e no `RENDERERS` | `npm run typecheck` verde (o `Record` exaustivo cobra o renderer) |
| **F5** | UI: seção `danger`, painel, modal, `signOut` + redireção | Aparece só para `owner`; o botão só habilita com as três condições |
| **F6** | i18n nos dois dicionários | `npm run i18n:check` verde |
| **F7** | Portão completo | `typecheck && i18n:check && lint && test && format:check && build` |
| **F8** | Teste manual do §10 contra conta descartável real | Checklist com os 10 itens marcados |

Migração: **provavelmente nenhuma**. Se o F1 pedir,
`079_delete_account_rpc.sql` — e aí vale a regra do `AGENTS.md`: **confirmar com
o mantenedor antes de aplicar em vn e rs**.

---

## 10. Teste manual (F8) — conta descartável, número real

1. Criar conta nova, convidar dois colegas (um `admin`, um `agent`) e aceitar os
   convites.
2. Popular: 3 contatos, 1 conversa com imagem e áudio, 1 disparo em rascunho,
   1 fluxo com mídia, 1 negócio em um estágio, 1 instância QRCode conectada.
3. Entrar como o colega `admin` → **a seção "Zona de risco" não existe** no
   menu; `POST /api/account/delete` por `curl` com a sessão dele → **403**.
4. Como titular: abrir o modal e conferir se as contagens batem com o banco.
5. Digitar o nome com uma letra trocada → o botão continua desabilitado; digitar
   certo com a senha errada → **401** e nada apagado (conferir no banco).
6. Confirmar de verdade. A sessão cai e o login aparece com o aviso.
7. SQL de conferência (trocar `:id`):
   ```sql
   select 'accounts' t, count(*) from accounts where id = :id
   union all select 'profiles', count(*) from profiles where account_id = :id
   union all select 'contacts', count(*) from contacts where account_id = :id
   union all select 'messages', count(*) from messages m
     join conversations c on c.id = m.conversation_id where c.account_id = :id
   union all select 'channels', count(*) from channels where account_id = :id
   union all select 'storage', count(*) from storage.objects
     where name like 'account-' || :id || '/%';
   ```
   Todas as linhas devem dar **0**.
8. Os dois colegas continuam conseguindo entrar; cada um cai em conta pessoal
   vazia com o plano padrão
   (`select account_id, account_role from profiles where user_id = …`).
9. O titular não entra mais, e o mesmo e-mail aceita um cadastro novo.
10. `select action, payload from platform_audit_log where action = 'account.delete'`
    traz id, nome, e-mail e contagens; a instância sumiu da VPS; o proprietário
    recebeu o e-mail `account.deleted`.

---

## 11. Limitações conhecidas (escrever no guia, não descobrir depois)

- **Sem desfazer e sem carência** (D-1). Enquanto o `pg_cron` não existir no
  ambiente, é assim que fica honesto.
- **Conta gigante pode demorar.** O `DELETE` é uma transação só; centenas de
  milhares de mensagens levam minutos e seguram a conexão. No deploy atual
  (Node em VPS, sem teto de execução serverless) isso passa; se um dia migrar
  para um runtime com timeout, esta rota é a primeira a quebrar.
- **A entrega do e-mail depende do dispatcher da SPEC 063** — sem o disparo
  agendado, o evento fica na outbox. O rastro em `platform_audit_log` é
  síncrono e não depende disso.
- **`/admin` continua sem botão equivalente** (PRD §5). A rota nasce genérica o
  bastante para receber um depois.
