# Registro de atividade, painel/métricas e retenção de mensagens

> Domínio da SPEC 079. Rule: `.claude/rules/atividade-painel-retencao.md`. Migração atual e rotas de cron: [`status.md`](./status.md). Apagar mensagem enviada (SPEC 074) fica em [`inbox-atribuicao.md`](./inbox-atribuicao.md). Mapa: [`INDEX.md`](./INDEX.md).

## Onde mexer

- **Gravar um evento de atividade:** `src/lib/activity/record.ts` (`recordActivity`)
- **Ler / filtrar / apresentar:** `src/lib/activity/query.ts`, `feed.ts`; página `/activity`, `src/components/activity/`
- **Retenção do registro de atividade:** `src/lib/activity/retention.ts`
- **Painel (métricas, gráficos):** `src/lib/dashboard/queries.ts`, `src/components/dashboard/`
- **Retenção de mensagens (política, varredura):** `src/lib/retention/` (`policy`, `defaults`, `global-defaults`, `sweep`), `src/components/retention/`
- **Varredura agendada:** `src/app/api/messages/retention/cron/route.ts` (agendamento em [`status.md`](./status.md))
- **Retenção no console do proprietário:** `src/app/(platform)/admin/retention/`, `src/lib/platform/retention-defaults.ts`

## Registro de atividade (SPEC 075)

1. **Dois escritores, uma tabela, um dono por tipo de evento** ([SPEC 075](../spec-075-registro-de-atividade-da-conta.md) §1.3). Trigger `SECURITY DEFINER` cobre o que o navegador escreve direto (contato, negócio, etiqueta, funil — sabe o de→para); `recordActivity()` cobre o que só a rota/motor sabe (canal, desfecho, campanha). **Rota que esquecer de chamar `recordActivity` não registra.** A trigger tem guarda para não duplicar o que a rota já gravou.
2. **O INSERT passa sempre por `supabaseAdmin()` dentro de `recordActivity`**: a tabela é append-only por RLS **e** por grant (INSERT/UPDATE/DELETE revogados de `anon` e `authenticated`). Usar o client de sessão gravaria nada, em silêncio. A função **nunca lança**.
3. **Quem vê o quê (LGPD):** `admin`/`owner` veem tudo da conta e abrem `/activity` (`canViewAccountActivity`); `agent` vê só o que ele mesmo fez (`actor_user_id = auth.uid()`), no widget do painel; `viewer` não vê; o contato como ator mostra telefone mascarado. Não amplie o corte do agente — vira painel de vigilância entre colegas.
4. **Não é o `platform_audit_log`.** Aquela é a trilha do console do proprietário ([`planos-quotas-admin.md`](./planos-quotas-admin.md)); outro público, outro dono. A exclusão da conta leva o registro junto (`ON DELETE CASCADE`).
5. **Retenção própria e global, só por idade**: `ACTIVITY_LOG_RETENTION_DAYS` — ausente = **desligada** (nada roda); `0` = ligada mas nunca apaga; `>0` = apaga o que passou de N dias. `.env` torto vira "desligada" com aviso, nunca um erro que derrube o cron.

## Painel

`src/lib/dashboard/queries.ts` agrega no cliente sobre dados que a RLS já escopou; os RPCs de métrica são `SECURITY DEFINER` **escopados por conta**. O widget "Atividade recente" lê do registro (`queryActivity`), não de um `ORDER BY … LIMIT 10` avulso. Um módulo novo que leia `conversations` precisa respeitar a atribuição por linha ([`inbox-atribuicao.md`](./inbox-atribuicao.md)).

## Retenção de mensagens (SPEC 060)

Princípio: **apagar é a única operação sem desfazer** ([SPEC 060](../spec-060-retencao-e-limpeza-de-mensagens.md) §1).

1. **Nasce desligada.** Sem `MESSAGE_RETENTION_ENABLED=true` no servidor a varredura não roda (um `git pull` num fork nunca pode começar a apagar histórico). Variáveis (`_MIN_AGE_HOURS`, `_INTERVAL_HOURS`, `_BATCH_LIMIT`, `_WHATSAPP_CLOUD_*`, `_WHATSAPP_QR_*`): README § "Retenção de mensagens".
2. **Piso de idade** `MESSAGE_RETENTION_MIN_AGE_HOURS` (padrão 72 h) **prevalece sobre qualquer política**. Protege: reentrega do provedor reinserindo a mensagem (zumbi com data nova), âncora de fluxo esperando resposta (`flow_runs.last_prompt_message_id`), atribuição de resposta a campanha (`hydrate-reply.ts`) e contexto da IA.
3. **Precedência por dimensão:** linha da política → padrão global (console, depois `.env`) → **sem limite**. `NULL` = usa o padrão daquela dimensão; **`0` = sem limite explícito**; `>0` = limite. Toda ausência de configuração resulta em **não apagar nada**.
4. **Política é por conta × tipo de canal** (Cloud × QRCode), não por canal individual. Favoritar (`messages.is_favorite`) poupa a mensagem; a fase de favoritas roda **depois** das outras, e essa ordem cria a carência.
5. **Prévia antes do estrago** (`p_dry_run`): o painel mostra "isto apagaria N" sem apagar. `conversations` nunca é apagada por esta limpeza.
6. **O banco executa o conjunto** (`purge_channel_messages`, `SECURITY DEFINER`); o TypeScript decide os números (`policy.ts`, testado). Não troque por laço em Node.
7. **Onde se edita:** o padrão global (`/admin/retention`) e as políticas por conta (`/api/platform/accounts/[accountId]/retention`) ficam no **console do proprietário** (SPEC 062 §7.5); a antiga aba de Configurações foi movida, não copiada. Chave `Settings.retention.*` órfã = cópia em vez de mover.
8. **O mesmo cron varre o registro de atividade** (`activityLog` no resultado); duas varreduras ao mesmo tempo = claim `running_since` não conferido.

## Armadilhas

- Mensagem apagada **reaparece**: piso baixo + reentrega do provedor.
- Política salva e nada some: interruptor ausente, ou `0` (sem limite — correto).

## Mais

[`../spec-060-retencao-e-limpeza-de-mensagens.md`](../spec-060-retencao-e-limpeza-de-mensagens.md) · [`../spec-060-teste-manual.md`](../spec-060-teste-manual.md) · [`../spec-075-registro-de-atividade-da-conta.md`](../spec-075-registro-de-atividade-da-conta.md) · [`catalogo-specs.md`](./catalogo-specs.md).
