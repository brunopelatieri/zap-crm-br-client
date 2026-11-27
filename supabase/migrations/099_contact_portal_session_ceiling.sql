-- ============================================================
-- 099_contact_portal_session_ceiling.sql — SPEC 083 §15 (F5-04 e F5-10)
--
-- Só do ZAP. Duas correções da revisão de segurança da F5, sem mudar
-- assinatura, privilégio nem experiência de quem usa a área:
--
-- 1. F5-04 — `portal_resolve_session` ganha TETO ABSOLUTO.
--    Hoje a validade desliza: cada uso a mais de 5 minutos da última
--    gravação empurra `expires_at` para `NOW() + p_ttl_s`. O cookie do dono
--    morre em 30 dias fixos (`maxAge` só no login, session.ts), mas o
--    token roubado, usado ao menos uma vez a cada 30 dias, valia para
--    sempre. Agora a sessão só resolve se `created_at` for mais novo que
--    `p_ttl_s` (a rota passa PORTAL_SESSION_TTL_S = 30 dias, o mesmo
--    número do cookie): a validade continua deslizante DENTRO do teto, e
--    ninguém que não seja um atacante percebe a diferença.
--    `portal_select_account` e `portal_change_password` não têm `p_ttl_s`
--    e não mudam: as rotas só chegam a elas depois de `portal_resolve_session`
--    (`getPortalSession`), então a sessão acima do teto já caiu antes.
--
-- 2. F5-10 — `portal_account_settings_set`, quando `enabled` passa de
--    TRUE a FALSE, apaga os acessos de sessão da conta
--    (`contact_portal.session_access`) e as sessões que ficam sem nenhum
--    acesso. Antes, desligar a área não encerrava sessão, e religar
--    revivia sessões antigas (e roubadas). A sessão de quem também tem
--    acesso em OUTRA conta continua viva, só sem o acesso desta (como
--    `portal_set_blocked` faz). Perder o item do plano continua
--    preservando as sessões (PRD 082 D-6): o gatilho é só o interruptor
--    da conta. Limites, trava e validações do corpo seguem como na 093.
--
-- Privilégios (D-19): SECURITY DEFINER com `search_path` fixo, REVOKE de
-- PUBLIC, anon e authenticated em comandos separados (a 091 pode não
-- estar aplicada), GRANT só a service_role.
--
-- Idempotente (CREATE OR REPLACE). Não é para fork de terceiros: nada de
-- URL ou segredo aqui.
-- ============================================================

