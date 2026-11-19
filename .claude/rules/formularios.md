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
- Resposta sempre vinculada a um contato; nada é gravado antes da identidade. `answers` é instantâneo imutável e o JSONB **não guarda a ordem**: a ordem vem dos blocos.
- Arquivo do visitante: bucket privado, URL assinada curta com `download`, caminho conferido contra a pasta da resposta. Exportar é `admin`+, auditado em `contact_exports` e com `neutralizeFormula` em toda célula; apagar exige o nome do formulário.
- Quota no banco (trigger), mês em `America/Sao_Paulo` no SQL e no TS. 097/098 só vão ao `vn` com confirmação do mantenedor (fase F5).
- Cron: fase `forms` em `/api/automations/cron` (`sweep.ts`): `abandoned` após 24 h, objetos órfãos ou de abandonadas > 7 dias; `completed` nunca perde arquivo.
- i18n: `Forms` e `PublicForm` nos dois dicionários; `i18n:check` e placeholders ICU idênticos.

Detalhe: leia `docs/context/formularios.md`.
