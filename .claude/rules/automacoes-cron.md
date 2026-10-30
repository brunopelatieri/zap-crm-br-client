---
paths:
  - 'src/lib/automations/**'
  - 'src/components/automations/**'
  - 'src/app/api/**/cron/route.ts'
  - 'supabase/setup/cron-jobs.sql'
---

# Automações no-code e rotas de cron

- Toda rota de cron exige `x-cron-secret` = `AUTOMATION_CRON_SECRET`: variável ausente → `503` de propósito, segredo errado → `401`; rota nova compara em tempo constante.
- Rota de cron nova repete esse contrato **e** entra em `docs/context/status.md` e em `supabase/setup/cron-jobs.sql`; prefira uma fase nova de `/api/automations/cron`.
- Sem agendador nada quebra visivelmente: o recurso só não acontece. Diagnostique em ordem: `503` × `401` sem o header → `cron.job` no projeto Supabase confirmado → só então o motor. Não envie o segredo nem leia `.env*`.
- `cron-jobs.sql` não é migração (URL e segredo do deploy ficam no Vault); o operador edita e não commita os valores.
- O motor usa service role (`admin-client.ts`): filtre sempre por `account_id`.
- Janela de 24 h em `window-*.ts`; gatilho por horário em `schedule*.ts`; erros de `/api/**` em inglês.

Detalhe: leia `docs/context/automacoes-cron.md`.
