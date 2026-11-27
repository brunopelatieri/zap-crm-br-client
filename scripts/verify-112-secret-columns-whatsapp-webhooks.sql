-- verify-112-secret-columns-whatsapp-webhooks.sql — conferência do P-15 da SPEC 089. NÃO é migração.
--
-- !!! ORDEM DE DEPLOY: este verify só faz sentido DEPOIS de (1) o código da P-15
-- !!! estar publicado em produção e (2) a migração 112 estar aplicada, nessa ordem.
-- !!! Aplicar a 112 com o código antigo em produção derruba o envio de WhatsApp
-- !!! (dev e produção usam o MESMO banco).
--
-- Para o SQL Editor do `vn`. Rode DEPOIS de aplicar
-- `supabase/migrations/112_secret_columns_whatsapp_webhooks.sql`. Uma consulta só.
-- Roda os testes DENTRO de um bloco que sempre termina em RAISE EXCEPTION: o
-- Postgres desfaz tudo (valores de teste nas colunas cifradas, linhas de teste em
-- webhook_endpoints e a troca temporária de papel do usuário para viewer/agent).
-- O relatório vem na mensagem do erro, que começa com `P15_TESTE_REVERTIDO`; cada
-- linha começa com `ok`, `FALHA` ou `info`, e a última diz quantas falharam.
-- Depois, confira que
--   select count(*) from webhook_endpoints where url like '%zz-112%'
-- é 0 e que o papel do usuário usado não mudou (a troca some no rollback).
--
-- Usa uma conta A com um admin/owner e ao menos uma linha em whatsapp_config
-- (admin preferido; o vn não tem usuário viewer/agent, então o teste rebaixa o
-- mesmo usuário), e uma conta B da qual esse usuário NÃO é membro. Se a B não tiver
-- whatsapp_config, os itens de isolamento dessa tabela viram `info`. Os segredos
-- das linhas existentes são trocados por valores de teste ('zz-112-...') dentro
-- da transação; NENHUM valor de segredo real é lido nem impresso — o relatório só
-- diz "legível" ou "negado".
--
-- Cobre: privilégios no catálogo (anon sem nada nas duas tabelas; authenticated sem
-- as 4 colunas cifradas e com as demais; service_role com tudo; escrita preservada),
-- leitura simulando o papel `authenticated` como admin/owner, viewer e agent (colunas
-- comuns sim; `access_token`, `app_secret`, `verify_token`, `secret`, `select *` e
-- `WHERE segredo IS NOT NULL` com 42501), escrita do admin (UPDATE com RETURNING
-- comum, gravar token novo, INSERT/UPDATE/DELETE de webhook) e de viewer/agent
-- (barrados pela RLS), o papel `anon` (42501), o isolamento entre contas e o
-- service_role lendo os segredos.

DO $$
DECLARE
  v_a       UUID;
  v_u       UUID;
  v_role    TEXT;
  v_b       UUID;
  v_cfg_a   UUID;
  v_cfg_b   UUID;
  v_we_a    UUID;
  v_we_b    UUID;
  v_n       BIGINT;
  v_rows    INT;
  v_txt     TEXT;
  v_txt2    TEXT;
  v_txt3    TEXT;
  v_id      UUID;
  v_hit     BOOLEAN;
  v_r       TEXT := '';
  v_fail    INT;
  v_rt      TEXT;
  v_lbl     TEXT;
  v_probe   TEXT;
  v_is_adm  BOOLEAN;
  v_demoted BOOLEAN;
