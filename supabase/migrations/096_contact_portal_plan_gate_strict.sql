-- ============================================================
-- 096_contact_portal_plan_gate_strict.sql — SPEC 083 §5.2 (PRD 082 D-2)
--
-- Só do ZAP (não existe no Valen Ranch). A área do contato é a PRIMEIRA
-- chave de recurso que bloqueia de verdade uma porta, e a semântica da
-- `plan_feature()` da 067 não serve para isso:
--
--   - chave ausente no plano → TRUE ("ilimitado", PRD 058 D-3);
--   - `platform_settings.quotas_enforced = FALSE` → TRUE para tudo.
--
-- Num deployment que nunca rodou o seed, ou com quotas desligadas, TODO
-- plano liberaria a área e o único freio seria o `enabled` de cada conta.
-- O ZAP é fork público: um terceiro que suba o app sem o seed teria a
-- porta aberta no primeiro clique em "ligar".
--
-- 1. `public.plan_feature_strict(account, key)` — permissão comercial,
--    não teto de uso. Três diferenças para `plan_feature()`:
--      a) chave ausente é FALSE;
--      b) `quotas_enforced` NÃO é consultado (o item vale mesmo em
--         deployment que não aplica quota);
--      c) conta sem `account_plans` é FALSE.
--    Lê `plans.features || account_plans.limit_overrides` como a 067, então
--    a exceção por conta do console (`limit_overrides`) continua valendo:
--    é o caminho da primeira conta piloto (PRD 082 D-1, F6).
--    `plan_feature()` fica como está para as cinco chaves antigas.
--
-- 2. `contact_portal.account_is_eligible` reescrita trocando
--    `plan_feature(` por `plan_feature_strict(`. Mesma assinatura e mesmo
--    corpo da 093 no resto: área ligada + conta não bloqueada. Tudo que
--    confere elegibilidade (candidates, portal_login, portal_resolve_session,
--    portal_public_account, portal_account_settings_get → `eligible`,
--    portal_account_summary) passa a usar a decisão estrita sem mudar.
--    O lado da conta no app (`src/lib/contact-portal/plan-gate.ts`) chama
--    `plan_feature_strict` direto, então rota, aba, ficha e área enxergam
--    uma decisão só.
--
-- Privilégios (D-19): SECURITY DEFINER com `search_path` fixo, REVOKE de
-- PUBLIC, anon e authenticated em comandos separados (a 091 pode não
-- estar aplicada), GRANT só a service_role — como toda `portal_*`.
--
-- Perder o item não apaga nada (PRD 082 D-6): senha, termos e sessões
-- ficam; só a próxima requisição é negada.
--
-- Pré-requisitos: 093 (schema `contact_portal` e `account_is_eligible`),
-- 067 (`plans`, `account_plans`). Idempotente: `CREATE OR REPLACE`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. plan_feature_strict
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.plan_feature_strict(p_account_id UUID, p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Sem CASE sobre a chave de quotas, de propósito (PRD 082 D-2).
  SELECT COALESCE(
    (
      SELECT ((p.features || ap.limit_overrides) ->> p_key)::boolean
      FROM account_plans ap
      JOIN plans p ON p.id = ap.plan_id
      WHERE ap.account_id = p_account_id
    ),
    FALSE
  );
$$;

ALTER FUNCTION public.plan_feature_strict(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.plan_feature_strict(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.plan_feature_strict(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.plan_feature_strict(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.plan_feature_strict(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.plan_feature_strict(UUID, TEXT) IS
  'PRD 082 D-2: chave de recurso fail-closed (ausente = FALSE, ignora quotas_enforced, sem account_plans = FALSE). Para permissão comercial, não para quota.';

-- ------------------------------------------------------------
-- 2. account_is_eligible → plan_feature_strict
--    Mesma assinatura, mesmo regime da 093 (LANGUAGE sql, STABLE,
--    search_path fixo, sem SECURITY DEFINER: ajudante interno chamado
--    só pelas `portal_*`, que são DEFINER). CREATE OR REPLACE preserva a
--    ACL "ninguém além do dono" conferida na 093.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION contact_portal.account_is_eligible(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1
           FROM contact_portal.settings s
           JOIN public.accounts a ON a.id = s.account_id
           WHERE s.account_id = p_account_id
             AND s.enabled
             AND a.blocked_at IS NULL
         )
     AND public.plan_feature_strict(p_account_id, 'contact_portal_enabled');
$$;

-- ------------------------------------------------------------
-- 3. Asserções (falham alto, padrão 089/090/093)
--
--    Sem linha de teste em `accounts` (exigiria usuário em auth.users e
--    dispararia handle_new_user). As três semânticas do PRD 082 D-2 são
--    provadas (a) sobre os operadores jsonb que a função usa, com
--    literais; (b) sobre o corpo da função; (c) sobre TODAS as contas
--    reais, só leitura, comparando a função com o valor cru do catálogo;
--    (d) com um UUID que não é conta.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_fn      CONSTANT TEXT := 'public.plan_feature_strict(uuid,text)';
  v_key     CONSTANT TEXT := 'contact_portal_enabled';
  v_src     TEXT;
  v_quotas  BOOLEAN;
  v_bad     INTEGER;
  v_legacy  INTEGER;
BEGIN
  -- Privilégios: só service_role (D-19).
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '096: % executável por anon/authenticated/PUBLIC.', v_fn USING ERRCODE = '55006';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '096: % sem EXECUTE para service_role — o servidor quebraria.', v_fn USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = v_fn::regprocedure
      AND prosecdef
      AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=public')
  ) THEN
    RAISE EXCEPTION '096: % sem SECURITY DEFINER ou sem search_path fixo.', v_fn USING ERRCODE = '55006';
  END IF;

  -- (a) Semântica dos operadores que a função usa, com literais.
  --     Chave ausente → NULL → COALESCE FALSE.
  IF COALESCE(('{}'::jsonb ->> v_key)::boolean, FALSE) IS NOT FALSE THEN
    RAISE EXCEPTION '096: chave ausente não resolve para FALSE.' USING ERRCODE = '55006';
  END IF;
  --     false explícito (o seed) → FALSE.
  IF COALESCE((('{"contact_portal_enabled":false}'::jsonb || '{}'::jsonb) ->> v_key)::boolean, FALSE) IS NOT FALSE THEN
    RAISE EXCEPTION '096: false explícito não resolve para FALSE.' USING ERRCODE = '55006';
  END IF;
  --     Override por conta libera (limit_overrides vence features).
  IF COALESCE((('{"contact_portal_enabled":false}'::jsonb || '{"contact_portal_enabled":true}'::jsonb) ->> v_key)::boolean, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION '096: override por conta não libera.' USING ERRCODE = '55006';
  END IF;
  --     Override por conta também pode NEGAR o que o plano dá.
  IF COALESCE((('{"contact_portal_enabled":true}'::jsonb || '{"contact_portal_enabled":false}'::jsonb) ->> v_key)::boolean, FALSE) IS NOT FALSE THEN
    RAISE EXCEPTION '096: override por conta não nega.' USING ERRCODE = '55006';
  END IF;

  -- (b) Corpo: não consulta quotas_enforced e cai em FALSE.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn::regprocedure;
  IF v_src ILIKE '%quotas_enforced%' THEN
    RAISE EXCEPTION '096: plan_feature_strict consulta quotas_enforced — tem de ignorar (D-2).' USING ERRCODE = '55006';
  END IF;
  IF v_src NOT ILIKE '%COALESCE(%' OR v_src NOT ILIKE '%FALSE%' THEN
    RAISE EXCEPTION '096: plan_feature_strict sem COALESCE(…, FALSE).' USING ERRCODE = '55006';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'contact_portal.account_is_eligible(uuid)'::regprocedure;
  IF v_src NOT LIKE '%plan_feature_strict(%' OR v_src ~ 'plan_feature\(' THEN
    RAISE EXCEPTION '096: account_is_eligible ainda usa plan_feature() — a área liberaria chave ausente.' USING ERRCODE = '55006';
  END IF;

  -- (c) Toda conta real: função == valor cru do catálogo, chave ausente = FALSE.
  SELECT count(*) INTO v_bad
  FROM account_plans ap
  JOIN plans p ON p.id = ap.plan_id
  WHERE public.plan_feature_strict(ap.account_id, v_key)
        IS DISTINCT FROM COALESCE(((p.features || ap.limit_overrides) ->> v_key)::boolean, FALSE);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '096: plan_feature_strict diverge do catálogo em % conta(s).', v_bad USING ERRCODE = '55006';
  END IF;

  --     quotas_enforced = FALSE: a legada libera todo mundo; a estrita, não.
  SELECT quotas_enforced INTO v_quotas FROM platform_settings;
  IF v_quotas IS FALSE THEN
    SELECT count(*) INTO v_legacy
    FROM account_plans ap
    WHERE public.plan_feature(ap.account_id, v_key)
      AND NOT public.plan_feature_strict(ap.account_id, v_key);
    SELECT count(*) INTO v_bad
    FROM account_plans ap
    JOIN plans p ON p.id = ap.plan_id
    WHERE COALESCE(((p.features || ap.limit_overrides) ->> v_key)::boolean, FALSE) IS FALSE;
    -- Toda conta sem o item tem de ser liberada pela legada e negada pela estrita.
    IF v_legacy <> v_bad THEN
      RAISE EXCEPTION '096: com quotas_enforced = false, % conta(s) sem o item, mas só % divergem entre plan_feature e plan_feature_strict.', v_bad, v_legacy USING ERRCODE = '55006';
    END IF;
    RAISE NOTICE '096: quotas_enforced = false — plan_feature() libera % conta(s) que plan_feature_strict() nega (esperado, PRD 082 D-2).', v_legacy;
  END IF;

  -- (d) Conta inexistente (sem account_plans) → FALSE, nunca NULL.
  IF public.plan_feature_strict(gen_random_uuid(), v_key) IS NOT FALSE THEN
    RAISE EXCEPTION '096: conta sem account_plans não resolve para FALSE.' USING ERRCODE = '55006';
  END IF;

  -- Ajudantes de contact_portal: continuam só do dono (093 §6).
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
    RAISE EXCEPTION '096: função de contact_portal executável fora do dono.' USING ERRCODE = '55006';
  END IF;
END;
$$;
