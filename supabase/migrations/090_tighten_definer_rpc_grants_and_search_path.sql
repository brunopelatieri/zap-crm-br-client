-- ============================================================
-- 090_tighten_definer_rpc_grants_and_search_path.sql
--
-- Porte do aperto de RPCs do Valen Ranch (migrações 090 e 092 de lá,
-- SPEC 080 daquele repositório — não confundir com a SPEC 080 daqui).
-- O ZAP CRM BR e o Ranch compartilham as migrações 001–089, então as
-- funções, os grants e o motivo são os mesmos. Esta é a varredura das
-- funções antigas que a 084b avisou que não tinha feito.
--
-- Por que "REVOKE ... FROM PUBLIC" nunca bastou aqui
--
--   A 067 fez `REVOKE ALL ON FUNCTION recount_account_usage(UUID) FROM
--   PUBLIC` e mesmo assim `anon` e `authenticated` ficam com EXECUTE. O
--   Supabase concede EXECUTE a anon/authenticated/service_role por
--   DEFAULT PRIVILEGES do schema `public`: são grants explícitos, que o
--   REVOKE de PUBLIC não toca. Por isso esta migração revoga de PUBLIC,
--   anon e authenticated em comandos separados (lição da 042 e da 084b).
--
-- Quatro funções são exploráveis de verdade, sem JWT, só com a anon key
-- do bundle (nenhuma checa quem chama):
--
--   upsert_webhook_funnel(...)             cria/incrementa disparo
--                                          `streaming` em QUALQUER conta
--   increment_broadcast_total_recipients() infla o contador de qualquer
--                                          disparo
--   purge_webhook_ingest_logs(int)         apaga o log de ingestão de
--                                          TODAS as contas
--   recount_account_usage(uuid)            reescreve o contador de
--                                          contatos de qualquer conta
--
-- As outras já validam `auth.uid()`/`is_account_member()` por dentro; o
-- ACL passa a ser a segunda tranca, como na 082.
--
-- Decisão por função:
--
--   A. Só servidor/gatilho  → sem EXECUTE para PUBLIC, anon, authenticated.
--      service_role mantém o grant (é quem o app usa, via supabaseAdmin()).
--      Revogar EXECUTE não afeta o disparo como trigger: o Postgres checa
--      EXECUTE na criação do trigger, não a cada disparo (mesmo raciocínio
--      da 084b).
--   B. Sessão do usuário    → só `authenticated`. Anon some.
--   C. peek_invitation      → anon FICA, de propósito: o convidado ainda
--      não tem conta nem sessão quando abre o link.
--
-- Diferenças em relação ao Ranch (lá a 092 corrigiu a 090 depois de
-- aplicada; aqui as correções já nascem nesta migração):
--
--   * `plans_select_own` vai para `TO authenticated` ANTES dos REVOKE, em
--     vez de o catálogo público de `plans` ficar quebrado entre uma
--     migração e outra (ver abaixo).
--   * `triage_row_matches` NÃO recebe search_path: a 046/047 a deixaram
--     sem ele de propósito, para o planner fazer inline. O lint 0011 fica
--     com esse 1 WARN, aceito: o corpo só usa built-ins de pg_catalog.
--   * As invariantes globais comparam por assinatura (regprocedure), não
--     por nome: uma sobrecarga com o mesmo nome não escapa.
--   * A asserção de search_path trata `proconfig` nulo como falha. A
--     forma do Ranch (`NOT (proconfig @> ...)`) dava NULL nesse caso e
--     não pegava justamente a função que ficou sem o SET.
--
-- A 091 trata a causa (privilégio padrão de funções novas). Fica de fora,
-- por decisão: mover a extensão `vector` para outro schema (lint 0014).
--
-- Idempotente: REVOKE, GRANT, ALTER POLICY e ALTER FUNCTION repetidos não
-- mudam nada. Roda como `postgres`, numa transação: se uma asserção
-- falhar, nada fica aplicado.
-- ============================================================

-- ------------------------------------------------------------
-- plans: o catálogo público precisa continuar legível sem login
--
-- `plans_select_catalog` (067) libera `is_active AND is_public` para todo
-- mundo; `plans_select_own` chama is_account_member(). As duas são PUBLIC,
-- e o Postgres checa EXECUTE de TODA função das policies permissivas ao
-- iniciar o executor, sem curto-circuito pelo OR. Sem esta linha, depois
-- do REVOKE abaixo, `GET /rest/v1/plans` anônimo daria 42501 em vez do
-- catálogo. `plans` é a única tabela de `public` com esse desenho.
--
-- `storage.objects` tem desenho parecido, mas o download público não
-- passa pela RLS; só a listagem anônima do bucket passa a recusar, e o
-- app não lista sem sessão. Fica como está.
-- ------------------------------------------------------------
ALTER POLICY plans_select_own ON public.plans TO authenticated;

