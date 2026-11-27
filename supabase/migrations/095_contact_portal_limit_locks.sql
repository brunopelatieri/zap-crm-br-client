-- ============================================================
-- 095_contact_portal_limit_locks.sql — SPEC 083 F1 (PRD 082)
--
-- ORIGEM: cópia byte a byte de `096_contact_portal_limit_locks.sql` do Valen Ranch (SPEC 084
-- daquele repositório). Só este aviso de origem difere; o SQL abaixo é
-- idêntico, inclusive o cabeçalho e os números de migração citados nos
-- comentários, que são os do Ranch: 094 → 093, 095 → 094, 096 → 095 no
-- ZAP. A guarda por plano fail-closed (`plan_feature_strict`, PRD 082
-- D-2) entra na 096 do ZAP, que reescreve `account_is_eligible`.
-- ============================================================

-- ============================================================
-- 096_contact_portal_limit_locks.sql — SPEC 084 F6 (proposta P-1)
--
-- Achados da revisão de segurança da F6 (SPEC 084 §13.2) que só se
-- corrigem no banco. Mesmas assinaturas da 094: `CREATE OR REPLACE`,
-- sem mudar o que as rotas recebem.
--
-- 1. Corrida nos limites (A-4)
--
--    Os limites da 094 são "conta e depois grava", sem trava: pedidos em
--    paralelo leem o mesmo contador antes de qualquer INSERT (READ
--    COMMITTED não vê o que o outro ainda não confirmou), e o laço de
--    `portal_complete_code` lia o código sem `FOR UPDATE`. Cem tentativas
--    simultâneas passavam todas pelo limite de 10 (login) ou de 5
--    (código), e dois pedidos de código simultâneos para o mesmo contato
--    batiam no índice único `uq_contact_portal_codes_one_active` (500).
--
--    Agora uma trava de transação por TELEFONE (`contact_portal.lock_phone`,
--    `pg_advisory_xact_lock` sobre o hash do telefone canônico) serializa
--    tudo que conta ou gasta o limite daquele telefone: pedir código,
--    convite, concluir código e entrar. É o limite que protege a conta de
--    alguém (A-6 conta 25 palpites/h por telefone). `portal_complete_code`
--    também trava as linhas de `codes` que lê (`FOR UPDATE OF k`): com a
--    reavaliação do READ COMMITTED, um código que chegou a 5 erros
--    enquanto esperava sai do laço. `portal_change_password` trava a linha
--    da sessão: palpites da senha atual por uma sessão roubada também
--    viram fila.
--
--    De propósito, SEM trava por IP: numa prova, dezenas de pessoas saem
--    pelo mesmo IP (Wi-Fi do evento, 4G com NAT), e serializar o bcrypt
--    de todas (~74 ms cada, §13.3) encostaria no `statement_timeout` de
--    8 s. Os limites por IP seguem aproximados sob concorrência; os por
--    telefone, que são os que importam contra força bruta, ficam exatos.
--    Ordem das travas: no máximo UMA trava consultiva por chamada, antes
--    de qualquer trava de linha — sem ciclo, sem deadlock.
--
-- 2. Tempo do pedido de código (A-3)
--
--    `portal_request_code` só fazia bcrypt (bf 8, ~18 ms) quando achava
--    contato. Os dois ramos `no_match` passam a rodar um bcrypt de mesmo
--    custo. Soma-se ao piso de 750 ms da rota (`holdUntil`, F6).
--
-- 3. Chave do convite pelo telefone canônico (A-9)
--
--    A web conta `send_phone` pelo canônico de 13 dígitos (o primeiro
--    candidato de `phoneCandidates`, TS), e o convite contava pelo
--    `phone_normalized` gravado, que pode ser o celular legado de 12
--    dígitos (SPEC 050 D-6). Contato salvo sem o nono dígito tinha dois
--    contadores. `contact_portal.canonical_phone` repete a regra do TS;
--    a paridade é presa pelas asserções abaixo e por
--    `src/lib/contact-portal/phone.test.ts` (mesmos pares).
--
-- O que NÃO muda: assinaturas, retorno, grants (só service_role),
-- limites (`p_limits`, fonte única em `limits.ts`), regra de
-- elegibilidade. Idempotente; asserções no fim falham alto.
-- ============================================================

