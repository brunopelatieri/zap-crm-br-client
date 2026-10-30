---
name: evolution-go-qrcode
description: WhatsApp QRCode via Evolution Go, instância que caiu ou desconectou, QR/pair, webhook da Evolution, checagem de número. Use ao mexer em src/lib/evolution ou nos canais não oficiais.
---

# Canal WhatsApp QRCode (Evolution Go)

## Quando usar

Ao mexer no canal não oficial: criar/parear instância, receber ou enviar mensagem, checagem de número e captação, ou quando uma instância cai, desconecta ou o webhook não entrega.

## Como funciona

1. **Onde fica cada peça:**
   - cliente, config, erro: `src/lib/evolution/` (`client.ts`, `config.ts`, `respond.ts`); leitura defensiva do payload em `payload.ts`;
   - instâncias: `instances.ts` e `src/app/api/channels/evolution/instances/**`;
   - webhook de entrada: `src/app/api/channels/evolution/webhook/[secret]/route.ts`; ingestão em `src/lib/channels/ingest.ts`;
   - adaptador: `src/lib/channels/adapters/evolution.ts`; capacidades em `capabilities.ts`;
   - checagem e captação (SPEC 069): `check-*.ts`, `harvest*.ts`; envio frio: `cold-send-limit.ts`; limites: `limits.ts`.
2. **A referência está incompleta — leia só a seção necessária.** `docs/references/EVOLUTION_GO_REFERENCE.md` (⚠️) é incompleta e em parte errada:

   ```bash
   grep -n '^#' docs/references/EVOLUTION_GO_REFERENCE.md   # ache o endpoint
   sed -n '<início>,<fim>p' docs/references/EVOLUTION_GO_REFERENCE.md
   ```

   Antes de confiar nela, leia a SPEC 048 §1 (a sondagem do servidor real contradiz a referência: formato de erro, botões/listas, path de mídia, escopo da chave). Não leia o arquivo inteiro nem o copie para código ou docs.

3. **Webhook.** Não é assinado: valide em cadeia (`secret` do path, `instanceId`, `instanceToken`, tempo constante), `401` sem detalhe, `200` imediato e processamento em `after()`; idempotência por `(conversation_id, message_id)`. O nome do `event` não é o da família assinada (veja `EVENT_KINDS` na rota). Mídia chega em `base64` ou `mediaUrl` (`resolveMediaSource`), nunca pela `URL` cifrada do CDN. A rota fica fora do `matcher` do middleware.
4. **Instância caiu ou desconectou.** Verifique o status da instância (rotas `instances/**`, status), reconecte por QR/pair se preciso e confira se o webhook registrado ainda aponta para o domínio atual (webhooks guardam a URL antiga após mudar de host) antes de suspeitar do código. Sintoma típico não é exceção: é mensagem que some ou áudio que não toca.
5. **Dúvida de contrato:** `node scripts/evolution-probe.mjs` (só leitura; usa URL e chave do ambiente — não abra `.env*`). `--lifecycle` **escreve na VPS**: só com OK do mantenedor.
6. **Teste:** fixture de payload real (sonda ou `EVOLUTION_DEBUG=true`), nunca inventada; confira o teste falhando no código antigo.
7. **Capacidade, não tipo:** pergunte a `capabilities.ts` (botões e listas não renderizam no canal QR).

Detalhe: `docs/context/canais-e-qrcode.md`; SPEC 048, 049, 056 e 069 pelo catálogo (`docs/context/catalogo-specs.md`).

## Exemplos

- "Instância aparece desconectada" → passo 4.
- "Preciso do endpoint de enviar mídia" → passo 2: `grep -n '^#'`, ler só `/send/media`, conferir na SPEC 048 §1.
- "Áudio recebido não toca" → passo 3 (`resolveMediaSource`) e fixture real do passo 6.
