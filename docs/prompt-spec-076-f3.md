# Prompt de abertura — SPEC 076, F3 (webhook + sinal de pagamento)

> **Modelo:** Opus (a própria SPEC §21 marca a F3 como "Opus: caminho quente e
> idempotência, onde um erro custa mais"). **Sessão:** nova, dedicada.
> Cole o bloco abaixo inteiro, sem editar.

```text
Leia primeiro AGENTS.md (raiz do repo) e depois docs/spec-076-monitor-cobranca-whatsapp-cloud-api.md
inteira. Responda sempre em português do Brasil.

CONTEXTO — o que já existe (F1 e F2 feitas, NÃO refaça nem reabra):
  - Migração supabase/migrations/086_whatsapp_billing_monitor.sql, aplicada à mão pelo
    mantenedor SÓ NO PROJETO vn. NÃO está aplicada no rs. Ela criou: tabela
    whatsapp_billing_status (PK account_id+waba_id), messages.pricing_billable /
    pricing_category, notifications.channel_id + tipo 'channel_payment_blocked' + índice
    único parcial uq_notifications_payment_blocked_unread, a função
    notify_channel_payment_blocked(p_account_id, p_channel_id, p_waba_id) (só service_role,
    cria 1 alerta por owner/admin, dedupe por ON CONFLICT DO NOTHING, devolve nº de linhas)
    e platform_settings.whatsapp_billing_monitor_enabled (padrão FALSE).
  - ATENÇÃO: as colunas de erro da tabela são SEPARADAS por leitura (health_error_* /
    spend_error_*), não last_error_* como o texto original da SPEC dizia — a SPEC já foi
    emendada. Isso não afeta a F3 (a F3 só mexe nas colunas de pagamento), mas leia o §8.1
    atual.
  - src/lib/whatsapp/billing-monitor.ts (puro) já tem readStatus(), PAYMENT_ERROR_CODE,
    maskId() e os tipos. USE-OS; não reimplemente. src/lib/whatsapp/billing-graph.ts e
    src/types/index.ts (WhatsappBillingStatusRow) também já existem.

VOCÊ VAI IMPLEMENTAR SÓ A F3 (§21). Nada de billing-server.ts, nada de rotas
/api/whatsapp/billing, nada de UI, nada de i18n — isso é F4/F5. Entregáveis:

  1. src/lib/whatsapp/billing-signal.ts — applyPaymentSignal(...) (§7.2, §10.3, §10.4).
     Dois sinais: 'payment_error' (liga) e 'billable_ok' (limpa). Regras exatas no §6.3:
     COALESCE/GREATEST, "episódio novo" só quando payment_blocked_since era nulo,
     limpeza automática só com ts > last_payment_error_at, 131042 antigo depois de uma
     limpeza só reabre se ts > payment_cleared_at, mensagem billable=false nunca limpa.
     Em episódio novo E com platform_settings.whatsapp_billing_monitor_enabled = TRUE,
     chamar notify_channel_payment_blocked uma vez por CANAL daquele WABA naquela conta.
     Com o flag desligado o estado é gravado do mesmo jeito (D-10) e só a notificação não sai.
  2. Webhook (src/app/api/whatsapp/webhook/route.ts): tipar statuses[].pricing (§10.1);
     passar { wabaId: entry.id, phoneNumberId: value.metadata.phone_number_id } a
     handleStatusUpdate (§10.2); gravar pricing_billable/pricing_category em messages
     (sem pricing = NÃO tocar as colunas, nunca sobrescrever com nulo); acionar o sinal nos
     dois casos do §10.3. Resolver a conta UMA vez por change (memoizar por phone_number_id),
     não por status — o caminho quente não pode ganhar uma consulta por status.
  3. Sinal SÍNCRONO (RF-07) no envio: MetaApiError com code 131042 liga o mesmo estado.
  4. Testes: billing-signal.test.ts (§15.1) + ampliar webhook/route.test.ts e cobrir o envio
     síncrono (§15.2). O teste deve FALHAR no código sem a mudança (verifique de verdade).

PONTOS QUE EU JÁ INVESTIGUEI (confirme, não presuma):
  - handleStatusUpdate hoje recebe só o item de status e DESCARTA pricing. A resolução de
    conta no webhook é por whatsapp_config.phone_number_id (UNIQUE, migração 013). Se
    entry.id divergir do waba_id da config, vale o da config e a divergência é logada (§7.8).
    whatsapp_config.waba_id é opcional no tipo: decida e documente o que fazer quando faltar.
  - ONDE ENGANCHAR O ENVIO SÍNCRONO: o ponto único é sendContentViaChannel
    (src/lib/channels/send.ts ~linha 457). Ele serve sendWithPhoneVariants,
    sendAndPersistOutbound, o disparo em massa (broadcast-core.ts ~568), ingest/send e a
    transferência — hookar ali cobre todos. MAS: o ChannelContext do Cloud só traz
    credentials { phoneNumberId, accessToken } e o Channel pode ser SINTÉTICO
    (id "cloud:<account>", ver cloudChannelContext) — não tem waba_id nem channel_id real.
    Logo o sinal tem de resolver waba_id e a lista de canais REAIS pela whatsapp_config via
    phone_number_id. Confirme que o adaptador (src/lib/channels/adapters/whatsapp-cloud.ts)
    deixa o MetaApiError original subir com .code intacto; se algum wrapper o embrulhar, o
    hook tem de olhar a causa.
  - O hook é best-effort: try/catch, nunca troca nem atrasa o erro devolvido ao chamador,
    nunca derruba o envio. O mesmo vale para o sinal do webhook (§10.4: falha de escrita é
    logada e NÃO interrompe o espelho em broadcast_recipients nem o fan-out
    message.status_updated).
  - RNF-05: nenhuma chamada à Graph dentro do webhook. RNF-01: nenhum token em log.
  - Um disparo em massa falhando com 131042 gera RAJADA de status 'failed' do mesmo WABA em
    paralelo. É esse o cenário de concorrência que justifica a F3 ser Opus: o resultado tem
    de ser idempotente e SEM notificação duplicada.

A DECISÃO DE DESENHO CENTRAL (você decide, justifica no resumo final):
  O UPSERT com COALESCE/GREATEST e a leitura de "episódio novo" não cabem em um único
  .upsert() do supabase-js e fazer ler-e-depois-escrever abre corrida. A saída que eu
  recomendo é uma função SQL atômica (ex.: apply_payment_signal(...) RETURNS boolean
  "episódio novo"), numa migração NOVA 087 — mas isso é desvio da SPEC (o §8 não a prevê),
  então só vale se você concluir que a alternativa em TypeScript é pior. Se criar a 087:
    * rode `ls supabase/migrations/` antes de nomear; se já houver 087, PARE e pergunte;
    * mesmo molde das asserções/REVOKE da 084b/085/086 (SECURITY DEFINER, search_path fixo,
      EXECUTE só para service_role);
    * NÃO aplique em vn nem em rs (nem apply_migration, nem execute_sql). Entregue o .sql.
  Se preferir TypeScript puro, mostre como evita a corrida e o episódio duplicado.

PERGUNTE-ME ANTES DE CODAR (uma pergunta só, objetiva):
  O pricing_billable/pricing_category vai no MESMO UPDATE de messages que o webhook já faz
  (é o que a SPEC diz, D-7). Só que a 086 NÃO existe no projeto rs: lá esse UPDATE
  referenciaria colunas inexistentes e falharia INTEIRO, quebrando o espelho de status
  (sent/delivered/read) de todas as mensagens. Pergunte se a 086 já foi aplicada no rs; se
  não foi, o pricing tem de ir num UPDATE separado e best-effort (que pode falhar sozinho
  sem derrubar o status). Não decida isso por conta própria.

REGRAS DO REPO:
  - Lógica em src/lib/, rota só orquestra; teste co-locado ao lado do fonte.
  - Mensagens de /api/** e logs em inglês; textos de notificação já vêm da função SQL.
  - Clientes Supabase: o webhook e o sinal usam supabaseAdmin() (service_role) com
    account_id sempre filtrado (RNF-02). Nunca importe admin.ts em código de browser.
  - NÃO aplique migração em nenhum projeto. NÃO faça git commit/push — deixe o comando
    pronto (AGENTS.md: commit é manual).
  - Se editar arquivos, rode `npx prettier --write` neles no fim: neste Windows já apareceu
    arquivo com CRLF que o `format:check` (endOfLine lf) reprova.

GATE (rodar ao final, nesta ordem):
  npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
  Atenção: src/lib/activity/query.test.ts tem 6 falhas PRÉ-EXISTENTES (falham na árvore
  limpa, não são da SPEC 076). Não as "conserte" e não as conte contra você; confirme que
  são as mesmas 6 e que todo o resto passa.

CRITÉRIO DE PRONTO:
  - Webhook repetido (a Meta reenvia) não muda a linha nem duplica notificação.
  - delivered cobrável MAIS ANTIGO que o último 131042 não limpa; 131042 antigo depois de
    uma limpeza não reabre; billable=false nunca limpa.
  - Status sem pricing não sobrescreve as colunas de messages.
  - Falha do sinal não impede o espelho em broadcast_recipients nem o fan-out.
  - Envio síncrono com MetaApiError(131042) liga o estado e devolve o MESMO erro.
  - Com o flag desligado: estado gravado, nenhuma notificação criada.

AO TERMINAR: resuma o que criou, aponte cada desvio do texto literal da SPEC (e por quê),
liste o que ficou sem teste, deixe o comando de commit pronto (sem executar) e PARE.
Não avance para a F4. Se quiser, sugira rodar /code-review high nesta mudança antes do commit.
```
