# Automações no-code e rotas de cron

> Domínio sob demanda (SPEC 079). A lista das rotas de cron, quais estão agendadas e como recontar fica **só** em [`status.md` → Rotas de cron](./status.md#rotas-de-cron). Rule: `.claude/rules/automacoes-cron.md`.

## Onde fica

| Peça                     | Caminho                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Motor                    | `src/lib/automations/engine.ts` (+ `engine.*.test.ts`)                                                                          |
| Validação do builder     | `src/lib/automations/validate.ts`                                                                                               |
| Gatilho por horário      | `src/lib/automations/schedule.ts`, `schedule-scan.ts` — [SPEC 046](../spec-046-agendamento-visual.md)                           |
| Janela de 24h            | `src/lib/automations/window-*.ts` — [SPEC 045](../spec-045-reengajamento-janela-24h.md)                                         |
| Service role do motor    | `src/lib/automations/admin-client.ts` (reexporta `src/lib/supabase/admin.ts` — ver [`supabase-rls-mcp`](./supabase-rls-mcp.md)) |
| UI                       | `src/components/automations/`                                                                                                   |
| Rotas de cron            | `src/app/api/**/cron/route.ts`                                                                                                  |
| Agendamento (não-código) | `supabase/setup/cron-jobs.sql`                                                                                                  |

## Contrato de toda rota de cron

- Header `x-cron-secret` comparado com `AUTOMATION_CRON_SECRET`. Rota nova compara em tempo constante (`timingSafeEqual` com checagem de tamanho antes, como `flows/cron`) — nem todas as antigas fazem isso; confira com `grep -L timingSafeEqual` nas rotas.
- **Sem a variável no servidor → `503` (`cron not configured`) de propósito**: não existe cron "meio configurado". Segredo errado → `401`.
- Mensagens de erro em inglês (é `/api/**`, ver [`i18n`](./i18n.md)).
- Rota nova de cron repete esse contrato **e** entra em `status.md` e em `cron-jobs.sql` (bloco agendado ou comentado). Prefira pendurar a varredura nova como **fase** de `/api/automations/cron` (o comentário do topo da rota explica: rota nova exige ação manual de todo operador já em produção).

## O que roda pela `/api/automations/cron`

Uma rota, várias fases (lista e SPEC de cada uma no comentário do topo de `src/app/api/automations/cron/route.ts`): retomar passos `wait` vencidos, varrer janelas de 24h (SPEC 045), gatilho `time_based` (SPEC 046), retenção de mensagens (SPEC 060), ciclo de plano (SPEC 062), reentrega da outbox de notificações (SPEC 063), varredura dos formulários (SPEC 085) e **retomada da indexação da base de conhecimento da IA** (SPEC 089 F2: `pending` e `indexing` parado há mais de 10 min, 5 por ciclo, 3 tentativas; `src/lib/ai/ingest/indexer.ts`) e **retenção dos dados de IA** (SPEC 089 P-5 e F8, fase 9, `src/lib/ai/tuning/retention.ts`: rascunhos de IA 2 dias, candidatos a exemplo 60, rejeitados 30, rodadas de avaliação 180, desligável por `AI_TUNING_RETENTION=off`; e a auditoria `ai_tool_calls` com mais de 90 dias, até 1.000 linhas por passada, pela RPC `purge_ai_tool_calls` da migração 110, independente da variável). As rotas `messages/retention` e `plans/lifecycle` são portas **opcionais** para horário próprio — o trabalho já acontece aqui.

Já `contacts/check` e `contacts/harvest` (SPEC 069) **não** têm porta padrão: sem o job delas a fila de checagem só cresce e a captação nunca roda (o `harvest` ainda confere a própria janela de madrugada no código — ver o cabeçalho do bloco em `cron-jobs.sql` sobre fuso).

## Falha silenciosa

Sem agendador, **nada quebra visivelmente**: o recurso simplesmente nunca acontece (disparo fica "Agendado", automação trava no `wait`, reengajamento e `time_based` nunca disparam). Diagnóstico, nesta ordem:

1. `AUTOMATION_CRON_SECRET` existe no host? `curl -i https://<app>/api/broadcasts/cron` **sem** o header: `503` = falta a variável, `401` = está configurada. Não envie o segredo nem o leia de `.env*`: com ele a rota executa o trabalho de verdade (dispara campanhas vencidas) — teste com segredo é do mantenedor.
2. No projeto Supabase **confirmado** (invariante 1, [`supabase-rls-mcp`](./supabase-rls-mcp.md)): `pg_cron` está instalado e há linhas em `cron.job`? Histórico em `cron.job_run_details`. Não suponha — confira antes de suspeitar de bug de código.
3. Só então investigue o motor.

## `supabase/setup/cron-jobs.sql`

- Usa Supabase Cron (`pg_cron` + `pg_net`) e guarda URL do app e segredo no **Vault** — nunca legíveis em `cron.job.command`.
- **Não é migração** (invariante 10): carrega a URL e o segredo do deploy; como migração, todo fork agendaria chamadas para o seu domínio. O operador edita as duas linhas, roda no SQL Editor e **não commita** os valores.
- Idempotente (`cron.schedule` com nome existente sobrescreve); traz consultas de conferência e o `cron.unschedule` para desfazer.
- Alternativas (serviço externo, `crontab` do VPS) e a tabela de respostas: [`README.md` § Agendador cron](../../README.md#agendador-cron).

## Armadilha conhecida

| Sintoma                             | Causa provável                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Agendamento "não dispara", sem erro | Cron não configurado, ou `AUTOMATION_CRON_SECRET` ausente (rota devolve 503) |
