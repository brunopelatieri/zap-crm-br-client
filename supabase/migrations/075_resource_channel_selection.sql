-- ============================================================
-- 075_resource_channel_selection.sql — seleção de canal por recurso
-- SPEC 065 §4 (F1)
--
-- O princípio, em uma linha:
--
--   Onde há saída, há escolha de canal — e a escolha mora no RECURSO,
--   não em Configurações.
--
-- O que este arquivo cria
--
--   1. `automations.channel_id` e `flows.channel_id` (D-4 / D-6).
--      NULL = vale para TODOS os canais, que é exatamente o
--      comportamento de hoje — daí não haver backfill (seção 1).
--   2. Dois índices parciais para o caminho quente do despacho, que
--      passa a filtrar `channel_id IS NULL OR channel_id = $1` uma vez
--      por mensagem recebida (seção 2).
--   3. `deactivate_resource_on_channel_loss()` + gatilho nas duas
--      tabelas (D-8): perder o canal DESATIVA o recurso, nunca o faz
--      voltar a valer para todos os números em silêncio (seção 3).
--   4. Troca `idx_one_active_run_per_contact` por
--      `idx_one_active_run_per_conversation` (D-7): com dois números, o
--      mesmo contato precisa poder ter uma execução de fluxo ativa em
--      CADA conversa. Hoje a segunda colide e o motor devolve
--      `duplicate_inbound_ignored` — falha em SILÊNCIO (seção 4).
--
-- A ORDEM DAS SEÇÕES IMPORTA
--
--   Na seção 4 o DROP vem ANTES do CREATE: enquanto o índice antigo
--   existir, a segunda execução (outro canal, mesmo contato) continua
--   colidindo e o índice novo não teria efeito observável.
--
-- DESVIOS DELIBERADOS DO TEXTO DA SPEC — cada um comentado no lugar
-- onde acontece:
--   * seção 3 — a função é SECURITY INVOKER (a do §4.3 não declara
--                nada): ela só escreve em NEW, não lê tabela nenhuma, e
--                DEFINER aqui só criaria superfície para o linter do
--                Supabase apontar;
--   * seção 4 — pré-checagem amigável antes de criar o índice único,
--                no padrão 013/014/072 §4. NÃO é backfill (o D-7 diz,
--                com razão, que não há o que corrigir): é a diferença
--                entre abortar com um 23505 cru do Postgres e abortar
--                dizendo QUAIS linhas estão no caminho.
--
-- ESTA MIGRAÇÃO NÃO MUDA COMPORTAMENTO NENHUM SOZINHA. Automação e
-- fluxo existentes continuam disparando igual: todas nascem com
-- `channel_id NULL`, e nenhum motor lê a coluna até a F3/F4.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================


-- ============================================================
-- 1) CANAL DO RECURSO (§4.1 — D-4 e D-6)
--
-- BACKFILL: NENHUM, DE PROPÓSITO. `NULL` significa "todos os canais",
-- que é exatamente o comportamento de hoje. Toda automação e todo fluxo
-- existentes continuam funcionando sem tocar em uma linha de dado — é o
-- que torna esta migração reversível de verdade (SPEC 065 §10).
-- ============================================================
ALTER TABLE automations ADD COLUMN IF NOT EXISTS channel_id UUID;
ALTER TABLE flows       ADD COLUMN IF NOT EXISTS channel_id UUID;

