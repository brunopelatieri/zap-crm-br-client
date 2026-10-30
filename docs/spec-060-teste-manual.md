# SPEC 060 — Teste manual (F8)

> **Executado em:** 2026-08-26, por Sonnet 5, contra o projeto `vn`.
> **Método:** dados sintéticos, isolados numa conta de teste descartável — nunca
> contra dado real de cliente. Ver "Como foi executado" abaixo antes de repetir.
> **Resultado:** 12 dos 14 itens verificados diretamente contra o banco real
> (função `purge_channel_messages` + RLS com JWT simulado). 2 itens (1 e 2) já
> cobertos por teste automatizado (`src/lib/retention/defaults.test.ts`) e não
> repetidos aqui. O item 11 tem sua metade de banco confirmada; a metade de UI
> (o aviso realmente aparecendo na tela) segue **não verificada** — nenhuma
> sessão com login estava disponível para abrir o navegador.

---

## Como foi executado

Rodar isto de novo, com segurança, **exige** todo este cuidado — pular uma
etapa é o que transformaria um teste em um incidente:

1. **Nunca ligar `MESSAGE_RETENTION_ENABLED` num ambiente com contas reais** e
   rodar o cron de verdade. A varredura (`sweep.ts`) enumera **todos** os
   pares conta×canal do banco — ligá-la aponta a arma para toda conta viva,
   não só a de teste.
2. Em vez disso, cada cenário chamou `purge_channel_messages(...)`
   **diretamente por SQL**, sempre com `p_account_id` apontando para uma
   conta sintética criada só para o teste — nunca o cron, nunca a rota HTTP.
3. As contas de teste (`SPEC-060 F8 test A/B/AGENT`) foram criadas via
   **Supabase Auth Admin API** (`auth.admin.createUser`), não por `INSERT`
   direto em `auth.users` — é o único jeito suportado de criar um usuário
   sem passar pelo fluxo de cadastro real, e o `handle_new_user` faz o resto
   (conta + perfil + plano) exatamente como um cadastro de verdade faria.
4. Ao final, as três contas foram apagadas (`DELETE FROM accounts` — cascata
   cuida de canais/conversas/mensagens/política) e os três usuários via
   `auth.admin.deleteUser`. Conferido depois: zero linha de sobra em
   `accounts`, `auth.users`, `messages` ou `channel_retention_policies`.

Nenhuma conta real foi lida, contada ou tocada em nenhum momento.

---

## Os 14 itens (§14 da SPEC)