BEGIN
  -- ---------- Dados ----------
  SELECT p.account_id, p.user_id, p.account_role::text INTO v_a, v_u, v_role
    FROM profiles p
   WHERE p.account_role IN ('admin', 'owner') AND p.blocked_at IS NULL
     AND EXISTS (SELECT 1 FROM whatsapp_config w WHERE w.account_id = p.account_id)
   ORDER BY (p.account_role = 'admin') DESC, p.user_id LIMIT 1;
  IF v_a IS NULL THEN
    RAISE EXCEPTION 'P15_TESTE_ABORTADO precisa de uma conta com admin/owner e uma linha em whatsapp_config';
  END IF;
  SELECT a.id INTO v_b
    FROM accounts a
   WHERE a.id <> v_a
     AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = a.id AND p.user_id = v_u)
   ORDER BY EXISTS (SELECT 1 FROM whatsapp_config w WHERE w.account_id = a.id) DESC, a.id LIMIT 1;
  IF v_b IS NULL THEN
    RAISE EXCEPTION 'P15_TESTE_ABORTADO precisa de uma segunda conta da qual o usuario nao e membro';
  END IF;

  SELECT id INTO v_cfg_a FROM whatsapp_config WHERE account_id = v_a ORDER BY created_at LIMIT 1;
  SELECT id INTO v_cfg_b FROM whatsapp_config WHERE account_id = v_b ORDER BY created_at LIMIT 1;

  -- Valores de teste nas colunas cifradas (como o papel da sessão do SQL Editor;
  -- some no rollback).
  UPDATE whatsapp_config
     SET access_token = 'zz-112-tok-a', verify_token = 'zz-112-ver-a', app_secret = 'zz-112-sec-a'
   WHERE id = v_cfg_a;
  IF v_cfg_b IS NOT NULL THEN
    UPDATE whatsapp_config
       SET access_token = 'zz-112-tok-b', verify_token = 'zz-112-ver-b', app_secret = 'zz-112-sec-b'
     WHERE id = v_cfg_b;
  END IF;
  INSERT INTO webhook_endpoints (account_id, url, secret)
  VALUES (v_a, 'https://example.invalid/zz-112-a', 'zz-112-we-a') RETURNING id INTO v_we_a;
  INSERT INTO webhook_endpoints (account_id, url, secret)
  VALUES (v_b, 'https://example.invalid/zz-112-b', 'zz-112-we-b') RETURNING id INTO v_we_b;

  v_r := v_r || 'info 0. usuario usado tem papel ' || v_role || ' na conta A; '
             || CASE WHEN v_cfg_b IS NULL THEN 'a conta B NAO tem whatsapp_config (isolamento dessa tabela nao testado)'
                     ELSE 'a conta B tem whatsapp_config' END || E'\n';

  -- ---------- 1) privilégios no catálogo ----------
  v_r := v_r || CASE WHEN NOT has_any_column_privilege('anon', 'public.whatsapp_config', 'SELECT, INSERT, UPDATE, REFERENCES')
                      AND NOT has_table_privilege('anon', 'public.whatsapp_config', 'DELETE, TRUNCATE, TRIGGER')
                      AND NOT has_any_column_privilege('anon', 'public.webhook_endpoints', 'SELECT, INSERT, UPDATE, REFERENCES')
                      AND NOT has_table_privilege('anon', 'public.webhook_endpoints', 'DELETE, TRUNCATE, TRIGGER')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1a. anon sem privilegio em whatsapp_config e webhook_endpoints' || E'\n';
  v_r := v_r || CASE WHEN NOT has_table_privilege('authenticated', 'public.whatsapp_config', 'SELECT')
                      AND NOT has_column_privilege('authenticated', 'public.whatsapp_config', 'access_token', 'SELECT')
                      AND NOT has_column_privilege('authenticated', 'public.whatsapp_config', 'app_secret', 'SELECT')
                      AND NOT has_column_privilege('authenticated', 'public.whatsapp_config', 'verify_token', 'SELECT')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1b. authenticated: sem SELECT de tabela e sem access_token/app_secret/verify_token em whatsapp_config' || E'\n';
  v_r := v_r || CASE WHEN NOT has_table_privilege('authenticated', 'public.webhook_endpoints', 'SELECT')
                      AND NOT has_column_privilege('authenticated', 'public.webhook_endpoints', 'secret', 'SELECT')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1c. authenticated: sem SELECT de tabela e sem secret em webhook_endpoints' || E'\n';
  v_r := v_r || CASE WHEN NOT EXISTS (
                            SELECT 1 FROM pg_attribute a
                             WHERE a.attrelid = 'public.whatsapp_config'::regclass AND a.attnum > 0
                               AND NOT a.attisdropped
                               AND a.attname NOT IN ('access_token', 'app_secret', 'verify_token')
                               AND NOT has_column_privilege('authenticated', 'public.whatsapp_config', a.attname, 'SELECT'))
                      AND NOT EXISTS (
                            SELECT 1 FROM pg_attribute a
                             WHERE a.attrelid = 'public.webhook_endpoints'::regclass AND a.attnum > 0
                               AND NOT a.attisdropped
                               AND a.attname <> 'secret'
                               AND NOT has_column_privilege('authenticated', 'public.webhook_endpoints', a.attname, 'SELECT'))
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1d. authenticated le todas as outras colunas das duas tabelas (as telas seguem inteiras)' || E'\n';
  v_r := v_r || CASE WHEN has_table_privilege('authenticated', 'public.whatsapp_config', 'INSERT')
                      AND has_table_privilege('authenticated', 'public.whatsapp_config', 'UPDATE')
                      AND has_table_privilege('authenticated', 'public.whatsapp_config', 'DELETE')
                      AND has_table_privilege('authenticated', 'public.webhook_endpoints', 'INSERT')
                      AND has_table_privilege('authenticated', 'public.webhook_endpoints', 'UPDATE')
                      AND has_table_privilege('authenticated', 'public.webhook_endpoints', 'DELETE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1e. authenticated mantem INSERT/UPDATE/DELETE nas duas (a RLS de admin+ decide)' || E'\n';
  v_r := v_r || CASE WHEN has_column_privilege('service_role', 'public.whatsapp_config', 'access_token', 'SELECT')
                      AND has_column_privilege('service_role', 'public.whatsapp_config', 'app_secret', 'SELECT')
                      AND has_column_privilege('service_role', 'public.whatsapp_config', 'verify_token', 'SELECT')
                      AND has_column_privilege('service_role', 'public.webhook_endpoints', 'secret', 'SELECT')
                      AND has_table_privilege('service_role', 'public.whatsapp_config', 'UPDATE')
                      AND has_table_privilege('service_role', 'public.webhook_endpoints', 'UPDATE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1f. service_role le os 4 segredos e escreve (o servidor depende disso)' || E'\n';
  v_r := v_r || CASE WHEN (SELECT count(*) FROM pg_policies
                            WHERE schemaname = 'public'
                              AND tablename IN ('whatsapp_config', 'webhook_endpoints')
                              AND cmd = 'SELECT') = 2
                      AND (SELECT bool_and(relrowsecurity) FROM pg_class
                            WHERE oid IN ('public.whatsapp_config'::regclass, 'public.webhook_endpoints'::regclass))
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1g. RLS ligada nas duas, com policy de SELECT (a 112 nao mexe nelas)' || E'\n';

  -- ---------- 2) admin/owner, viewer e agent da conta A (papel trocado, desfeito no rollback) ----------
  FOREACH v_rt IN ARRAY ARRAY['(admin)', 'viewer', 'agent'] LOOP
    v_is_adm  := (v_rt = '(admin)');
    v_lbl     := CASE WHEN v_is_adm THEN v_role ELSE v_rt END;
    v_demoted := TRUE;

    IF NOT v_is_adm THEN
      BEGIN
        UPDATE profiles SET account_role = v_rt::account_role_enum WHERE user_id = v_u AND account_id = v_a;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_demoted := (v_rows = 1);
      EXCEPTION WHEN OTHERS THEN
        v_demoted := FALSE;
        v_r := v_r || 'info 2. nao foi possivel trocar o usuario para ' || v_rt || ' (' || SQLSTATE || '); itens desse papel nao rodaram' || E'\n';
      END;
    END IF;

    IF v_demoted THEN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
                         json_build_object('role', 'authenticated', 'sub', v_u)::text, true);

      -- 2.x leitura das colunas comuns
      SELECT count(*) INTO v_n FROM whatsapp_config WHERE account_id = v_a;
      v_r := v_r || CASE WHEN v_n >= 1 THEN 'ok   ' ELSE 'FALHA' END
            || ' [' || v_lbl || '] whatsapp_config: le as linhas da propria conta pelas colunas comuns (' || v_n || ')' || E'\n';
      SELECT count(*) INTO v_n FROM webhook_endpoints WHERE account_id = v_a;
      v_r := v_r || CASE WHEN v_n >= 1 THEN 'ok   ' ELSE 'FALHA' END
            || ' [' || v_lbl || '] webhook_endpoints: le as linhas da propria conta pelas colunas comuns (' || v_n || ')' || E'\n';

      -- isolamento entre contas
      SELECT count(*) INTO v_n FROM whatsapp_config WHERE account_id = v_b;
      v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
            || ' [' || v_lbl || '] whatsapp_config: nao ve linhas da conta B (' || v_n || ')' || E'\n';
      SELECT count(*) INTO v_n FROM webhook_endpoints WHERE account_id = v_b;
      v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
            || ' [' || v_lbl || '] webhook_endpoints: nao ve linhas da conta B (' || v_n || ')' || E'\n';

      -- colunas cifradas negadas (uma a uma)
      FOREACH v_probe IN ARRAY ARRAY['access_token', 'app_secret', 'verify_token'] LOOP
        v_hit := FALSE;
        BEGIN
          EXECUTE format('SELECT %I FROM whatsapp_config WHERE account_id = $1 LIMIT 1', v_probe)
            INTO v_txt USING v_a;
          v_hit := TRUE;
        EXCEPTION WHEN insufficient_privilege THEN
          v_hit := FALSE;
        END;
        v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] whatsapp_config: SELECT ' || v_probe || ' negado (42501)' || E'\n';

        -- o truque de filtro tampouco vaza: a coluna nem pode ser referenciada
        v_hit := FALSE;
        BEGIN
          EXECUTE format('SELECT 1 FROM whatsapp_config WHERE account_id = $1 AND %I IS NOT NULL', v_probe)
            USING v_a;
          v_hit := TRUE;
        EXCEPTION WHEN insufficient_privilege THEN
          v_hit := FALSE;
        END;
        v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] whatsapp_config: nem WHERE ' || v_probe || ' IS NOT NULL (sem oraculo de presenca)' || E'\n';
      END LOOP;

      v_hit := FALSE;
      BEGIN
        SELECT secret INTO v_txt FROM webhook_endpoints WHERE account_id = v_a LIMIT 1;
        v_hit := TRUE;
      EXCEPTION WHEN insufficient_privilege THEN
        v_hit := FALSE;
      END;
      v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
            || ' [' || v_lbl || '] webhook_endpoints: SELECT secret negado (42501)' || E'\n';

      v_hit := FALSE;
      BEGIN
        PERFORM 1 FROM webhook_endpoints WHERE account_id = v_a AND secret IS NOT NULL;
        v_hit := TRUE;
      EXCEPTION WHEN insufficient_privilege THEN
        v_hit := FALSE;
      END;
      v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
            || ' [' || v_lbl || '] webhook_endpoints: nem WHERE secret IS NOT NULL (sem oraculo de presenca)' || E'\n';

      -- select * negado nas duas
      v_hit := FALSE;
      BEGIN
        PERFORM * FROM whatsapp_config WHERE account_id = v_a;
        v_hit := TRUE;
      EXCEPTION WHEN insufficient_privilege THEN
        v_hit := FALSE;
      END;
      v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
            || ' [' || v_lbl || '] whatsapp_config: SELECT * negado (quem quiser a linha tem de listar as colunas)' || E'\n';
      v_hit := FALSE;
      BEGIN
        PERFORM * FROM webhook_endpoints WHERE account_id = v_a;
        v_hit := TRUE;
      EXCEPTION WHEN insufficient_privilege THEN
        v_hit := FALSE;
      END;
      v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
            || ' [' || v_lbl || '] webhook_endpoints: SELECT * negado' || E'\n';

      IF v_is_adm THEN
        -- Escrita comum do admin: UPDATE + RETURNING de colunas permitidas (a tela de cooldown).
        v_hit := FALSE;
        BEGIN
          UPDATE whatsapp_config SET broadcast_cooldown_days = 7 WHERE id = v_cfg_a RETURNING id INTO v_id;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          v_hit := (v_rows = 1 AND v_id IS NOT NULL);
        EXCEPTION WHEN insufficient_privilege THEN
          v_hit := FALSE;
        END;
        v_r := v_r || CASE WHEN v_hit THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] whatsapp_config: UPDATE broadcast_cooldown_days ... RETURNING id funciona' || E'\n';

        -- Gravar um token novo continua possivel (escrever nao exige SELECT na coluna).
        v_hit := FALSE;
        BEGIN
          UPDATE whatsapp_config
             SET access_token = 'zz-112-tok-novo', verify_token = 'zz-112-ver-novo', app_secret = 'zz-112-sec-novo'
           WHERE id = v_cfg_a;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          v_hit := (v_rows = 1);
        EXCEPTION WHEN insufficient_privilege THEN
          v_hit := FALSE;
        END;
        v_r := v_r || CASE WHEN v_hit THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] whatsapp_config: UPDATE dos tres segredos (salvar credencial nova) continua funcionando' || E'\n';

        -- Conta alheia: UPDATE nao acha a linha (RLS).
        IF v_cfg_b IS NOT NULL THEN
          UPDATE whatsapp_config SET broadcast_cooldown_days = 9 WHERE id = v_cfg_b;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
                || ' [' || v_lbl || '] whatsapp_config: nao atualiza a linha da conta B (' || v_rows || ' linhas)' || E'\n';
        END IF;

        -- webhook_endpoints: UPDATE/RETURNING comuns, INSERT e DELETE de admin.
        v_hit := FALSE;
        BEGIN
          UPDATE webhook_endpoints SET is_active = FALSE WHERE id = v_we_a RETURNING id INTO v_id;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          v_hit := (v_rows = 1 AND v_id IS NOT NULL);
        EXCEPTION WHEN insufficient_privilege THEN
          v_hit := FALSE;
        END;
        v_r := v_r || CASE WHEN v_hit THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] webhook_endpoints: UPDATE is_active ... RETURNING id funciona' || E'\n';

        v_hit := FALSE;
        BEGIN
          INSERT INTO webhook_endpoints (account_id, url, secret)
          VALUES (v_a, 'https://example.invalid/zz-112-novo', 'zz-112-we-novo');
          v_hit := TRUE;
        EXCEPTION WHEN insufficient_privilege THEN
          v_hit := FALSE;
        END;
        v_r := v_r || CASE WHEN v_hit THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] webhook_endpoints: INSERT (criar endpoint com secret) continua funcionando' || E'\n';

        DELETE FROM webhook_endpoints WHERE account_id = v_a AND url = 'https://example.invalid/zz-112-novo';
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_r := v_r || CASE WHEN v_rows = 1 THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] webhook_endpoints: DELETE do proprio endpoint funciona (' || v_rows || ')' || E'\n';

        UPDATE webhook_endpoints SET is_active = FALSE WHERE id = v_we_b;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] webhook_endpoints: nao atualiza o endpoint da conta B (' || v_rows || ' linhas)' || E'\n';
      ELSE
        -- viewer/agent: RLS de admin+ barra a escrita.
        UPDATE whatsapp_config SET broadcast_cooldown_days = 5 WHERE id = v_cfg_a;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] whatsapp_config: nao escreve (RLS de admin+, ' || v_rows || ' linhas)' || E'\n';
        UPDATE webhook_endpoints SET is_active = FALSE WHERE id = v_we_a;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] webhook_endpoints: nao escreve (RLS de admin+, ' || v_rows || ' linhas)' || E'\n';
        v_hit := FALSE;
        BEGIN
          INSERT INTO webhook_endpoints (account_id, url, secret)
          VALUES (v_a, 'https://example.invalid/zz-112-' || v_rt, 'zz-112-we-' || v_rt);
          v_hit := TRUE;
        EXCEPTION WHEN insufficient_privilege THEN
          v_hit := FALSE;
        END;
        v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
              || ' [' || v_lbl || '] webhook_endpoints: INSERT negado (RLS de admin+)' || E'\n';
      END IF;
      RESET ROLE;
    END IF;
  END LOOP;

  -- ---------- 3) anon ----------
  v_hit := FALSE;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM id FROM whatsapp_config;
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  RESET ROLE;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 3a. anon: SELECT em whatsapp_config negado (42501, ja na tabela, nao so na policy)' || E'\n';
  v_hit := FALSE;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM id FROM webhook_endpoints;
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  RESET ROLE;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 3b. anon: SELECT em webhook_endpoints negado (42501)' || E'\n';
  v_hit := FALSE;
  BEGIN
    SET LOCAL ROLE anon;
    INSERT INTO webhook_endpoints (account_id, url, secret)
    VALUES (v_a, 'https://example.invalid/zz-112-anon', 'zz-112-anon');
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  RESET ROLE;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 3c. anon: INSERT em webhook_endpoints negado' || E'\n';

  -- ---------- 4) service_role ----------
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  v_hit := FALSE;
  BEGIN
    SELECT access_token, verify_token, app_secret INTO v_txt, v_txt2, v_txt3
      FROM whatsapp_config WHERE id = v_cfg_a;
    -- `zz-112-*-novo` so existe se o item de escrita do admin rodou; senao, os valores iniciais.
    v_hit := (v_txt IN ('zz-112-tok-a', 'zz-112-tok-novo')
              AND v_txt2 IN ('zz-112-ver-a', 'zz-112-ver-novo')
              AND v_txt3 IN ('zz-112-sec-a', 'zz-112-sec-novo'));
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 4a. service_role le access_token, verify_token e app_secret (o que o servidor decifra)' || E'\n';

  v_hit := FALSE;
  BEGIN
    SELECT secret INTO v_txt FROM webhook_endpoints WHERE id = v_we_a;
    v_hit := (v_txt = 'zz-112-we-a');
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 4b. service_role le webhook_endpoints.secret (deliver.ts depende disso)' || E'\n';

  SELECT count(*) INTO v_n FROM webhook_endpoints WHERE account_id IN (v_a, v_b);
  v_r := v_r || CASE WHEN v_n >= 2 THEN 'ok   ' ELSE 'FALHA' END
        || ' 4c. service_role enxerga as duas contas (por isso o codigo SEMPRE filtra por account_id)' || E'\n';
  RESET ROLE;

  v_fail := (length(v_r) - length(replace(v_r, 'FALHA', ''))) / 5;
  RAISE EXCEPTION E'P15_TESTE_REVERTIDO\n%\nFalhas: %', v_r, v_fail;
END;
$$;
