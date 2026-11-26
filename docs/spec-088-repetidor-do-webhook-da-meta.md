# SPEC 088 — Repetidor do webhook da Meta

| Campo            | Valor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status           | **Implementada; F1 a F5 commitadas, F6 parcial** — D-1…D-11 ratificadas em 2026-11-23. No HEAD: F1 (migração 101, aplicada no `vn`), F2, F3, F4, F5, ingest escopado pelo segredo que assinou (§4.1), M-1 itens 1 a 3 (§4.4) e as fixtures reais de `statuses` e `messages`. **No working tree em 2026-11-25, a commitar pelo mantenedor:** correções B-1, B-2, B-4, B-6, B-8 e M-2 e as da revisão integrada, A-1 e L-1 a L-3 (§11). **F6 parcial:** itens 1 a 5 e 11 do §9 testados em produção em 2026-11-25; itens 6 a 10 e 12 a 14 não executados |
| Data             | 2026-11-23                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Escopo           | `POST /api/whatsapp/webhook` (gancho), `src/lib/webhooks/` (módulo novo + refatoração da entrega), rotas `/api/account/meta-relay`, cartão em "Chaves de API"                                                                                                                                                                                                                                                                                                                                                                                          |
| Depende de       | SPEC 064 (N números oficiais por conta), migração 028 (`sign.ts`, `ssrf.ts`, `deliver.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Migração         | **`101_meta_webhook_relay.sql`** — tabela `meta_webhook_relays` + função `record_meta_relay_failure`. Conferir o número em `status.md` antes de criar                                                                                                                                                                                                                                                                                                                                                                                                  |
| Dependências npm | Nenhuma                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| i18n             | Chaves novas em `Settings.apiKeys.metaRelay.*` e `Activity.actions.*` (D-10), nos dois dicionários                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## Contexto

Hoje a Meta entrega os eventos do WhatsApp Cloud API em
[`/api/whatsapp/webhook`](../src/app/api/whatsapp/webhook/route.ts). A
rota valida `x-hub-signature-256`, responde `200` e processa em
`after()`. Quem integra por fora só enxerga o que o CRM **reinterpreta**:
os eventos `message.received`, `message.status_updated` e
`conversation.created` de [`src/lib/webhooks/events.ts`](../src/lib/webhooks/events.ts),
dentro de um envelope próprio (`{ id, event, occurred_at, account_id, data }`).

Esse envelope perde informação de propósito: não traz `pricing`, `errors`
completos, `context`, `referral`, cartões de contato nem qualquer campo
que o CRM não modela. E um número só pode ter **uma** URL de webhook na
Meta, então quem aponta o número para o ZAP CRM BR não consegue alimentar
um segundo sistema (n8n, BI, outro atendimento) com o payload original.

## Objetivo

Um **repetidor**: quando a Meta envia um webhook de um número oficial da
conta, o CRM reenvia o mesmo JSON, **na íntegra e sem envelope**, para
uma URL que a conta configurou. O CRM continua processando o evento
normalmente; o repetidor é uma saída a mais, em paralelo.

### O que esta SPEC entrega

1. Tabela `meta_webhook_relays`: uma configuração por conta (URL, chave,
   ligado/desligado, contadores).
2. Módulo `src/lib/webhooks/meta-relay.ts`: decide o que a conta recebe e
   entrega.
3. Gancho no `POST /api/whatsapp/webhook`, depois da assinatura da Meta
   validada, dentro do mesmo `after()`.
4. Cartão **"Repetidor do webhook da Meta"** em Configurações → Chaves de
   API, com: ligar/desligar, chave de segurança e teste de conectividade.
5. Documentação do formato para quem consome.

### Não-objetivos

- **Repetir a assinatura da Meta** (`X-Hub-Signature-256`). Não é enviada (D-1).
- **Eventos sem número**: template (`message_template_*`), `account_update`
  e outros de nível de WABA não são repetidos (D-5).
- **Webhook da Evolution Go** (canal QRCode). Só Cloud API (D-11).
- **Gestão pela API pública** (`/api/v1`). O repetidor é configurado só
  pelo painel; nenhum endpoint, escopo ou evento novo em `/api/v1`, e os
  `openapi*.json` não mudam.
- **Mais de uma URL por conta**, filtro por tipo de evento ou por número.
  O consumidor filtra pelo próprio payload (`metadata.phone_number_id`).
- **Fila durável, retry com backoff, ordenação.** Uma tentativa, melhor esforço (D-7).
- **Entregar a mídia.** O payload cru leva só o `id` da mídia; baixar exige
  token da Graph, que o repetidor não fornece.
- **Item de plano / quota.**

---

## Decisões

| #    | Decisão                                                                                                                                                                                                                                               | Estado                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| D-1  | **Isolamento.** A conta recebe **apenas** os webhooks dos números WhatsApp Cloud API **dela**. Nada de outra conta sai junto. **Sem** a assinatura da Meta.                                                                                           | **Ratificada** (mantenedor, 2026-11-23) |
| D-2  | **Controle no painel**, em Configurações → Chaves de API: habilitar/desabilitar, chave de segurança e teste de conectividade.                                                                                                                         | **Ratificada** (mantenedor, 2026-11-23) |
| D-3  | **Armazenamento em tabela própria** (`meta_webhook_relays`, uma linha por conta) em vez de reaproveitar `webhook_endpoints`. Motivo: uma config por conta, gerida pelo painel, sem se misturar com os endpoints da API pública nem mexer no contrato. | **Ratificada** (mantenedor, 2026-11-23) |
| D-4  | **A chave é um segredo HMAC.** Cada entrega leva `X-Wacrm-Signature` (mesmo esquema de `sign.ts`); a chave nunca trafega. Alternativa descartada: chave estática enviada num cabeçalho (mais simples no n8n, porém trafega em toda requisição).       | **Ratificada** (mantenedor, 2026-11-23) |
| D-5  | **Só `changes` com `metadata.phone_number_id`** de um número da conta são repetidos. Evento de WABA (template, conta) fica de fora: não é "de um número" e um WABA pode servir duas contas.                                                           | **Ratificada** (mantenedor, 2026-11-23) |
| D-6  | **Número desativado** (SPEC 064 D-12) e número que não está no CRM não são repetidos.                                                                                                                                                                 | **Ratificada** (mantenedor, 2026-11-23) |
| D-7  | **Semântica de entrega:** 1 tentativa, timeout de 5 s, sem seguir redirect; 15 falhas seguidas desligam o repetidor e a tela mostra quando desligou e após quantas falhas (o motivo da falha não é gravado).                                          | **Ratificada** (mantenedor, 2026-11-23) |
| D-8  | **Quem gerencia:** admin ou acima, como as chaves de API. O cartão não aparece para os demais papéis.                                                                                                                                                 | **Ratificada** (mantenedor, 2026-11-23) |
| D-9  | **Teste de conectividade** envia um payload de exemplo marcado com `X-Wacrm-Test: true`, funciona com o repetidor desligado, não conta como falha e devolve ao navegador só status HTTP e tempo (nunca o corpo da resposta).                          | **Ratificada** (mantenedor, 2026-11-23) |
| D-10 | **Registro de atividade** (SPEC 075): ligar, desligar, trocar URL, gerar chave nova e remover entram no log da conta. É saída de dado pessoal para fora do CRM e merece rastro.                                                                       | **Ratificada** (mantenedor, 2026-11-23) |
| D-11 | **Só Meta.** Evolution fica de fora.                                                                                                                                                                                                                  | **Ratificada** (mantenedor, 2026-11-23) |

---

## 1. Mudanças, arquivo por arquivo

| Arquivo                                                                   | Mudança                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `supabase/migrations/101_meta_webhook_relay.sql` **(novo)**               | Tabela, RLS sem policy, função de falha (§3)                                                                       |
| `src/lib/webhooks/deliver.ts`                                             | Extrai `postSignedPayload` (SSRF + `fetch` + assinatura, devolve resultado); `dispatchWebhookEvent` **inalterado** |
| `src/lib/webhooks/meta-relay.ts` **(novo)**                               | `planMetaRelay` (pura), `relayMetaWebhook`, `buildRelayTestPayload`, `sendRelayTest`                               |
| `src/lib/webhooks/meta-relay-config.ts` **(novo)**                        | Leitura/gravação da config, colunas seguras, serialização para a UI                                                |
| `src/lib/webhooks/meta-relay*.test.ts` **(novos)**                        | Testes do §7.1 e §7.2                                                                                              |
| `src/app/api/whatsapp/webhook/route.ts` + `route.test.ts`                 | `relayMetaWebhook` em paralelo ao `processWebhook` dentro do `after()` (§4)                                        |
| `src/app/api/account/meta-relay/route.ts` **(novo)**                      | `GET`, `PUT`, `DELETE` (§5.1)                                                                                      |
| `src/app/api/account/meta-relay/secret/route.ts` **(novo)**               | `POST` — gera chave nova                                                                                           |
| `src/app/api/account/meta-relay/test/route.ts` **(novo)**                 | `POST` — teste de conectividade                                                                                    |
| `src/lib/rate-limit.ts`                                                   | `RATE_LIMITS.metaRelayTest` (6/min por conta) e `RATE_LIMITS.metaRelayDelivery` (50/s por conta, achado B-2)       |
| `src/components/settings/meta-relay-settings.tsx` **(novo)**              | O cartão (§6)                                                                                                      |
| `src/components/settings/api-keys-settings.tsx`                           | Renderiza o cartão abaixo da lista de chaves, só para admin+                                                       |
| `messages/en.json`, `messages/pt-BR.json`                                 | `Settings.apiKeys.metaRelay.*`                                                                                     |
| `src/lib/activity/` (catálogo) — D-10                                     | Ações do repetidor + `Activity.actions.*` nos dois dicionários                                                     |
| `src/types/index.ts`                                                      | Tipo da linha, se a tabela entrar nos tipos do domínio                                                             |
| `docs/public-api.md`                                                      | Subseção em "Webhooks": formato e verificação do repetidor (prosa, em inglês). **Os `openapi*.json` não mudam**    |
| `docs/context/whatsapp-cloud.md`, `.claude/skills/webhooks-meta/SKILL.md` | Uma linha cada: o repetidor existe e onde fica                                                                     |
| `docs/context/status.md`                                                  | Última migração e próximo número, depois de aplicada                                                               |

---

## 2. Contrato da entrega

### 2.1 Quando dispara

Para cada `POST` da Meta com assinatura válida, se a conta tem o
repetidor **ligado** e o POST traz ao menos um `change` de um número
oficial ativo dela.

### 2.2 Requisição enviada

`POST <url>` com `Content-Type: application/json`.

| Cabeçalho             | Valor                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------- |
| `X-Wacrm-Event`       | `meta.webhook_raw`                                                                    |
| `X-Wacrm-Delivery-Id` | uuid por entrega                                                                      |
| `X-Wacrm-Signature`   | `t=<unix>,v1=<hex>` — HMAC-SHA256 de `"<t>.<corpo>"` com a chave da conta (`sign.ts`) |
| `X-Wacrm-Test`        | `true`, só no teste de conectividade                                                  |

**Não** vai `X-Hub-Signature-256` nem qualquer outro cabeçalho da Meta (D-1).

Corpo:

- **POST inteiro da conta** (caso comum): a string `rawBody` que a rota
  leu do corpo (`readTextWithLimit`, o mesmo texto que `request.text()`
  daria), byte a byte.
- **Corpo reduzido** (`filtered`): sai sempre que algum `change` do POST
  não é repassável à conta, e não só quando há eventos de mais de uma
  conta: número de outra conta, número da própria conta desativado ou fora
  do CRM, `change` sem `metadata` (por exemplo, evento de template no mesmo
  POST), número fora do escopo do App Secret ou `entry` malformada. O
  objeto tem `entry[]` reduzido às entradas que têm `changes` da conta e
  cada `changes[]` reduzido aos `changes` da conta. Chaves de topo e de cada
  `entry` e o conteúdo de cada `change` ficam iguais, e a entrada que fica
  sem `changes` é removida. O JSON é **regravado** com `JSON.stringify`:
  espaços e escapes podem diferir do original da Meta, e a assinatura vale
  sobre o corpo enviado.

O consumidor não precisa distinguir os dois casos para verificar a
assinatura. Em ambos o corpo traz só `changes` de números da conta; o
repetidor confere a assinatura da Meta e o número, e não valida o resto do
conteúdo.

### 2.3 Semântica

Uma tentativa por POST da Meta, timeout de 5 s (`DELIVERY_TIMEOUT_MS`),
`redirect: 'manual'`, só `https` e sem credenciais na URL (recusado antes
do DNS), `isDeliverableUrl` antes do `fetch`. Sem garantia
de ordem. A Meta reenvia quando não recebe `200`, então o mesmo evento
pode chegar mais de uma vez: o consumidor deduplica por `messages[].id`
e por `statuses[].id` + `status`. Sucesso zera `failure_count`; a 15ª
falha seguida desliga o repetidor (`is_enabled = false`,
`auto_disabled_at = now()`).

---

## 3. Migração 101

Procedimento: skill `nova-migracao-supabase`. Mostrar o SQL ao mantenedor
e esperar o OK antes de aplicar no `vn`; depois, `get_advisors` (security).

```sql
CREATE TABLE IF NOT EXISTS meta_webhook_relays (
  account_id       uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  url              text NOT NULL,
  secret           text NOT NULL,              -- AES-256-GCM (encryption.ts)
  is_enabled       boolean NOT NULL DEFAULT false,
  failure_count    integer NOT NULL DEFAULT 0, -- falhas SEGUIDAS
  last_delivery_at timestamptz,                -- última entrega com 2xx
  last_failure_at  timestamptz,
  auto_disabled_at timestamptz,                -- preenchido só pelo desligamento automático
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE meta_webhook_relays ENABLE ROW LEVEL SECURITY;
-- Sem policy, de propósito: só o servidor (service_role) lê e escreve.
REVOKE ALL ON TABLE meta_webhook_relays FROM PUBLIC;
REVOKE ALL ON TABLE meta_webhook_relays FROM anon;
REVOKE ALL ON TABLE meta_webhook_relays FROM authenticated;

CREATE OR REPLACE FUNCTION public.record_meta_relay_failure(
  p_account_id uuid,
  p_max_failures int
) RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE meta_webhook_relays
     SET failure_count    = failure_count + 1,
         last_failure_at  = now(),
         is_enabled       = CASE WHEN failure_count + 1 >= p_max_failures THEN false ELSE is_enabled END,
         auto_disabled_at = CASE WHEN failure_count + 1 >= p_max_failures AND is_enabled THEN now() ELSE auto_disabled_at END
   WHERE account_id = p_account_id;
$$;

REVOKE ALL ON FUNCTION public.record_meta_relay_failure(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_meta_relay_failure(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.record_meta_relay_failure(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_meta_relay_failure(uuid, int) TO service_role;
```

Notas:

- **RLS ligada sem policy** (mesmo desenho de `form_phone_proofs`): a
  coluna `secret` nunca fica ao alcance do navegador. O `get_advisors`
  vai acusar um INFO 0008 a mais, esperado.
- O `REVOKE … FROM authenticated` na tabela é necessário: o privilégio
  padrão do `vn` concede escrita a `authenticated` em tabela nova (lição
  da 097, em `status.md`).
- Função **sem** `SECURITY DEFINER`: só o `service_role` a chama, e ele
  já ignora RLS. O incremento em SQL é atômico (um `count + 1` em
  TypeScript perde incrementos com entregas simultâneas).
- `updated_by … ON DELETE SET NULL`: excluir o usuário não apaga a config.
- Sem URL nem segredo de deploy no arquivo: é migração, não `setup/`.

---

## 4. Isolamento e gancho na rota

### 4.1 Dono de cada `change`

| Forma do `change`                                                                                                    | Resultado                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Tem `value.metadata.phone_number_id` com **uma** linha em `whatsapp_config`, cujo canal existe e não está `disabled` | Pertence à conta dessa linha                            |
| Sem `metadata`, número fora do CRM, mais de uma linha, canal apagado ou `disabled`                                   | **Sem dono**: não é repetido para ninguém (fail-closed) |
| POST validado pelo `app_secret` de um canal, e o número não guarda esse mesmo segredo                                | **Sem dono** (fail-closed)                              |

`phone_number_id` é único global (migração 013). A resolução parte
sempre do número, nunca do WABA.

**Escopo do segredo (revisão de segurança, achado 1).** A rota usa
`resolveMetaWebhookSigner`, que diz qual segredo validou. O
`META_APP_SECRET` (App padrão) vale para todo número. O `app_secret` de
um canal é gravado pelo admin da conta, sem validação na Meta, e por isso
só vale para os números cujo `whatsapp_config` guarda esse mesmo segredo
(`phoneNumberIdsForSigner`). Assim, o admin da conta A não consegue
assinar com o próprio segredo um `change` do número de B e fazer o
repetidor de B entregá-lo. Consequência: num App que não é o padrão,
cada canal que usa o repetidor precisa do próprio `app_secret` gravado.

**O mesmo escopo vale para o ingest** (`processWebhook(body, signer)`,
na mesma rota). Antes, qualquer `app_secret` de canal fazia o ingest
processar qualquer `phone_number_id`: o admin de A injetava
mensagens/status no inbox de B e disparava `message.received` e
automações de B. Regra, por `change` (helper compartilhado
`signerCoversPhoneNumber`):

| `field` / forma                                                              | `META_APP_SECRET` | `app_secret` de canal                                                                                                                 |
| ---------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `messages` (mensagens e `statuses`), `calls`: com `metadata.phone_number_id` | Como antes        | Só se o número guarda o mesmo segredo; senão o `change` é ignorado                                                                    |
| Qualquer `change` não-template **sem** `metadata.phone_number_id`            | Como antes        | Ignorado (fail-closed)                                                                                                                |
| `message_template_*` (nunca trazem número)                                   | Como antes        | Só atualiza templates das contas dos números desse segredo (`accountIdsForSigner` → `.in('account_id', …)`); nenhuma conta = ignorado |

- `change` ignorado não derruba os demais do mesmo POST; a Meta recebe
  `200` (sem reentrega) e o log é um `console.warn` com o
  `phone_number_id`, sem corpo nem segredo.
- `account_update`, `phone_number_*`, `security`, `account_*` e `calls`
  já eram no-op no ingest; a regra só os documenta.
- **Efeito colateral:** num App que não é o padrão, um número **sem** o
  próprio `app_secret` cujo evento era validado pelo segredo de um canal
  irmão (mesmo App) deixa de ser ingerido (antes entrava). Correção:
  gravar o `app_secret` também nesse canal. Conferido no `vn` em
  2026-11-24 (leitura): os 2 números conectados estão em Apps distintos,
  cada um com o próprio `app_secret`; o terceiro está `disabled` e sem
  segredo. Nenhum número ativo é afetado hoje.
- **`statuses` ficam na conta do número** (B-1 da revisão final, tratado
  em 2026-11-25): o escopo acima só prova que quem assinou fala pelo
  número; o `statuses[].id` é texto livre. A conta é resolvida uma vez por
  `change` (`resolveNumberOwner`) e o espelho só toca mensagens e disparos
  dela (§11).

### 4.2 Função pura

```ts
// src/lib/webhooks/meta-relay.ts
export type RelayPlan =
  | { kind: 'raw' } // POST inteiro é da conta: enviar rawBody
  | { kind: 'filtered'; body: Record<string, unknown> };

/** `owners`: phone_number_id → account_id (só números ativos e sem duplicata). */
export function planMetaRelay(
  body: unknown,
  owners: Map<string, string>
): Map<string, RelayPlan>;
```

Sem I/O, sem lançar. Corpo sem `entry[]` ou de forma inesperada devolve
mapa vazio. Conta que não é dona de nenhum `change` não entra no mapa.

### 4.3 Orquestração

```ts
export async function relayMetaWebhook(
  db: SupabaseClient,
  input: { rawBody: string; body: unknown; signer: MetaWebhookSigner }
): Promise<void>;
```

1. Lê `meta_webhook_relays` com `is_enabled = true`
   (`account_id, url, secret`). **Lista vazia: retorna.** É o custo para
   quem não usa: uma consulta por POST.
2. Coleta os `phone_number_id` do corpo que o `signer` cobre (§4.1); lê `whatsapp_config`
   (`account_id, channel_id, phone_number_id`) e o `status` dos canais.
   No máximo duas consultas.
3. `planMetaRelay`.
4. **Conta bloqueada não recebe (achado B-4).** Das contas com repetidor
   ligado **e** plano, uma única consulta a `accounts` (`id, blocked_at`,
   `in(ids)`); só segue quem existe e tem `blocked_at` nulo. **Falha
   fechada:** erro de leitura ⇒ ninguém é repassado, com um
   `console.error` sem corpo/URL/chave. Justificativa: o repasse é
   melhor esforço (R-7), entregar a conta bloqueada é o lado danoso, e
   um banco que não responde aqui dificilmente atenderia o resto do POST
   (o oposto de `loadBlockedAccountIds`, que falha aberta porque tem
   o backstop de envio conta a conta; o repasse não tem backstop).
   Sem plano para ninguém, nem consulta.
5. **Teto por conta (achado B-2).** Cada entrega passa por
   `checkRateLimit('meta-relay:<account_id>', RATE_LIMITS.metaRelayDelivery)`
   (50 por janela fixa de 1 s). O excedente é **descartado sem `fetch`**,
   com um `console.warn` por conta e por janela (só `account_id` e o
   teto) e **não conta como falha**: não mexe em `failure_count` nem
   aciona o auto-desligamento. Conta bloqueada não consome o orçamento.
6. Para cada conta que passou nos dois filtros: `postSignedPayload`
   com os cabeçalhos do §2.2, em `Promise.allSettled`. Sucesso:
   `failure_count = 0`, `last_delivery_at = now()`. Falha:
   `record_meta_relay_failure(account_id, 15)`.
7. Nunca lança. Tabela ausente (código implantado antes da 101): encerra
   em silêncio, com um aviso por processo (molde de
   `notePricingSchemaMissing`, em `billing-signal.ts`).

O repetidor **não recebe** o cabeçalho de assinatura da Meta: a função
não tem esse parâmetro, de propósito.

### 4.4 Gancho

```ts
// POST /api/whatsapp/webhook, no lugar do after() atual
after(async () => {
  await Promise.allSettled([
    processWebhook(body).catch((error) =>
      console.error('Error processing webhook:', error)
    ),
    relayMetaWebhook(supabaseAdmin(), { rawBody, body, signer }),
  ]);
});
```

- Só roda **depois** de `resolveMetaWebhookSigner` validar a assinatura;
  o `signer` devolvido segue para o repetidor (§4.1).
- **Ordem antes da assinatura** (revisão final, M-1, itens 1 a 3), do mais
  barato ao mais caro: cabeçalho fora de `^sha256=[0-9a-f]{64}$` → `401`
  sem ler corpo nem banco; corpo acima de 4 MiB
  (`META_WEBHOOK_MAX_BODY_BYTES`; a Meta documenta até 3 MB) → `413`, pelo
  `content-length` ou contando os bytes do stream; `META_APP_SECRET`; e só
  se ele não validar, a consulta e a decifração dos segredos de canal. O
  `rawBody` continua sendo o mesmo texto que `request.text()` daria.
- Em **paralelo** ao processamento: destino lento não atrasa o ingest, e
  falha de um lado não afeta o outro nem o `200` já devolvido à Meta.
- Dentro do `after()` e do `maxDuration = 60`. Não usar promessa solta
  (issue #301, comentário na rota).
- **Sem guarda de laço:** como a assinatura da Meta não é repassada, um
  repetidor apontado para o próprio `/api/whatsapp/webhook` recebe `401`,
  conta falha e se desliga sozinho em 15 tentativas.

---

## 5. Rotas do painel

Sessão por cookie (`getCurrentAccount` + `requireRole('admin')`), no
molde de `/api/account/api-keys`. Como a tabela não tem policy, as rotas
usam o cliente `admin.ts` **depois** de validar o papel, sempre filtrando
pelo `accountId` da sessão. Erros em inglês.

### 5.1 Endpoints

| Rota                                  | Faz                                                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/account/meta-relay`         | `{ relay: null }` ou `{ relay: { url, is_enabled, failure_count, last_delivery_at, last_failure_at, auto_disabled_at, updated_at } }`. **Nunca** devolve `secret`                  |
| `PUT /api/account/meta-relay`         | Corpo `{ url, is_enabled }`. Cria ou atualiza. Na **criação**, gera a chave e a devolve **uma única vez** (`{ relay, secret }`). Religar zera `failure_count` e `auto_disabled_at` |
| `DELETE /api/account/meta-relay`      | Remove a linha (URL e chave)                                                                                                                                                       |
| `POST /api/account/meta-relay/secret` | Gera chave nova, invalida a anterior, devolve `{ secret }` uma única vez                                                                                                           |
| `POST /api/account/meta-relay/test`   | Teste de conectividade (§5.3)                                                                                                                                                      |

### 5.2 Validação da URL

`normalizeWebhookUrl` (só `https://`) e `isDeliverableUrl` já no `PUT`,
para o erro aparecer na hora de salvar (`400`). A guarda SSRF roda de
novo em cada entrega: o DNS pode mudar depois.

### 5.3 Teste de conectividade

- Usa a URL e a chave **salvas** (não aceita URL no corpo: evita usar o
  servidor para sondar endereços arbitrários). Funciona com o repetidor
  desligado, para testar antes de ligar.
- Envia `buildRelayTestPayload()`: um webhook de mensagem de texto no
  formato da Meta, com ids evidentemente falsos (`phone_number_id: "0"`,
  `wamid.TEST`) e o cabeçalho `X-Wacrm-Test: true`. A forma sai de um
  payload real redigido (§7), não inventada.
- Assinado como uma entrega real, para o consumidor validar a chave.
- Resposta ao navegador: `{ ok, status, duration_ms, error }`, com
  `error` em `timeout | not_public | http_error | network`. **Nunca** o
  corpo nem os cabeçalhos da resposta do destino.
- Não altera `failure_count` nem `last_delivery_at`.
- `RATE_LIMITS.metaRelayTest`, por conta.

---

## 6. UI — cartão em "Chaves de API"

Componente `meta-relay-settings.tsx`, renderizado em
[`api-keys-settings.tsx`](../src/components/settings/api-keys-settings.tsx)
abaixo da lista de chaves, só para admin+. Segue os componentes e o
padrão visual da própria tela.

| Elemento                 | Comportamento                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Título e descrição       | O que o repetidor faz e o aviso: o destino recebe telefone, nome e texto das mensagens dos contatos                              |
| Campo **URL de destino** | `https://`; erro de validação traduzido pela UI                                                                                  |
| Chave **Ativo**          | Liga/desliga. Desabilitada enquanto não houver URL salva                                                                         |
| **Salvar**               | `PUT`. Na primeira gravação abre o diálogo da chave                                                                              |
| Diálogo da chave         | Mostra a chave uma vez, com copiar e o aviso de que não será exibida de novo (mesmo padrão do `CreateKeyDialog`)                 |
| **Gerar nova chave**     | Confirmação ("a chave atual deixa de valer") → `POST …/secret` → diálogo da chave                                                |
| **Testar conexão**       | `POST …/test`; mostra "Conectado (HTTP 200, 123 ms)" ou o motivo da falha. Desabilitado sem URL salva ou com alteração não salva |
| Linha de status          | Última entrega, falhas seguidas                                                                                                  |
| Aviso de desligamento    | Quando `auto_disabled_at` está preenchido e `is_enabled = false`: "Desativado automaticamente após 15 falhas seguidas em <data>" |
| **Remover**              | Confirmação → `DELETE`                                                                                                           |
| Conta sem número oficial | Dica: o repetidor só envia eventos de números WhatsApp Cloud API                                                                 |

i18n: tudo em `Settings.apiKeys.metaRelay.*`, nos dois dicionários;
`npm run i18n:check`. Cuidado com sintaxe ICU em `t.rich()` e com
shadowing de `t` em `.map()` (armadilhas do `AGENTS.md`).

---

## 7. Testes

Fixtures a partir de **payload real** da Meta (redigido: telefone, nome e
ids trocados), nunca de forma inventada. O mantenedor fornece um POST de
mensagem e um de status. Cada teste novo tem de falhar no código anterior
à mudança.

### 7.1 `planMetaRelay` (pura)

1. POST só de números da conta A: A recebe `raw`.
2. `entry[]` com números de A e de B: cada um recebe `filtered` só com os
   seus `changes`; o JSON de A **não contém** o `phone_number_id` nem o
   `wa_id` de B (asserção por busca de substring).
3. Número fora do CRM junto com um de A: A recebe `filtered`; o outro não
   vai para ninguém.
4. Número com canal `disabled`: sem dono.
5. `change` sem `metadata` (evento de template): sem dono, mesmo que o
   `entry.id` seja o WABA da conta.
6. `filtered` preserva chaves de topo e campos desconhecidos do `change`.
7. Corpo sem `entry`, `entry` vazio, `changes` ausente: mapa vazio, sem lançar.

### 7.2 `relayMetaWebhook`, teste e config

1. Nenhum repetidor ligado: nenhuma leitura de `whatsapp_config`, nenhum `fetch`.
2. Plano `raw`: o `body` do `fetch` é **idêntico** (`===`) ao `rawBody`,
   com fixture cujo texto difere de `JSON.stringify(JSON.parse(x))`
   (montar a string por código, não digitar escape unicode no arquivo).
3. Nenhuma entrega leva `X-Hub-Signature-256`; `X-Wacrm-Signature`
   confere com `verifySignatureHeader` sobre o corpo enviado.
4. Repetidor desligado: nada é enviado, mesmo com evento da conta.
5. Destino não público: sem `fetch`, `record_meta_relay_failure` chamada.
6. Não-2xx e timeout: falha registrada; 2xx zera o contador.
7. Erro de banco, tabela ausente ou exceção no `fetch`: resolve sem lançar.
8. `sendRelayTest`: leva `X-Wacrm-Test: true`, não toca nos contadores,
   devolve só `ok/status/duration_ms/error`.
9. `deliver.test.ts` continua passando sem alterar os testes existentes.

### 7.3 Rotas

1. Webhook: assinatura válida chama `relayMetaWebhook` com `rawBody` e
   `body`; `401` e `413` não chamam; falha de um lado não impede o outro.
   Cabeçalho ausente/malformado e corpo acima do teto: nenhuma consulta.
   `META_APP_SECRET` válido: nenhum segredo de canal lido ou decifrado.
2. `/api/account/meta-relay`: papel abaixo de admin recebe `403`; `GET`
   nunca traz `secret`; `PUT` devolve `secret` só na criação; URL `http://`
   ou de rede privada dá `400`; religar zera contadores; conta A não lê
   nem altera a config da conta B.
3. `/secret`: a chave antiga deixa de assinar. `/test`: rate limit, e não
   funciona sem config salva (`404`).

---

## 8. Fases de execução

| Fase | Entrega                                                                              | Modelo sugerido                             |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| F1   | Migração 101 escrita; aplicada no `vn` **só com o OK do mantenedor**; `get_advisors` | Sonnet 5.5 (skill `nova-migracao-supabase`) |
| F2   | `deliver.ts`, `meta-relay.ts`, `meta-relay-config.ts` e testes do §7.1 e §7.2        | Sonnet 5.5                                  |
| F3   | Gancho na rota do webhook + testes                                                   | Sonnet 5.5                                  |
| F4   | Rotas do painel, cartão, i18n, rate limit, atividade (D-10)                          | Sonnet 5.5                                  |
| F5   | `docs/public-api.md` (prosa), domínio, skill, `status.md`                            | Sonnet 5.5                                  |
| F6   | Teste manual do §9 em produção                                                       | Mantenedor                                  |

Uma sessão por fase, com `/code-review high` ao fim de F2, F3 e F4. O §4
(isolamento) e o §5 (rotas com `service_role`) pedem `/security-review`
antes da F6. A 101 precisa estar aplicada antes do código de F3 ir para
produção; se não estiver, o repetidor fica inerte (§4.3, passo 5).

---

## 9. Checklist de teste manual (F6)

Destino: um endpoint `https` que mostre corpo e cabeçalhos (workflow n8n
com nó Webhook, por exemplo).

1. Em Configurações → Chaves de API, salvar a URL: o diálogo mostra a
   chave uma vez. Recarregar a página: a chave não aparece mais.
2. **Testar conexão** com o repetidor desligado: "Conectado"; o destino
   recebe o payload de exemplo com `X-Wacrm-Test: true`.
3. Ligar. Enviar uma mensagem de texto ao número oficial: o destino
   recebe o JSON da Meta, sem `X-Hub-Signature-256`; a mensagem aparece no
   inbox como antes.
4. Recalcular `X-Wacrm-Signature` no destino com a chave: tem de bater.
5. Responder pelo inbox: chegam os status `sent`, `delivered`, `read`.
6. Enviar imagem, áudio e reação: o corpo cru chega com o `id` da mídia.
7. Desligar: os eventos param de chegar; o inbox segue normal.
8. **Gerar nova chave**: a assinatura passa a bater só com a chave nova.
9. Trocar a URL por uma que devolve `500` e ligar: o inbox segue
   recebendo; após 15 falhas a tela mostra o aviso de desligamento
   automático. Religar zera o contador.
10. Conta com dois números oficiais: eventos dos dois chegam, distinguíveis
    por `metadata.phone_number_id`. Desativar um número: os dele param.
11. Com um segundo cliente (outra conta) recebendo mensagens no mesmo
    período: nenhum evento dele chega ao destino da primeira conta.
12. Evento de template (aprovar/rejeitar um template): **não** chega.
13. Usuário com papel abaixo de admin: o cartão não aparece.
14. Log do servidor: nenhuma linha traz corpo, chave ou URL completa.

---

## 10. Validação local (obrigatória — não há CI)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

---

## 11. Segurança e riscos

| #    | Ponto                                                                                                                                                                          | Tratamento                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | **Vazamento entre contas.**                                                                                                                                                    | §4: dono só pelo número, fail-closed; testes 7.1.2 e manual 11                                                                                                                                                                                                                                                                                                                                        |
| R-2  | **SSRF.** A URL vem do usuário e quem requisita é o servidor.                                                                                                                  | `isDeliverableUrl` + `redirect: 'manual'` em toda entrega e no teste; teste não aceita URL no corpo nem devolve resposta. A guarda interpreta IPv6 de verdade (IPv4 embutido em hex, NAT64, 6to4; achado 2 da revisão)                                                                                                                                                                                |
| R-3  | **Chave.**                                                                                                                                                                     | Cifrada em repouso, mostrada uma vez, nunca logada, tabela sem policy; rotação invalida a anterior na hora                                                                                                                                                                                                                                                                                            |
| R-4  | **LGPD.** O payload leva telefone, nome e texto do contato para fora do CRM.                                                                                                   | Só admin+ configura; aviso no cartão; registro de atividade (D-10)                                                                                                                                                                                                                                                                                                                                    |
| R-5  | **Volume.** Um disparo de 10 mil contatos gera dezenas de milhares de POSTs de status, e cada um vira uma entrega até o teto do R-11.                                          | Aceito até 50 entregas/s por conta; o excedente é descartado (R-11). Documentado para o consumidor                                                                                                                                                                                                                                                                                                    |
| R-6  | **Desligamento por falhas.** Com volume alto, 15 falhas seguidas acontecem em segundos.                                                                                        | A tela mostra o motivo e a data; notificação ativa fica fora desta SPEC                                                                                                                                                                                                                                                                                                                               |
| R-7  | **Perda de evento.** Sem fila: destino fora do ar perde o que chegou no intervalo.                                                                                             | Mesmo limite dos webhooks de saída atuais                                                                                                                                                                                                                                                                                                                                                             |
| R-8  | **Custo por POST.** Uma consulta a mais em todo POST da Meta, mesmo sem repetidor ligado.                                                                                      | Tabela pequena. Cache de processo com TTL curto só se medir problema                                                                                                                                                                                                                                                                                                                                  |
| R-9  | **DNS rebinding** no destino.                                                                                                                                                  | Risco residual já documentado no topo de `ssrf.ts`                                                                                                                                                                                                                                                                                                                                                    |
| R-10 | **POST anônimo caro** (M-1 da revisão final): corpo sem limite e banco antes da assinatura.                                                                                    | Itens 1 a 3 corrigidos em 2026-11-24 (§4.4). Residual: cabeçalho bem formado e falso ainda custa uma consulta, as decifrações e N+1 HMACs de até 4 MiB; o cache de segredos e o limite no Traefik (itens 4 e 5) ficam para depois                                                                                                                                                                     |
| R-11 | **Refletor de POST** (B-2 da revisão final): o admin da conta assina com o próprio `app_secret` POSTs ilimitados do próprio número, e cada um sai para a URL que ele escolheu. | **Tratado em 2026-11-25** (§4.3 passo 5): teto de 50 entregas/s por conta, excedente descartado sem falha. Limite do `rate-limit.ts`: em memória, **por processo** (N instâncias ⇒ N× o teto) e janela fixa (rajada na virada pode levar até 2×). Alvo que responde 2xx continua sem desligar, mas agora a vazão é limitada. Eventos descartados não são reenviados (R-7)                             |
| R-12 | **Conta bloqueada** (B-4 da revisão final): a SPEC 062 §4.3 diz que a conta bloqueada para de enviar; a exceção D-9 é só para **guardar** o inbound.                           | **Tratado em 2026-11-25** (§4.3 passo 4): conta bloqueada não recebe repasse, falha fechada. **Limitação aceita:** o admin bloqueado não consegue desligar o repetidor (`requireRole` recusa), então ele fica ligado e inerte até o desbloqueio, sem contar falha. **Fora desta correção:** os webhooks de saída (`dispatchWebhookEvent`) têm o mesmo buraco, pré-existente, a tratar em SPEC própria |

Logs: só `account_id`, status HTTP e duração. Nunca corpo, chave ou URL completa.

**M-2 e B-8 da revisão final: tratados em 2026-11-25.** `postSignedPayload`
(`deliver.ts`, usado pelos webhooks de saída e pelo repetidor) recusa, antes
da resolução DNS e do `fetch`, URL com `protocol !== 'https:'` ou com
`user:senha@`. A falha volta como `not_public` (a UI e o botão de teste
mantêm o contrato `timeout | not_public | http_error | network`, sem chave
i18n nova). B-8: o campo `message` do resultado agora é sempre texto fixo
ou classe do erro mais código de sistema (`ENOTFOUND`...); a mensagem crua do
`fetch`, que traz a URL inteira com senha e query, não é mais copiada nem
logada, e o log de `dispatchWebhookEvent` mostra só `id` do endpoint, classe
do erro e status. Conferido em leitura no `vn` em 2026-11-25: `webhook_endpoints`
tem 0 linhas e `meta_webhook_relays` tem 1, https, então a mudança não derruba
nenhuma entrega existente.
**Fora desta correção** (SPEC própria, com confirmação do mantenedor): fixar o
IP resolvido no socket (DNS rebinding, R-9, e o oráculo de `/test`, B-7);
`CHECK (url LIKE 'https://%')` em `webhook_endpoints` (exige migração; sem
ela, `http://` gravado direto pelo PostgREST apenas falha na entrega e conta
para o desligamento automático); timeout de DNS (B-3).

**B-1 da revisão final: tratado em 2026-11-25.** O espelho de `statuses`
localizava a mensagem só pelo `wamid`: o admin de A, assinando com o próprio
segredo um `change` do próprio número, mudava o status de uma mensagem de B,
marcava o contato de B como inválido (131026) e disparava
`message.status_updated` para B. Agora:

- A conta do número vem da `whatsapp_config`, uma vez por `change`
  (`src/lib/whatsapp/number-owner.ts`, cache de processo de 15 s que o sinal
  de pagamento reaproveita). Número desconhecido, duplicado, de canal
  `disabled` ou com falha de leitura nas duas tentativas (L-2): os `statuses` do `change` são ignorados
  com um `console.warn` (sem corpo) e o resto do POST segue.
- `messages` e `broadcast_recipients` são lidos junto com a conta da conversa
  e do disparo (`src/lib/whatsapp/status-scope.ts`) e só as linhas da conta
  são atualizadas, por `id`. `messages.channel_id` não serve de filtro: é nulo
  nas 3.920 mensagens do `vn` com `message_id` (leitura de 2026-11-25).
- `wamid` que existe só em outra conta: nenhum efeito (espelho, pricing,
  sinal de pagamento, número morto, webhook de saída). `wamid` que não existe
  em conta nenhuma: nada a espelhar, mas o sinal de pagamento do próprio
  número continua (status antes do INSERT, ou envio feito fora do CRM).
- O contato do destinatário também precisa ser da conta: a RLS de
  `broadcast_recipients` só confere o disparo.
- `META_APP_SECRET` sem número no `change`: como antes.

**B-6 da revisão final: tratado em 2026-11-25.** Em `processWebhook`, uma
exceção num `change` derrubava os seguintes do mesmo POST, e a Meta já tinha
recebido `200` (sem reentrega, perda definitiva). Casos reproduzidos:
`decrypt` de token inválido, timestamp ausente/ilegível (`RangeError` no
`toISOString()`), `changes` ausente. Se a Meta juntasse contas num POST, o
token corrompido de A apagaria os eventos de B (o repetidor já era imune).
Agora, em `route.ts`:

- **Isolamento por unidade.** Cada `change`, cada `status` e cada mensagem
  roda dentro de `isolated()`, que nunca lança. O erro vai para um
  `console.error` com `unit` (`change`/`status`/`message`), posição
  (`entry`, `change`, índice), `phone_number_id` truncado em 64, classe do
  erro (e `code`, quando houver) e mensagem truncada em 200, sem valores entre
  aspas (o Postgres cita a entrada rejeitada). Nunca o corpo, o token, o
  segredo nem o telefone do contato. A exceção não chega ao `after()`; o `200` e o repetidor
  não mudam. O log do ingest que rejeita mudou de
  `Error processing webhook:` + objeto para esse JSON curto. Um token ilegível
  derruba só os `changes` daquele canal.
- **Defesa de forma.** `entry` que não é lista: o corpo é ignorado com aviso.
  `entry` nulo ou sem `changes` em lista: pula o entry (aviso). `change` ou
  `value` nulo/não objeto: pula o `change` (aviso). `statuses`, `messages` e
  `contacts` que não são listas: nada a processar. Forma inválida é aviso, não
  erro: é esperada de quem assina.
- **Timestamp ausente, não numérico ou fora do alcance de `Date`
  (decisão):** o item **não é descartado**; usa-se o relógio do servidor, com
  um `console.warn` sem valor. Status: `sent_at`/`delivered_at`/`read_at` do
  disparo levam o instante de recebimento (perder o espelho de entrega por um
  carimbo seria pior). Mensagem: `occurredAt` = agora (antes a `Date` inválida
  chegava ao ingest e lançava depois de contato e conversa existirem, deixando
  conversa vazia). Limite: um evento **atrasado** e sem timestamp ganha o
  instante do recebimento, e aí a âncora da janela de 24 h fica adiante da real
  e alonga a janela (o aviso da SPEC 045 no próprio `route.ts`). Irrelevante
  com a Meta real, que sempre manda o timestamp. Timestamp numérico legível segue como antes; a leitura agora
  é estrita (`parseMetaTimestamp`): `0`, negativo ou texto com sufixo
  (`"1786000000x"`) caem no relógio do servidor, em vez de passar pelo
  `parseInt`.
- **Fora desta correção:** escopo de signer/conta, validação (M-1), o
  repetidor, `deliver.ts`, `ssrf.ts` e o cache de segredos. Limite aceito: o
  isolamento não reprocessa; o que falhou foi perdido, como sempre foi (R-7).
  `handleTemplateWebhookChange` também fica isolado por `change`
  (`accountIdsForSigner`, cujo resultado é memorizado por POST, nunca rejeita).

**A-1 da revisão integrada: tratado em 2026-11-25.** Com o isolamento do B-6,
cada item quebrado virou uma exceção e uma linha de log sem parar o POST. Um
POST assinado de 4 MiB com `"statuses":[null,…]` (830 mil itens) parava o
processo, e portanto todas as contas, por 53 s e escrevia 188 MB de log;
`statuses:[0,…]` fazia 2,5 milhões de consultas em série. Agora cada POST tem
um `WebhookPostGuard` (`src/lib/whatsapp/webhook-post-guard.ts`):

- **Forma antes do banco.** `entry` sem `changes`, `change`/`value` que não é
  objeto, mensagem que não é objeto e `status` sem `id` (string não vazia) são
  pulados antes de qualquer consulta, e até a conta do número só é lida se
  sobrar item bem formado.
- **Abandono.** No 100º item de **forma** inválida o resto do POST é
  descartado; o que veio antes já foi processado. Falha ao processar item bem
  formado (banco fora do ar) **não** conta.
- **Teto de 20.000 itens** por POST (`entry` + `change` + `status` +
  mensagem), com um aviso. A Meta documenta no máximo 1.000 atualizações por
  lote (Graph API Webhooks, página genérica; a do WhatsApp só cita 3 MB): no
  pior caso, 3.000 itens.
- **Log:** no máximo 20 linhas da rota por POST (das quais até 10 de aviso; o
  resto fica para erro, que o ruído do corpo não cala) mais uma de resumo (`POST cut
short` ou `POST processed`), com as contagens. Vale para o que recebe o guard
  (rota, `status-scope`, eventos de template e o aviso sem I/O do sinal de
  pagamento); ingest, mídia e `number-owner` logam por conta própria, sempre
  depois de I/O e limitados pelo teto de itens.
- **Event loop** cedido (`setImmediate`) a cada 100 itens.

Não mudam o `200` imediato, o `rawBody` do repetidor, a ordem de validação
(M-1), o escopo do segredo e da conta (B-1) nem o isolamento (B-6).

**L-1 a L-3 da revisão integrada: tratados em 2026-11-25.**

- **L-1:** falha de leitura não descarta mais o sinal de pagamento (131042 ou
  limpeza): ele só atinge o WABA do próprio número. `wamid` que se sabe ser de
  outra conta continua sem efeito nenhum.
- **L-2:** a leitura de `messages` que falha é repetida uma vez **antes** do
  espelho, e o webhook de saída usa o mesmo resultado (não há mais releitura
  no fim): sem linha no espelho, não sai `message.status_updated`. A leitura
  do dono do número também ganha uma nova tentativa; o negativo segue sem
  cache. O **UPDATE** do espelho que falha também é repetido uma vez e, se
  falhar de novo, o evento não sai (o disparo e o sinal de pagamento seguem).
  Exceção: status que a CHECK de `messages.status` recusa (`23514`, ex.:
  `played`) nunca será gravado; não se repete e o evento sai como sempre saiu.
- **L-3:** timestamp além de agora + 1 dia é ilegível (relógio do servidor,
  com aviso). Em milissegundos, `"1795576195000"` dá o ano 58868, que o
  Postgres recusa (`pg_input_is_valid` = `false` no `vn`). O teto
  fica em `parseMetaTimestamp`, então vale também para o sinal de pagamento:
  131042 ou cobrável com carimbo ilegível é ignorado com aviso (regra da SPEC
  076), porque um ano aceito pelo Postgres (5138) gravaria um
  `last_payment_error_at` que nenhuma mensagem cobrável limparia.

**Riscos conhecidos, fora de escopo (revisão integrada), sem correção aqui:**

- **I-4:** `findStatusMessages` lê sem filtro de conta e sem ordem. Quem
  conhece um `wamid` de outra conta e insere na própria conta mais linhas com
  esse `message_id` do que o limite do PostgREST (padrão 1.000) pode empurrar a
  linha da outra para fora do resultado, e aquele status se perde. Plausível,
  não reproduzido.
- **I-5:** `number-owner.ts` não confere `channel.account_id`, como fazem o
  ingest e o repetidor. Sem efeito entre contas.
- **I-6:** número que troca de conta fica até 15 s na conta antiga (a sessão de
  pagamento, até 30 s); `invalidatePaymentSignalCache` não limpa o cache de
  dono. Aceito.
- **I-7:** pré-existentes: `Error updating message status:` imprime o objeto do
  PostgREST, cujo `details` pode trazer a linha inteira; e
  `detectDeadNumberOnFailure` olha as duas últimas falhas do contato sem
  filtrar a conta do disparo.

---

## 12. Git

Commits e push são do mantenedor. Sugestão de mensagens:

```text
feat(db): tabela meta_webhook_relays e contador de falhas (SPEC 088 F1)
feat(webhooks): repetidor do webhook da Meta por conta (SPEC 088 F2-F3)
feat(settings): repetidor do webhook da Meta em Chaves de API (SPEC 088 F4)
docs: formato do repetidor do webhook da Meta (SPEC 088 F5)
```

---

## Referências

- [`src/app/api/whatsapp/webhook/route.ts`](../src/app/api/whatsapp/webhook/route.ts) — `POST`, `after()`, `processWebhook`
- [`src/lib/webhooks/`](../src/lib/webhooks/) — `deliver.ts`, `sign.ts`, `ssrf.ts`, `endpoints.ts`
- [`src/components/settings/api-keys-settings.tsx`](../src/components/settings/api-keys-settings.tsx), [`src/app/api/account/api-keys/route.ts`](../src/app/api/account/api-keys/route.ts) — molde da tela e das rotas
- [`supabase/migrations/028_webhook_endpoints.sql`](../supabase/migrations/028_webhook_endpoints.sql) — contador atômico de falhas
- [`docs/public-api.md` § Webhooks](./public-api.md#webhooks) — verificação de `X-Wacrm-Signature`
- [`docs/context/whatsapp-cloud.md`](./context/whatsapp-cloud.md), [`docs/context/supabase-rls-mcp.md`](./context/supabase-rls-mcp.md)
- SPEC 064 (números oficiais por conta, D-12), SPEC 075 (registro de atividade)