-- ------------------------------------------------------------
-- 1. portal_resolve_session — teto absoluto (F5-04)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.portal_resolve_session(
  p_token_hash  BYTEA,
  p_ttl_s       INTEGER
)
RETURNS TABLE (
  session_id    UUID,
  contact_id    UUID,
  account_id    UUID,
  contact_name  TEXT,
  account_name  TEXT,
  is_current    BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_s  RECORD;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RETURN;
  END IF;
  IF p_ttl_s IS NULL OR p_ttl_s <= 0 THEN
    RAISE EXCEPTION 'portal_resolve_session: invalid ttl' USING ERRCODE = '22023';
  END IF;

  -- Validade deslizante (`expires_at`) DENTRO de um teto absoluto: a
  -- sessão nunca vive mais que `p_ttl_s` desde o login (`created_at`),
  -- igual ao `maxAge` do cookie (F5-04).
  SELECT s.id, s.current_contact_id, s.last_seen_at
    INTO v_s
  FROM contact_portal.sessions s
  WHERE s.token_hash = p_token_hash
    AND s.expires_at > NOW()
    AND s.created_at > NOW() - make_interval(secs => p_ttl_s);

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Validade deslizante, gravando no máximo a cada 5 minutos.
  IF v_s.last_seen_at < NOW() - INTERVAL '5 minutes' THEN
    UPDATE contact_portal.sessions s
       SET last_seen_at = NOW(), expires_at = NOW() + make_interval(secs => p_ttl_s)
     WHERE s.id = v_s.id;
  END IF;

  RETURN QUERY
  SELECT v_s.id,
         a.contact_id,
         a.account_id,
         c.name,
         acc.name,
         COALESCE(a.contact_id = v_s.current_contact_id, FALSE)
  FROM contact_portal.session_access sa
  JOIN contact_portal.access a ON a.contact_id = sa.contact_id
  JOIN public.contacts c       ON c.id = a.contact_id
  JOIN public.accounts acc     ON acc.id = a.account_id
  WHERE sa.session_id = v_s.id
    AND a.password_hash IS NOT NULL
    AND a.blocked_at IS NULL
    AND contact_portal.account_is_eligible(a.account_id)
  ORDER BY acc.name, a.contact_id;
END;
$$;

-- ------------------------------------------------------------
-- 2. portal_account_settings_set — desligar encerra sessões (F5-10)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.portal_account_settings_set(
  p_account_id  UUID,
  p_patch       JSONB,
  p_user_id     UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_try      INTEGER := 0;
  v_was_on   BOOLEAN;
  v_now_on   BOOLEAN;
  v_sessions UUID[];
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'portal_account_settings_set: patch must be an object' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_patch) k
    WHERE k NOT IN ('enabled', 'channel_id', 'auth_template_id', 'keyword', 'terms_version')
  ) THEN
    RAISE EXCEPTION 'portal_account_settings_set: unknown key' USING ERRCODE = '22023';
  END IF;

  -- Canal e template precisam ser DA conta.
  IF p_patch ? 'channel_id' AND jsonb_typeof(p_patch -> 'channel_id') <> 'null'
     AND NOT EXISTS (
       SELECT 1 FROM public.channels ch
       WHERE ch.id = (p_patch ->> 'channel_id')::UUID AND ch.account_id = p_account_id
     ) THEN
    RAISE EXCEPTION 'portal_account_settings_set: channel not in account' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'auth_template_id' AND jsonb_typeof(p_patch -> 'auth_template_id') <> 'null'
     AND NOT EXISTS (
       SELECT 1 FROM public.message_templates t
       WHERE t.id = (p_patch ->> 'auth_template_id')::UUID AND t.account_id = p_account_id
     ) THEN
    RAISE EXCEPTION 'portal_account_settings_set: template not in account' USING ERRCODE = '22023';
  END IF;

  -- Primeira gravação cria a linha e o código curto (colisão: tenta de novo).
  WHILE NOT EXISTS (SELECT 1 FROM contact_portal.settings WHERE account_id = p_account_id) LOOP
    v_try := v_try + 1;
    IF v_try > 5 THEN
      RAISE EXCEPTION 'portal_account_settings_set: could not allocate public code' USING ERRCODE = '55000';
    END IF;
    INSERT INTO contact_portal.settings (account_id, public_code, updated_by)
    VALUES (p_account_id, contact_portal.new_public_code(), p_user_id)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- Valor ANTES da gravação, com a linha travada: duas chamadas
  -- concorrentes não disputam quem viu `TRUE -> FALSE` (F5-10).
  SELECT s.enabled INTO v_was_on
  FROM contact_portal.settings s
  WHERE s.account_id = p_account_id
  FOR UPDATE;

  UPDATE contact_portal.settings s
     SET enabled          = CASE WHEN p_patch ? 'enabled'
                                 THEN (p_patch ->> 'enabled')::BOOLEAN ELSE s.enabled END,
         channel_id       = CASE WHEN p_patch ? 'channel_id'
                                 THEN (p_patch ->> 'channel_id')::UUID ELSE s.channel_id END,
         auth_template_id = CASE WHEN p_patch ? 'auth_template_id'
                                 THEN (p_patch ->> 'auth_template_id')::UUID ELSE s.auth_template_id END,
         keyword          = CASE WHEN p_patch ? 'keyword'
                                 THEN NULLIF(btrim(p_patch ->> 'keyword'), '') ELSE s.keyword END,
         terms_version    = CASE WHEN p_patch ? 'terms_version'
                                 THEN NULLIF(btrim(p_patch ->> 'terms_version'), '') ELSE s.terms_version END,
         updated_at       = NOW(),
         updated_by       = p_user_id
   WHERE s.account_id = p_account_id
  RETURNING s.enabled INTO v_now_on;

  -- Desligar a área encerra as sessões que a abriam: religar não revive
  -- sessão antiga (nem roubada). Quem tem acesso em outra conta fica
  -- logado nela; a sessão que ficar sem nenhum acesso é apagada.
  IF v_was_on IS TRUE AND v_now_on IS NOT TRUE THEN
    WITH removed AS (
      DELETE FROM contact_portal.session_access sa
       USING contact_portal.access a
       WHERE a.contact_id = sa.contact_id
         AND a.account_id = p_account_id
      RETURNING sa.session_id
    )
    SELECT COALESCE(array_agg(DISTINCT r.session_id), '{}'::UUID[])
      INTO v_sessions
    FROM removed r;

    DELETE FROM contact_portal.sessions s
     WHERE s.id = ANY (v_sessions)
       AND NOT EXISTS (
         SELECT 1 FROM contact_portal.session_access sa WHERE sa.session_id = s.id
       );
  END IF;

  RETURN public.portal_account_settings_get(p_account_id);
