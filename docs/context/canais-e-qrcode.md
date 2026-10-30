# Canais, WhatsApp QRCode (Evolution Go) e transferência entre canais

> Domínio sob demanda (SPEC 079). Rule: `.claude/rules/canais-e-qrcode.md`. Skill: `evolution-go-qrcode`. Envio pela Cloud API, templates e N números oficiais (SPEC 064/065): [`whatsapp-cloud`](./whatsapp-cloud.md).

## Camada de canais (`src/lib/channels/`)

- `registry.ts` é o `switch` por tipo de canal (PRD 047 §6.3): motores e inbox pedem o adaptador ao registro e trabalham contra a interface. Ainda existem comparações `channel.type === …` fora dele (envio, badges e listas do inbox) — não as multiplique: código novo pergunta ao registro ou à capacidade.
- Adaptadores: `src/lib/channels/adapters/whatsapp-cloud.ts` e `adapters/evolution.ts`.
- O que cada canal suporta (ex.: `sessionWindow24h`): `capabilities.ts` + `types.ts` — pergunte à capacidade, não ao tipo.
- Transferir/continuar a conversa por outro canal (resgate fora da janela de 24h): `transfer.ts` — [SPEC 056](../spec-056-transferencia-entre-canais.md) e o checklist [`spec-056-teste-manual.md`](../spec-056-teste-manual.md).
- Teto de **envio frio** no canal não-oficial (mensagem a quem não está conversando — o que derruba número): `cold-send-limit.ts`, `cold-send-wiring.ts`.
- Inbox multicanal e motores cientes de canal: [SPEC 049](../spec-049-inbox-multicanal-e-motores.md).

## Evolution Go (`src/lib/evolution/`)

- Cliente, config, erro: `client.ts`, `config.ts`, `respond.ts`; leitura defensiva do payload: `payload.ts`.
- Instâncias: `instances.ts`; rotas `src/app/api/channels/evolution/instances/**` (qr, pair, status, …).
- Webhook de entrada: `src/app/api/channels/evolution/webhook/[secret]/route.ts`.
- Checagem de número, avatar, captação: `check-*.ts`, `avatar.ts`, `harvest*.ts`; `src/app/api/evolution/harvested/**`.
- UI: `src/components/channels/` + aba QRCode em `src/components/settings/`.

Documentos: [PRD 047](../prd-047-canais-e-whatsapp-qrcode.md) (camada de canais), [SPEC 048](../spec-048-canal-whatsapp-qrcode.md) (fundação, adaptador, plano de teste), [PRD 068](../prd-068-enriquecimento-e-validacao-por-instancia-qrcode.md) + [SPEC 069](../spec-069-checagem-captacao-e-cascata-de-limites.md) (checagem, captação e cascata única de limites instância → conta → `.env` → código; checklist [`spec-069-teste-manual.md`](../spec-069-teste-manual.md)).

## A referência está incompleta — o servidor decide

[`docs/references/EVOLUTION_GO_REFERENCE.md`](../references/EVOLUTION_GO_REFERENCE.md) ⚠️ é **incompleta e em parte errada**. Regras:

1. **Leia só a seção do endpoint que vai usar** (`grep -n '^#'` no arquivo e `sed -n` no trecho). Não leia inteiro, não copie para cá nem para código.
2. Antes de confiar nela, leia a [SPEC 048 §1](../spec-048-canal-whatsapp-qrcode.md#1-o-que-a-sondagem-do-servidor-real-mudou): a sondagem do servidor real contradiz a referência em contagem de endpoints, existência de botões/listas, formato de erro (string plana, 404 em `text/plain`), nome do path de download de mídia e escopo da chave global.
3. Botões e listas: o endpoint existe, mas **não renderizam** no canal QR (veredito na SPEC 048 §1.1-bis). Use a capacidade do canal, não a existência do endpoint.
4. Dúvida sobre um contrato → `node scripts/evolution-probe.mjs` (só leitura; lê URL e chave do ambiente — não abra `.env*`). `--lifecycle` **escreve na VPS** (cria e apaga instância): só com OK do mantenedor. A evidência gerada fica fora do versionamento.
5. Fixture de teste vem de **payload real** (sonda ou `EVOLUTION_DEBUG=true`, que loga a estrutura sem base64 nem segredo) — fixture inventada só repete a suposição de quem escreveu. Confira o teste falhando no código antigo antes de dar a correção por boa.

Apoio (mesma cautela): [`evolution-go-multitenant-chat-integration.md`](../references/evolution-go-multitenant-chat-integration.md), [`evolution_go_crm_spec.md`](../references/evolution_go_crm_spec.md).

## Webhook da Evolution — o que já custou caro

- O webhook **não é assinado** pela Evolution. Verificação em cadeia (topo da rota): `secret` do path, `instanceId` e `instanceToken` do payload, os segredos em tempo constante — qualquer falha é `401` sem detalhe.
- Responde `200` na hora e processa em `after()`: a Evolution reentrega por desenho, então a idempotência por `(conversation_id, message_id)` em `src/lib/channels/ingest.ts` é caminho quente.
- O nome do `event` **não** é o da família assinada (ex.: assinar `SEND_MESSAGE` entrega `SendMessage`; `READ_RECEIPT` entrega `Receipt`). Ver `EVENT_KINDS` na rota.
- Mídia: a `URL` do proto aponta para o CDN do WhatsApp com conteúdo **cifrado**; o que serve é o `base64` ou um `mediaUrl` de MinIO/S3 (`resolveMediaSource`).
- O payload mistura JSON de struct Go (`Info`, `ID`) com protojson (`audioMessage`) — leitura indiferente à caixa, via `payload.ts`.
- A rota fica **fora do `matcher`** de `src/middleware.ts` (assim como o webhook da Meta): o middleware clona o corpo com teto de 10 MB, e mídia em base64 estoura isso em silêncio. Webhook novo entra na exclusão do `matcher`.
- Sintoma típico aqui não é exceção: é mensagem que some ou áudio que não toca.

## Limites e VPS

- Limite de instâncias por conta: quota do plano (`channels_whatsapp_qr`) com fallback em `EVOLUTION_MAX_INSTANCES_PER_ACCOUNT`; `EVOLUTION_MAX_INSTANCES_TOTAL` protege a VPS inteira (`limits.ts`). Quotas e planos: [`planos-quotas-admin`](./planos-quotas-admin.md).
- Configuração exigida na VPS da Evolution: SPEC 048 §9. Deploy do app: [`deploy-docker`](./deploy-docker.md).
