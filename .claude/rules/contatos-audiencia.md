---
paths:
  - 'src/lib/contacts/**'
  - 'src/lib/audience/**'
  - 'src/lib/ingest/**'
  - 'src/lib/phone/**'
  - 'src/lib/spreadsheet/**'
  - 'src/app/api/import/**'
  - 'src/app/api/contacts/**'
  - 'src/components/contacts/**'
  - 'src/components/import/**'
  - 'n8n_automation/**'
---

# Contatos, telefone BR, importação e audiência

- Toda escrita de contato passa por `normalizeContactPhone`: só dígitos com DDI, sem `+` nem máscara; dedup por `phone_normalized` por conta.
- A força da validação BR varia por caminho (SPEC 050 D-5): formulário bloqueia, import pula a linha, API pública só normaliza, webhook inbound **nunca** valida. "Deploy brasileiro" é `NEXT_PUBLIC_APP_LOCALE`, não `useLocale()`.
- Opt-out casa a mensagem **inteira**, nunca por "contém".
- Exportar exige `admin`+ e é auditado em `contact_exports`.
- Etiqueta nova na importação/disparo só para quem passa em `canEditSettings`; reuse `resolveImportTagIds`.
- Planilhas moram em `src/lib/spreadsheet/` (Google Planilhas passa pela guarda SSRF); editar contato é o modal `ContactForm`, nunca `update` direto do telefone.
- n8n: credencial sempre `<REDACTED>` no export versionado.

Detalhe: leia `docs/context/contatos-audiencia.md`. Procedimento: skill `integracao-n8n`.
