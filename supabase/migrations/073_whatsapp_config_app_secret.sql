-- 073: `whatsapp_config.app_secret` — App Secret DA META por canal.
--
-- Por que isto existe
--
--   `verifyMetaWebhookSignature` (src/lib/whatsapp/webhook-signature.ts)
--   validava TODO POST de webhook contra um único `META_APP_SECRET` de
--   env var. Isso bastava enquanto só existia um App da Meta na conta —
--   mas a SPEC 064 permite conectar um segundo número oficial sob um App
--   da Meta DIFERENTE (WABA separado, credenciais próprias), e cada App
--   assina seus webhooks com o PRÓPRIO App Secret. Com só um secret
--   configurado, todo evento do segundo App chega e é rejeitado com
--   401 "Invalid signature" — a Meta ENTREGA a mensagem (confirmado no
--   log de produção: `[webhook] rejected request with invalid
--   signature` no exato segundo de cada teste), mas o servidor descarta
--   antes de processar. Sintoma: número "conectado", diagnóstico "tudo
--   verde", e nenhuma mensagem chega — porque a rejeição acontece antes
--   de qualquer lookup por `phone_number_id`.
--
-- A regra
--
--   Igual a `verify_token` (mesma tabela, mesmo problema resolvido pela
--   072/pelo loop do GET): o POST do webhook passa a aceitar a
--   assinatura se ela bater com QUALQUER app_secret cadastrado nos
--   canais, OU com o `META_APP_SECRET` de env var (o App "padrão",
--   preserva contas de número único sem exigir preenchimento). Nulo é o
--   caso comum — só precisa ser preenchido quando um canal usa um App
--   da Meta diferente do App padrão da conta.

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS app_secret TEXT;

COMMENT ON COLUMN whatsapp_config.app_secret IS
  'App Secret da Meta (Configurações do App > Básico), criptografado com o mesmo esquema de access_token/verify_token. NULL = usa META_APP_SECRET (env var) para validar a assinatura do webhook. Só precisa ser preenchido quando este canal foi conectado sob um App da Meta diferente do App padrão (SPEC 064 D-2, ver src/lib/whatsapp/webhook-signature.ts).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'whatsapp_config' AND column_name = 'app_secret') THEN
    RAISE EXCEPTION '073: coluna whatsapp_config.app_secret nao foi criada.';
  END IF;
END $$;
