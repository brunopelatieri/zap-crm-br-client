-- ============================================================
-- 094_contact_portal_public_account.sql — SPEC 083 F1 (PRD 082)
--
-- ORIGEM: cópia byte a byte de `095_contact_portal_public_account.sql` do Valen Ranch (SPEC 084
-- daquele repositório). Só este aviso de origem difere; o SQL abaixo é
-- idêntico, inclusive o cabeçalho e os números de migração citados nos
-- comentários, que são os do Ranch: 094 → 093, 095 → 094, 096 → 095 no
-- ZAP. A guarda por plano fail-closed (`plan_feature_strict`, PRD 082
-- D-2) entra na 096 do ZAP, que reescreve `account_is_eligible`.
-- ============================================================

-- ============================================================
-- 095_contact_portal_public_account.sql — SPEC 084 F4
--
-- A tela `/area/c/<código>` mostra o nome da conta que divulga o
-- endereço (PRD 081 §4.1). A 094 não tinha como responder "de quem é
-- este código": `contact_portal.account_by_code` é ajudante interno e
-- devolve só o id.
--
-- `portal_public_account` devolve o NOME (nunca o id) e só quando a
-- conta é elegível — área ligada, item de plano e conta não bloqueada.
-- Conta desligada responde vazio, como código inexistente: a tela cai
-- no "Área do contato" genérico.
--
-- Não é oráculo de contato: o código é público por desenho (QR no
-- evento, link na bio), e a função não recebe telefone nenhum.
--
-- Mesmo regime da 094: SECURITY DEFINER, `search_path` fixo, EXECUTE só
-- para `service_role` (a página chama pelo servidor).
-- ============================================================

CREATE OR REPLACE FUNCTION public.portal_public_account(p_public_code TEXT)
RETURNS TABLE (account_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.name
  FROM contact_portal.settings s
  JOIN public.accounts a ON a.id = s.account_id
  WHERE p_public_code IS NOT NULL
    AND s.public_code = upper(btrim(p_public_code))
    AND contact_portal.account_is_eligible(s.account_id);
$$;

REVOKE ALL ON FUNCTION public.portal_public_account(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_public_account(TEXT) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.portal_public_account(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_public_account(text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.portal_public_account(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '095: portal_public_account executável por anon/authenticated/PUBLIC.'
      USING ERRCODE = '55006';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.portal_public_account(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '095: portal_public_account sem EXECUTE para service_role.'
      USING ERRCODE = '55006';
  END IF;
END;
$$;
