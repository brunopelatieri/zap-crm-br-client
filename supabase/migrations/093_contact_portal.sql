-- ============================================================
-- 093_contact_portal.sql — SPEC 083 F1 (PRD 082)
--
-- ORIGEM: cópia byte a byte de `094_contact_portal.sql` do Valen Ranch (SPEC 084
-- daquele repositório). Só este aviso de origem difere; o SQL abaixo é
-- idêntico, inclusive o cabeçalho e os números de migração citados nos
-- comentários, que são os do Ranch: 094 → 093, 095 → 094, 096 → 095 no
-- ZAP. A guarda por plano fail-closed (`plan_feature_strict`, PRD 082
-- D-2) entra na 096 do ZAP, que reescreve `account_is_eligible`.
-- ============================================================

-- ============================================================
-- 094_contact_portal.sql — SPEC 084 F1 (PRD 081, revisão 3)
--
-- Área do contato: o contato de uma conta entra em `/area` com
-- telefone + senha. Esta migração cria TODO o banco dela; não há
-- código de aplicação que a use ainda (F2 em diante).
--
-- O desenho, em uma frase: o contato NÃO é usuário do Supabase Auth.
-- Não ganha `auth.users`, `profiles`, JWT nem papel Postgres. Por isso
-- nenhuma policy da CRM e nenhum dos `GRANT … TO authenticated` o
-- alcança — o isolamento vem da construção, não de auditoria (PRD 081
-- D-3/D-5). O preço: tudo que é dele vive aqui e só se alcança por
-- funções `public.portal_*` que SÓ `service_role` executa.
--
-- 1. Schema `contact_portal`
--
--    Fora do PostgREST (não está em "Exposed schemas" — conferir no
--    painel depois de aplicar) e sem USAGE para anon/authenticated. As
--    tabelas têm RLS ligada e NENHUMA policy, e nenhum papel além do
--    dono (postgres) tem privilégio nelas: nem `service_role`, que só
--    entra pelas funções `SECURITY DEFINER`.
--
--    | Tabela         | Para quê                                              |
--    | settings       | a conta liga a área, canal, template, palavra-chave   |
--    | access         | a credencial de UM contato (logo, de uma conta) — D-2 |
--    | codes          | código de 6 dígitos, só o hash bcrypt, um ativo       |
--    | sessions       | sessão opaca: só o sha256 do token do cookie          |
--    | session_access | quais acessos uma sessão abriu (os que bateram)       |
--    | attempts       | contadores de limite (envio, código, login) no banco  |
--
-- 2. Elegibilidade numa função só (SPEC 084 E-1)
--
--    Conta elegível = `settings.enabled` + `plan_feature(...,
--    'contact_portal_enabled')` + `accounts.blocked_at IS NULL`. Acesso
--    elegível = conta elegível + `access.blocked_at IS NULL`. Toda
--    função reconfere a cada chamada; não existe cache. Desligar a
--    área, bloquear a conta (SPEC 062) ou o acesso corta na próxima
--    requisição.
--
-- 3. Telefone: candidatos (E-2)
--
--    `contacts.phone_normalized` é só "tira não dígito" (022), e há
--    celulares salvos sem o nono dígito. O servidor manda até dois
--    candidatos (canônico SPEC 050 e a variante legada); o primeiro é
--    o canônico e é a chave dos contadores por telefone. Índice novo
--    em `contacts(phone_normalized)`: o UNIQUE da 022 começa por
--    `account_id` e não serve para buscar o telefone em todas as contas.
--
-- 4. Limites vêm do servidor (SPEC 084 §5)
--
--    Cada função recebe `p_limits jsonb` (fonte única:
--    `src/lib/contact-portal/limits.ts`) e falha alto se faltar chave.
--    Nada de limite "padrão" escondido aqui.
--
-- 5. Anti-enumeração
--
--    `portal_request_code` registra a tentativa ANTES de procurar o
--    contato, então o limite bate igual para quem é e quem não é
--    contato; a rota responde sempre a mesma frase e envia em
--    `after()`. `portal_complete_code` e `portal_login` rodam um
--    `crypt` de mesmo custo quando não há candidato. Resíduo aceito: o
--    login faz um bcrypt por acesso do telefone (máx. 10), então o
--    tempo cresce com o número de contas em que a pessoa tem senha.
--
-- 6. Ciclo de vida (PRD 081 D-11)
--
--    Exclusão de contato/conta: ON DELETE CASCADE. Troca de telefone:
--    gatilho `contact_portal_phone_changed` apaga o acesso e os códigos
--    — trocar o número NUNCA transfere a senha. Mescla de duplicados:
--    desde o UNIQUE (account_id, phone_normalized) da 022 não existe
--    duplicado, e `merge_duplicate_contacts()` é manutenção de uma vez
--    só; se rodar, o acesso do absorvido cai no cascade (o contato faz
--    primeiro acesso de novo). A função NÃO é reescrita aqui.
--
-- O que NÃO muda: `handle_new_user()`, `auth.users`, policies e grants
-- da CRM. A asserção 4 confere o hash do `handle_new_user()` lido no
-- banco em 2026-10-30.
--
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS),
-- com bloco final de asserções que falha alto (padrão 089/090).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS contact_portal;
REVOKE ALL ON SCHEMA contact_portal FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON SCHEMA contact_portal IS
  'Área do contato (SPEC 084). Fora do PostgREST; só as funções public.portal_* (service_role) alcançam.';

