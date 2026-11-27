-- ============================================================
-- 107_ai_custom_tools.sql — SPEC 089 F6 (ferramenta HTTP definida pela conta)
--
--   1. ai_custom_tools: as ferramentas HTTP que o ADMIN da conta cria para o
--      agente de IA (estoque, pedido, agenda). Cada linha é uma chamada
--      FIXA: a URL e o método são do admin; o modelo só preenche os campos
--      do esquema de entrada (`input_schema`, um subconjunto simples de JSON
--      Schema validado pelo código). Nasce DESLIGADA (`is_active = false`,
--      D-16) e com risco `write` (o admin marca `read` de propósito).
--   2. Cabeçalhos (Authorization, X-Api-Key…) ficam CIFRADOS em
--      `headers_encrypted` (AES-GCM, `ENCRYPTION_KEY`, o mesmo mecanismo das
--      chaves de IA; formato `<iv>:<cifra>:<tag>` em hex). O CHECK só aceita
--      esse formato, então um valor em texto claro nunca entra por engano.
--      `header_names` guarda só os NOMES (sem valores) para a tela mostrar o
--      que está configurado.
--   3. Teto por conta: 20 ferramentas HTTP (trigger BEFORE INSERT com trava
--      consultiva por conta; erro `AI_CUSTOM_TOOL_LIMIT:20`). Não há quota
--      de plano nova: cada chamada já conta em `ai_tool_calls_month`
--      (migração 106), e o teto fixo impede que a lista cresça sem limite.
--   4. Nome: snake_case, 3 a 48 caracteres, único por conta. A colisão com as
--      ferramentas nativas é checada pelo código (a lista cresce com a SPEC;
--      um CHECK aqui ficaria velho) e, na execução, a nativa sempre vence.
--
-- Privilégios (supabase-rls-mcp.md; lição da 097): o privilégio padrão do
-- dono dá `arwdDxtm` a `authenticated`, então revogamos tudo.
--   - authenticated: SELECT só nas colunas SEM segredo (a coluna
--     `headers_encrypted` nunca é legível pelo navegador), e a policy deixa
--     admin+ ler as linhas da PRÓPRIA conta. Nenhum INSERT/UPDATE/DELETE.
--   - service_role: tudo (as rotas validam o papel `admin` antes e filtram
--     por `account_id`; o auto-reply lê os cabeçalhos só na hora da chamada).
--   - anon: nada.
-- A função (do trigger de teto e a de `updated_at`) é interna: REVOKE de
-- PUBLIC, anon e authenticated.
--
-- Idempotente — pode rodar de novo. Nada de URL ou segredo do deploy aqui.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tabela
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_custom_tools (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- É o nome que o modelo vê. Em inglês e snake_case, como as nativas.
  name              text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{2,47}$'),
  -- Lida pelo modelo: diz QUANDO usar a ferramenta.
  description       text NOT NULL
                      CHECK (char_length(description) BETWEEN 10 AND 500),
  -- Subconjunto de JSON Schema (objeto plano de campos simples); o código
  -- valida a forma, o banco só limita tipo e tamanho.
  input_schema      jsonb NOT NULL
                      DEFAULT '{"type":"object","properties":{}}'::jsonb
                      CHECK (jsonb_typeof(input_schema) = 'object'
                             AND octet_length(input_schema::text) <= 4096),
  -- Sempre https e FIXA. O código recusa IP interno, credencial na URL,
  -- porta incomum e segredo na query string; a guarda SSRF roda de novo a
  -- cada chamada.
  url               text NOT NULL
                      CHECK (char_length(url) BETWEEN 12 AND 2000
                             AND url ~ '^https://'),
  method            text NOT NULL DEFAULT 'POST'
                      CHECK (method IN ('GET', 'POST')),
  -- `write` (padrão): só roda de verdade no auto-reply, simula no playground
  -- e nunca roda no rascunho. `read`: roda também no rascunho.
  risk              text NOT NULL DEFAULT 'write'
                      CHECK (risk IN ('read', 'write')),
  -- JSON `{ "Nome": "valor" }` cifrado com AES-GCM (`ENCRYPTION_KEY`).
  headers_encrypted text
                      CHECK (headers_encrypted IS NULL
                             OR (char_length(headers_encrypted) <= 20000
                                 AND headers_encrypted ~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$')),
  -- Só os NOMES dos cabeçalhos, para a tela (nunca os valores).
  header_names      text[] NOT NULL DEFAULT '{}'
                      CHECK (cardinality(header_names) <= 10),
  timeout_ms        integer NOT NULL DEFAULT 8000
                      CHECK (timeout_ms BETWEEN 1000 AND 10000),
  is_active         boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_custom_tools_account_name_key UNIQUE (account_id, name),
  -- Cabeçalho cifrado e lista de nomes andam juntos.
  CONSTRAINT ai_custom_tools_headers_consistent
    CHECK ((headers_encrypted IS NULL) = (cardinality(header_names) = 0))
);

COMMENT ON TABLE public.ai_custom_tools IS
  'SPEC 089 F6: ferramentas HTTP definidas pelo admin da conta para o agente de IA. URL fixa; o modelo so preenche os campos do esquema. Cabecalhos cifrados (AES-GCM).';
COMMENT ON COLUMN public.ai_custom_tools.headers_encrypted IS
  'SPEC 089 F6: JSON dos cabecalhos cifrado com AES-GCM (ENCRYPTION_KEY). NAO legivel por authenticated (privilegio por coluna); so o service_role le, na hora da chamada.';
COMMENT ON COLUMN public.ai_custom_tools.risk IS
  'SPEC 089 F6: write (padrao) roda de verdade so no auto-reply; read roda tambem no rascunho. No playground e na avaliacao nada roda (simulacao).';

CREATE INDEX IF NOT EXISTS ai_custom_tools_account_active_idx
  ON public.ai_custom_tools (account_id)
  WHERE is_active;

ALTER TABLE public.ai_custom_tools ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_custom_tools_select ON public.ai_custom_tools;
CREATE POLICY ai_custom_tools_select ON public.ai_custom_tools
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

REVOKE ALL ON public.ai_custom_tools FROM PUBLIC;
REVOKE ALL ON public.ai_custom_tools FROM anon;
REVOKE ALL ON public.ai_custom_tools FROM authenticated;
REVOKE ALL ON public.ai_custom_tools FROM service_role;
-- Tudo MENOS `headers_encrypted`: o navegador nunca lê o segredo cifrado.
GRANT SELECT (
  id, account_id, name, description, input_schema, url, method, risk,
  header_names, timeout_ms, is_active, created_by, created_at, updated_at
) ON public.ai_custom_tools TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_custom_tools TO service_role;

-- ------------------------------------------------------------
-- 2) Teto por conta (20) — trigger BEFORE INSERT
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_ai_custom_tool_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max CONSTANT integer := 20;
  v_n   integer;
BEGIN
  -- Serializa as inserções da mesma conta: sem a trava, duas corridas
  -- passariam juntas do teto.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_custom_tools:' || NEW.account_id::text, 107));
  SELECT count(*) INTO v_n FROM public.ai_custom_tools WHERE account_id = NEW.account_id;
  IF v_n >= v_max THEN
    RAISE EXCEPTION 'AI_CUSTOM_TOOL_LIMIT:%', v_max USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_ai_custom_tool_limit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_ai_custom_tool_limit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_ai_custom_tool_limit() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_ai_custom_tool_limit() FROM authenticated;

DROP TRIGGER IF EXISTS enforce_ai_custom_tool_limit_trigger ON public.ai_custom_tools;
CREATE TRIGGER enforce_ai_custom_tool_limit_trigger
  BEFORE INSERT ON public.ai_custom_tools
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ai_custom_tool_limit();

-- ------------------------------------------------------------
-- 3) updated_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_ai_custom_tools_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.update_ai_custom_tools_updated_at() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_ai_custom_tools_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_ai_custom_tools_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.update_ai_custom_tools_updated_at() FROM authenticated;

