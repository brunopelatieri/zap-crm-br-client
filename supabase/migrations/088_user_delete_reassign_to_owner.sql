-- ============================================================
-- 088_user_delete_reassign_to_owner.sql
--
-- Excluir um usuário (auth.users) não pode mais apagar dados de conta:
-- o que ele criou em uma conta passa para o PROPRIETÁRIO daquela conta.
--
-- Herança do wacrm original (pré multi-conta): 16 tabelas de dados de
-- conta têm `user_id → auth.users ON DELETE CASCADE`. Quando o modelo
-- passou a ser por conta (`account_id` + RLS via is_account_member),
-- `user_id` virou só "quem criou" — mas a FK continuou em CASCADE.
--
-- Efeito em produção (vn):
--   * 2026-08-31 — o DELETE do usuário antigo de um membro removido
--     levou junto os contatos que ele havia criado na conta compartilhada
--     (40 deals ficaram órfãos de contato às 20:23 UTC).
--   * 2026-10-06 — membro removido da conta compartilhada e, em seguida,
--     a conta pessoal criada para ele (remove_account_member) excluída
--     pelo console /admin. A exclusão do login (etapa 5 de
--     platform/accounts/[accountId]/delete) apagou em cascata 1.627
--     contatos da conta compartilhada, com conversas, mensagens, notas,
--     etiquetas, disparos e templates criados por ele. O tombstone do
--     console registrou counts = 0 porque só conta a conta excluída.
--     Plano Free, sem backup: perda definitiva (ver
--     docs/issues_resolved/2026-10-06-recuperacao-cascata-andrey.sql).
--
-- Correção, em duas camadas:
--
--   1) Trigger BEFORE DELETE em auth.users (`reassign_user_rows_to_owner`):
--      antes de o login sumir, toda linha das 16 tabelas com
--      user_id = OLD.id passa a user_id = accounts.owner_user_id da conta
--      da própria linha. Roda antes das ações de FK, então nada chega a
--      cascatear.
--
--      Sempre há um dono diferente para receber: accounts.owner_user_id é
--      ON DELETE RESTRICT, então o Postgres não deixa apagar quem ainda é
--      dono de alguma conta — os fluxos de exclusão (SPEC 062 / SPEC 073)
--      apagam `accounts` ANTES do login, e com isso as linhas da conta do
--      próprio usuário já foram embora por cascade de account_id. O que
--      sobra com user_id = OLD.id é, por construção, dado em conta alheia.
--
--   2) Rede de segurança: as 16 FKs passam a ON DELETE SET NULL (e a
--      coluna perde o NOT NULL). Se um dia uma tabela nova com user_id
--      ficar fora da lista do trigger, o pior caso é "criador vazio" —
--      nunca mais apagar dado.
--
-- Ficam em CASCADE, de propósito (são do usuário, não da conta):
--   profiles, member_presence, notifications.
--
-- A autoria original continua em account_activity_log (actor_name /
-- actor_role); o user_id passa a significar "responsável atual".
--
-- RLS: as únicas policies que leem `user_id` nessas tabelas são as legadas
-- "Users can manage own automations" / "Users can view own automation
-- logs" (permissivas, OR com as policies por conta) — reatribuir ao dono
-- só amplia o acesso do dono, que já tem acesso pela policy de conta.
--
-- Idempotente: pode ser reaplicada.
-- ============================================================

-- 1) Reatribuição ao proprietário da conta ---------------------------

CREATE OR REPLACE FUNCTION public.reassign_user_rows_to_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t       TEXT;
  v_count BIGINT;
  v_tables CONSTANT TEXT[] := ARRAY[
    'automation_logs',
    'automation_pending_executions',
    'automations',
    'broadcasts',
    'contact_notes',
    'contacts',
    'conversations',
    'custom_fields',
    'deals',
    'flow_runs',
    'flows',
    'message_templates',
    'pipelines',
    'quick_replies',
    'tags',
    'whatsapp_config'
  ];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format(
      'UPDATE public.%I r
          SET user_id = a.owner_user_id
         FROM public.accounts a
        WHERE r.user_id = $1
          AND a.id = r.account_id
          AND a.owner_user_id IS NOT NULL
          AND a.owner_user_id <> $1',
      t
    ) USING OLD.id;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      RAISE LOG 'reassign_user_rows_to_owner: % linha(s) de % passaram de % ao dono da conta',
        v_count, t, OLD.id;
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_user_rows_to_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_deleted_reassign ON auth.users;
CREATE TRIGGER on_auth_user_deleted_reassign
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.reassign_user_rows_to_owner();

-- 2) Rede de segurança: CASCADE → SET NULL -------------------------

DO $$
DECLARE
  t TEXT;
  v_tables CONSTANT TEXT[] := ARRAY[
    'automation_logs',
    'automation_pending_executions',
    'automations',
    'broadcasts',
    'contact_notes',
    'contacts',
    'conversations',
    'custom_fields',
    'deals',
    'flow_runs',
    'flows',
    'message_templates',
    'pipelines',
    'quick_replies',
    'tags',
    'whatsapp_config'
  ];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_user_id_fkey'
    );
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN user_id DROP NOT NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) '
      'REFERENCES auth.users(id) ON DELETE SET NULL',
      t, t || '_user_id_fkey'
    );
  END LOOP;
END;
$$;

-- Guarda: nenhuma tabela de dado de conta pode voltar a cascatear a partir
-- de auth.users. Falha a migração se sobrar alguma fora da lista permitida.
DO $$
DECLARE
  v_offenders TEXT;
BEGIN
  SELECT string_agg(c.conrelid::regclass::text, ', ')
    INTO v_offenders
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.confrelid = 'auth.users'::regclass
     AND c.confdeltype = 'c'
     AND c.connamespace = 'public'::regnamespace
     AND c.conrelid::regclass::text NOT IN
         ('profiles', 'member_presence', 'notifications');

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      '088: ainda há FK para auth.users com ON DELETE CASCADE em: %',
      v_offenders;
  END IF;
END;
$$;
