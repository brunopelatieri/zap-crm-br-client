-- ============================================================
-- 076_broadcasts_channel_source.sql — origem do canal agendado
-- SPEC 065 §11 (achado de code review sobre a F7/F8)
--
-- O problema que isto corrige
--
--   `broadcasts.channel_id` no agendamento é gravado CONGELADO
--   (SPEC 064 D-3) — inclusive quando ninguém escolheu um canal e a
--   campanha herdou o padrão da conta no momento do agendamento. Sem
--   uma coluna própria, `channel_id` sozinho não distingue as duas
--   situações: está preenchido nos dois casos. O cron, ao efetivamente
--   disparar a campanha dias depois, relia só nesse `channel_id` para
--   calcular `channelSource` (SPEC 065 §11) — e um valor sempre
--   preenchido vira sempre `'resource'`, mesmo quando a campanha usou
--   o padrão. Toda campanha agendada com canal padrão saía do log de
--   auditoria rotulada como "alguém escolheu", derrotando exatamente a
--   pergunta que `channelSource` existe para responder.
--
-- O que este arquivo cria
--
--   `broadcasts.channel_source` — grava, NO MOMENTO DO AGENDAMENTO (ou
--   do disparo imediato), se `channel_id` veio de uma escolha explícita
--   ou do padrão da conta. O cron lê esta coluna na hora de entregar a
--   campanha, em vez de recalcular a partir de um `channel_id` que já
--   perdeu essa informação.
--
-- Sem backfill, de propósito
--
--   `NULL` é o valor de toda linha existente — igual ao padrão de toda
--   coluna nova desta SPEC. O código trata `NULL` como "não sei",
--   recaindo no cálculo antigo (`channel_id ? 'resource' : 'default'`)
--   só para linhas que já existiam antes desta migração — o mesmo
--   comportamento de hoje, nem melhor nem pior, só não retroativamente
--   corrigido.
-- ============================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS channel_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_channel_source_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_channel_source_check
      CHECK (channel_source IS NULL OR channel_source IN ('resource', 'default'));
  END IF;
END $$;

COMMENT ON COLUMN broadcasts.channel_source IS
  'SPEC 065 §11 (achado de code review). De onde veio channel_id no momento do agendamento/disparo: resource = alguem escolheu explicitamente; default = caiu no canal Cloud padrao da conta. NULL em linhas anteriores a esta coluna — o codigo recai no calculo antigo (channel_id ? resource : default) so nesse caso.';

-- ── Asserções ──────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'broadcasts'
      AND column_name = 'channel_source'
  ) THEN
    RAISE EXCEPTION '076: coluna broadcasts.channel_source nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_channel_source_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    RAISE EXCEPTION '076: constraint broadcasts_channel_source_check nao foi criada.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
