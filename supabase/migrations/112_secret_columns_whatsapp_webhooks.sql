-- ============================================================
-- 112 — whatsapp_config e webhook_endpoints: segredos fora do alcance do JWT
--       (SPEC 089, P-15)
-- ============================================================
-- Idempotente. Aplicar no SQL Editor do `vn` pelo mantenedor; depois rodar
-- scripts/verify-112-secret-columns-whatsapp-webhooks.sql e `get_advisors`
-- (security).
--
-- !!! ORDEM DE DEPLOY — LEIA ANTES DE APLICAR !!!
--   1) PRIMEIRO publique o código da P-15 em produção (a imagem na VPS tem de
--      ser a nova) e confira que o app está de pé.
--   2) SÓ DEPOIS aplique esta migração.
--   Dev e produção usam o MESMO banco. Se esta migração rodar com o código
--   ANTIGO em produção, `resolveCloudConfig` (que lia `whatsapp_config` com o
--   cliente de sessão, `select('*')`) passa a levar 42501 e TODO o WhatsApp
--   para de enviar (envio, disparo, template, mídia, reação, exportação).
--   O código novo funciona com o banco antigo e com o novo; o contrário
--   não. (A 111 foi aplicada antes do deploy uma vez — não repetir.)
--   Reverter, se algo quebrar:
--     GRANT SELECT ON TABLE public.whatsapp_config, public.webhook_endpoints
--       TO authenticated;
--
-- O problema (mesma classe da P-14 / migração 111)
--   As policies de SELECT (`whatsapp_config_select`, `webhook_endpoints_select`)
--   são só `is_account_member(account_id)`, sem papel mínimo, e o
--   `authenticated` tem SELECT de tabela. Pelo PostgREST, com o JWT do usuário,
--   QUALQUER membro da conta (`viewer` e `agent` inclusive) lê:
--     whatsapp_config.access_token  token da Meta (AES-256-GCM)
--     whatsapp_config.app_secret    App Secret da Meta (AES-256-GCM)
--     whatsapp_config.verify_token  token de verificação do webhook (AES-256-GCM)
--     webhook_endpoints.secret      chave HMAC dos webhooks de saída (AES-256-GCM)
--   São cifrados com `ENCRYPTION_KEY`, mas o texto cifrado não precisa sair do
--   servidor: quem decifra é código de servidor (service role), e nenhuma rota
--   devolve o valor (só indicadores de "configurado").
--
-- O que esta migração faz
--   1) `authenticated` perde o SELECT de TABELA em `whatsapp_config` e
--      `webhook_endpoints` e ganha SELECT POR COLUNA em todas as colunas, menos
--      as quatro acima. INSERT/UPDATE/DELETE seguem como estavam (a RLS de
--      admin+ decide; gravar um token novo continua possível, pois escrever
--      não exige SELECT na coluna).
--   2) `anon` perde TODO privilégio de tabela nas duas (a policy já o barrava
--      porque `is_account_member` foi revogado de `anon` na 090, mas o GRANT de
--      tabela era ruído perigoso). Nenhum caminho do app usa `anon` nelas.
--   3) `service_role` não é tocado: segue com tudo.
--   O servidor lê a credencial com `supabaseAdmin()` (service role, ignora RLS
--   e privilégio de coluna): `resolveCloudConfig` (src/lib/whatsapp/
--   cloud-channels.ts) faz isso, sempre filtrando por `account_id` e
--   `channel_id`; `webhook_endpoints.secret` já era lido só por service role
--   (`deliver.ts`, `/api/v1/webhooks`). `select('*')` nessas tabelas com o
--   cliente de sessão passa a dar 42501 (de propósito).
--
-- Coluna NOVA no futuro (risco documentado)
--   Um `ALTER TABLE ... ADD COLUMN` NÃO herda o SELECT por coluna: a coluna
--   nova nasce ilegível para `authenticated` (falha FECHADA — o segredo novo
--   nunca vaza por esquecimento). O custo é o inverso: uma coluna comum nova
--   precisa de `GRANT SELECT (coluna) ON public.<tabela> TO authenticated` na
--   migração que a cria, senão a tela que a lê leva 42501. As asserções abaixo
--   e o verify-112 listam as colunas que ficaram sem GRANT.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) anon sem privilégio nas duas tabelas
-- ------------------------------------------------------------
REVOKE ALL ON TABLE public.whatsapp_config   FROM anon;
REVOKE ALL ON TABLE public.webhook_endpoints FROM anon;

-- ------------------------------------------------------------
-- 2) authenticated: SELECT por coluna, sem as cifradas
--    (REVOKE de tabela também limpa privilégio de coluna que já existisse)
-- ------------------------------------------------------------
REVOKE SELECT ON TABLE public.whatsapp_config FROM authenticated;

