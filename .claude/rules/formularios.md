---
paths:
  - 'src/lib/forms/**'
  - 'src/components/forms/**'
  - 'src/app/api/forms/**'
  - 'src/app/(public)/f/**'
---

# Formulários de captação

- O servidor é o dono de identidade, pontuação, faixa, quota e projeção pública; o visitante só devolve valores. `PublicFormPayload` é fechado e tem teste de contrato (sem `account_id`, pontos, faixa, ids de funil/etiqueta/atribuição).
- Rota da conta: `requireRole` e **depois** `requireFormsFeature` (403 `FEATURE_NOT_IN_PLAN`). Mensagens em inglês com código estável; a UI traduz. Página pública: mesma página neutra (HTTP 200) para qualquer indisponibilidade.
- `service_role` só em `public-service.ts`, `plan-gate.ts` e nas rotas da conta depois do papel `admin` confirmado (trilha de exportação, remoção de objetos). `src/components/forms/**` e `src/app/(public)/f/**` nunca importam `admin-client`.
- Resposta sempre vinculada a um contato; nada é gravado antes da identidade. Com `require_phone_proof` (F7) o telefone digitado nunca cria nem altera contato: só a prova inbound confirmada pelo WhatsApp (`phone-proof.ts`, gancho em `ingestInbound`, uso único); sem canal WhatsApp a página é a neutra. Migração `100` (`form_phone_proofs`): RLS sem policy, só `service_role`. `answers` é instantâneo imutável e o JSONB **não guarda a ordem**: a ordem vem dos blocos.
- Arquivo do visitante: bucket privado, URL assinada curta com `download`, caminho conferido contra a pasta da resposta. Exportar é `admin`+, auditado em `contact_exports` e com `neutralizeFormula` em toda célula; apagar exige o nome do formulário.
- Quota no banco (trigger), mês em `America/Sao_Paulo` no SQL e no TS. 097/098 aplicadas no `vn` (F5); schema novo é migração nova com confirmação. Piloto: `forms_enabled` **junto** com as 3 quotas em `limit_overrides` (chave ausente = ilimitado), só com confirmação.
- A página pública só assina mídia `account-<conta do formulário>/…` (o admin grava `theme`/`media` direto pela RLS); upload tem teto por IP e por conta (`formUploadAccount`).
- Cron: fase `forms` em `/api/automations/cron` (`sweep.ts`): `abandoned` após 24 h, objetos órfãos ou de abandonadas > 7 dias; `completed` nunca perde arquivo.
- i18n: `Forms` e `PublicForm` nos dois dicionários; `i18n:check` e placeholders ICU idênticos.

Detalhe: leia `docs/context/formularios.md`.