END;
$$;

-- ------------------------------------------------------------
-- 3. Privilégios: só service_role (comandos separados, D-19)
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION public.portal_resolve_session(bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_resolve_session(bytea, integer) FROM anon;
REVOKE ALL ON FUNCTION public.portal_resolve_session(bytea, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.portal_resolve_session(bytea, integer) TO service_role;

REVOKE ALL ON FUNCTION public.portal_account_settings_set(uuid, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_account_settings_set(uuid, jsonb, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.portal_account_settings_set(uuid, jsonb, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.portal_account_settings_set(uuid, jsonb, uuid) TO service_role;

-- ------------------------------------------------------------
-- 4. Asserções finais (falham alto)
-- ------------------------------------------------------------

DO $$
DECLARE
  v_fn   TEXT;
  v_src  TEXT;
  v_args TEXT;
BEGIN
  -- 1. As duas funções existem com as MESMAS assinaturas, e só service_role
  --    executa. (`::regprocedure` falha se a assinatura mudou.)
  FOREACH v_fn IN ARRAY ARRAY[
    'public.portal_resolve_session(bytea,integer)',
    'public.portal_account_settings_set(uuid,jsonb,uuid)'
  ]
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '099: % executável por anon/authenticated/PUBLIC.', v_fn USING ERRCODE = '55006';
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '099: % sem EXECUTE para service_role.', v_fn USING ERRCODE = '55006';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION '099: % não é SECURITY DEFINER.', v_fn USING ERRCODE = '55006';
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = v_fn::regprocedure) IS DISTINCT FROM ARRAY['search_path=public'] THEN
      RAISE EXCEPTION '099: % sem search_path = public fixo.', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- 2. Retorno de `portal_resolve_session` intacto (a rota depende das 6 colunas).
  SELECT pg_get_function_result('public.portal_resolve_session(bytea,integer)'::regprocedure) INTO v_args;
  IF v_args IS DISTINCT FROM 'TABLE(session_id uuid, contact_id uuid, account_id uuid, contact_name text, account_name text, is_current boolean)' THEN
    RAISE EXCEPTION '099: retorno de portal_resolve_session mudou: %.', v_args USING ERRCODE = '55006';
  END IF;

  -- 3. Teto absoluto no corpo de `portal_resolve_session` (F5-04).
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.portal_resolve_session(bytea,integer)'::regprocedure;
  IF v_src NOT LIKE '%s.created_at > NOW() - make_interval(secs => p_ttl_s)%' THEN
    RAISE EXCEPTION '099: portal_resolve_session sem o teto absoluto por created_at (F5-04).' USING ERRCODE = '55006';
  END IF;

  -- 4. Desligar encerra sessão no corpo de `portal_account_settings_set` (F5-10),
  --    e o corpo da 093 (validações) continua lá.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.portal_account_settings_set(uuid,jsonb,uuid)'::regprocedure;
  IF v_src NOT LIKE '%DELETE FROM contact_portal.session_access%'
     OR v_src NOT LIKE '%DELETE FROM contact_portal.sessions%' THEN
    RAISE EXCEPTION '099: portal_account_settings_set não encerra sessões ao desligar (F5-10).' USING ERRCODE = '55006';
  END IF;
  IF v_src NOT LIKE '%channel not in account%'
     OR v_src NOT LIKE '%template not in account%'
     OR v_src NOT LIKE '%could not allocate public code%'
     OR v_src NOT LIKE '%unknown key%' THEN
    RAISE EXCEPTION '099: portal_account_settings_set perdeu validações da 093.' USING ERRCODE = '55006';
  END IF;

  -- 5. Ajudantes de contact_portal: continuam só do dono (093 §6).
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'contact_portal'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
           OR has_function_privilege('public', p.oid, 'EXECUTE')
           OR has_function_privilege('service_role', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION '099: função de contact_portal executável fora do dono.' USING ERRCODE = '55006';
  END IF;

  -- 6. Nenhuma `portal_*` em public ficou aberta a anon/authenticated/PUBLIC.
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname LIKE 'portal\_%'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
           OR has_function_privilege('public', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION '099: alguma public.portal_* executável por anon/authenticated/PUBLIC.' USING ERRCODE = '55006';
  END IF;
END;
$$;
