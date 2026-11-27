-- ============================================================
-- 111 — ai_configs: chaves cifradas fora do alcance do JWT (SPEC 089, P-14)
-- ============================================================
-- Idempotente. Aplicar no SQL Editor do `vn` pelo mantenedor; depois rodar
-- scripts/verify-111-ai-configs-secret-columns.sql e `get_advisors` (security).
-- Não depende da 109 (SPEC 090) nem da 110.
--
-- O problema (pré-existente, achado na revisão da F8)
--   A policy `ai_configs_select` (029) deixa QUALQUER membro da conta ler a
--   linha, `viewer` inclusive, e o `authenticated` tem SELECT de tabela. Pelo
--   PostgREST, com o JWT do usuário, saem `api_key` e `embeddings_api_key`.
--   São AES-256-GCM (`ENCRYPTION_KEY`), mas o texto cifrado não precisa sair
--   do servidor: quem decifra é o código de servidor (service role), e a rota
--   `GET /api/ai/config` nunca devolve a chave, só `has_key`.
--   Verificado no `vn` (2026-11-27): o admin da conta lê as duas colunas e a
--   `tools_config`; o papel `anon` é barrado (42501) porque a policy chama
--   `is_account_member`, que a 090 revogou dele.
--
-- O que esta migração faz
--   1) `authenticated` perde o SELECT de TABELA em `ai_configs` e ganha SELECT
--      POR COLUNA em todas as colunas, menos `api_key` e
--      `embeddings_api_key`. INSERT/UPDATE/DELETE seguem como estavam (a RLS
--      de admin+ decide; gravar uma chave nova continua possível).
--      Uma coluna nova em `ai_configs` NÃO nasce legível: precisa do GRANT
--      por coluna na migração que a cria (falha fechada; a asserção abaixo e
--      o verify listam o que falta).
--   2) `anon` perde TODO privilégio de tabela em `ai_configs`,
--      `ai_knowledge_documents`, `ai_knowledge_chunks` e `ai_usage_log`
--      (029/030 deram GRANT de tabela a `anon`; só a RLS fechava, porque
--      `anon` não executa `is_account_member`). Nenhum caminho do app usa
--      `anon` nessas tabelas.
--   O servidor lê as chaves com `supabaseAdmin()` (service role, ignora RLS e
--   privilégio de coluna, mantém o GRANT total). A mudança de código vai na
--   mesma entrega: `loadAiConfig`/`loadEmbeddingsTarget` recebem o cliente de
--   service role e `GET/POST /api/ai/config` + `POST /api/ai/test` leem a
--   chave por ele. `select('*')` em `ai_configs` com o cliente de sessão passa
--   a dar 42501 (de propósito).
--
-- Reverter (só se algo da tela quebrar e for preciso voltar ao estado antigo):
--   GRANT SELECT ON TABLE public.ai_configs TO authenticated;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) anon sem privilégio nas tabelas antigas de IA
-- ------------------------------------------------------------
REVOKE ALL ON TABLE public.ai_configs            FROM anon;
REVOKE ALL ON TABLE public.ai_knowledge_documents FROM anon;
REVOKE ALL ON TABLE public.ai_knowledge_chunks    FROM anon;
REVOKE ALL ON TABLE public.ai_usage_log           FROM anon;

-- ------------------------------------------------------------
-- 2) authenticated: SELECT por coluna em ai_configs, sem as cifradas
--    (REVOKE de tabela também limpa privilégio de coluna que já existisse)
-- ------------------------------------------------------------
REVOKE SELECT ON TABLE public.ai_configs FROM authenticated;

GRANT SELECT (
  id,
  account_id,
  created_by,
  provider,
  model,
  system_prompt,
  is_active,
  auto_reply_enabled,
  auto_reply_max_per_conversation,
  created_at,
  updated_at,
  handoff_agent_id,
  embeddings_provider,
  provider_options,
  tools_config
) ON public.ai_configs TO authenticated;

COMMENT ON COLUMN public.ai_configs.api_key IS
  'Chave BYO do provedor, AES-256-GCM. Legível só por service_role (111, P-14); a UI só vê has_key.';
COMMENT ON COLUMN public.ai_configs.embeddings_api_key IS
  'Chave de embeddings, AES-256-GCM. Legível só por service_role (111, P-14); a UI só vê has_embeddings_key.';

-- ------------------------------------------------------------
-- Asserções finais (falham alto; tudo reverte)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_tbl     regclass;
  v_col     text;
  v_missing text;
BEGIN
  -- anon: nada nas quatro tabelas
  FOREACH v_tbl IN ARRAY ARRAY[
    'public.ai_configs'::regclass,
    'public.ai_knowledge_documents'::regclass,
    'public.ai_knowledge_chunks'::regclass,
    'public.ai_usage_log'::regclass
  ] LOOP
    IF has_any_column_privilege('anon', v_tbl, 'SELECT, INSERT, UPDATE, REFERENCES')
       OR has_table_privilege('anon', v_tbl, 'DELETE, TRUNCATE, TRIGGER') THEN
      RAISE EXCEPTION '111: anon ainda tem privilegio em %.', v_tbl USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- authenticated: sem SELECT de tabela nem nas colunas cifradas
  IF has_table_privilege('authenticated', 'public.ai_configs', 'SELECT') THEN
    RAISE EXCEPTION '111: authenticated ainda tem SELECT de tabela em ai_configs.' USING ERRCODE = '55006';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['api_key', 'embeddings_api_key'] LOOP
    IF has_column_privilege('authenticated', 'public.ai_configs', v_col, 'SELECT') THEN
      RAISE EXCEPTION '111: authenticated ainda le ai_configs.%.', v_col USING ERRCODE = '55006';
    END IF;
    IF has_column_privilege('anon', 'public.ai_configs', v_col, 'SELECT') THEN
      RAISE EXCEPTION '111: anon ainda le ai_configs.%.', v_col USING ERRCODE = '55006';
    END IF;
    IF NOT has_column_privilege('service_role', 'public.ai_configs', v_col, 'SELECT') THEN
      RAISE EXCEPTION '111: service_role perdeu a leitura de ai_configs.% (o servidor quebraria).', v_col
        USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- toda outra coluna segue legível para a tela
  SELECT string_agg(a.attname, ', ' ORDER BY a.attnum)
    INTO v_missing
    FROM pg_attribute a
   WHERE a.attrelid = 'public.ai_configs'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('api_key', 'embeddings_api_key')
     AND NOT has_column_privilege('authenticated', 'public.ai_configs', a.attname, 'SELECT');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '111: colunas sem SELECT para authenticated (a tela quebraria): %.', v_missing
      USING ERRCODE = '55006';
  END IF;

  -- escrita de admin+ preservada (a RLS decide)
  IF NOT (has_table_privilege('authenticated', 'public.ai_configs', 'INSERT')
          AND has_table_privilege('authenticated', 'public.ai_configs', 'UPDATE')
          AND has_table_privilege('authenticated', 'public.ai_configs', 'DELETE')) THEN
    RAISE EXCEPTION '111: authenticated perdeu INSERT/UPDATE/DELETE em ai_configs.' USING ERRCODE = '55006';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.ai_configs', 'SELECT')
          AND has_table_privilege('service_role', 'public.ai_configs', 'INSERT')
          AND has_table_privilege('service_role', 'public.ai_configs', 'UPDATE')
          AND has_table_privilege('service_role', 'public.ai_configs', 'DELETE')) THEN
    RAISE EXCEPTION '111: service_role perdeu privilegio em ai_configs.' USING ERRCODE = '55006';
  END IF;
END $$;

COMMIT;
