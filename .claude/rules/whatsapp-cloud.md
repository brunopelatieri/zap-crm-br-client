---
paths:
  - 'src/lib/whatsapp/**'
  - 'src/app/api/whatsapp/**'
  - 'src/lib/broadcasts/**'
  - 'src/components/broadcasts/**'
  - 'src/lib/meta-errors.ts'
---

# WhatsApp Cloud API, templates e disparos

- Credencial é do **canal**, não da conta: resolva por `resolveCloudConfig` / `resolveChannelContext` (`cloud-channels.ts`); nunca `whatsapp_config` por conta com `.single()` ou `.limit(1)`.
- O canal vem antes do template: toda lista de template filtra pelo WABA do canal que envia (`templates-for-channel.ts`).
- Webhook da Meta valida `x-hub-signature-256` sobre o corpo cru; sem segredo, falha fechado; fica fora do gate de sessão do middleware.
- Janela de 24 h só por `session-window.ts`; fora dela, só template `APPROVED`.
- Token é criptografado (`encryption.ts`): nunca logue nem devolva ao navegador. `access_token`, `app_secret` e `verify_token` não são legíveis pelo JWT (112): só `supabaseAdmin()` os lê, com `account_id` casado.
- Disparo: uma campanha, uma linha (editar rascunho = `UPDATE`; o `draftId` é adotado); o tier da Meta limita contatos **por disparo**.
- Monitor de cobrança (SPEC 076): pós-pago, "valor a pagar" ≠ saldo; moeda é do WABA; falha transitória não muda o estado.
- Erro da Meta: `throwMetaError` mantém `error_user_msg` e `error_subcode`.

Detalhe: leia `docs/context/whatsapp-cloud.md`. Procedimento: skill `webhooks-meta`.
