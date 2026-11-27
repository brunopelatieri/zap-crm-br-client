-- 092: `whatsapp_config.app_id` — App ID DA META por canal.
--
-- Por que isto existe
--
--   Template com cabeçalho de imagem precisa de um handle do Resumable
--   Upload, e essa sessão de upload é aberta em `POST /{app_id}/uploads`
--   (src/lib/whatsapp/meta-api.ts). O app_id vinha só de `META_APP_ID`,
--   um valor único por instância, enquanto o token e o `app_secret` (073)
--   já são por canal. Um número conectado sob outro App da Meta usaria o
--   App ID errado para o token dele.
--
-- A regra
--
--   `app_id` do canal > `META_APP_ID` de env var (o App "padrão"). Nulo é
--   o caso comum: só precisa ser preenchido quando este canal foi
--   conectado sob um App da Meta diferente do App padrão da instância.
--
-- Não é segredo: o App ID é um identificador público do App, por isso
-- fica em texto puro e entra na resposta do GET /api/whatsapp/config,
-- diferente de `access_token`, `verify_token` e `app_secret`.
--
-- Ordem de deploy: aplique ANTES de publicar o código. O GET e o POST de
-- /api/whatsapp/config passam a citar a coluna.

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS app_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'whatsapp_config_app_id_digits') THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_app_id_digits
      CHECK (app_id IS NULL OR app_id ~ '^[0-9]+$');
  END IF;
END $$;

COMMENT ON COLUMN whatsapp_config.app_id IS
  'App ID da Meta (Configurações do App > Básico). NULL = usa META_APP_ID (env var) no Resumable Upload de cabeçalho de template. Só precisa ser preenchido quando este canal foi conectado sob um App da Meta diferente do App padrão da instância. Não é segredo.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'whatsapp_config' AND column_name = 'app_id') THEN
    RAISE EXCEPTION '092: coluna whatsapp_config.app_id nao foi criada.';
  END IF;
END $$;
