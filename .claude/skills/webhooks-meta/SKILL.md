---
name: webhooks-meta
description: Webhook da Meta (WhatsApp Cloud API), assinatura X-Hub, status de entrega sent/delivered/read/failed, erro 131042 e eventos de template. Use ao mexer em /api/whatsapp/webhook.
---

# Webhook da Meta (WhatsApp Cloud API)

## Quando usar

Ao alterar `src/app/api/whatsapp/webhook/route.ts`, a verificação de assinatura, o tratamento de status de entrega, os eventos de template ou ao diagnosticar mensagem que "não chega" da Meta.

## Como funciona

1. **Onde fica:** `route.ts` (GET de verificação com `hub.mode` / `hub.verify_token`; POST), `src/lib/whatsapp/webhook-signature.ts` (`resolveMetaWebhookSigner`, `resolveWebhookChannelSecrets`), `webhook-body.ts` (teto do corpo), `template-webhook.ts` e, para cobrança, `billing-signal.ts`.
2. **Assinatura.** `x-hub-signature-256` é o HMAC-SHA256 do **corpo cru** com o App Secret. Valem `META_APP_SECRET` mais o `app_secret` de cada canal (um segundo App da Meta assina com outro segredo — sem ele a Meta entrega e o app responde `401`). Sem nenhum segredo, **falha fechado**: rejeita tudo. Nunca troque por "aceitar com aviso". **Ordem (POST anônimo tem de ser barato):** cabeçalho fora de `^sha256=[0-9a-f]{64}$` (hex maiúsculo inclusive) → `401` sem ler corpo nem banco; corpo acima de 4 MiB (`META_WEBHOOK_MAX_BODY_BYTES`; a Meta manda até 3 MB) → `413`, pelo `content-length` ou contando o stream; `META_APP_SECRET`; só se ele não validar, os segredos de canal são lidos e decifrados. O texto lido é igual ao de `request.text()`: BOM e UTF-8 inválido continuam dando `401`. **Escopo:** `resolveMetaWebhookSigner` devolve quem validou; `META_APP_SECRET` cobre todo número, o `app_secret` de um canal só os números que guardam esse mesmo segredo. `processWebhook(body, signer)` ignora (`console.warn`, `200`) o `change` fora do escopo ou sem número, e restringe eventos de template às contas desses números. Num App que não é o padrão, cada número precisa do próprio `app_secret` gravado.
3. **Ack rápido.** O POST responde `200` e processa em `after()`; ack lento faz a Meta reentregar e duplicar inserts. A rota declara `maxDuration = 60`.
4. **Roteamento** por `phone_number_id` (único global), resolvendo o canal; dois números da mesma conta são suportados — não volte a consultar `whatsapp_config` por conta.
5. **Fora do gate de sessão.** A rota está excluída do `matcher` de `src/middleware.ts`; webhook novo entra na mesma exclusão (o middleware clona o corpo com teto de 10 MB).
6. **Status de entrega.** `handleStatusUpdate` espelha em `messages` (por `message_id`, que **não é único** — migração 009) e em `broadcast_recipients` (`whatsapp_message_id`). `isValidStatusTransition` impede regressão (um `failed` tardio não sobrescreve `delivered`/`read`). Em `failed` o texto é `(#code) title: message`.
7. **`131042`** (pagamento pendente) liga o estado `payment_blocked` do monitor de cobrança, independente do `health_status` (SPEC 076 §10.3). A regra de que falha transitória (5xx, timeout, 429) não muda o estado é de `deriveSendState` (§6.2), não do handler do webhook.
8. **Eventos de template** (`message_template_*`) seguem para `handleTemplateWebhookChange`; assinar os três campos no painel da Meta é passo manual, sem API.
9. **Tipo de mensagem desconhecido** vira `[Unsupported message type]` se `parseMessageContent` não o reconhece — comece por aí quando botão ou contato "some".
10. **Teste:** `src/app/api/whatsapp/webhook/route.test.ts`; assine o corpo no próprio teste. Não use nem peça segredos reais.

11. **Repetidor (SPEC 088).** O mesmo POST, depois da assinatura validada, também alimenta `relayMetaWebhook` (`src/lib/webhooks/meta-relay.ts`) em paralelo ao `processWebhook`, no mesmo `after()`; ele nunca recebe `X-Hub-Signature-256` nem lança. Mexeu na assinatura, no `rawBody` ou no `after()`? Rode `meta-relay*.test.ts` e `route.test.ts`. Config no cartão de Chaves de API.

Detalhe: `docs/context/whatsapp-cloud.md`; contexto do monitor em `docs/spec-076-monitor-cobranca-whatsapp-cloud-api.md` §2.4 e §10.

## Exemplos

- "Status `read` não aparece no disparo" → passo 6: comece por `isValidStatusTransition` e por `broadcast_recipients.whatsapp_message_id`; lembre que `message_id` não é único em `messages`.
- "Segundo número recebe 401 no webhook" → passo 2: o `app_secret` do canal não está em `resolveWebhookChannelSecrets`.
- "Número de outro App responde 200 mas a mensagem não entra" (log `change ignored — phone_number_id outside the scope`) → passo 2: o canal não tem o próprio `app_secret`; o POST foi validado pelo segredo de um canal irmão, que não fala por ele.
- "Criar rota de webhook nova" → passos 3 e 5.
