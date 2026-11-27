-- ============================================================
-- 102_ai_openrouter_prompt_versions.sql — SPEC 089 F1
--
-- OpenRouter como provedor de IA, custo por chamada e versões de prompt.
--
--   1. ai_configs.provider e ai_usage_log.provider aceitam 'openrouter'.
--   2. ai_configs.embeddings_provider ('openai' | 'openrouter'): quem
--      atende os embeddings da base de conhecimento (D-3). Com
--      provider = 'openrouter' e sem chave de embeddings própria, o
--      código reaproveita a chave do chat.
--   3. ai_configs.provider_options jsonb: opções do provedor. Hoje só
--      `deny_data_collection` (D-5): quando true, o chat do OpenRouter
--      leva `provider: { data_collection: "deny" }`. Nasce vazio = desligado.
--   4. ai_usage_log.cost_usd: custo da chamada em USD quando o provedor
--      informa (OpenRouter: `usage.cost`). Nulo nos demais (D-6).
--   5. ai_prompt_versions: histórico do `system_prompt` (append-only).
--      Uma linha por mudança do prompt; restaurar grava uma versão nova.
--
-- Privilégios (lição da 097): o privilégio padrão de tabela do dono dá
-- `arwdDxtm` a `authenticated` em `public`, então revogamos tudo e
-- concedemos só o necessário. `ai_prompt_versions`: o admin lê e insere
-- (RLS); ninguém altera nem apaga (a exclusão da conta cascateia pela FK).
-- Esta migração não cria função.
--
-- Fora desta migração (F2/F3 da SPEC 089 usam o próximo número livre, não
-- esta): colunas da base de conhecimento, `embedding_model` por fatia,
-- `fts_pt`, RPC híbrida e `unaccent`. Os vetores do OpenAI direto e do
-- OpenRouter são do mesmo modelo (`text-embedding-3-small`, 1536
-- dimensões), então trocar `embeddings_provider` não mistura vetores
-- incomparáveis.
--
-- Idempotente — pode rodar de novo. Nada de URL ou segredo do deploy aqui.
-- ============================================================

-- 1) CHECKs de provedor. O nome do CHECK inline é gerado pelo Postgres
--    (<tabela>_provider_check); descobrimos pelo catálogo para não depender
--    do nome.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND c.conrelid IN ('public.ai_configs'::regclass, 'public.ai_usage_log'::regclass)
       AND pg_get_constraintdef(c.oid) ILIKE '%provider%'
       AND pg_get_constraintdef(c.oid) ILIKE '%anthropic%'
       AND pg_get_constraintdef(c.oid) NOT ILIKE '%embeddings_provider%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE public.ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

-- 2) Provedor de embeddings.
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS embeddings_provider text NOT NULL DEFAULT 'openai';

ALTER TABLE public.ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_embeddings_provider_check;
ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_embeddings_provider_check
  CHECK (embeddings_provider IN ('openai', 'openrouter'));

-- 3) Opções do provedor (privacidade do OpenRouter, D-5).
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS provider_options jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 4) Custo por chamada (USD). numeric: uma chamada custa frações de centavo.
ALTER TABLE public.ai_usage_log
  ADD COLUMN IF NOT EXISTS cost_usd numeric(14, 8);

-- 5) Versões de prompt.
CREATE TABLE IF NOT EXISTS public.ai_prompt_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Texto do prompt naquele momento. '' = prompt vazio (limpo).
  system_prompt text NOT NULL DEFAULT '',
  note          text,
  -- 'panel' (tela) | 'api' (API pública, SPEC 090).
  source        text NOT NULL DEFAULT 'panel' CHECK (source IN ('panel', 'api')),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_versions_account_created
  ON public.ai_prompt_versions (account_id, created_at DESC);

ALTER TABLE public.ai_prompt_versions ENABLE ROW LEVEL SECURITY;

-- O prompt é configuração da conta: só admin+ lê e grava (mesma régua de
-- `ai_configs` para escrita; leitura restrita porque o histórico pode
-- guardar instruções antigas que ninguém além do admin precisa ver).
DROP POLICY IF EXISTS ai_prompt_versions_select ON public.ai_prompt_versions;
CREATE POLICY ai_prompt_versions_select ON public.ai_prompt_versions
  FOR SELECT TO authenticated
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_prompt_versions_insert ON public.ai_prompt_versions;
CREATE POLICY ai_prompt_versions_insert ON public.ai_prompt_versions
  FOR INSERT TO authenticated
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND (created_by IS NULL OR created_by = auth.uid())
  );

REVOKE ALL ON TABLE public.ai_prompt_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_prompt_versions FROM anon;
REVOKE ALL ON TABLE public.ai_prompt_versions FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.ai_prompt_versions TO authenticated;
GRANT ALL ON TABLE public.ai_prompt_versions TO service_role;
