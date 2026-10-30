# Prompt para nova sessão — SPEC 062 F1 (migração 069)

> Copie e cole tudo abaixo numa sessão nova do Claude Code, aberta na raiz do
> repositório `zap-crm-br-client`. Este arquivo é só o "correio" — pode apagá-lo
> depois de colar o conteúdo.

---

Leia primeiro **`AGENTS.md`** (raiz do repo) — convenções obrigatórias do
projeto — e depois **`docs/spec-062-console-do-proprietario.md`** inteira.
Essa SPEC já está com status "pronta para implementação": todas as decisões
do PRD 061 (D-1 a D-14) foram ratificadas pelo mantenedor em 2026-08-26. Você
vai implementar só a **F1** dela — a migração de schema — nada de rota, nada
de UI ainda.

## O que é a F1

Da tabela de fases da SPEC 062 (§10):

> **F1** — Migração 069: bloqueio, `is_account_member` reescrita, ciclo e
> cobrança externa em `account_plans` (§3.3, §3.7), desconto, `platform_settings`
> (inclusive `retention_defaults`), `platform_audit_log`, **drop das policies de
> retenção** (§3.8), asserções.
> **Pronto quando:** suíte verde; asserções passam; app se comporta exatamente
> como antes (nada bloqueado, nenhum vencimento inventado, nenhuma política de
> retenção perdida).

Arquivo a criar: `supabase/migrations/069_platform_console.sql`.

**Confira antes de nomear**: rode `ls supabase/migrations/` — se já existir
alguma 069 ou 070 que eu não sei (outra sessão pode ter avançado), pare e
pergunte ao mantenedor antes de prosseguir. No momento em que este prompt foi
escrito, a última migração era `068_message_retention.sql`.

## As seções da SPEC 062 que compõem esta migração — leia todas, na ordem

1. **§3.1** — colunas de bloqueio (`blocked_at`, `blocked_reason`, `blocked_by`)
   em `accounts` e `profiles`, com os dois índices parciais.
2. **§3.2** — `is_account_member()` reescrita (o `CREATE OR REPLACE` com o
   `JOIN accounts` e as duas condições `blocked_at IS NULL`). **Ponto mais
   sensível de toda a migração**: essa função está dentro de praticamente toda
   policy RLS do repositório. Leia com atenção o aviso de que ela precisa
   continuar `STABLE` e que o `ALTER FUNCTION … OWNER TO postgres` tem que ser
   repetido depois do `CREATE OR REPLACE` (a SPEC explica o porquê nas
   armadilhas, §11).
3. **§3.3** — colunas de ciclo em `account_plans` (`billing_cycle`,
   `started_at`, `cancel_at_period_end`, `canceled_at`, `grace_until`) + índice.
   Backfill: `current_period_end` **permanece NULL** para toda conta existente
   — não invente vencimento.
4. **§3.4** — desconto anual em `plans` (`yearly_discount_percent`) e as novas
   colunas de `platform_settings` (`default_yearly_discount_percent` default
   17, `support_email`, `grace_days` default 7, `self_service_enabled` default
   TRUE).
5. **§3.5** — tabela `platform_audit_log`, RLS ligada, **zero policies**.
6. **§3.7** — cobrança externa: `billing_source`, `external_billing_ref`,
   `last_payment_ref`, `last_payment_at` em `account_plans`, com o índice único
   parcial de `last_payment_ref` (é o que garante a idempotência da futura rota
   de renovação — não é usado nesta fase, só precisa existir).
7. **§3.8** — a virada de dono da retenção: **derrubar** as quatro policies de
   `channel_retention_policies` e a de `message_retention_state` (os
   `DROP POLICY IF EXISTS` estão escritos na própria SPEC — copie exatamente),
   e adicionar `platform_settings.retention_defaults JSONB NOT NULL DEFAULT
   '{}'::jsonb`. **Não apague nenhuma linha de dado** — só a RLS muda.
8. **§3.9** — o bloco de asserções finais. Implemente **cada item da lista**
   como um `DO $$ … RAISE EXCEPTION … $$` (siga o padrão das migrações 041,
   052, 067 e 068 — leia uma delas antes de escrever, para o estilo de erro
   ficar consistente com a casa). Preste atenção especial a estas três, que são
   as mais fáceis de esquecer:
   - contagem de linhas de `channel_retention_policies` **antes e depois** da
     migração precisa ser idêntica (a virada de dono não pode apagar política
     de ninguém);
   - `purge_channel_messages` continua **sem** `EXECUTE` para `anon`/
     `authenticated` (não pode ter afrouxado o `REVOKE` da 068);
   - nenhuma conta sai com `current_period_end` preenchido.

## Convenções obrigatórias (de `AGENTS.md`, não repita erro de quem pula isso)

- Migração **idempotente**: `IF NOT EXISTS` em toda `ADD COLUMN`/`CREATE TABLE`/
  `CREATE INDEX`; `DROP … CREATE` para toda policy, trigger e função.
- **Não aplique a migração em nenhum projeto Supabase.** Existem três projetos
  (`vn`, `rs`, `jh`) e a regra do `AGENTS.md` exige confirmação do mantenedor
  antes de aplicar em qualquer um deles. Sua entrega é o **arquivo `.sql`
  revisável**, nada além disso — nem `apply_migration` via MCP, nem `execute_sql`.
- Depois de escrever o arquivo, rode a validação padrão do repositório:

  ```bash
  npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
  ```

  Nesta fase (só SQL, nenhum TypeScript novo) o esperado é que tudo passe
  **sem nenhuma mudança de comportamento** — é justamente o critério de pronto
  da F1 ("app se comporta exatamente como antes").
- **Git**: commits e push são manuais do mantenedor. Não rode `git commit` nem
  `git push` — ao terminar, apenas informe que o arquivo está pronto para
  revisão e deixe o comando de commit pronto para ele copiar, se ele pedir.

## O que NÃO fazer nesta sessão

- Não escreva rotas de API, componentes React, nem `src/lib/platform/**` —
  isso é F2 em diante. Esta sessão entrega **só** a migração 069.
- Não toque em `src/lib/retention/**` nem em `src/components/retention/**` —
  a mudança de dono da retenção nesta fase é **só o schema** (derrubar as
  policies); o `sweep.ts` lendo o padrão global novo é trabalho da F7 (§5.3 da
  SPEC 062), não desta.
- Não invente preço, plano ou dado comercial novo — o catálogo já existe em
  `supabase/setup/plans-seed.sql` e não muda nesta fase.

## Contexto de origem (para você entender o "porquê", não para agir sobre isso)

Este trabalho vem de um PRD (`docs/prd-061-console-do-proprietario-e-ciclo-de-plano.md`)
e duas SPECs irmãs: `docs/spec-062-console-do-proprietario.md` (esta) e
`docs/spec-063-notificacoes-do-sistema-smtp.md` (SMTP + eventos, migração 070,
**fora do escopo desta sessão**). Todas as 14 decisões de produto do PRD já
foram ratificadas pelo mantenedor — você não precisa perguntar nada sobre
regra de negócio, só implementar o que está escrito. Se encontrar uma
ambiguidade real entre o texto da SPEC e o schema atual do banco (por exemplo,
um nome de coluna que já existe com outro tipo), pare e pergunte antes de
adivinhar.

Ao terminar, resuma o que foi criado, aponte qualquer desvio que você teve que
fazer em relação ao texto literal da SPEC (e por quê), e pare — não avance
para F2 sem o mantenedor pedir explicitamente.
