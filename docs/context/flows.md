# Flows — editor visual e motor de execução

> Domínio da SPEC 079. Rule: `.claude/rules/flows.md`. Rotas de cron e migração atual: [`status.md`](./status.md). Automações (outro motor): [`automacoes-cron.md`](./automacoes-cron.md). Mapa geral: [`INDEX.md`](./INDEX.md).

## Onde mexer

- **Motor (entrada única do inbound):** `src/lib/flows/engine.ts` — `dispatchInboundToFlows`
- **Política de resposta fora das opções:** `src/lib/flows/fallback.ts` (`resolveFallbackPolicy`)
- **Validação ao ativar (cliente **e** servidor):** `src/lib/flows/validate.ts`
- **Envio (texto, mídia, botões, lista):** `src/lib/flows/meta-send.ts` → `src/lib/channels/send.ts` (adaptador do canal)
- **Menu numerado em canal sem botão:** `src/lib/flows/degraded-menu.ts`
- **Grafo/layout/arestas:** `edges.ts`, `layout.ts`, `types.ts` (mesma pasta)
- **Editor:** `src/components/flows/` (`flow-builder` = lista, `flow-canvas` = grafo)
- **Formulário por tipo de nó:** `src/components/flows/forms/` — arquitetura em [`../references/flows-forms-lib-architecture.md`](../references/flows-forms-lib-architecture.md)
- **API / varredura de execuções abandonadas:** `src/app/api/flows/`, `src/app/api/flows/cron/route.ts`

## Como o motor funciona (em uma frase)

O runner percorre o cliente por um grafo de nós gravado no banco e **só suspende em nó que precisa de resposta** (`send_buttons`, `send_list`); cada toque ou texto o acorda. É chamado pelo pipeline de ingestão (`src/lib/channels/ingest.ts`), não pelo webhook da Meta diretamente — flows vencem a IA, e o retorno diz se as automações também disparam. Existe a chave de plano `flows_enabled` (`src/lib/plans/types.ts`); não há gate dela no código de flows — confirme antes de assumir que o plano bloqueia.

## Regras que não podem quebrar

1. **Salvar rascunho pode ser incompleto; ativar não.** `validate.ts` roda na ativação, no navegador (feedback ao vivo) **e** no servidor (POST/PUT direto não passa). Os limites da Meta (título de botão ≤ 20, ≤ 3 botões, ≤ 10 linhas de lista, título de linha ≤ 24) espelham os checks de `meta-api.ts`: mude os dois juntos.
2. **Escopo de canal** ([SPEC 065](../spec-065-selecao-de-canal-por-recurso.md) D-6): `flows.channel_id` NULL = vale para todos os canais; preenchido = só para aquele número. Fluxo é 100% reativo, então canal aqui é **escopo**, não "enviar por": a resposta sai sempre pelo canal da conversa. Se dois fluxos casam a mesma palavra-chave, **o escopado vence o genérico**.
3. **Uma execução ativa por conversa**, não por contato (D-7): índice único parcial `idx_one_active_run_per_conversation` sobre `flow_runs` com `status = 'active'`. Dois fluxos escopados a dois números rodam em paralelo para o mesmo cliente.
4. **Canal que some desativa o fluxo** (D-8): a trigger `deactivate_flow_on_channel_loss_trg` (migração de seleção de canal) passa `flows.status` para `draft`; nunca "volta a valer para todos".
5. **Menu degradado é um PAR** (saída numerada + casador da resposta digitada) no mesmo módulo, lendo a mesma ordem de opções ([SPEC 049](../spec-049-inbox-multicanal-e-motores.md) §5.2). Traduzir só a saída faz o bot repetir o menu até estourar `reprompt_count`, sem erro nenhum. Nunca separe os dois.
6. **O cron de flows não é opcional.** Sem ele, quem abandona o fluxo mantém a linha no índice único e **bloqueia novos gatilhos naquela conversa** para sempre. A rota usa `AUTOMATION_CRON_SECRET`, responde `503` sem ela, ignora contas bloqueadas (`loadBlockedAccountIds`) e encerra por `fallback_policy.on_timeout_hours` (padrão 24 h) — detalhes de agendamento em [`automacoes-cron.md`](./automacoes-cron.md) e [`status.md`](./status.md).
7. **Cliente de banco do motor é service role** (`admin-client.ts` reexporta `src/lib/supabase/admin.ts`): ignora RLS, então todo caminho novo precisa filtrar por `account_id` explicitamente. Nunca importe `admin-client` em código que chega ao navegador.
8. **`ingest.ts` repassa `channel_id`** ao motor; se um novo ponto de entrada de inbound esquecer, o fluxo escopado deixa de casar (só os genéricos disparam).

## Políticas de fallback

`flows.fallback_policy` (JSONB) decide o que fazer quando a resposta não casa nenhuma opção: `reprompt` (reenvia e espera), `handoff` (encerra como `handed_off` e põe a conversa em `pending`) ou `end` (esgotadas as tentativas). Linhas antigas ou JSON parcial recebem os padrões via `resolveFallbackPolicy` — não leia o JSONB cru no motor.

## Armadilhas

- Fluxo que repete o menu em canal QRCode: o canal não tem botão; o par saída/casador de `degraded-menu.ts` precisa estar nos dois lados (testes em `engine.degraded.test.ts`).
- Fluxo ativo "preso": execução órfã com conversa apagada (`conversation_id` vira NULL); o cron encerra por tempo. O índice só vale com `conversation_id IS NOT NULL`.
- Mensagem interativa só vale dentro da janela de 24 h; fora dela o envio exige template (ver [`whatsapp-cloud.md`](./whatsapp-cloud.md)).

## Mais

[`../spec-065-selecao-de-canal-por-recurso.md`](../spec-065-selecao-de-canal-por-recurso.md) §5.5 · [`../spec-049-inbox-multicanal-e-motores.md`](../spec-049-inbox-multicanal-e-motores.md) · [`catalogo-specs.md`](./catalogo-specs.md).
