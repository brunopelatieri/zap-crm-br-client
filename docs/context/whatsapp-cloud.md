# WhatsApp Cloud API — envio, templates, disparos, cobrança

> Domínio da SPEC 079. Rule: `.claude/rules/whatsapp-cloud.md`. Skill: `webhooks-meta`. Versões, migrações e rotas de cron: [`status.md`](./status.md). Canais, QRCode e transferência: [`canais-e-qrcode.md`](./canais-e-qrcode.md). Mapa geral: [`INDEX.md`](./INDEX.md).

## Onde mexer

- **Envio, chamadas à Graph, erros:** `src/lib/whatsapp/send-message.ts`, `meta-api.ts`, `src/lib/meta-errors.ts`
- **Webhook da Meta (recebe + status):** `src/app/api/whatsapp/webhook/route.ts`, `src/lib/whatsapp/webhook-signature.ts`
- **Templates (validar, montar, enviar):** `src/lib/whatsapp/template-*.ts`, `src/app/api/whatsapp/templates/`
- **Disparos em massa:** `src/lib/whatsapp/broadcast-*.ts`, `src/lib/broadcasts/`, `src/app/api/broadcasts/`
- **Credencial por número oficial:** `src/lib/whatsapp/cloud-channels.ts`
- **Monitor de envio e consumo (SPEC 076):** `src/lib/whatsapp/billing-*.ts`, `src/app/api/whatsapp/billing/`

UI: `src/components/broadcasts/`, `src/components/interactive/`, abas de templates/WhatsApp/cobrança em `src/components/settings/`.

## Regras que não podem quebrar

1. **Credencial é do CANAL, não da conta** ([SPEC 064](../spec-064-multiplos-numeros-oficiais.md) §1). Nunca consulte `whatsapp_config` com `.eq('account_id', …).single()` nem troque por `.limit(1)`: com 2 números isso falha alto no `single` e, no `limit(1)`, **envia pelo número errado em silêncio**. Resolva por `resolveCloudConfig` / `resolveChannelContext` (`cloud-channels.ts`).
2. **O canal vem antes do template** ([SPEC 065](../spec-065-selecao-de-canal-por-recurso.md) §1). Template pertence ao **WABA**: toda lista de template precisa filtrar pelo WABA do canal que vai enviar (`templates-for-channel.ts` + `use-channel-templates`), senão a Meta recusa com `(#132001) Template name does not exist in the translation`.
3. **Escolher canal num recurso reativo é escopo, não rota de saída.** A resposta sai pelo canal da conversa; trocar de canal no meio do diálogo só por `fallback_channel` (automações) ou transferência (SPEC 056).
4. **Webhook da Meta:** valida `x-hub-signature-256` (HMAC-SHA256 do corpo cru com o App Secret). Sem segredo configurado, **falha fechado** (rejeita tudo). O middleware exclui essa rota; não a coloque atrás do gate de sessão. O roteamento é por `phone_number_id` (único global) e já aceita dois números da mesma conta.
5. **Janela de 24 h** vem de `session-window.ts` (minutos; fechamento exclusivo) — não recalcule no componente. Fora dela só template aprovado (`template-approval.ts` guarda `status = 'APPROVED'`).
6. **Token é criptografado** (`encryption.ts`, AES-GCM; CBC só lê legado). Nunca logue nem devolva ao navegador.
7. **Graph:** `META_API_VERSION` em `meta-api.ts` é a versão geral; o monitor usa constante **própria** (`billing-graph.ts`, D-3 da SPEC 076). Não unifique sem validar o payload.
8. **App da Meta também é do canal:** `whatsapp_config.app_id` (092) e `app_secret` (073) ficam nulos no App padrão da instância (`META_APP_ID`, `META_APP_SECRET`) e são preenchidos quando o número está sob outro App. O `app_id` abre o Resumable Upload do cabeçalho de imagem (`ensureImageHeaderHandle`); App ID errado ou de outro App dá `(#100) Unsupported post request` com subcode 33, antes de o template existir.

## Disparos

- Teto absoluto de destinatários: `src/lib/broadcasts/limits.ts` (sem dependência server-only, de propósito: roda no navegador).
- Horário permitido de envio: `send-window.ts` — **bloqueia por padrão**, com override consciente.
- Tier da Meta é o teto de contatos **por disparo** (não saldo diário); regra pura em `messaging-limit.ts`.
- Disparo parcial (SPEC 069, "checar antes de disparar"): máquina de estados pura em `partial-send.ts`. A mesma campanha percorre `awaiting_check → sending → … → sent`; transição errada duplica envio ou trava a campanha.
- **Uma campanha, uma linha** ([SPEC 070](../spec-070-editar-disparo-em-rascunho.md) §1.3): editar rascunho é `UPDATE` da linha aberta; ao disparar/agendar o `draftId` é **adotado** (`broadcast-dispatch.ts`), nunca gera `INSERT` novo deixando rascunho órfão. A rota é `/broadcasts/[id]/edit`, assistente compartilhado.
- Teste A/B: sorteio exato, opt-out **antes** do sorteio, exatamente dois braços — [`teste-ab-disparos.md`](../teste-ab-disparos.md), SPEC 044 §6.6.
- O `channel_id` é resolvido e gravado **na criação** (SPEC 064 D-3); mudar o padrão da conta não reescreve campanha existente.

## Monitor de envio e consumo (SPEC 076)

Somente leitura, por canal oficial ([SPEC 076](../spec-076-monitor-cobranca-whatsapp-cloud-api.md) §4.1):

- Cobrança é **pós-paga**: "Saldo atual" da Meta é o **valor a pagar**, não crédito. Nunca rotule consumo como "saldo". Não existe API pública para ler/pagar esse valor.
- Pagamento pendente vem do erro **`131042`**, independente do `health_status` (estado `payment_blocked`).
- A **moeda é do WABA** (pode mudar): formate pela `currency` retornada, nunca assuma R$. Custo ausente = "indisponível", nunca zero. Consumo é **estimativa**.
- `deriveSendState` (§6.2): falha transitória (5xx, timeout, 429) **não muda o estado** — mantém o último retrato com `stale`.
- Feature flag `platform_settings.whatsapp_billing_monitor_enabled`; o valor é por ambiente — consulte o banco.

## Armadilhas

- `Unexpected token '<'` ao criar template = HTML de gateway lido como JSON; o front valida `content-type`.
- Botão `COPY_CODE`: `example` é **string** e o texto é sempre `Copy offer code` (o backend força).
- O erro da Meta só é diagnosticável se `throwMetaError` incluir `error_user_msg` e `error_subcode`; não simplifique para `error.message`.
- Rotas que chamam a Meta em cadeia declaram `maxDuration = 60`.
- Mensagem `button`/`contacts` recebida vira `[Unsupported message type]` se o `parseMessageContent` do webhook não a reconhece. Histórico: `docs/issues_resolved/2026-07-*`.

## Mais

[`catalogo-specs.md`](./catalogo-specs.md).