-- ============================================================
-- 1. Ajudantes (schema contact_portal, só o dono executa)
-- ============================================================

-- Telefone gravado → canônico da SPEC 050, como o primeiro candidato de
-- `phoneCandidates` (src/lib/contact-portal/phone.ts): celular legado
-- (55 + DDD + 8 dígitos começando com 9) ganha o nono dígito; o resto
-- (celular atual, fixo, estrangeiro) fica como está.
CREATE OR REPLACE FUNCTION contact_portal.canonical_phone(p_phone TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN p_phone ~ '^55[1-9][0-9]9[0-9]{7}$'
             THEN substr(p_phone, 1, 4) || '9' || substr(p_phone, 5)
           ELSE p_phone
         END;
$$;

-- Trava de transação por telefone (A-4). `p_key` é o `key_hash` do
-- canônico — a mesma chave dos contadores `send_phone`/`login_phone`.
CREATE OR REPLACE FUNCTION contact_portal.lock_phone(p_key TEXT)
RETURNS VOID
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('contact_portal:phone:' || p_key, 0));
$$;

REVOKE ALL ON FUNCTION contact_portal.canonical_phone(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION contact_portal.lock_phone(TEXT)      FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- 2. portal_request_code — trava por telefone + bcrypt no no_match
-- ============================================================

CREATE OR REPLACE FUNCTION public.portal_request_code(
  p_phones       TEXT[],
  p_public_code  TEXT,
  p_purpose      TEXT,
  p_code         TEXT,
  p_ip_hash      TEXT,
  p_limits       JSONB
)
RETURNS TABLE (status TEXT, contact_id UUID, account_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_phone_key  TEXT;
  v_scope      UUID;
  v_contact    UUID;
  v_account    UUID;
BEGIN
  PERFORM contact_portal.check_phones(p_phones);
  PERFORM contact_portal.check_ip_hash(p_ip_hash);
  IF p_purpose IS NULL OR p_purpose NOT IN ('first_access', 'reset') THEN
    RAISE EXCEPTION 'portal_request_code: invalid purpose' USING ERRCODE = '22023';
  END IF;
  IF p_code IS NULL OR p_code !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'portal_request_code: invalid code format' USING ERRCODE = '22023';
  END IF;

  PERFORM contact_portal.housekeep();
  v_phone_key := contact_portal.key_hash(p_phones[1]);

  -- 096 (A-4): um pedido por vez por telefone — o limite e o índice
  -- único de código ativo deixam de depender da sorte.
  PERFORM contact_portal.lock_phone(v_phone_key);

  IF contact_portal.attempt_count('send_ip', p_ip_hash, 3600)
       >= contact_portal.limit_value(p_limits, 'send_ip_per_hour')
     OR contact_portal.attempt_count('send_phone', v_phone_key,
          contact_portal.limit_value(p_limits, 'send_phone_min_interval_s')) > 0
     OR contact_portal.attempt_count('send_phone', v_phone_key, 3600)
       >= contact_portal.limit_value(p_limits, 'send_phone_per_hour') THEN
    RETURN QUERY SELECT 'throttled'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- Conta ANTES de procurar: o limite vale igual para quem é contato e
  -- para quem não é (anti-enumeração).
  INSERT INTO contact_portal.attempts (kind, key_hash)
  VALUES ('send_ip', p_ip_hash), ('send_phone', v_phone_key);

  IF p_public_code IS NOT NULL THEN
    v_scope := contact_portal.account_by_code(p_public_code);
    IF v_scope IS NULL THEN
      -- 096 (A-3): mesmo custo do ramo que grava o código.
      PERFORM extensions.crypt(p_code, extensions.gen_salt('bf', 8));
      RETURN QUERY SELECT 'no_match'::TEXT, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  -- Pelo endereço genérico, a conta da conversa mais recente (D-6).
  SELECT c.contact_id, c.account_id
    INTO v_contact, v_account
  FROM contact_portal.candidates(p_phones, v_scope) c
  ORDER BY c.last_activity DESC NULLS LAST, c.contact_id
  LIMIT 1;

  IF v_contact IS NULL THEN
    PERFORM extensions.crypt(p_code, extensions.gen_salt('bf', 8));
    RETURN QUERY SELECT 'no_match'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  UPDATE contact_portal.codes SET consumed_at = NOW()
   WHERE contact_id = v_contact AND consumed_at IS NULL;

  INSERT INTO contact_portal.codes (contact_id, purpose, code_hash, expires_at)
  VALUES (
    v_contact,
    p_purpose,
    extensions.crypt(p_code, extensions.gen_salt('bf', 8)),
    NOW() + make_interval(secs => contact_portal.limit_value(p_limits, 'code_ttl_s'))
  );

  RETURN QUERY SELECT 'sent'::TEXT, v_contact, v_account;
END;
$$;

-- ============================================================
-- 3. portal_complete_code — trava por telefone + FOR UPDATE nos códigos
-- ============================================================

CREATE OR REPLACE FUNCTION public.portal_complete_code(
  p_phones         TEXT[],
  p_public_code    TEXT,
  p_code           TEXT,
  p_password       TEXT,
  p_terms_version  TEXT,
  p_ip_hash        TEXT,
  p_limits         JSONB
)
RETURNS TABLE (status TEXT, contact_id UUID, account_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_scope     UUID;
  v_scope_ok  BOOLEAN := TRUE;
  v_row       RECORD;
  v_seen      INTEGER := 0;
  v_hit       UUID;
  v_hit_acct  UUID;
  v_max       INTEGER;
BEGIN
  PERFORM contact_portal.check_phones(p_phones);
  PERFORM contact_portal.check_ip_hash(p_ip_hash);
  PERFORM contact_portal.check_password(p_password);
  IF p_code IS NULL OR p_code !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'portal_complete_code: invalid code format' USING ERRCODE = '22023';
  END IF;

  v_max := contact_portal.limit_value(p_limits, 'code_max_attempts');

  -- 096 (A-4): um palpite por vez por telefone — o limite de 5 erros por
  -- código vale de verdade.
  PERFORM contact_portal.lock_phone(contact_portal.key_hash(p_phones[1]));

  IF contact_portal.attempt_count('code_ip', p_ip_hash,
       contact_portal.limit_value(p_limits, 'code_ip_window_s'))
     >= contact_portal.limit_value(p_limits, 'code_ip_fail_max') THEN
    RETURN QUERY SELECT 'throttled'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_public_code IS NOT NULL THEN
    v_scope := contact_portal.account_by_code(p_public_code);
    v_scope_ok := v_scope IS NOT NULL;
  END IF;

  IF v_scope_ok THEN
    FOR v_row IN
      SELECT k.contact_id, k.code_hash, cand.account_id
      FROM contact_portal.codes k
      JOIN contact_portal.candidates(p_phones, v_scope) cand ON cand.contact_id = k.contact_id
      WHERE k.consumed_at IS NULL
        AND k.expires_at > NOW()
      ORDER BY k.created_at DESC
      FOR UPDATE OF k
    LOOP
      v_seen := v_seen + 1;
      IF extensions.crypt(p_code, v_row.code_hash) = v_row.code_hash THEN
        v_hit := v_row.contact_id;
        v_hit_acct := v_row.account_id;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_hit IS NULL THEN
    IF v_seen = 0 THEN
      PERFORM extensions.crypt(p_code, extensions.gen_salt('bf', 8));
    ELSE
      -- Erro conta contra todo código ativo daquele telefone; no limite,
      -- o código morre e é preciso pedir outro.
      UPDATE contact_portal.codes k
         SET attempts = k.attempts + 1,
             consumed_at = CASE WHEN k.attempts + 1 >= v_max THEN NOW() ELSE NULL END
       WHERE k.consumed_at IS NULL
         AND k.expires_at > NOW()
         AND k.contact_id IN (
           SELECT cand.contact_id FROM contact_portal.candidates(p_phones, v_scope) cand
         );
    END IF;
    INSERT INTO contact_portal.attempts (kind, key_hash) VALUES ('code_ip', p_ip_hash);
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  UPDATE contact_portal.codes SET consumed_at = NOW()
   WHERE contact_id = v_hit AND consumed_at IS NULL;

  INSERT INTO contact_portal.access AS a
    (contact_id, account_id, phone, password_hash, activated_at, terms_version, terms_accepted_at)
  VALUES (
    v_hit,
    v_hit_acct,
    p_phones[1],
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
    NOW(),
    p_terms_version,
    CASE WHEN p_terms_version IS NOT NULL THEN NOW() END
  )
  ON CONFLICT (contact_id) DO UPDATE
    SET password_hash     = EXCLUDED.password_hash,
        activated_at      = COALESCE(a.activated_at, NOW()),
        terms_version     = COALESCE(EXCLUDED.terms_version, a.terms_version),
        terms_accepted_at = COALESCE(EXCLUDED.terms_accepted_at, a.terms_accepted_at),
        updated_at        = NOW();

  -- Senha nova: nenhuma sessão antiga continua abrindo este acesso.
  DELETE FROM contact_portal.session_access WHERE contact_id = v_hit;

  RETURN QUERY SELECT 'ok'::TEXT, v_hit, v_hit_acct;
END;
$$;

-- ============================================================
-- 4. portal_login — trava por telefone
-- ============================================================

CREATE OR REPLACE FUNCTION public.portal_login(
  p_phones    TEXT[],
  p_password  TEXT,
  p_ip_hash   TEXT,
  p_limits    JSONB
)
RETURNS TABLE (status TEXT, contact_ids UUID[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_phone_key  TEXT;
  v_window     INTEGER;
  v_row        RECORD;
  v_seen       INTEGER := 0;
  v_hits       UUID[] := '{}';
BEGIN
  PERFORM contact_portal.check_phones(p_phones);
  PERFORM contact_portal.check_ip_hash(p_ip_hash);
  IF p_password IS NULL OR octet_length(p_password) NOT BETWEEN 1 AND 72 THEN
    RAISE EXCEPTION 'portal_login: invalid password length' USING ERRCODE = '22023';
  END IF;

  PERFORM contact_portal.housekeep();
  v_phone_key := contact_portal.key_hash(p_phones[1]);
  v_window := contact_portal.limit_value(p_limits, 'login_window_s');

  -- 096 (A-4): uma tentativa por vez por telefone — o limite de 10 erros
  -- deixa de ser multiplicado por pedidos em paralelo.
  PERFORM contact_portal.lock_phone(v_phone_key);

  IF contact_portal.attempt_count('login_ip', p_ip_hash, v_window)
       >= contact_portal.limit_value(p_limits, 'login_ip_fail_max')
     OR contact_portal.attempt_count('login_phone', v_phone_key, v_window)
       >= contact_portal.limit_value(p_limits, 'login_phone_fail_max') THEN
    RETURN QUERY SELECT 'throttled'::TEXT, '{}'::UUID[];
    RETURN;
  END IF;

  FOR v_row IN
    SELECT a.contact_id, a.password_hash
    FROM contact_portal.access a
    JOIN contact_portal.candidates(p_phones, NULL) cand ON cand.contact_id = a.contact_id
    WHERE a.password_hash IS NOT NULL
    ORDER BY a.contact_id
    LIMIT 10
  LOOP
    v_seen := v_seen + 1;
    IF extensions.crypt(p_password, v_row.password_hash) = v_row.password_hash THEN
      v_hits := v_hits || v_row.contact_id;
    END IF;
  END LOOP;

  IF v_seen = 0 THEN
    PERFORM extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  END IF;

  IF cardinality(v_hits) = 0 THEN
    INSERT INTO contact_portal.attempts (kind, key_hash)
    VALUES ('login_ip', p_ip_hash), ('login_phone', v_phone_key);
    RETURN QUERY SELECT 'invalid'::TEXT, '{}'::UUID[];
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::TEXT, v_hits;
END;
$$;

-- ============================================================
-- 5. portal_change_password — trava a linha da sessão
-- ============================================================

CREATE OR REPLACE FUNCTION public.portal_change_password(
  p_token_hash  BYTEA,
  p_current     TEXT,
  p_new         TEXT,
  p_ip_hash     TEXT,
  p_limits      JSONB
)
RETURNS TABLE (status TEXT, changed INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_sid  UUID;
  v_row  RECORD;
  v_new  TEXT;
  v_n    INTEGER := 0;
BEGIN
  PERFORM contact_portal.check_ip_hash(p_ip_hash);
  PERFORM contact_portal.check_password(p_new);
  IF p_current IS NULL OR octet_length(p_current) NOT BETWEEN 1 AND 72 THEN
    RAISE EXCEPTION 'portal_change_password: invalid password length' USING ERRCODE = '22023';
  END IF;

  -- 096 (A-4): FOR UPDATE — palpites da senha atual pela mesma sessão
  -- viram fila, e o limite abaixo os vê um a um.
  SELECT s.id INTO v_sid
  FROM contact_portal.sessions s
  WHERE s.token_hash = p_token_hash AND s.expires_at > NOW()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_session'::TEXT, 0;
    RETURN;
  END IF;

  -- Sessão roubada não vira oráculo da senha atual: mesmo limite do login.
  IF contact_portal.attempt_count('login_ip', p_ip_hash,
       contact_portal.limit_value(p_limits, 'login_window_s'))
     >= contact_portal.limit_value(p_limits, 'login_ip_fail_max') THEN
    RETURN QUERY SELECT 'throttled'::TEXT, 0;
    RETURN;
  END IF;

  v_new := extensions.crypt(p_new, extensions.gen_salt('bf', 10));

  FOR v_row IN
    SELECT a.contact_id, a.password_hash
    FROM contact_portal.session_access sa
    JOIN contact_portal.access a ON a.contact_id = sa.contact_id
    WHERE sa.session_id = v_sid
      AND a.password_hash IS NOT NULL
      AND a.blocked_at IS NULL
      AND contact_portal.account_is_eligible(a.account_id)
  LOOP
    IF extensions.crypt(p_current, v_row.password_hash) = v_row.password_hash THEN
      UPDATE contact_portal.access a
         SET password_hash = v_new, updated_at = NOW()
       WHERE a.contact_id = v_row.contact_id;
      DELETE FROM contact_portal.session_access sa
       WHERE sa.contact_id = v_row.contact_id AND sa.session_id <> v_sid;
      v_n := v_n + 1;
    END IF;
  END LOOP;

  IF v_n = 0 THEN
    INSERT INTO contact_portal.attempts (kind, key_hash) VALUES ('login_ip', p_ip_hash);
    RETURN QUERY SELECT 'invalid'::TEXT, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::TEXT, v_n;
END;
$$;

-- ============================================================
-- 6. portal_invite — chave e trava pelo telefone canônico
-- ============================================================

CREATE OR REPLACE FUNCTION public.portal_invite(
  p_account_id  UUID,
  p_contact_id  UUID,
  p_code        TEXT,
  p_user_id     UUID,
  p_limits      JSONB
)
RETURNS TABLE (status TEXT, phone TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_c        RECORD;
  v_phone    TEXT;
  v_key      TEXT;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'portal_invite: invalid code format' USING ERRCODE = '22023';
  END IF;

  SELECT c.id, c.phone_normalized, c.opt_in_status
    INTO v_c
  FROM public.contacts c
  WHERE c.id = p_contact_id AND c.account_id = p_account_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF NOT contact_portal.account_is_eligible(p_account_id) THEN
    RETURN QUERY SELECT 'not_eligible'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM contact_portal.access a WHERE a.contact_id = p_contact_id AND a.blocked_at IS NOT NULL) THEN
    RETURN QUERY SELECT 'blocked'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  -- Convite é mensagem da empresa: respeita o opt-out (D-10).
  IF v_c.opt_in_status = 'opted_out' THEN
    RETURN QUERY SELECT 'opted_out'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF v_c.phone_normalized IS NULL OR v_c.phone_normalized !~ '^[0-9]{10,15}$' THEN
    RETURN QUERY SELECT 'invalid_phone'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- 096 (A-9): a mesma chave da web (canônico), e a mesma trava (A-4).
  v_phone := contact_portal.canonical_phone(v_c.phone_normalized);
  v_key := contact_portal.key_hash(v_phone);
  PERFORM contact_portal.lock_phone(v_key);

  IF contact_portal.attempt_count('send_phone', v_key,
       contact_portal.limit_value(p_limits, 'send_phone_min_interval_s')) > 0
     OR contact_portal.attempt_count('send_phone', v_key, 3600)
       >= contact_portal.limit_value(p_limits, 'send_phone_per_hour') THEN
    RETURN QUERY SELECT 'throttled'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  INSERT INTO contact_portal.attempts (kind, key_hash) VALUES ('send_phone', v_key);

  INSERT INTO contact_portal.access AS a (contact_id, account_id, phone, invited_at, invited_by)
  VALUES (p_contact_id, p_account_id, v_phone, NOW(), p_user_id)
  ON CONFLICT (contact_id) DO UPDATE
    SET invited_at = NOW(), invited_by = EXCLUDED.invited_by, updated_at = NOW();

  UPDATE contact_portal.codes SET consumed_at = NOW()
   WHERE contact_id = p_contact_id AND consumed_at IS NULL;

  INSERT INTO contact_portal.codes (contact_id, purpose, code_hash, expires_at)
  VALUES (
    p_contact_id,
    'invite',
    extensions.crypt(p_code, extensions.gen_salt('bf', 8)),
    NOW() + make_interval(secs => contact_portal.limit_value(p_limits, 'invite_code_ttl_s'))
  );

  RETURN QUERY SELECT 'sent'::TEXT, v_c.phone_normalized;
END;
$$;

-- ============================================================
-- 7. Grants das funções reescritas: só service_role (como na 094)
-- ============================================================

DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.portal_request_code(text[],text,text,text,text,jsonb)',
    'public.portal_complete_code(text[],text,text,text,text,text,jsonb)',
    'public.portal_login(text[],text,text,jsonb)',
    'public.portal_change_password(bytea,text,text,text,jsonb)',
    'public.portal_invite(uuid,uuid,text,uuid,jsonb)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END;
$$;

-- ============================================================
-- 8. Asserções finais (falham alto)
-- ============================================================

DO $$
DECLARE
  v_fn     TEXT;
  v_src    TEXT;
  v_pair   TEXT[];
BEGIN
  -- 1. canonical_phone = primeiro candidato de `phoneCandidates` (TS).
  --    Mesmos pares em src/lib/contact-portal/phone.test.ts.
  FOREACH v_pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['551999249658',  '5519999249658'],  -- celular legado → ganha o 9
    ARRAY['5519999249658', '5519999249658'],  -- celular atual
    ARRAY['551932345678',  '551932345678'],   -- fixo
    ARRAY['551188887777',  '551188887777'],   -- 8 dígitos começando com 8: fixo para o br.ts
    ARRAY['447911123456',  '447911123456']    -- estrangeiro
  ]
  LOOP
    IF contact_portal.canonical_phone(v_pair[1]) IS DISTINCT FROM v_pair[2] THEN
      RAISE EXCEPTION '096: canonical_phone(%) = %, esperado %.',
        v_pair[1], contact_portal.canonical_phone(v_pair[1]), v_pair[2]
        USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- 2. Funções reescritas: só service_role, e com a trava no corpo.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.portal_request_code(text[],text,text,text,text,jsonb)',
    'public.portal_complete_code(text[],text,text,text,text,text,jsonb)',
    'public.portal_login(text[],text,text,jsonb)',
    'public.portal_change_password(bytea,text,text,text,jsonb)',
    'public.portal_invite(uuid,uuid,text,uuid,jsonb)'
  ]
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '096: % executável por anon/authenticated/PUBLIC.', v_fn USING ERRCODE = '55006';
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '096: % sem EXECUTE para service_role.', v_fn USING ERRCODE = '55006';
    END IF;
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF v_src NOT LIKE '%lock_phone%' AND v_src NOT LIKE '%FOR UPDATE%' THEN
      RAISE EXCEPTION '096: % sem trava (A-4).', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- 3. Ajudantes de contact_portal: ninguém além do dono (inclui os novos).
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