-- ============================================================
-- 1. Tabelas
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_portal.settings (
  account_id        UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  channel_id        UUID REFERENCES public.channels(id) ON DELETE SET NULL,
  auth_template_id  UUID REFERENCES public.message_templates(id) ON DELETE SET NULL,
  -- NULL = palavra-chave desligada. A comparação (sem acento, sem
  -- caixa) é do servidor; aqui só o tamanho.
  keyword           TEXT DEFAULT 'SENHA'
                    CHECK (keyword IS NULL OR char_length(keyword) BETWEEN 2 AND 32),
  -- Código curto do endereço `/area/c/<código>`; alfabeto sem I, L, O.
  public_code       TEXT NOT NULL UNIQUE CHECK (public_code ~ '^[2-9A-HJKMNP-Z]{8}$'),
  terms_version     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS contact_portal.access (
  contact_id        UUID PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  phone             TEXT NOT NULL,
  -- NULL = convite enviado, senha ainda não criada.
  password_hash     TEXT,
  invited_at        TIMESTAMPTZ,
  invited_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  activated_at      TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  blocked_at        TIMESTAMPTZ,
  blocked_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  terms_version     TEXT,
  terms_accepted_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_portal_access_account
  ON contact_portal.access (account_id);

CREATE TABLE IF NOT EXISTS contact_portal.codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL CHECK (purpose IN ('first_access', 'reset', 'invite')),
  code_hash    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Um código ativo por contato: pedir outro consome o anterior.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_portal_codes_one_active
  ON contact_portal.codes (contact_id) WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contact_portal_codes_created
  ON contact_portal.codes (created_at);

CREATE TABLE IF NOT EXISTS contact_portal.sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256 do token de 32 bytes do cookie; o token em si nunca chega aqui.
  token_hash          BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  current_contact_id  UUID REFERENCES contact_portal.access(contact_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_portal_sessions_expires
  ON contact_portal.sessions (expires_at);

CREATE TABLE IF NOT EXISTS contact_portal.session_access (
  session_id  UUID NOT NULL REFERENCES contact_portal.sessions(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contact_portal.access(contact_id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_portal_session_access_contact
  ON contact_portal.session_access (contact_id);

CREATE TABLE IF NOT EXISTS contact_portal.attempts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('send_phone', 'send_ip', 'code_ip', 'login_phone', 'login_ip')),
  -- sha256 hex: do telefone canônico (calculado aqui) ou do IP (vem
  -- pronto do servidor). Nunca o valor em claro.
  key_hash    TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_portal_attempts_lookup
  ON contact_portal.attempts (kind, key_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_contact_portal_attempts_created
  ON contact_portal.attempts (created_at);

ALTER TABLE contact_portal.settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_portal.access         ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_portal.codes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_portal.sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_portal.session_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_portal.attempts       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES    IN SCHEMA contact_portal FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA contact_portal FROM PUBLIC, anon, authenticated, service_role;

-- Busca por telefone em todas as contas (§3 do cabeçalho).
CREATE INDEX IF NOT EXISTS idx_contacts_phone_normalized
  ON public.contacts (phone_normalized);

-- ============================================================
-- 2. Ajudantes internos (schema contact_portal)
--
-- Chamados de dentro das `portal_*`, que rodam como postgres. Não são
-- SECURITY DEFINER (não precisam) — exceto o gatilho, que dispara com
-- o papel de quem edita o contato.
-- ============================================================

CREATE OR REPLACE FUNCTION contact_portal.limit_value(p_limits JSONB, p_key TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v INTEGER;
BEGIN
  v := (p_limits ->> p_key)::INTEGER;
  IF v IS NULL OR v <= 0 THEN
    RAISE EXCEPTION 'contact_portal: limit "%" missing or invalid', p_key
      USING ERRCODE = '22023';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION contact_portal.check_phones(p_phones TEXT[])
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_phones IS NULL
     OR cardinality(p_phones) NOT BETWEEN 1 AND 2
     OR EXISTS (SELECT 1 FROM unnest(p_phones) x WHERE x IS NULL OR x !~ '^[0-9]{10,15}$') THEN
    RAISE EXCEPTION 'contact_portal: invalid phone candidates' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION contact_portal.check_ip_hash(p_ip_hash TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_ip_hash IS NULL OR p_ip_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'contact_portal: invalid ip hash' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION contact_portal.check_password(p_password TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  -- A regra de verdade é `password-policy.ts` (SPEC 054), no servidor.
  -- Aqui só o que o bcrypt exige: 72 bytes no máximo.
  IF p_password IS NULL OR octet_length(p_password) NOT BETWEEN 8 AND 72 THEN
    RAISE EXCEPTION 'contact_portal: invalid password length' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION contact_portal.key_hash(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(extensions.digest(p_value, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION contact_portal.attempt_count(p_kind TEXT, p_key TEXT, p_window_s INTEGER)
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT count(*)::INTEGER
  FROM contact_portal.attempts
  WHERE kind = p_kind
    AND key_hash = p_key
    AND created_at > NOW() - make_interval(secs => p_window_s);
$$;

-- Limpeza oportunista (SPEC 084 E-8): sem cron novo.
CREATE OR REPLACE FUNCTION contact_portal.housekeep()
RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
  DELETE FROM contact_portal.attempts WHERE created_at < NOW() - INTERVAL '24 hours';
  DELETE FROM contact_portal.codes
   WHERE created_at < NOW() - INTERVAL '2 days'
     AND (consumed_at IS NOT NULL OR expires_at < NOW());
  DELETE FROM contact_portal.sessions s
   WHERE s.expires_at < NOW()
      OR NOT EXISTS (SELECT 1 FROM contact_portal.session_access sa WHERE sa.session_id = s.id);
$$;

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
     AND public.plan_feature(p_account_id, 'contact_portal_enabled');
$$;

CREATE OR REPLACE FUNCTION contact_portal.account_by_code(p_public_code TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT account_id FROM contact_portal.settings
  WHERE public_code = upper(btrim(p_public_code));
$$;

-- Contatos de contas elegíveis com aquele telefone, sem acesso
-- bloqueado. `p_account_id` NULL = todas as contas.
CREATE OR REPLACE FUNCTION contact_portal.candidates(p_phones TEXT[], p_account_id UUID)
RETURNS TABLE (contact_id UUID, account_id UUID, last_activity TIMESTAMPTZ)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.id,
         c.account_id,
         (SELECT max(cv.last_message_at) FROM public.conversations cv WHERE cv.contact_id = c.id)
  FROM public.contacts c
  WHERE c.phone_normalized = ANY (p_phones)
    AND (p_account_id IS NULL OR c.account_id = p_account_id)
    AND contact_portal.account_is_eligible(c.account_id)
    AND NOT EXISTS (
      SELECT 1 FROM contact_portal.access a
      WHERE a.contact_id = c.id AND a.blocked_at IS NOT NULL
    );
$$;

CREATE OR REPLACE FUNCTION contact_portal.new_public_code()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';  -- 31
  v_bytes    BYTEA := extensions.gen_random_bytes(8);
  v_code     TEXT := '';
BEGIN
  FOR i IN 0..7 LOOP
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 31) + 1, 1);
  END LOOP;
  RETURN v_code;
END;
$$;

-- Gatilho de troca de telefone (D-11). SECURITY DEFINER: dispara com o
-- papel de quem edita o contato (authenticated, pela RLS), que não tem
-- privilégio nenhum em contact_portal.
CREATE OR REPLACE FUNCTION contact_portal.on_contact_phone_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM contact_portal.codes  WHERE contact_id = NEW.id;
  DELETE FROM contact_portal.access WHERE contact_id = NEW.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS contact_portal_phone_changed ON public.contacts;
CREATE TRIGGER contact_portal_phone_changed
  AFTER UPDATE OF phone ON public.contacts
  FOR EACH ROW
  WHEN (OLD.phone_normalized IS DISTINCT FROM NEW.phone_normalized)
  EXECUTE FUNCTION contact_portal.on_contact_phone_changed();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA contact_portal FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- 3. Lado do contato — public.portal_* (só service_role)
--
-- Chamadas pelas rotas /api/area/** via src/lib/contact-portal/service.ts.
-- `#variable_conflict use_column`: as colunas de RETURNS TABLE têm o
-- mesmo nome das colunas das tabelas.
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

CREATE OR REPLACE FUNCTION public.portal_create_session(
  p_token_hash   BYTEA,
  p_contact_ids  UUID[],
  p_ttl_s        INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id  UUID;
  v_n   INTEGER;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'portal_create_session: invalid token hash' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_s IS NULL OR p_ttl_s <= 0 THEN
    RAISE EXCEPTION 'portal_create_session: invalid ttl' USING ERRCODE = '22023';
  END IF;

  INSERT INTO contact_portal.sessions (token_hash, expires_at)
  VALUES (p_token_hash, NOW() + make_interval(secs => p_ttl_s))
  RETURNING id INTO v_id;

  -- Reconfere tudo: a rota passa o que `portal_login` devolveu, mas
  -- esta função não confia nisso.
  INSERT INTO contact_portal.session_access (session_id, contact_id)
  SELECT v_id, a.contact_id
  FROM contact_portal.access a
  WHERE a.contact_id = ANY (p_contact_ids)
    AND a.password_hash IS NOT NULL
    AND a.blocked_at IS NULL
    AND contact_portal.account_is_eligible(a.account_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    DELETE FROM contact_portal.sessions WHERE id = v_id;
    RETURN NULL;
  END IF;

  IF v_n = 1 THEN
    UPDATE contact_portal.sessions s
       SET current_contact_id = (SELECT sa.contact_id FROM contact_portal.session_access sa WHERE sa.session_id = v_id)
     WHERE s.id = v_id;
  END IF;

  UPDATE contact_portal.access a
     SET last_login_at = NOW()
   WHERE a.contact_id IN (SELECT sa.contact_id FROM contact_portal.session_access sa WHERE sa.session_id = v_id);

  RETURN v_id;
END;
$$;

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

  SELECT s.id, s.current_contact_id, s.last_seen_at
    INTO v_s
  FROM contact_portal.sessions s
  WHERE s.token_hash = p_token_hash AND s.expires_at > NOW();

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

CREATE OR REPLACE FUNCTION public.portal_select_account(
  p_token_hash  BYTEA,
  p_contact_id  UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE contact_portal.sessions s
     SET current_contact_id = p_contact_id
   WHERE s.token_hash = p_token_hash
     AND s.expires_at > NOW()
     AND EXISTS (
       SELECT 1
       FROM contact_portal.session_access sa
       JOIN contact_portal.access a ON a.contact_id = sa.contact_id
       WHERE sa.session_id = s.id
         AND sa.contact_id = p_contact_id
         AND a.blocked_at IS NULL
         AND contact_portal.account_is_eligible(a.account_id)
     );
  RETURN FOUND;
END;
$$;

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

  SELECT s.id INTO v_sid
  FROM contact_portal.sessions s
  WHERE s.token_hash = p_token_hash AND s.expires_at > NOW();
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

CREATE OR REPLACE FUNCTION public.portal_logout(
  p_token_hash  BYTEA,
  p_everywhere  BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sid  UUID;
BEGIN
  SELECT s.id INTO v_sid FROM contact_portal.sessions s WHERE s.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_everywhere THEN
    DELETE FROM contact_portal.session_access sa
     WHERE sa.session_id <> v_sid
       AND sa.contact_id IN (
         SELECT x.contact_id FROM contact_portal.session_access x WHERE x.session_id = v_sid
       );
  END IF;

  DELETE FROM contact_portal.sessions WHERE id = v_sid;
END;
$$;

-- ============================================================
-- 4. Lado da conta — public.portal_account_* e afins (só service_role)
--
-- Chamadas por /api/contact-portal/** DEPOIS de `requireRole` com o
-- cliente de sessão: a autorização do usuário da conta é da rota; aqui
-- cada função só garante que o contato pertence à conta informada.
-- ============================================================

CREATE OR REPLACE FUNCTION public.portal_account_settings_get(p_account_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'account_id',       s.account_id,
           'enabled',          s.enabled,
           'channel_id',       s.channel_id,
           'auth_template_id', s.auth_template_id,
           'keyword',          s.keyword,
           'public_code',      s.public_code,
           'terms_version',    s.terms_version,
           'updated_at',       s.updated_at,
           'updated_by',       s.updated_by,
           'eligible',         contact_portal.account_is_eligible(s.account_id)
         )
  FROM contact_portal.settings s
  WHERE s.account_id = p_account_id;
$$;

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
  v_try  INTEGER := 0;
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
   WHERE s.account_id = p_account_id;

  RETURN public.portal_account_settings_get(p_account_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_access_status(
  p_account_id   UUID,
  p_contact_ids  UUID[]
)
RETURNS TABLE (
  contact_id     UUID,
  status         TEXT,
  invited_at     TIMESTAMPTZ,
  activated_at   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  blocked_at     TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Contato sem linha = "sem acesso" (a UI completa).
  SELECT a.contact_id,
         CASE
           WHEN a.blocked_at IS NOT NULL    THEN 'blocked'
           WHEN a.password_hash IS NOT NULL THEN 'active'
           WHEN a.invited_at IS NOT NULL    THEN 'invited'
           ELSE 'none'
         END,
         a.invited_at,
         a.activated_at,
         a.last_login_at,
         a.blocked_at
  FROM contact_portal.access a
  WHERE a.account_id = p_account_id
    AND a.contact_id = ANY (p_contact_ids);
$$;

-- Filtro "com acesso ativo" da lista de contatos (F5).
CREATE OR REPLACE FUNCTION public.portal_active_contact_ids(p_account_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.contact_id
  FROM contact_portal.access a
  WHERE a.account_id = p_account_id
    AND a.password_hash IS NOT NULL
    AND a.blocked_at IS NULL;
$$;

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

  v_key := contact_portal.key_hash(v_c.phone_normalized);
  IF contact_portal.attempt_count('send_phone', v_key,
       contact_portal.limit_value(p_limits, 'send_phone_min_interval_s')) > 0
     OR contact_portal.attempt_count('send_phone', v_key, 3600)
       >= contact_portal.limit_value(p_limits, 'send_phone_per_hour') THEN
    RETURN QUERY SELECT 'throttled'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  INSERT INTO contact_portal.attempts (kind, key_hash) VALUES ('send_phone', v_key);

  INSERT INTO contact_portal.access AS a (contact_id, account_id, phone, invited_at, invited_by)
  VALUES (p_contact_id, p_account_id, v_c.phone_normalized, NOW(), p_user_id)
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

CREATE OR REPLACE FUNCTION public.portal_set_blocked(
  p_account_id  UUID,
  p_contact_id  UUID,
  p_blocked     BOOLEAN,
  p_user_id     UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.id = p_contact_id AND c.account_id = p_account_id
  ) THEN
    RETURN FALSE;
  END IF;

  IF p_blocked THEN
    -- Bloquear antes do primeiro acesso também vale: cria a linha já bloqueada.
    INSERT INTO contact_portal.access AS a (contact_id, account_id, phone, blocked_at, blocked_by)
    SELECT c.id, c.account_id, c.phone_normalized, NOW(), p_user_id
    FROM public.contacts c
    WHERE c.id = p_contact_id
    ON CONFLICT (contact_id) DO UPDATE
      SET blocked_at = COALESCE(a.blocked_at, NOW()),
          blocked_by = CASE WHEN a.blocked_at IS NULL THEN EXCLUDED.blocked_by ELSE a.blocked_by END,
          updated_at = NOW();
    DELETE FROM contact_portal.session_access WHERE contact_id = p_contact_id;
    UPDATE contact_portal.codes SET consumed_at = NOW()
     WHERE contact_id = p_contact_id AND consumed_at IS NULL;
  ELSE
    UPDATE contact_portal.access
       SET blocked_at = NULL, blocked_by = NULL, updated_at = NOW()
     WHERE contact_id = p_contact_id AND account_id = p_account_id;
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_end_sessions(
  p_account_id  UUID,
  p_contact_id  UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n  INTEGER;
BEGIN
  DELETE FROM contact_portal.session_access sa
   WHERE sa.contact_id = p_contact_id
     AND EXISTS (
       SELECT 1 FROM contact_portal.access a
       WHERE a.contact_id = p_contact_id AND a.account_id = p_account_id
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Console do proprietário (`/admin`): ligada/desligada + N acessos ativos.
CREATE OR REPLACE FUNCTION public.portal_account_summary(p_account_id UUID)
RETURNS TABLE (enabled BOOLEAN, eligible BOOLEAN, active_count INTEGER, public_code TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(s.enabled, FALSE),
         contact_portal.account_is_eligible(p_account_id),
         (SELECT count(*)::INTEGER FROM contact_portal.access a
           WHERE a.account_id = p_account_id
             AND a.password_hash IS NOT NULL
             AND a.blocked_at IS NULL),
         s.public_code
  FROM (SELECT p_account_id AS account_id) x
  LEFT JOIN contact_portal.settings s ON s.account_id = x.account_id;
$$;

-- ============================================================
-- 5. Grants das portal_*: só service_role
-- ============================================================

DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.portal_request_code(text[],text,text,text,text,jsonb)',
    'public.portal_complete_code(text[],text,text,text,text,text,jsonb)',
    'public.portal_login(text[],text,text,jsonb)',
    'public.portal_create_session(bytea,uuid[],integer)',
    'public.portal_resolve_session(bytea,integer)',
    'public.portal_select_account(bytea,uuid)',
    'public.portal_change_password(bytea,text,text,text,jsonb)',
    'public.portal_logout(bytea,boolean)',
    'public.portal_account_settings_get(uuid)',
    'public.portal_account_settings_set(uuid,jsonb,uuid)',
    'public.portal_access_status(uuid,uuid[])',
    'public.portal_active_contact_ids(uuid)',
    'public.portal_invite(uuid,uuid,text,uuid,jsonb)',
    'public.portal_set_blocked(uuid,uuid,boolean,uuid)',
    'public.portal_end_sessions(uuid,uuid)',
    'public.portal_account_summary(uuid)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END;
$$;

-- ============================================================
-- 6. Asserções finais (falham alto)
-- ============================================================

DO $$
DECLARE
  v_fn     TEXT;
  v_tbl    TEXT;
  v_role   TEXT;
  v_priv   TEXT;
  v_md5    TEXT;
BEGIN
  -- 1. Nenhuma tabela do schema alcançável por anon/authenticated/PUBLIC/service_role.
  FOREACH v_tbl IN ARRAY ARRAY[
    'contact_portal.settings', 'contact_portal.access', 'contact_portal.codes',
    'contact_portal.sessions', 'contact_portal.session_access', 'contact_portal.attempts'
  ]
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_tbl::regclass) THEN
      RAISE EXCEPTION '094: % sem RLS.', v_tbl USING ERRCODE = '55006';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_tbl::regclass) THEN
      RAISE EXCEPTION '094: % tem policy — o desenho é nenhuma.', v_tbl USING ERRCODE = '55006';
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public', 'service_role'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(v_role, v_tbl, v_priv) THEN
          RAISE EXCEPTION '094: % tem % em %.', v_role, v_priv, v_tbl USING ERRCODE = '55006';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 2. Sem USAGE no schema para quem fala com o PostgREST.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'contact_portal', 'USAGE') THEN
      RAISE EXCEPTION '094: % tem USAGE em contact_portal.', v_role USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- 3. portal_*: service_role sim; anon, authenticated, PUBLIC não.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.portal_request_code(text[],text,text,text,text,jsonb)',
    'public.portal_complete_code(text[],text,text,text,text,text,jsonb)',
    'public.portal_login(text[],text,text,jsonb)',
    'public.portal_create_session(bytea,uuid[],integer)',
    'public.portal_resolve_session(bytea,integer)',
    'public.portal_select_account(bytea,uuid)',
    'public.portal_change_password(bytea,text,text,text,jsonb)',
    'public.portal_logout(bytea,boolean)',
    'public.portal_account_settings_get(uuid)',
    'public.portal_account_settings_set(uuid,jsonb,uuid)',
    'public.portal_access_status(uuid,uuid[])',
    'public.portal_active_contact_ids(uuid)',
    'public.portal_invite(uuid,uuid,text,uuid,jsonb)',
    'public.portal_set_blocked(uuid,uuid,boolean,uuid)',
    'public.portal_end_sessions(uuid,uuid)',
    'public.portal_account_summary(uuid)'
  ]
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '094: % executável por anon/authenticated/PUBLIC.', v_fn USING ERRCODE = '55006';
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '094: % sem EXECUTE para service_role — o servidor quebraria.', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- Ajudantes de contact_portal: ninguém além do dono.
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'contact_portal'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
           OR has_function_privilege('public', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION '094: função de contact_portal executável por anon/authenticated/PUBLIC.' USING ERRCODE = '55006';
  END IF;

  -- 4. A área não encosta no cadastro do SaaS: handle_new_user() igual
  --    ao lido no banco em 2026-10-30 (versão da 067).
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.handle_new_user()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '42dbf56301eec1b34457364a82b27754' THEN
    RAISE EXCEPTION '094: handle_new_user() mudou (md5 %) — revisar antes de seguir.', v_md5
      USING ERRCODE = '55006';
  END IF;

  -- 5. Gatilho de troca de telefone no lugar.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.contacts'::regclass AND tgname = 'contact_portal_phone_changed'
  ) THEN
    RAISE EXCEPTION '094: gatilho contact_portal_phone_changed ausente.' USING ERRCODE = '55006';
  END IF;
END;
$$;
