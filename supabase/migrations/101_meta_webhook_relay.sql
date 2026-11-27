-- ============================================================
-- 101_meta_webhook_relay.sql — SPEC 088 F1 (repetidor do webhook da Meta)
--
-- Só do ZAP. Uma configuração por conta: URL de destino, chave HMAC
-- (cifrada em repouso, AES-256-GCM via `encryption.ts`), liga/desliga e
-- contadores de entrega. A regra (quem recebe o quê, isolamento entre
-- contas) mora em `src/lib/webhooks/meta-relay.ts` (testada).
--
-- `failure_count` conta falhas SEGUIDAS. O incremento é atômico em SQL
-- (`record_meta_relay_failure`): um `count + 1` em TypeScript perde
-- incrementos com entregas simultâneas. A N-ésima falha seguida desliga
-- o repetidor (`is_enabled = false`, `auto_disabled_at = now()`); o N vem
-- do chamador (`p_max_failures`).
--
-- Privilégios: RLS ligada e NENHUMA policy, de propósito — a coluna
-- `secret` nunca fica ao alcance do navegador; só o servidor
-- (service_role) lê e escreve. REVOKE de PUBLIC, anon e authenticated (o
-- privilégio padrão de tabela do dono dá `arwdDxtm` a `authenticated` em
-- `public`, lição da 097). A função é interna: sem SECURITY DEFINER, só
-- o service_role a executa (e ele já ignora RLS).
--
-- O `get_advisors` acusa um INFO 0008 ("RLS sem policy") a mais para
-- `meta_webhook_relays`: esperado.
--
-- Idempotente. Não é para fork de terceiros: nada de URL ou segredo aqui.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_webhook_relays (
  account_id       uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  url              text NOT NULL,
  secret           text NOT NULL,              -- AES-256-GCM (encryption.ts)
  is_enabled       boolean NOT NULL DEFAULT false,
  failure_count    integer NOT NULL DEFAULT 0, -- falhas SEGUIDAS
  last_delivery_at timestamptz,                -- última entrega com 2xx
  last_failure_at  timestamptz,
  auto_disabled_at timestamptz,                -- preenchido só pelo desligamento automático
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE meta_webhook_relays ENABLE ROW LEVEL SECURITY;
-- Sem policy, de propósito: só o servidor (service_role) lê e escreve.

REVOKE ALL ON TABLE meta_webhook_relays FROM PUBLIC;
REVOKE ALL ON TABLE meta_webhook_relays FROM anon;
REVOKE ALL ON TABLE meta_webhook_relays FROM authenticated;
GRANT ALL ON TABLE meta_webhook_relays TO service_role;

CREATE OR REPLACE FUNCTION public.record_meta_relay_failure(
  p_account_id uuid,
  p_max_failures int
) RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE meta_webhook_relays
     SET failure_count    = failure_count + 1,
         last_failure_at  = now(),
         is_enabled       = CASE WHEN failure_count + 1 >= p_max_failures THEN false ELSE is_enabled END,
         auto_disabled_at = CASE WHEN failure_count + 1 >= p_max_failures AND is_enabled THEN now() ELSE auto_disabled_at END
   WHERE account_id = p_account_id;
$$;

REVOKE ALL ON FUNCTION public.record_meta_relay_failure(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_meta_relay_failure(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.record_meta_relay_failure(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_meta_relay_failure(uuid, int) TO service_role;

-- Asserção: se o privilégio padrão do dono escapar, a migração falha e faz
-- rollback (mesmo padrão da 100).
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.meta_webhook_relays', 'SELECT')
     OR has_table_privilege('authenticated', 'public.meta_webhook_relays', 'SELECT')
     OR has_table_privilege('authenticated', 'public.meta_webhook_relays', 'INSERT')
     OR has_table_privilege('authenticated', 'public.meta_webhook_relays', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.meta_webhook_relays', 'DELETE') THEN
    RAISE EXCEPTION 'meta_webhook_relays: anon/authenticated com privilegio indevido';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.meta_webhook_relays'::regclass) THEN
    RAISE EXCEPTION 'meta_webhook_relays: RLS desligada';
  END IF;
  IF has_function_privilege('anon', 'public.record_meta_relay_failure(uuid, int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_meta_relay_failure(uuid, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'record_meta_relay_failure: anon/authenticated podem executar';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.record_meta_relay_failure(uuid, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'record_meta_relay_failure: service_role sem EXECUTE';
  END IF;
END $$;
