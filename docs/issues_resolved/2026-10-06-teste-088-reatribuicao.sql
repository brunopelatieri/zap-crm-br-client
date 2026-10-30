-- Teste de ponta a ponta da migração 088 (rodar no SQL Editor de CADA projeto: vn e rs).
--
-- Reproduz o incidente de 2026-10-06 em miniatura:
--   1) cria um usuário descartável (o gatilho handle_new_user cria a conta pessoal dele);
--   2) dá a ele um contato e uma etiqueta DENTRO da conta do proprietário (a "compartilhada");
--   3) apaga a conta pessoal dele e depois o login — exatamente a ordem do console /admin;
--   4) confere que contato e etiqueta continuam existindo e agora pertencem ao dono da conta.
--
-- NÃO deixa nada gravado: o bloco termina SEMPRE com um erro proposital, que desfaz a
-- transação inteira (usuário, conta, contato, etiqueta, logs de atividade). O resultado
-- do teste vem na mensagem de erro — "ERROR: P0001: TESTE 088 …" é o comportamento esperado.
--
-- Aprovado = a mensagem começa com "TESTE 088 OK".
-- Se o editor avisar "destructive operations", confirme com "Run" (o DELETE é só do usuário
-- de teste e do que ele criou, e tudo é revertido).

DO $$
DECLARE
  v_uid         uuid := gen_random_uuid();
  -- conta "compartilhada" do teste: a do vn (dono: Bruno) se existir; senão a conta com mais membros
  v_acc         uuid := coalesce(
                          (SELECT id FROM accounts WHERE id = '5e0564ad-a8f6-4dec-89a1-7e7bdc1775be'),
                          (SELECT a.id FROM accounts a
                            ORDER BY (SELECT count(*) FROM profiles p WHERE p.account_id = a.id) DESC, a.created_at
                            LIMIT 1));
  v_owner       uuid;
  v_contact     uuid;
  v_tag         uuid;
  v_contact_uid uuid;
  v_tag_uid     uuid;
  v_contact_ok  boolean;
  v_tag_ok      boolean;
  v_restantes   bigint := 0;
  v_n           bigint;
  t             text;
  v_msg         text;
  v_tables CONSTANT text[] := ARRAY[
    'automation_logs','automation_pending_executions','automations','broadcasts',
    'contact_notes','contacts','conversations','custom_fields','deals','flow_runs',
    'flows','message_templates','pipelines','quick_replies','tags','whatsapp_config'];
BEGIN
  BEGIN
    SELECT owner_user_id INTO v_owner FROM accounts WHERE id = v_acc;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'conta % não existe neste projeto — ajuste v_acc', v_acc;
    END IF;

    -- 1) usuário descartável (handle_new_user cria conta pessoal + perfil)
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
    VALUES (v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'teste-088-' || v_uid || '@example.invalid', '{"full_name":"Teste 088"}');

    -- 2) dados dele dentro da conta compartilhada
    INSERT INTO contacts (user_id, account_id, phone, name, created_via)
    VALUES (v_uid, v_acc, '5511900008808', 'teste 088', 'manual')
    RETURNING id INTO v_contact;

    INSERT INTO tags (user_id, account_id, name, color)
    VALUES (v_uid, v_acc, 'teste-088-' || v_uid, '#ff00ff')
    RETURNING id INTO v_tag;

    -- 3) mesma ordem do console: conta pessoal do usuário primeiro, login depois
    DELETE FROM accounts WHERE owner_user_id = v_uid;
    DELETE FROM auth.users WHERE id = v_uid;

    -- 4) conferência
    SELECT user_id, true INTO v_contact_uid, v_contact_ok FROM contacts WHERE id = v_contact;
    SELECT user_id, true INTO v_tag_uid,     v_tag_ok     FROM tags     WHERE id = v_tag;

    FOREACH t IN ARRAY v_tables LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = $1', t) INTO v_n USING v_uid;
      v_restantes := v_restantes + v_n;
    END LOOP;

    IF coalesce(v_contact_ok, false)
       AND coalesce(v_tag_ok, false)
       AND v_contact_uid = v_owner
       AND v_tag_uid = v_owner
       AND v_restantes = 0
       AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid)
    THEN
      v_msg := format('TESTE 088 OK — contato e etiqueta sobreviveram e passaram ao dono da conta (%s); 0 linhas ainda apontando para o usuário apagado.', v_owner);
    ELSE
      v_msg := format('TESTE 088 FALHOU — contato_existe=%s contato_user_id_e_dono=%s etiqueta_existe=%s etiqueta_user_id_e_dono=%s linhas_restantes_no_usuario=%s',
                      coalesce(v_contact_ok, false), v_contact_uid = v_owner,
                      coalesce(v_tag_ok, false), v_tag_uid = v_owner, v_restantes);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_msg := 'TESTE 088 ERRO INESPERADO — ' || SQLERRM || ' (SQLSTATE ' || SQLSTATE || ')';
  END;

  -- Erro proposital: desfaz tudo o que o teste criou.
  RAISE EXCEPTION '%', v_msg;
END;
$$;