-- `ON DELETE SET NULL` + gatilho de desativação (D-8, seção 3). SET NULL
-- sozinho tem efeito perverso: apagar o canal faria a automação escopada
-- voltar SILENCIOSAMENTE a valer para TODOS os números, sem ninguém
-- pedir. E um FK rígido também não serve — o D-12 da SPEC 064 promete
-- que canal SEM conversas é apagado de verdade, e o DELETE voltaria um
-- 23503 cru por causa de uma automação qualquer.
--
-- Guarda de idempotência do padrão 017:320-327 / 072 §5: `ADD
-- CONSTRAINT` não aceita `IF NOT EXISTS`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'automations_channel_id_fkey'
                    AND conrelid = 'public.automations'::regclass) THEN
    ALTER TABLE automations
      ADD CONSTRAINT automations_channel_id_fkey
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'flows_channel_id_fkey'
                    AND conrelid = 'public.flows'::regclass) THEN
    ALTER TABLE flows
      ADD CONSTRAINT flows_channel_id_fkey
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN automations.channel_id IS
  'SPEC 065 D-4. NULL = vale para todos os canais (comportamento anterior). Preenchido: o gatilho so dispara em eventos deste canal E os envios sem conversa abrem a conversa nele. NUNCA redireciona resposta de conversa existente.';

COMMENT ON COLUMN flows.channel_id IS
  'SPEC 065 D-6. NULL = vale para todos os canais. Escopo do gatilho apenas — flow sempre responde pelo canal da conversa.';


-- ============================================================
-- 2) ÍNDICES DE DESPACHO (§4.2)
--
-- O motor passa a filtrar `channel_id IS NULL OR channel_id = $1` no
-- caminho quente — uma consulta por mensagem recebida.
--
-- Os índices antigos (`idx_automations_active_trigger` da 006 e
-- `idx_flows_active_trigger` da 010/017) NÃO são derrubados: o §4.2 só
-- manda criar, e derrubar índice de caminho quente antes de a F3/F4
-- provarem que o novo é usado seria apostar no plano do Postgres sem
-- medir. O de automações é redundante (mesmo predicado, `trigger_type`
-- na frente); fica registrado aqui como candidato a limpeza depois da
-- F4 validada.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_automations_active_trigger_channel
  ON automations (trigger_type, channel_id) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_flows_active_trigger_channel
  ON flows (account_id, trigger_type, channel_id) WHERE status = 'active';

COMMENT ON INDEX idx_automations_active_trigger_channel IS
  'Caminho quente do despacho de automacoes com escopo de canal (SPEC 065 §4.2): ativas, por gatilho, filtrando channel_id IS NULL OR = <id>.';

COMMENT ON INDEX idx_flows_active_trigger_channel IS
  'Caminho quente do dispatchInboundToFlows com escopo de canal (SPEC 065 §4.2).';


-- ============================================================
-- 3) DESATIVAÇÃO AO PERDER O CANAL (§4.3 — D-8)
--
-- `BEFORE`, e não `AFTER`: só num gatilho BEFORE dá para alterar `NEW`.
-- A ação do FK (`SET NULL`) é um `UPDATE` como qualquer outro, então o
-- gatilho a vê.
--
-- ⚠️ O gatilho não distingue — e não tem como distinguir — "o canal foi
-- apagado" de "o operador voltou o recurso para 'Todos os números'".
-- Qualquer UPDATE que leve `channel_id` de preenchido para NULL
-- desativa o recurso. É o que o D-8 pede literalmente; a F3/F6 é que
-- decide como a rota trata o segundo caso (reativar na mesma requisição
-- ou avisar a interface).
--
-- SECURITY INVOKER (⚠️ desvio: o §4.3 não declara): a função só escreve
-- em NEW, não lê tabela nenhuma e não precisa de privilégio de
-- `postgres`. DEFINER aqui só criaria a superfície que a 044:129-135
-- descreve. Os REVOKE abaixo seguem o padrão da casa mesmo assim — uma
-- trigger function chamada por RPC erra, mas a porta fica fechada por
-- duas linhas.
-- ============================================================
CREATE OR REPLACE FUNCTION deactivate_resource_on_channel_loss()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF OLD.channel_id IS NOT NULL AND NEW.channel_id IS NULL THEN
    IF TG_TABLE_NAME = 'automations' THEN
      NEW.is_active := FALSE;
    ELSE
      NEW.status := 'draft';
    END IF;
    RAISE NOTICE '065: % % desativada — canal % foi removido.',
      TG_TABLE_NAME, OLD.id, OLD.channel_id;
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION deactivate_resource_on_channel_loss() OWNER TO postgres;
REVOKE ALL ON FUNCTION deactivate_resource_on_channel_loss() FROM PUBLIC;
REVOKE ALL ON FUNCTION deactivate_resource_on_channel_loss() FROM anon, authenticated;

