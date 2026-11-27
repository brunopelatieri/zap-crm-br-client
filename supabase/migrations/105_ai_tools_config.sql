-- ============================================================
-- 105_ai_tools_config.sql — SPEC 089 F4 (motor de ferramentas)
--
--   1. ai_configs.tools_config jsonb: liga/desliga por ferramenta e as
--      listas permitidas da conta (D-16). Formato (snake_case):
--        { "search_knowledge":    { "enabled": true },
--          "get_contact_profile": { "enabled": true,
--                                   "visible_fields": ["email", "tags",
--                                                      "custom:<uuid>"] },
--          "list_contact_deals":  { "enabled": true,
--                                   "pipeline_ids": ["<uuid>"] } }
--      Nasce '{}' = toda ferramenta DESLIGADA. O código (parseToolsConfig)
--      descarta chave desconhecida e trata lista vazia como "nada
--      permitido". Sem tela até a F5 (aba Ferramentas): liga-se por SQL.
--   2. ai_usage_log.steps / tool_calls: só em turno com ferramentas.
--      Uma linha por resposta; os tokens e o custo já vêm somados dos
--      passos. Nulos = turno sem ferramentas (como antes).
--
-- Fica para a 105b (F5): ai_tool_calls (auditoria), quota
-- ai_tool_calls_month. Para a 105c (F6): ai_custom_tools.
--
-- Esta migração não cria função nem tabela: nenhum GRANT/REVOKE novo. As
-- colunas herdam a RLS e os privilégios de ai_configs e ai_usage_log
-- (o admin lê e grava a própria config; ai_usage_log não tem INSERT para
-- authenticated).
--
-- Pode ser aplicada antes ou depois do deploy do código da F4: sem a
-- coluna, loadAiConfig relê sem tools_config e loga (ferramentas
-- desligadas, o resto funciona). Para ligar ferramentas, aplique-a.
--
-- Idempotente — pode rodar de novo. Nada de URL ou segredo do deploy aqui.
-- ============================================================

-- 1) Configuração das ferramentas por conta.
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS tools_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_tools_config_object_check;
ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_tools_config_object_check
  CHECK (jsonb_typeof(tools_config) = 'object');

COMMENT ON COLUMN public.ai_configs.tools_config IS
  'SPEC 089 D-16: per-tool on/off and allow-lists. {} = every tool off.';

-- 2) Passos e chamadas de ferramenta por resposta.
ALTER TABLE public.ai_usage_log
  ADD COLUMN IF NOT EXISTS steps smallint,
  ADD COLUMN IF NOT EXISTS tool_calls smallint;

ALTER TABLE public.ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_steps_check;
ALTER TABLE public.ai_usage_log
  ADD CONSTRAINT ai_usage_log_steps_check
  CHECK (steps IS NULL OR steps BETWEEN 1 AND 20);

ALTER TABLE public.ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_tool_calls_check;
ALTER TABLE public.ai_usage_log
  ADD CONSTRAINT ai_usage_log_tool_calls_check
  CHECK (tool_calls IS NULL OR tool_calls BETWEEN 0 AND 200);

-- 3) Asserções: a migração deixa o que promete.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ai_configs'
       AND column_name = 'tools_config' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '105: ai_configs.tools_config ausente ou anulavel';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ai_usage_log'
         AND column_name IN ('steps', 'tool_calls')) <> 2 THEN
    RAISE EXCEPTION '105: ai_usage_log.steps/tool_calls ausentes';
  END IF;
END $$;