DROP TRIGGER IF EXISTS ai_custom_tools_updated_at ON public.ai_custom_tools;
CREATE TRIGGER ai_custom_tools_updated_at
  BEFORE UPDATE ON public.ai_custom_tools
  FOR EACH ROW EXECUTE FUNCTION public.update_ai_custom_tools_updated_at();

-- ------------------------------------------------------------
-- 4) Conferência de fim de migração (falha alto se algo não ficou)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_custom_tools'::regclass) THEN
    RAISE EXCEPTION '107: RLS desligada em ai_custom_tools.' USING ERRCODE = '55006';
  END IF;
  IF has_column_privilege('authenticated', 'public.ai_custom_tools', 'headers_encrypted', 'SELECT') THEN
    RAISE EXCEPTION '107: authenticated le headers_encrypted.' USING ERRCODE = '55006';
  END IF;
  IF has_table_privilege('anon', 'public.ai_custom_tools', 'SELECT') THEN
    RAISE EXCEPTION '107: anon le ai_custom_tools.' USING ERRCODE = '55006';
  END IF;
  IF has_function_privilege('anon', 'public.enforce_ai_custom_tool_limit()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_ai_custom_tool_limit()', 'EXECUTE')
     OR has_function_privilege('public', 'public.enforce_ai_custom_tool_limit()', 'EXECUTE') THEN
    RAISE EXCEPTION '107: funcao do teto executavel por anon/authenticated/PUBLIC.' USING ERRCODE = '55006';
  END IF;
END
$$;