GRANT SELECT (
  id,
  user_id,
  account_id,
  channel_id,
  phone_number_id,
  waba_id,
  app_id,
  status,
  connected_at,
  registered_at,
  subscribed_apps_at,
  last_registration_error,
  messaging_limit_tier,
  messaging_limit_checked_at,
  broadcast_cooldown_days,
  created_at,
  updated_at
) ON public.whatsapp_config TO authenticated;

REVOKE SELECT ON TABLE public.webhook_endpoints FROM authenticated;

GRANT SELECT (
  id,
  account_id,
  created_by,
  url,
  events,
  is_active,
  last_delivery_at,
  failure_count,
  created_at
) ON public.webhook_endpoints TO authenticated;

COMMENT ON COLUMN public.whatsapp_config.access_token IS
  'Token da Meta, AES-256-GCM. Legível só por service_role (112, P-15); nunca devolvido ao navegador.';
COMMENT ON COLUMN public.whatsapp_config.app_secret IS
  'App Secret da Meta, AES-256-GCM. Legível só por service_role (112, P-15).';
COMMENT ON COLUMN public.whatsapp_config.verify_token IS
  'Token de verificação do webhook da Meta, AES-256-GCM. Legível só por service_role (112, P-15).';
COMMENT ON COLUMN public.webhook_endpoints.secret IS
  'Chave HMAC do webhook de saída, AES-256-GCM. Legível só por service_role (112, P-15); a API só a devolve na criação.';

-- ------------------------------------------------------------
-- Asserções finais (falham alto; tudo reverte)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_spec    text;
  v_tbl     regclass;
  v_secret  text[];
  v_col     text;
  v_missing text;
BEGIN
  -- 'tabela|coluna,coluna' (texto, para aceitar listas de tamanhos diferentes)
  FOREACH v_spec IN ARRAY ARRAY[
    'public.whatsapp_config|access_token,app_secret,verify_token',
    'public.webhook_endpoints|secret'
  ] LOOP
    v_tbl    := split_part(v_spec, '|', 1)::regclass;
    v_secret := string_to_array(split_part(v_spec, '|', 2), ',');

    -- anon: nada
    IF has_any_column_privilege('anon', v_tbl, 'SELECT, INSERT, UPDATE, REFERENCES')
       OR has_table_privilege('anon', v_tbl, 'DELETE, TRUNCATE, TRIGGER') THEN
      RAISE EXCEPTION '112: anon ainda tem privilegio em %.', v_tbl USING ERRCODE = '55006';
    END IF;

    -- authenticated: sem SELECT de tabela, sem as colunas cifradas
    IF has_table_privilege('authenticated', v_tbl, 'SELECT') THEN
      RAISE EXCEPTION '112: authenticated ainda tem SELECT de tabela em %.', v_tbl
        USING ERRCODE = '55006';
    END IF;
    FOREACH v_col IN ARRAY v_secret LOOP
      IF has_column_privilege('authenticated', v_tbl, v_col, 'SELECT') THEN
        RAISE EXCEPTION '112: authenticated ainda le %.%.', v_tbl, v_col USING ERRCODE = '55006';
      END IF;
      IF has_column_privilege('anon', v_tbl, v_col, 'SELECT') THEN
        RAISE EXCEPTION '112: anon ainda le %.%.', v_tbl, v_col USING ERRCODE = '55006';
      END IF;
      IF NOT has_column_privilege('service_role', v_tbl, v_col, 'SELECT') THEN
        RAISE EXCEPTION '112: service_role perdeu a leitura de %.% (o servidor quebraria).', v_tbl, v_col
          USING ERRCODE = '55006';
      END IF;
    END LOOP;

    -- toda outra coluna segue legível para a tela
    SELECT string_agg(a.attname, ', ' ORDER BY a.attnum)
      INTO v_missing
      FROM pg_attribute a
     WHERE a.attrelid = v_tbl
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname <> ALL (v_secret)
       AND NOT has_column_privilege('authenticated', v_tbl, a.attname, 'SELECT');
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION '112: colunas sem SELECT para authenticated em % (a tela quebraria): %.', v_tbl, v_missing
        USING ERRCODE = '55006';
    END IF;

    -- escrita de admin+ preservada (a RLS decide) e service_role intacto
    IF NOT (has_table_privilege('authenticated', v_tbl, 'INSERT')
            AND has_table_privilege('authenticated', v_tbl, 'UPDATE')
            AND has_table_privilege('authenticated', v_tbl, 'DELETE')) THEN
      RAISE EXCEPTION '112: authenticated perdeu INSERT/UPDATE/DELETE em %.', v_tbl USING ERRCODE = '55006';
    END IF;
    IF NOT (has_table_privilege('service_role', v_tbl, 'SELECT')
            AND has_table_privilege('service_role', v_tbl, 'INSERT')
            AND has_table_privilege('service_role', v_tbl, 'UPDATE')
            AND has_table_privilege('service_role', v_tbl, 'DELETE')) THEN
      RAISE EXCEPTION '112: service_role perdeu privilegio em %.', v_tbl USING ERRCODE = '55006';
    END IF;
  END LOOP;
END $$;

COMMIT;