-- ------------------------------------------------------------
-- A. Só servidor/gatilho: ninguém por /rest/v1/rpc
-- ------------------------------------------------------------

-- Funções de gatilho.
REVOKE ALL ON FUNCTION public.broadcast_recipient_aggregate_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.broadcast_recipient_aggregate_trigger() FROM anon;
REVOKE ALL ON FUNCTION public.broadcast_recipient_aggregate_trigger() FROM authenticated;

REVOKE ALL ON FUNCTION public.decrement_contact_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decrement_contact_usage() FROM anon;
REVOKE ALL ON FUNCTION public.decrement_contact_usage() FROM authenticated;

REVOKE ALL ON FUNCTION public.enforce_contact_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_contact_quota() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_contact_quota() FROM authenticated;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM authenticated;

REVOKE ALL ON FUNCTION public.normalize_contact_created_via() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_contact_created_via() FROM anon;
REVOKE ALL ON FUNCTION public.normalize_contact_created_via() FROM authenticated;

REVOKE ALL ON FUNCTION public.notify_conversation_assigned() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_conversation_assigned() FROM anon;
REVOKE ALL ON FUNCTION public.notify_conversation_assigned() FROM authenticated;

-- Ingestão por API-key: src/lib/ingest/funnel.ts roda com o cliente
-- service_role (ctx.supabase de /api/v1 é supabaseAdmin()).
REVOKE ALL ON FUNCTION public.upsert_webhook_funnel(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_webhook_funnel(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_webhook_funnel(UUID, UUID, TEXT, TEXT) FROM authenticated;

REVOKE ALL ON FUNCTION public.increment_broadcast_total_recipients(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_broadcast_total_recipients(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.increment_broadcast_total_recipients(UUID) FROM authenticated;

-- Manutenção: pg_cron (supabase/setup/cron-jobs.sql) e SQL Editor rodam
-- como postgres; nenhum código em src/ chama.
REVOKE ALL ON FUNCTION public.purge_webhook_ingest_logs(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_webhook_ingest_logs(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.purge_webhook_ingest_logs(INTEGER) FROM authenticated;

REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM authenticated;

-- ------------------------------------------------------------
-- B. Sessão do usuário: só authenticated
--
-- Duas famílias. As quatro funções-predicado de RLS e as quatro
-- `dashboard_*` são chamadas pelo browser/RLS com a sessão do usuário.
-- As quatro de equipe/presença/convite são chamadas pelas rotas
-- /api/account/* e /api/invitations/* com o cliente SSR (sessão).
--
-- Efeito colateral conhecido: as policies de RLS desta base usam o papel
-- PUBLIC e chamam is_account_member()/can_*(). Com anon sem EXECUTE, um
-- SELECT anônimo em tabela de tenant passa a falhar com 42501 em vez de
-- devolver 0 linhas. Continua fail-closed; só muda o formato da recusa.
-- Nenhum caminho do app consulta tabela de tenant sem sessão
-- (login/signup/join usam auth e as RPCs de convite).
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_account_member(UUID, account_role_enum) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_account_member(UUID, account_role_enum) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_account_member(UUID, account_role_enum) TO authenticated;

REVOKE ALL ON FUNCTION public.can_access_contact_notes(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_contact_notes(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_access_contact_notes(UUID, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.can_access_conversation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_conversation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_access_conversation(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.can_write_conversation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_write_conversation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_write_conversation(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.dashboard_counts(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_counts(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.dashboard_counts(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

REVOKE ALL ON FUNCTION public.dashboard_message_series(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_message_series(UUID, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.dashboard_message_series(UUID, TIMESTAMPTZ) TO authenticated;

REVOKE ALL ON FUNCTION public.dashboard_recent_inbound(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_recent_inbound(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.dashboard_recent_inbound(UUID, INTEGER) TO authenticated;

REVOKE ALL ON FUNCTION public.dashboard_response_samples(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_response_samples(UUID, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.dashboard_response_samples(UUID, TIMESTAMPTZ) TO authenticated;

REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.touch_presence(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_presence(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.touch_presence(TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- C. peek_invitation: anon fica, de propósito
--
-- A página /join/[token] chama /api/invitations/[token]/peek ANTES do
-- convidado ter conta ou sessão, com o cliente SSR — ou seja, como
-- `anon`. A função só devolve nome da conta, papel e validade, e só a
-- quem apresenta o hash de um token de 256 bits; a rota ainda aplica
-- rate-limit por IP. Revogar quebra o convite. Só garantimos o estado
-- explícito (idempotente) e fechamos PUBLIC.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;

-- ------------------------------------------------------------
-- search_path fixo nas funções que não tinham (lint 0011)
--
-- Nenhuma é SECURITY DEFINER e nenhuma é inlinável (4 gatilhos plpgsql e
-- uma plpgsql IMMUTABLE), então é só a limpeza que a 084b fez com
-- `mask_phone_for_log`. `triage_row_matches` fica de fora: ver o topo.
-- ------------------------------------------------------------
ALTER FUNCTION public.update_updated_at_column() SET search_path = public;
ALTER FUNCTION public._bcast_cols_for_status(TEXT) SET search_path = public;
ALTER FUNCTION public.update_ai_configs_updated_at() SET search_path = public;
ALTER FUNCTION public.update_ai_knowledge_documents_updated_at() SET search_path = public;
ALTER FUNCTION public.conversations_channel_id_immutable() SET search_path = public;

-- ============================================================
-- Asserções finais — falham alto, no padrão da 042/080/082/084b.
-- ============================================================
DO $assert$
DECLARE
  v_fn   TEXT;
  v_bad  TEXT;
  -- As 20 SECURITY DEFINER que authenticated pode executar, por
  -- assinatura. O cast falha alto se alguma não existir no banco.
  v_session regprocedure[] := ARRAY[
    'public.automation_window_stats(uuid)',
    'public.broadcast_account_stats(uuid,timestamptz)',
    'public.broadcast_engagement_series(uuid,integer,text)',
    'public.broadcast_quota_usage(uuid,integer,uuid)',
    'public.can_access_contact_notes(uuid,uuid)',
    'public.can_access_conversation(uuid)',
    'public.can_write_conversation(uuid)',
    'public.dashboard_counts(uuid,timestamptz,timestamptz)',
    'public.dashboard_message_series(uuid,timestamptz)',
    'public.dashboard_recent_inbound(uuid,integer)',
    'public.dashboard_response_samples(uuid,timestamptz)',
    'public.is_account_member(uuid,account_role_enum)',
    'public.peek_invitation(text)',
    'public.purge_stale_audience_staging(uuid,integer)',
    'public.redeem_invitation(text)',
    'public.remove_account_member(uuid)',
    'public.set_default_channel(uuid)',
    'public.set_member_role(uuid,account_role_enum)',
    'public.touch_presence(text)',
    'public.transfer_account_ownership(uuid)'
  ]::regprocedure[];
BEGIN
  -- A. Só servidor/gatilho: nem anon, nem authenticated, nem PUBLIC;
  --    service_role preservado.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.broadcast_recipient_aggregate_trigger()',
    'public.decrement_contact_usage()',
    'public.enforce_contact_quota()',
    'public.handle_new_user()',
    'public.normalize_contact_created_via()',
    'public.notify_conversation_assigned()',
    'public.upsert_webhook_funnel(uuid,uuid,text,text)',
    'public.increment_broadcast_total_recipients(uuid)',
    'public.purge_webhook_ingest_logs(integer)',
    'public.recount_account_usage(uuid)'
  ]
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '090: % continua executavel via RPC.', v_fn
        USING ERRCODE = '55006';
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '090: % perdeu o GRANT de service_role — o servidor quebraria.', v_fn
        USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- B. Sessão do usuário: authenticated sim, anon e PUBLIC não.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.is_account_member(uuid,account_role_enum)',
    'public.can_access_contact_notes(uuid,uuid)',
    'public.can_access_conversation(uuid)',
    'public.can_write_conversation(uuid)',
    'public.dashboard_counts(uuid,timestamptz,timestamptz)',
    'public.dashboard_message_series(uuid,timestamptz)',
    'public.dashboard_recent_inbound(uuid,integer)',
    'public.dashboard_response_samples(uuid,timestamptz)',
    'public.set_member_role(uuid,account_role_enum)',
    'public.transfer_account_ownership(uuid)',
    'public.touch_presence(text)',
    'public.redeem_invitation(text)',
    'public.remove_account_member(uuid)',
    'public.set_default_channel(uuid)',
    'public.automation_window_stats(uuid)',
    'public.broadcast_account_stats(uuid,timestamptz)',
    'public.broadcast_engagement_series(uuid,integer,text)',
    'public.broadcast_quota_usage(uuid,integer,uuid)',
    'public.purge_stale_audience_staging(uuid,integer)'
  ]
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '090: % continua executavel por anon/PUBLIC.', v_fn
        USING ERRCODE = '55006';
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '090: % perdeu o GRANT de authenticated — o app quebraria.', v_fn
        USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- C. peek_invitation: anon e authenticated, e só eles.
  IF NOT has_function_privilege('anon', 'public.peek_invitation(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.peek_invitation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '090: peek_invitation perdeu o EXECUTE de anon/authenticated — o convite quebraria.'
      USING ERRCODE = '55006';
  END IF;
  IF has_function_privilege('public', 'public.peek_invitation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '090: peek_invitation continua executavel por PUBLIC.'
      USING ERRCODE = '55006';
  END IF;

  -- Invariante global por assinatura: a única SECURITY DEFINER de public
  -- que anon executa é peek_invitation(text). Pega função esquecida acima.
  SELECT string_agg(p.oid::regprocedure::text, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.prosecdef
     AND p.oid <> 'public.peek_invitation(text)'::regprocedure
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = p.oid AND d.deptype = 'e');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '090: SECURITY DEFINER executavel por anon fora da lista: %', v_bad
      USING ERRCODE = '55006';
  END IF;

  -- Invariante global por assinatura: as SECURITY DEFINER que
  -- authenticated executa são exatamente as 20 de sessão. Uma nova
  -- aparece aqui? Decida (REVOKE ou entrar na lista) antes de seguir.
  -- Vale só nesta migração; as futuras não repetem a lista.
  SELECT string_agg(p.oid::regprocedure::text, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = p.oid AND d.deptype = 'e')
     AND p.oid::regprocedure <> ALL (v_session);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '090: SECURITY DEFINER executavel por authenticated fora da lista: %', v_bad
      USING ERRCODE = '55006';
  END IF;

  -- search_path fixo nas cinco. COALESCE: `proconfig` nulo é justamente
  -- a função sem SET, e NOT (NULL) não a selecionaria.
  SELECT string_agg(p.oid::regprocedure::text, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('update_updated_at_column', '_bcast_cols_for_status',
                       'update_ai_configs_updated_at',
                       'update_ai_knowledge_documents_updated_at',
                       'conversations_channel_id_immutable')
     AND NOT (COALESCE(p.proconfig, '{}') @> ARRAY['search_path=public']);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '090: search_path ainda mutavel em: %', v_bad
      USING ERRCODE = '55006';
  END IF;

  -- triage_row_matches continua inlinável (sem proconfig).
  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.triage_row_matches(text,text,text,text,boolean,text,boolean,bigint,boolean,boolean,bigint,timestamptz,timestamptz,boolean,integer)'::regprocedure
       AND proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '090: triage_row_matches tem proconfig — o planner nao faz inline.'
      USING ERRCODE = '55006';
  END IF;

  -- plans: nenhuma policy que alcança anon chama os predicados de
  -- membership, e anon ainda tem SELECT na tabela (o catálogo).
  SELECT string_agg(pol.polname, ', ')
    INTO v_bad
    FROM pg_policy pol
   WHERE pol.polrelid = 'public.plans'::regclass
     AND (0 = ANY (pol.polroles) OR 'anon'::regrole = ANY (pol.polroles::regrole[]))
     AND (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
          coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''))
         ~ '(is_account_member|can_access_conversation|can_write_conversation|can_access_contact_notes)';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '090: policy de plans que alcanca anon ainda chama predicado de membership: %', v_bad
      USING ERRCODE = '55006';
  END IF;
  IF NOT has_table_privilege('anon', 'public.plans', 'SELECT') THEN
    RAISE EXCEPTION '090: anon sem SELECT em plans — o catalogo publico some.'
      USING ERRCODE = '55006';
  END IF;

  RAISE NOTICE '090: 22 funcoes fechadas para anon (10 sem RPC nenhuma, 12 so authenticated), peek_invitation mantida para anon, search_path fixado nas 5, plans_select_own so authenticated.';
END $assert$;