COMMENT ON FUNCTION deactivate_resource_on_channel_loss() IS
  'SPEC 065 D-8. Recurso que perde o canal fica INATIVO (automations.is_active = FALSE, flows.status = draft) — nunca volta a valer para todos os numeros em silencio.';

-- `UPDATE OF channel_id` dispara quando a coluna aparece no SET, mesmo
-- que o valor não mude; a guarda de verdade é o IF do corpo.
DROP TRIGGER IF EXISTS deactivate_automation_on_channel_loss_trg ON automations;
CREATE TRIGGER deactivate_automation_on_channel_loss_trg
  BEFORE UPDATE OF channel_id ON automations
  FOR EACH ROW EXECUTE FUNCTION deactivate_resource_on_channel_loss();

DROP TRIGGER IF EXISTS deactivate_flow_on_channel_loss_trg ON flows;
CREATE TRIGGER deactivate_flow_on_channel_loss_trg
  BEFORE UPDATE OF channel_id ON flows
  FOR EACH ROW EXECUTE FUNCTION deactivate_resource_on_channel_loss();


-- ============================================================
-- 4) EXECUÇÃO ATIVA DE FLUXO PASSA A SER POR CONVERSA (§4.4 — D-7)
--
-- `idx_one_active_run_per_contact` (017:337-340) é
-- `UNIQUE (account_id, contact_id) WHERE status = 'active'`. Com dois
-- números, o mesmo contato conversando nos dois só consegue UMA
-- execução: a segunda colide (23505) e `startNewRun` devolve
-- `duplicate_inbound_ignored`. O cliente escreve no segundo número e o
-- fluxo simplesmente não responde — sem erro, sem log de falha.
--
-- ⚠️ A ORDEM IMPORTA E O `DROP` VEM PRIMEIRO: enquanto o índice antigo
-- existir, a segunda execução continua barrada e o índice novo não teria
-- efeito observável nenhum.
--
-- `conversation_id` é NULL-able (`ON DELETE SET NULL`, 010:164) — daí o
-- predicado. Uma execução cuja conversa foi apagada está órfã de
-- qualquer forma; o varredor do cron a encerra por tempo.
--
-- BACKFILL: nenhum (D-7). O índice antigo garantia no máximo uma
-- execução ativa por (conta, contato), então nenhuma linha existente
-- viola o novo.
-- ============================================================

-- ------------------------------------------------------------
-- ⚠️ DESVIO DELIBERADO — pré-checagem amigável antes do índice único,
-- no padrão 013/014 e 072 §4.
--
-- O D-7 está certo sobre não haver backfill, mas há UMA brecha que o
-- raciocínio "o índice antigo já garantia" não cobre: em índice único,
-- NULL é distinto de NULL. Execuções cujo `contact_id` virou NULL
-- (contato apagado, 010:160-163) nunca foram cobertas pelo índice
-- antigo, e duas delas podem, em tese, apontar para a MESMA conversa.
-- Sem esta checagem, o CREATE abortaria a migração inteira com um 23505
-- cru, que não diz o que fazer.
--
-- Não corrige nada — só diz quais linhas estão no caminho. Encerrar
-- execução ativa é decisão de operação, não de migração.
-- ------------------------------------------------------------
DO $$
DECLARE v_dups TEXT;
BEGIN
  SELECT string_agg(format('conta %s | conversa %s (%s execucoes ativas)', d.account_id, d.conversation_id, d.n), E'\n  ')
    INTO v_dups
    FROM (SELECT account_id, conversation_id, count(*) AS n
            FROM flow_runs
           WHERE status = 'active' AND conversation_id IS NOT NULL
           GROUP BY 1, 2
          HAVING count(*) > 1) d;

  IF v_dups IS NOT NULL THEN
    RAISE EXCEPTION
      E'075: nao e possivel criar UNIQUE(account_id, conversation_id) WHERE status = active — estas conversas ja tem mais de uma execucao ativa:\n  %\nEncerre as excedentes (UPDATE flow_runs SET status = ''timed_out'', ended_at = NOW() WHERE id = ...) e rode a migracao de novo.',
      v_dups;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_one_active_run_per_contact;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_conversation
  ON flow_runs (account_id, conversation_id)
  WHERE status = 'active' AND conversation_id IS NOT NULL;

