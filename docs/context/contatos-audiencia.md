# Contatos, telefone BR, importação/exportação, audiência e ingestão

> Domínio da SPEC 079. Rule: `.claude/rules/contatos-audiencia.md`. Skill: `integracao-n8n`. Números mutáveis: [`status.md`](./status.md). Mapa geral: [`INDEX.md`](./INDEX.md). Disparos que consomem a audiência: [`whatsapp-cloud.md`](./whatsapp-cloud.md).

## Onde mexer

- **Normalizar/validar telefone:** `src/lib/phone/br.ts` (`normalizeContactPhone`, `formatPhoneForDisplay`), `src/lib/whatsapp/phone-utils.ts`
- **Duplicidade, opt-out, consentimento:** `src/lib/contacts/{dedupe,opt-out,consent}*.ts`
- **Importar CSV / XLSX / Google Planilhas:** `src/lib/spreadsheet/`, `src/lib/contacts/parse-contact-csv.ts`, `src/app/api/import/google-sheets/`
- **Exportar contatos (CSV/XLSX):** `src/lib/contacts/export-*.ts`, `src/app/api/contacts/export/`
- **Audiência de disparo, triagem, estimativa:** `src/lib/audience/` (`normalize`, `resolve`, `stage`, `triage`, `estimate`)
- **Checagem de número / captação (QRCode):** `src/app/api/contacts/check-queue/`, `check/cron`, `harvest/cron` (SPEC 069)
- **Ingestão por webhook de entrada:** `src/lib/ingest/`, `src/app/api/v1/ingest/contact/route.ts`
- **Editar contato pelo modal:** `src/components/contacts/contact-form.tsx`, `contact-detail-view.tsx` (SPEC 071)

UI: `src/components/{contacts,import}/`, `src/components/broadcasts/audience/`; hook `use-spreadsheet-parser`.

## Telefone — o contrato

- **Formato gravado:** só dígitos, com DDI, sem `+` nem máscara (`5519992496598`). É o que a coluna gerada `contacts.phone_normalized` calcula e o que Meta e Evolution esperam. Máscara é só apresentação (`formatPhoneForDisplay`).
- **Dedup autoritativo** = `phone_normalized` único por conta; colisão `23505` é corrida, não falha. `phonesMatch` (últimos 8 dígitos) serve só a avisos de "possível duplicata".
- **A força da validação BR (DDD, 9º dígito) varia por caminho** — decisão D-5 da [SPEC 050](../spec-050-padronizacao-telefone-br.md): formulário manual **bloqueia**; importação de contatos pula a linha e reporta; audiência de disparo usa o mesmo normalizador (SPEC 052 D-2); API pública `/api/v1` só normaliza (validação de DDD **desligada** de propósito); webhook Meta/QRCode **nunca** valida — recusar inbound perderia a mensagem do cliente.
- **Quem decide "deploy brasileiro"** é `NEXT_PUBLIC_APP_LOCALE`, **não** o cookie `NEXT_LOCALE` (D-1): validação é integridade de dado, tem que ser uniforme por instalação. Não use `useLocale()` para isso.
- Celular legado de 8 dígitos é **aceito** (D-6); número estrangeiro passa no caminho genérico (D-2).
- Referências: [`phone-number-format-standard.md`](./phone-number-format-standard.md) (mapeamento histórico dos pontos de entrada — revalide arquivo:linha antes de agir) e [`../references/mobile_number_brasil_guide.md`](../references/mobile_number_brasil_guide.md) (Anatel, DDDs).

## Regras que não podem quebrar

1. **Toda escrita de contato passa pelo normalizador** do telefone; nunca grave `phone` com máscara ou `+`.
2. **Opt-out casa a mensagem INTEIRA** normalizada, nunca por "contém" (`opt-out.ts`): "não vou parar de comprar" não pode descadastrar. Falso negativo o agente corrige à mão; falso positivo perde cliente em silêncio. Quem grava o estado é a função de banco `set_contact_opt_in`.
3. **Exportar exige papel `admin`+** (`requireRole('admin')` na rota) e é auditada na tabela `contact_exports`; a rota devolve o arquivo no servidor ([SPEC 051](../spec-051-exportacao-de-contatos.md)). Etiquetas e canais saem em colunas posicionais (`etiqueta_1`…).
4. **Criar etiqueta na importação/disparo** só para quem passa em `canEditSettings` (de `src/lib/auth/roles.ts`); os demais ignoram com aviso. Reuse `resolveImportTagIds` — não crie resolvedor de etiqueta novo ([SPEC 057](../spec-057-audiencia-persistente-e-rastreabilidade.md) D-1).
5. **O disparo materializa a audiência importada em `contacts` no envio** (`resolveAudienceContacts` → `upsertImportedContacts`); ele não cria `conversations` nem `messages`, só `broadcast_recipients`. A conversa nasce quando o cliente responde (SPEC 057 §0).
6. **Formatos de planilha moram em `src/lib/spreadsheet/`**, não em `audience/` ([SPEC 052](../spec-052-importacao-de-contatos-multiformato.md) D-1). Google Planilhas passa pela guarda SSRF de `google-sheets.ts`.
7. **Editar contato = modal `ContactForm`**, nunca `update` direto do telefone no detalhe (gravava sem a validação BR; [SPEC 071](../spec-071-editar-contato-pelo-modal-no-detalhe.md)). Permissão: `useCan('send-messages')`.
8. **Webhook de entrada** (`POST /api/v1/ingest/contact`, chave de API) segue o contrato da [SPEC 055](../spec-055-webhook-de-entrada-de-contatos.md) §5; o funil de disparo é por `webhook_id`. Escopos e chaves: [`api-publica-webhooks.md`](./api-publica-webhooks.md).
9. **Tier da Meta limita contatos por disparo**, não por dia ([SPEC 044](../spec-044-audiencia-multiformato-e-triagem.md) §4.2.1); a regra pura está em `src/lib/whatsapp/messaging-limit.ts`.

## n8n

`n8n_automation/` versiona o workflow de ingestão (webhook → upsert no Supabase via REST). O export tem a chave de serviço **redigida** (`supabase_anon_service_role` = `<REDACTED>`); o valor real vive só no node `CONFIG` do n8n. Ao reimportar, repreencha; **nunca** versione a chave. Contrato e dedup em [`../../n8n_automation/README.md`](../../n8n_automation/README.md).

## Armadilhas

- Mesmo número formatado diferente por dois caminhos = um deles não usa `normalizeContactPhone`.

## Mais

[`catalogo-specs.md`](./catalogo-specs.md) lista as SPECs 044 e 050–057.
