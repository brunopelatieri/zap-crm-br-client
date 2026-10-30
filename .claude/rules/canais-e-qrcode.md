---
paths:
  - 'src/lib/channels/**'
  - 'src/lib/evolution/**'
  - 'src/app/api/channels/**'
  - 'src/app/api/evolution/**'
  - 'src/components/channels/**'
  - 'scripts/evolution-probe.mjs'
---

# Canais e WhatsApp QRCode (Evolution Go)

- Pergunte ao registro (`registry.ts`) ou à capacidade (`capabilities.ts`), não `channel.type === …`; não multiplique as comparações que já existem.
- `docs/references/EVOLUTION_GO_REFERENCE.md` é incompleta e em parte errada: leia só a seção do endpoint (`grep -n '^#'`) e a SPEC 048 §1 antes de confiar. Botões e listas não renderizam no canal QR.
- O webhook da Evolution não é assinado: valide em cadeia (`secret` do path, `instanceId`, `instanceToken`), `401` sem detalhe, `200` na hora e processamento em `after()`.
- Idempotência por `(conversation_id, message_id)` em `ingest.ts`; webhook novo entra na exclusão do `matcher` de `src/middleware.ts` (corpo base64 estoura o teto de 10 MB).
- Fixture de teste vem de payload real (sonda ou `EVOLUTION_DEBUG=true`), nunca inventada.
- `scripts/evolution-probe.mjs` só lê; `--lifecycle` escreve na VPS: só com OK do mantenedor. Não abra `.env*`.
- Envio frio no canal QR tem teto (`cold-send-limit.ts`); limite de instâncias vem da cascata (`limits.ts`).

Detalhe: leia `docs/context/canais-e-qrcode.md`. Procedimento: skill `evolution-go-qrcode`.