| # | Item | Método | Resultado |
| - | ---- | ------ | --------- |
| 1 | Interruptor ausente → nada é apagado | Unit test (`defaults.test.ts`) — `enabled` nasce `false` sem `MESSAGE_RETENTION_ENABLED`; confirmado que `.env.local` não define a variável | ✅ (automatizado, não repetido aqui) |
| 2 | `.env` com valor inválido → sem limite + warn, cron não quebra | Unit test (`defaults.test.ts`) — valor não numérico vira `null` com `console.warn`, nunca lança | ✅ (automatizado, não repetido aqui) |
| 3 | `retention_days = 0` → **nada** é apagado (o teste mais importante) | SQL real: 13 mensagens, `p_retention_days := 0` | ✅ `by_age: 0, by_count: 0, favorites_demoted: 0` — `messages_total` continuou 13 |
| 4 | Política só em `max_messages`, `retention_days` `NULL` → dias vêm do `.env` | Unit test (`policy.test.ts`, `resolveEffectivePolicy`) — a função SQL só recebe os números já resolvidos, então este é um teste de TypeScript, não de SQL | ✅ (automatizado, não repetido aqui) |
| 5 | Conta A com política, conta B sem → B usa o padrão; nenhuma mensagem de A conta no escopo de B | SQL real: conta B com 3 mensagens, chamada com os três limites `NULL` (padrão global ausente = sem limite) | ✅ `messages_total: 3` (nada apagado); tally final confirmou contagens de A e B inalteradas uma pela outra em todas as 9 chamadas anteriores |
| 6 | QRCode e Cloud na mesma conta, limites diferentes → cada um respeita o seu | SQL real: conta A com canal cloud (4 msgs) e QR (3 msgs); purgado só o QR com `retention_days := 5` | ✅ QR caiu de 3→1 (`by_age: 2`); Cloud continuou em 4, intocado |
| 7 | Favorita mais antiga que `retention_days` → **sobrevive** | SQL real: mensagem de 100 dias, `is_favorite := true`, `retention_days := 30` | ✅ sobreviveu (`is_favorite = true` no resultado pós-purga); as 4 não-favoritas antigas foram apagadas |
| 8 | Favoritas acima do teto → as mais antigas perdem a estrela; **nenhuma é apagada nesse ciclo**; são apagadas no seguinte | SQL real: 4 favoritas, `max_favorites := 2` | ✅ `favorites_demoted: 2`, `messages_total` inalterado (rebaixadas, não apagadas); rodando de novo com `retention_days := 30` no ciclo seguinte, as 2 rebaixadas (agora não-favoritas e com 100 dias) foram apagadas (`by_age: 2`) |
| 9 | Piso de idade → mensagem de 1h atrás sobrevive mesmo com o teto estourado | SQL real: `max_messages := 1` sobre 5 mensagens não-favoritas, 2 delas com ~1h de idade | ✅ `by_count: 3` — só as 3 mensagens mais velhas que o piso (72h) foram apagadas; as 2 recentes sobreviveram apesar de estourarem o teto de 1 |
| 10 | Reação e resposta: apagar a mensagem citada → resposta sobrevive sem a citação; reação some junto | SQL real: mensagem com 1 reação + 1 resposta apontando pra ela, apagada via idade | ✅ a resposta sobreviveu com `reply_to_message_id = NULL`; a reação foi para 0 linhas (cascata `ON DELETE CASCADE`) |
| 11 | Conversa esvaziada → continua na lista, com o aviso neutro na thread | SQL real (só a metade de banco): última mensagem da conversa QR apagada | ✅ metade de banco: a conversa sobreviveu (`status = 'open'`, `last_message_at` preenchido, `0` mensagens restantes) — é exatamente a condição que `message-thread.tsx` usa para mostrar o aviso. ⚠️ metade de UI **não verificada** — sem sessão logada para abrir o navegador |
| 12 | Prévia → o número previsto bate com o que a execução real apaga em seguida | SQL real: `p_dry_run := true` previu `by_age: 4`; `p_dry_run := false` logo depois apagou exatamente `by_age: 4` | ✅ previsão e execução bateram |
| 13 | `truncated` → com `batch_limit` baixo, dois (na prática, três) ciclos terminam o serviço | SQL real: 5 mensagens elegíveis, `p_batch_limit := 2` | ✅ ciclo 1: `by_age: 2, truncated: true`; ciclo 2: `by_age: 2, truncated: true`; ciclo 3: `by_age: 1, truncated: false` — terminou sozinho, sinalizando corretamente enquanto durou |
| 14 | ~~Permissão → agente/admin não veem a política; owner de outra conta recebe `0` linhas via SQL (RLS)~~ **OBSOLETO desde a SPEC 062 §3.8** (migração `069_platform_console.sql`) | O resultado original desta execução (owner da própria conta: `1` linha; owner de outra conta: `0`; agente da mesma conta: `0`) segue registrado como história, mas descreve um mundo que não existe mais: a 069 derrubou as cinco policies de `channel_retention_policies`/`message_retention_state`, e **nenhum** dono de conta — nem o da própria conta — enxerga a política pela sessão dele. As rotas `/api/account/retention*` foram apagadas junto com a aba de Configurações. | ➡️ **Substituído** pelos itens 13, 14 e 15 do teste manual da SPEC 062 §12, reproduzidos abaixo — roteiro executável em [`docs/spec-062-teste-manual.md`](./spec-062-teste-manual.md) (F10 daquela SPEC) |

---

## Item 14 → itens 13–15 da SPEC 062 (a retenção mudou de dono)

A [SPEC 062](./spec-062-console-do-proprietario.md) §3.8 tirou a configuração de
retenção do dono da conta e a deu ao **proprietário da plataforma**. Nenhuma
linha de política foi apagada na virada — só deixaram de ser visíveis e
editáveis pela sessão do cliente. O que este documento chamava de item 14 vira,
lá, três verificações (§12, itens 13–15):

13. **O dono da conta perdeu o acesso:** a aba não aparece em Configurações,
    `/settings?tab=retention` cai no Overview, as rotas antigas
    (`/api/account/retention*`) respondem `404` — porque **não existem mais**,
    não porque recusam — e um `SELECT` em `channel_retention_policies` com a
    sessão dele devolve `0` linhas, **mesmo sendo `account_role = 'owner'`**.
14. **Nada se perdeu:** uma conta que já tinha política configurada antes da 069
    continua com os mesmos três valores, conferido por `service_role` (não pela
    sessão do cliente — ela não vê mais nada, por design). A varredura seguinte
    apaga exatamente o que apagaria antes.
15. **O elo novo funciona:** com o `.env` definindo `retentionDays` e o console
    (`/admin/retention`) definindo só `maxMessages` para o mesmo canal, a
    varredura respeita **os dois** — e a prévia do console bate com o que a
    execução real apaga em seguida (é o item 12 desta tabela, agora pelo
    console).

## O que ficou de fora

- **Rotas HTTP e UI** (`GET/PUT /api/account/retention`, `POST .../preview`,
  `GET /api/messages/retention/cron`, o painel de Configurações, o aviso na
  thread) — precisam de uma sessão logada no navegador, que não estava
  disponível nesta execução. O que foi testado é a camada que mais importa
  (a função SQL que decide o que apagar) — as rotas são principalmente
  tradução de HTTP para essa função, já cobertas por `typecheck`/`build`.
- **Claim de sobreposição** (`message_retention_state.running_since`,
  vencimento de 30 min) — não testado neste ciclo; é lógica de
  `sweep.ts` (TypeScript), não da função SQL, e não tem teste unitário
  dedicado além de `schedule.test.ts` (`isClaimStale`, puro).