COMMENT ON INDEX idx_one_active_run_per_conversation IS
  'Uma execucao ativa por CONVERSA, nao por contato (SPEC 065 D-7). Com N numeros, o mesmo contato tem uma execucao em cada conversa. Predicado inclui conversation_id IS NOT NULL porque a coluna e SET NULL quando a conversa e apagada.';


-- ============================================================
-- 5) ASSERÇÕES — falham alto de propósito (§4.5)
--
-- Padrão 042/044/045/050/055/067/071/072. O que esta migração troca é
-- estrutural e silencioso quando dá errado pela metade: um FK sem
-- `SET NULL`, um gatilho que não nasceu ou o índice antigo que não caiu
-- só aparecem depois, em produção — e os três falham exatamente do
-- jeito que esta SPEC existe para eliminar (em silêncio).
-- ============================================================
DO $$
DECLARE
  v_txt TEXT;
BEGIN
  -- ── 5.1. As duas colunas existem ─────────────────────────────
  SELECT string_agg(t.tabela, ', ') INTO v_txt
    FROM (VALUES ('automations'), ('flows')) AS t(tabela)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public'
                        AND table_name = t.tabela
                        AND column_name = 'channel_id');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '075: channel_id nao foi criada em: %.', v_txt;
  END IF;

  -- ── 5.2. Os dois FKs existem COM ON DELETE SET NULL ──────────
  -- 'n' = SET NULL. Sem isso, o DELETE de canal que a 064 D-12 promete
  -- volta um 23503 cru — e com NO ACTION o gatilho da secao 3 nunca
  -- chegaria a rodar.
  SELECT string_agg(t.nome, ', ') INTO v_txt
    FROM (VALUES ('automations_channel_id_fkey', 'public.automations'),
                 ('flows_channel_id_fkey',       'public.flows')) AS t(nome, tabela)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = t.nome
                        AND conrelid = t.tabela::regclass
                        AND confdeltype = 'n');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '075: estes FKs faltam ou nao estao com ON DELETE SET NULL: %.', v_txt;
  END IF;

  -- ── 5.3. A funcao e os dois gatilhos de desativacao (D-8) ────
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace
                    AND proname = 'deactivate_resource_on_channel_loss') THEN
    RAISE EXCEPTION '075: deactivate_resource_on_channel_loss() nao existe — recurso que perde o canal voltaria a valer para TODOS os numeros em silencio (D-8).';
  END IF;

  SELECT string_agg(t.nome || ' (' || t.tabela || ')', ', ') INTO v_txt
    FROM (VALUES ('deactivate_automation_on_channel_loss_trg', 'public.automations'),
                 ('deactivate_flow_on_channel_loss_trg',       'public.flows')) AS t(nome, tabela)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = t.tabela::regclass
                        AND g.tgname = t.nome
                        AND NOT g.tgisinternal);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '075: gatilhos de desativacao ausentes: %.', v_txt;
  END IF;

  -- BEFORE, nao AFTER: so num gatilho BEFORE da para alterar NEW. Um
  -- AFTER passaria em todas as checagens acima e nao desativaria nada.
  -- tgtype & 2 = BEFORE (zero = AFTER), pela definicao de pg_trigger.
  SELECT string_agg(g.tgname, ', ') INTO v_txt
    FROM pg_trigger g
   WHERE g.tgname IN ('deactivate_automation_on_channel_loss_trg',
                      'deactivate_flow_on_channel_loss_trg')
     AND NOT g.tgisinternal
     AND (g.tgtype & 2) = 0;
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '075: estes gatilhos nao sao BEFORE: %. Um AFTER nao consegue escrever em NEW e nao desativaria nada.', v_txt;
  END IF;

  -- ── 5.4. Os dois indices de despacho ─────────────────────────
  SELECT string_agg(t.nome, ', ') INTO v_txt
    FROM (VALUES ('idx_automations_active_trigger_channel'),
                 ('idx_flows_active_trigger_channel')) AS t(nome)
   WHERE NOT EXISTS (SELECT 1 FROM pg_indexes
                      WHERE schemaname = 'public' AND indexname = t.nome);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '075: indices de despacho ausentes: %.', v_txt;
  END IF;

  -- ── 5.5. A troca do indice de execucao ativa (D-7) ───────────
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public' AND indexname = 'idx_one_active_run_per_contact') THEN
    RAISE EXCEPTION '075: idx_one_active_run_per_contact ainda existe — enquanto ele estiver de pe, a segunda execucao (outro canal, mesmo contato) continua colidindo e o indice novo nao tem efeito.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'idx_one_active_run_per_conversation') THEN
    RAISE EXCEPTION '075: idx_one_active_run_per_conversation ausente.';
  END IF;

  -- UNIQUE e PARCIAL, nao apenas "existe": um indice comum aqui deixaria
  -- `startNewRun` criar duas execucoes ativas na MESMA conversa, e a
  -- protecao contra inbound duplicado (flows/engine.ts) desapareceria
  -- sem nenhum sintoma imediato.
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indexrelid = 'public.idx_one_active_run_per_conversation'::regclass
                    AND i.indisunique
                    AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION '075: idx_one_active_run_per_conversation precisa ser UNIQUE e PARCIAL (WHERE status = active AND conversation_id IS NOT NULL).';
  END IF;

  -- ── 5.6. Nenhum recurso aponta para canal de OUTRA conta ─────
  -- Consulta de auditoria do §11: deve devolver zero linhas sempre.
  -- Aqui ela e vacuamente verdadeira (ninguem preencheu channel_id
  -- ainda); a assercao existe para a REEXECUCAO desta migracao depois da
  -- F3/F6, quando ja houver escolha gravada.
  IF EXISTS (SELECT 1 FROM automations a JOIN channels c ON c.id = a.channel_id
              WHERE c.account_id <> a.account_id) THEN
    RAISE EXCEPTION '075: automacao apontando para canal de outra conta.';
  END IF;

  IF EXISTS (SELECT 1 FROM flows f JOIN channels c ON c.id = f.channel_id
              WHERE c.account_id <> f.account_id) THEN
    RAISE EXCEPTION '075: fluxo apontando para canal de outra conta.';
  END IF;

  RAISE NOTICE '075: escopo de canal disponivel em automations/flows e execucao de fluxo agora e por conversa. Nenhum motor le channel_id ainda — comportamento inalterado ate a F3/F4 (SPEC 065 §9).';
END $$;


-- ============================================================
-- 6) ÚLTIMO COMANDO: recarregar o cache do PostgREST
--
-- `automations.channel_id` e `flows.channel_id` sao colunas novas: sem
-- o reload, o primeiro `PATCH` que mandar `channel_id` volta PGRST204
-- ("column not found in schema cache") — e a F3/F6 pareceria quebrada
-- por um motivo que nao tem nada a ver com o codigo delas.
-- ============================================================
NOTIFY pgrst, 'reload schema';
