-- ============================================================
-- 097_forms_core.sql — SPEC 085 §5.1 (PRD 084), F1
--
-- Formulários de captação: o núcleo do banco. Três tabelas no schema
-- `public`, RLS para a equipe (`is_account_member`), NADA para `anon`
-- (E-1): a página pública `/f/<slug>` usa `service_role` escopado por
-- slug e o visitante nunca toca o banco.
--
-- Escrita LOCAL nesta fase; aplicar no `vn` só na F5, com confirmação
-- do mantenedor (SPEC 085 §11). Idempotente — seguro reexecutar.
--
-- 1. `forms`            — um formulário por slug (único no deployment, E-3)
-- 2. `form_fields`      — blocos em tabela própria (E-2), `account_id`
--                         redundante de propósito (RLS sem join)
-- 3. `form_responses`   — instantâneo em JSONB (PRD D-4), sempre com
--                         contato (PRD D-2); escrita só por `service_role`
-- 4. RLS                — policies `TO authenticated` (D-20); `anon` sem
--                         GRANT nem policy
-- 5. `contacts.created_via` ganha `'form'` (lista copiada da 078, a
--    última que recriou o CHECK — não da 067)
-- 6. Buckets privados `form-uploads` (16 MB, allowlist) e `form-media`
--    (5 MB, só imagem); leitura por membro no padrão da 078 (CASE
--    guardado por regexp), escrita só por `service_role` em
--    `form-uploads` e por `admin` da conta em `form-media`
-- 7. `form_responses_delete(form_id, ids[])` — `admin+`, devolve os
--    caminhos dos arquivos para a rota apagar os objetos (PRD D-14)
-- 8. `form_public_availability(slug, generic_link)` — versão MÍNIMA
--    (publicado + conta não bloqueada); a 098 a reescreve com
--    `plan_feature_strict` e as quotas, para esta migração não depender
--    de função de plano
-- 9a. `forms_list_stats(account)` — contadores da lista `/forms` em UMA
--    consulta agregada (F2, SPEC 085 §7.1)
-- 9b. `form_fields_replace(form_id, fields)` — substitui os blocos em
--    transação mantendo ids (F2, SPEC 085 §7.1)
-- 9. Trilhas: `account_activity_log.resource_type` aceita `'form'`;
--    `set_contact_opt_in` e `contact_consent_events.source` aceitam
--    `'form'`; `reassign_user_rows_to_owner` (088) cobre `forms`
-- 10. Asserções — falham alto
--
-- Desvios da SPEC §5.1 encontrados ao escrever (registrados no Status
-- da SPEC 085):
--   - `forms.user_id` é NULLABLE com `ON DELETE SET NULL` (a SPEC
--     escrevia `NOT NULL … ON DELETE SET NULL`, que é contraditório:
--     o SET NULL violaria o NOT NULL). A 088 já faz esse par
--     (reatribuir ao dono + SET NULL como rede) para as outras tabelas;
--     `forms` entra na mesma lista.
--   - O regex do slug exige 3–60 caracteres (E-3); a forma da SPEC
--     aceitava slug de 1 caractere.
--   - `form_public_availability` nasce com o 2º parâmetro
--     `p_generic_link` (a checagem de `contacts` cheia só vale para o
--     link genérico, E-8) — assim a 098 faz CREATE OR REPLACE sem DROP.
-- ============================================================

-- ------------------------------------------------------------
-- 1) forms
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forms (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Criador (auditoria). NULL depois que o usuário é excluído e a 088
  -- não encontrou dono diferente para receber a linha.
  user_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug              TEXT NOT NULL UNIQUE
                      CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','published','archived')),
  locale            TEXT NOT NULL DEFAULT 'pt-BR'
                      CHECK (locale IN ('pt-BR','en')),
  description       TEXT,
  -- logo_path, colors{primary,background,text,button}, font, radius,
  -- welcome{…}, thank_you{…}
  theme             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- accept_generic_link, confirm_phone_with_token, allow_multiple_responses,
  -- token_ttl_days, turnstile, embed_origins[], redirect_url, whatsapp_cta
  settings          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- bands[]: {key,label,min,max,actions{tag_ids[],deal{pipeline_id,
  -- stage_id,title_template,assign:{mode,user_id}},notify_user_ids[]}}
  scoring           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Campos USADOS só pela SPEC 086; nascem aqui para a 086 não precisar
  -- de migração em `forms` (SPEC 085 §13).
  portal_visibility TEXT NOT NULL DEFAULT 'none'
                      CHECK (portal_visibility IN ('none','fill','responses','both')),
  ai_offerable      BOOLEAN NOT NULL DEFAULT FALSE,
  ai_offer_hint     TEXT,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_at      TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forms_account ON forms(account_id);
CREATE INDEX IF NOT EXISTS idx_forms_published_slug
  ON forms(slug) WHERE status = 'published';

COMMENT ON TABLE forms IS
  'Formularios de captacao (SPEC 085). slug unico no deployment; status draft|published|archived; archived sai da quota e despublica (PRD 084 D-14).';
COMMENT ON COLUMN forms.scoring IS
  'Faixas de pontuacao e acoes (PRD 084 D-5). Calculado SO no servidor; nunca vai ao payload publico (E-9).';

DROP TRIGGER IF EXISTS set_updated_at ON forms;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 2) form_fields
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_fields (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id     UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  -- Redundante de propósito: a RLS decide sem join em `forms`.
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key         TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,40}$'),
  position    INTEGER NOT NULL CHECK (position >= 0),
  type        TEXT NOT NULL CHECK (type IN (
                'short_text','long_text','email','phone','number','date',
                'single_select','multi_select','dropdown','yes_no','rating',
                'file_upload','statement','consent')),
  label       TEXT NOT NULL,
  description TEXT,
  required    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Só em type='phone'; no máximo um por formulário (índice parcial).
  is_identity BOOLEAN NOT NULL DEFAULT FALSE,
  -- [{id,label,points,jump_to}]
  options     JSONB,
  -- min,max,step,max_length,mask,min_choices,max_choices,max_files,
  -- accept[],scale,points_ranges[]
  validation  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {kind:'image',path} | {kind:'video',url}
  media       JSONB,
  -- {target:'contact.name'|'contact.email'|'contact.company'|
  --  'contact.opt_in'|'custom:<uuid>'|'tag', overwrite:boolean,
  --  tag_by_option:{option_id:tag_id}}
  mapping     JSONB,
  -- {field_key,op,value}
  show_if     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- DEFERRABLE: `form_fields_replace` (seção 9b) troca chaves entre blocos
  -- na mesma transação (trocar a ordem de dois blocos com chave fixa).
  CONSTRAINT form_fields_form_key_unique UNIQUE (form_id, key)
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT form_fields_identity_is_phone
    CHECK (NOT is_identity OR type = 'phone')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_form_fields_one_identity
  ON form_fields(form_id) WHERE is_identity;
CREATE INDEX IF NOT EXISTS idx_form_fields_form_position
  ON form_fields(form_id, position);
CREATE INDEX IF NOT EXISTS idx_form_fields_account ON form_fields(account_id);

COMMENT ON TABLE form_fields IS
  'Blocos do formulario, um por tela (SPEC 085 §4.1). key estavel por formulario; mapping por ID de campo personalizado, nunca por nome (SPEC 055 §2.2).';

DROP TRIGGER IF EXISTS set_updated_at ON form_fields;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON form_fields
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 3) form_responses
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id           UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- PRD 084 D-2: nunca nulo. Excluir o contato leva as respostas (LGPD).
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'partial'
                      CHECK (status IN ('partial','completed','abandoned')),
  identity_mode     TEXT NOT NULL CHECK (identity_mode IN ('phone','token')),
  source            TEXT NOT NULL DEFAULT 'link'
                      CHECK (source IN ('link','inbox','broadcast','automation',
                                        'flow','portal','ai','api','embed')),
  form_version      INTEGER NOT NULL,
  -- {key:{label,type,value,points,option_labels?}} — instantâneo (D-4)
  answers           JSONB NOT NULL DEFAULT '{}'::jsonb,
  score             INTEGER,
  band_key          TEXT,
  -- sha256 do resume_token; NULL depois de completed
  resume_token_hash BYTEA,
  upload_bytes      BIGINT NOT NULL DEFAULT 0 CHECK (upload_bytes >= 0),
  utm               JSONB,
  locale            TEXT,
  -- sha256(ip + chave derivada de FORM_LINK_SECRET); nunca o IP
  ip_hash           TEXT,
  user_agent        TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 256),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT form_responses_completed_has_timestamp
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_form_responses_form_status
  ON form_responses(form_id, status, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_responses_contact
  ON form_responses(contact_id);
CREATE INDEX IF NOT EXISTS idx_form_responses_account_month
  ON form_responses(account_id, completed_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_form_responses_answers
  ON form_responses USING GIN (answers jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_form_responses_partial_stale
  ON form_responses(updated_at) WHERE status = 'partial';

COMMENT ON TABLE form_responses IS
  'Respostas (SPEC 085 §4.6): partial (criada no start) -> completed (submit) | abandoned (varredura > 24 h). So completed conta na quota e dispara faixa/integracoes. Escrita so por service_role.';

DROP TRIGGER IF EXISTS set_updated_at ON form_responses;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON form_responses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 4) RLS — equipe por `is_account_member`, `TO authenticated` (D-20).
--    `anon`: nenhuma policy e nenhum GRANT. Depois da 091 isso já é o
--    padrão para tabela nova; antes dela, o `REVOKE` abaixo garante.
-- ------------------------------------------------------------
ALTER TABLE forms          ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_fields    ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_responses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE forms, form_fields, form_responses FROM PUBLIC;
REVOKE ALL ON TABLE forms, form_fields, form_responses FROM anon;
-- `authenticated` também: o privilégio padrão do dono `postgres` em `public`
-- (ALTER DEFAULT PRIVILEGES do Supabase) concede `arwdDxtm` a `authenticated`
-- e `service_role` em TODA tabela nova. Sem este REVOKE a equipe ficaria com
-- INSERT/UPDATE/DELETE/TRUNCATE em `form_responses` (a RLS barraria, mas a SPEC
-- 085 §5.1 manda só SELECT). Achado na F5 (primeira aplicação falhou na
-- asserção "authenticated com privilegio de escrita"). Os GRANTs abaixo
-- repõem exatamente o que cada papel deve ter.
REVOKE ALL ON TABLE forms, form_fields, form_responses FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE forms       TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE form_fields TO authenticated, service_role;
-- Respostas: a equipe só lê. Escrita (INSERT/UPDATE) só pelas rotas
-- públicas com service_role; DELETE só pela RPC `form_responses_delete`
-- (SECURITY DEFINER), que exige admin.
GRANT SELECT ON TABLE form_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE form_responses TO service_role;

DROP POLICY IF EXISTS forms_select ON forms;
CREATE POLICY forms_select ON forms
  FOR SELECT TO authenticated
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS forms_insert ON forms;
CREATE POLICY forms_insert ON forms
  FOR INSERT TO authenticated
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS forms_update ON forms;
CREATE POLICY forms_update ON forms
  FOR UPDATE TO authenticated
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS forms_delete ON forms;
CREATE POLICY forms_delete ON forms
  FOR DELETE TO authenticated
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS form_fields_select ON form_fields;
CREATE POLICY form_fields_select ON form_fields
  FOR SELECT TO authenticated
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS form_fields_insert ON form_fields;
CREATE POLICY form_fields_insert ON form_fields
  FOR INSERT TO authenticated
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND EXISTS (SELECT 1 FROM forms f
                 WHERE f.id = form_fields.form_id
                   AND f.account_id = form_fields.account_id)
  );

DROP POLICY IF EXISTS form_fields_update ON form_fields;
CREATE POLICY form_fields_update ON form_fields
  FOR UPDATE TO authenticated
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND EXISTS (SELECT 1 FROM forms f
                 WHERE f.id = form_fields.form_id
                   AND f.account_id = form_fields.account_id)
  );

DROP POLICY IF EXISTS form_fields_delete ON form_fields;
CREATE POLICY form_fields_delete ON form_fields
  FOR DELETE TO authenticated
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS form_responses_select ON form_responses;
CREATE POLICY form_responses_select ON form_responses
  FOR SELECT TO authenticated
  USING (is_account_member(account_id));
-- Nenhuma policy de escrita para `authenticated` — de propósito.

-- ------------------------------------------------------------
-- 5) contacts.created_via += 'form' (PRD 084 D-10: conta na quota e
--    NÃO tem a isenção do inbound). Lista copiada da 078 — a última que
--    recriou o CHECK — e não da 067.
-- ------------------------------------------------------------
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_created_via_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_created_via_check
  CHECK (created_via IN ('manual','import','api','audience','inbound','legacy','harvest','form'));

-- ------------------------------------------------------------
-- 6) Buckets privados
-- ------------------------------------------------------------
-- `form-uploads`: arquivos enviados pelo visitante. Caminho
-- `account-<uuid>/<form_id>/<response_id>/<uuid>.<ext>`. `allowed_mime_types`
-- é comparado como string literal pelo Storage (lição da 016/020/023):
-- a rota normaliza com `baseMimeType` antes de assinar.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('form-uploads', 'form-uploads', FALSE, 16777216,
        ARRAY[
          'image/jpeg','image/png','image/webp',
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/plain','text/csv',
          'audio/mpeg','audio/ogg',
          'video/mp4'
        ])
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- `form-media`: imagens do construtor (logo, mídia por bloco). Caminho
-- `account-<uuid>/<form_id>/<uuid>.<ext>`. Privado: a página pública
-- recebe URL assinada curta gerada no servidor (E-16).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('form-media', 'form-media', FALSE, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Leitura por membro da conta dona do primeiro segmento. CASE guardado
-- por regexp (078): um objeto com nome fora da convenção devolve NULL
-- em vez de lançar 22P02 dentro da policy e cegar o bucket inteiro.
DROP POLICY IF EXISTS "Members read own account form uploads" ON storage.objects;
CREATE POLICY "Members read own account form uploads"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'form-uploads'
    AND is_account_member(
      CASE
        WHEN (storage.foldername(name))[1] ~*
             '^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN substring((storage.foldername(name))[1] FROM 9)::uuid
      END
    )
  );
-- `form-uploads`: SEM policy de escrita para `authenticated`. Só a rota
-- pública (service_role) assina URL de upload; só a RPC de apagar
-- respostas/rota (service_role) remove.

DROP POLICY IF EXISTS "Members read own account form media" ON storage.objects;
CREATE POLICY "Members read own account form media"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'form-media'
    AND is_account_member(
      CASE
        WHEN (storage.foldername(name))[1] ~*
             '^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN substring((storage.foldername(name))[1] FROM 9)::uuid
      END
    )
  );

-- `form-media`: escrita para `admin` da conta (quem edita o formulário),
-- no padrão de `flow-media` (020) com a guarda de papel.
DROP POLICY IF EXISTS "Admins write own account form media" ON storage.objects;
CREATE POLICY "Admins write own account form media"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'form-media'
    AND is_account_member(
      CASE
        WHEN (storage.foldername(name))[1] ~*
             '^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN substring((storage.foldername(name))[1] FROM 9)::uuid
      END,
      'admin'
    )
  );

DROP POLICY IF EXISTS "Admins update own account form media" ON storage.objects;
CREATE POLICY "Admins update own account form media"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'form-media'
    AND is_account_member(
      CASE
        WHEN (storage.foldername(name))[1] ~*
             '^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN substring((storage.foldername(name))[1] FROM 9)::uuid
      END,
      'admin'
    )
  );

DROP POLICY IF EXISTS "Admins delete own account form media" ON storage.objects;
CREATE POLICY "Admins delete own account form media"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'form-media'
    AND is_account_member(
      CASE
        WHEN (storage.foldername(name))[1] ~*
             '^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN substring((storage.foldername(name))[1] FROM 9)::uuid
      END,
      'admin'
    )
  );

-- ------------------------------------------------------------
-- 7) form_responses_delete(form_id, ids[]) — PRD 084 D-14
--
-- A equipe não tem policy de DELETE em `form_responses` (escrita é só do
-- servidor), então apagar passa por aqui: SECURITY DEFINER, guarda
-- `is_account_member(account_id, 'admin')` NO CORPO, apaga e devolve os
-- caminhos dos arquivos (`file_upload` no instantâneo) para a rota
-- remover os objetos do bucket em melhor esforço. `p_ids = NULL` apaga
-- todas as respostas do formulário. Devolve também os bytes liberados
-- (a rota decrementa `form_upload_bytes`; o contador nasce na 098).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_responses_delete(
  p_form_id UUID,
  p_ids     UUID[] DEFAULT NULL
)
RETURNS TABLE (storage_path TEXT, deleted_count INTEGER, freed_bytes BIGINT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_deleted    INTEGER := 0;
  v_bytes      BIGINT  := 0;
  v_paths      TEXT[]  := ARRAY[]::TEXT[];
BEGIN
  SELECT f.account_id INTO v_account_id FROM forms f WHERE f.id = p_form_id;

  -- Mesma resposta para "não existe" e "não é seu": 42501, sem detalhe.
  IF v_account_id IS NULL OR NOT is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'Form not found or not accessible'
      USING ERRCODE = '42501';
  END IF;

  WITH gone AS (
    DELETE FROM form_responses r
     WHERE r.form_id = p_form_id
       AND r.account_id = v_account_id
       AND (p_ids IS NULL OR r.id = ANY(p_ids))
    RETURNING r.answers, r.upload_bytes, r.status
  ),
  files AS (
    SELECT (fileref ->> 'path') AS path
      FROM gone g,
           jsonb_each(g.answers) AS a(key, entry),
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(entry -> 'value') = 'array'
                  THEN entry -> 'value' ELSE '[]'::jsonb END
           ) AS fileref
     WHERE entry ->> 'type' = 'file_upload'
       AND jsonb_typeof(fileref) = 'object'
       AND (fileref ->> 'path') IS NOT NULL
  )
  SELECT
    (SELECT count(*) FROM gone),
    (SELECT COALESCE(sum(upload_bytes), 0) FROM gone WHERE status = 'completed'),
    (SELECT COALESCE(array_agg(DISTINCT path), ARRAY[]::TEXT[]) FROM files)
  INTO v_deleted, v_bytes, v_paths;

  RETURN QUERY
  SELECT p, v_deleted, v_bytes
    FROM unnest(v_paths) AS p
  UNION ALL
  SELECT NULL::TEXT, v_deleted, v_bytes
   WHERE cardinality(v_paths) = 0;
END;
$$;

ALTER FUNCTION public.form_responses_delete(UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.form_responses_delete(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.form_responses_delete(UUID, UUID[]) FROM anon;
-- A rota chama como o usuário: o escopo é a guarda de admin no corpo.
GRANT EXECUTE ON FUNCTION public.form_responses_delete(UUID, UUID[])
  TO authenticated, service_role;
COMMENT ON FUNCTION public.form_responses_delete(UUID, UUID[]) IS
  'SPEC 085 §5.1 / PRD 084 D-14: apaga respostas (admin+ da conta, guarda no corpo) e devolve os caminhos de arquivo para a rota remover do bucket. p_ids NULL = todas.';

-- ------------------------------------------------------------
-- 8) form_public_availability(slug, generic_link) — versão mínima (E-8)
--
-- Só `service_role`: a página pública chama com `supabaseAdmin()`. A 098
-- reescreve com `plan_feature_strict(…, 'forms_enabled')` e as quotas,
-- mantendo a assinatura e as colunas. `reason` existe para log e teste
-- (`availability.ts` mapeia TODO motivo para a mesma página neutra,
-- PRD 084 D-11 / L5).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_public_availability(
  p_slug         TEXT,
  p_generic_link BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (status TEXT, reason TEXT, form_id UUID, account_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_form    RECORD;
  v_blocked TIMESTAMPTZ;
BEGIN
  SELECT f.id, f.account_id, f.status
    INTO v_form
    FROM forms f
   WHERE f.slug = p_slug;

  IF v_form.id IS NULL THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, 'not_found'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF v_form.status <> 'published' THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, 'not_published'::TEXT, v_form.id, v_form.account_id;
    RETURN;
  END IF;

  SELECT a.blocked_at INTO v_blocked FROM accounts a WHERE a.id = v_form.account_id;
  IF v_blocked IS NOT NULL THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, 'account_blocked'::TEXT, v_form.id, v_form.account_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'available'::TEXT, 'ok'::TEXT, v_form.id, v_form.account_id;
END;
$$;

ALTER FUNCTION public.form_public_availability(TEXT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) TO service_role;
COMMENT ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) IS
  'SPEC 085 E-8: pre-checagem da pagina publica. Versao da 097 (publicado + conta nao bloqueada); a 098 acrescenta plan_feature_strict e quotas. So service_role.';

-- ------------------------------------------------------------
-- 9) Trilhas que precisam conhecer o formulário
-- ------------------------------------------------------------
-- 9a. Registro de atividade: recurso novo `form` (SPEC 085 §9). O CHECK
--     da 084 é anônimo (inline no CREATE TABLE); recriado por nome.
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.account_activity_log'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%resource_type%'
  LOOP
    EXECUTE format('ALTER TABLE account_activity_log DROP CONSTRAINT %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE account_activity_log
  ADD CONSTRAINT account_activity_log_resource_type_check
  CHECK (resource_type IN (
    'message','conversation','contact','deal','broadcast',
    'automation','flow','channel','member','export',
    'plan','tag','webhook','form'));

-- 9b. Consentimento declarado no bloco `consent` (SPEC 085 §4.1,
--     mapeamento `contact.opt_in`): origem `'form'` na trilha e na RPC.
--     Corpo de `set_contact_opt_in` idêntico ao da 048, só com `'form'`
--     na lista de origens aceitas.
ALTER TABLE contact_consent_events DROP CONSTRAINT IF EXISTS contact_consent_events_source_check;
ALTER TABLE contact_consent_events ADD CONSTRAINT contact_consent_events_source_check
  CHECK (source IN ('inbound_keyword','manual','import','api','automation','form'));

COMMENT ON COLUMN contacts.opt_in_source IS
  'Como o estado atual foi definido: inbound_keyword | manual | import | api | automation | form.';

CREATE OR REPLACE FUNCTION public.set_contact_opt_in(
  p_contact_id          UUID,
  p_status              TEXT,
  p_source              TEXT DEFAULT 'manual',
  p_keyword             TEXT DEFAULT NULL,
  p_whatsapp_message_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  contact_id        UUID,
  opt_in_status     TEXT,
  opt_in_updated_at TIMESTAMPTZ,
  changed           BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_phone      TEXT;
  v_previous   TEXT;
  v_now        TIMESTAMPTZ := NOW();
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('opted_in', 'opted_out', 'unknown') THEN
    RAISE EXCEPTION 'Invalid opt-in status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  IF p_source IS NULL OR p_source NOT IN ('inbound_keyword', 'manual',
                                          'import', 'api', 'automation',
                                          'form') THEN
    RAISE EXCEPTION 'Invalid consent source: %', p_source
      USING ERRCODE = '22023';
  END IF;

  SELECT c.opt_in_status INTO v_previous
    FROM contacts c
   WHERE c.id = p_contact_id;

  UPDATE contacts c
     SET opt_in_status     = p_status,
         opt_in_source     = p_source,
         opt_in_updated_at = v_now
   WHERE c.id = p_contact_id
  RETURNING c.account_id, c.phone INTO v_account_id, v_phone;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Contact not found or not accessible'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO contact_consent_events (
    account_id, contact_id, phone, status, source,
    keyword, whatsapp_message_id, actor_user_id
  ) VALUES (
    v_account_id, p_contact_id, v_phone, p_status, p_source,
    p_keyword, p_whatsapp_message_id, auth.uid()
  );

  RETURN QUERY
  SELECT p_contact_id, p_status, v_now,
         COALESCE(v_previous, 'unknown') IS DISTINCT FROM p_status;
END;
$$;

ALTER FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT)
  TO authenticated, service_role;

-- 9c. Excluir usuário (088): `forms` entra na lista de reatribuição ao
--     dono antes do delete; a FK já nasce `ON DELETE SET NULL` (rede).
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
    'forms',
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

ALTER FUNCTION public.reassign_user_rows_to_owner() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reassign_user_rows_to_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reassign_user_rows_to_owner() FROM anon;
REVOKE ALL ON FUNCTION public.reassign_user_rows_to_owner() FROM authenticated;

-- ------------------------------------------------------------
-- 9a) forms_list_stats(account) — F2, `GET /api/forms`
--
-- SECURITY INVOKER: a RLS de `form_responses` (membro da conta) continua
-- valendo; o parâmetro só estreita. Mês em `America/Sao_Paulo`, o mesmo
-- fuso do contador `form_responses:YYYY-MM` (098).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.forms_list_stats(p_account_id UUID)
RETURNS TABLE (
  form_id          UUID,
  started_count    BIGINT,
  completed_count  BIGINT,
  completed_month  BIGINT,
  last_response_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT r.form_id,
         count(*)::BIGINT,
         (count(*) FILTER (WHERE r.status = 'completed'))::BIGINT,
         (count(*) FILTER (
            WHERE r.status = 'completed'
              AND r.completed_at >= (
                date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
                  AT TIME ZONE 'America/Sao_Paulo')
         ))::BIGINT,
         max(r.completed_at)
    FROM form_responses r
   WHERE r.account_id = p_account_id
   GROUP BY r.form_id
$$;

ALTER FUNCTION public.forms_list_stats(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.forms_list_stats(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forms_list_stats(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.forms_list_stats(UUID)
  TO authenticated, service_role;
COMMENT ON FUNCTION public.forms_list_stats(UUID) IS
  'SPEC 085 §7.1: iniciadas, concluidas, concluidas no mes (America/Sao_Paulo) e ultima resposta por formulario, em uma consulta. INVOKER: a RLS de form_responses vale.';

-- ------------------------------------------------------------
-- 9b) form_fields_replace(form_id, fields) — F2, `PUT /api/forms/[id]/fields`
--
-- Substitui TODOS os blocos do formulário numa transação só: itens com
-- `id` de um bloco deste formulário são atualizados (o id é mantido, e
-- com ele o que aponta para ele); os demais são inseridos; blocos que
-- não vieram são apagados. `position` é o índice no array. SECURITY
-- INVOKER: a RLS (admin da conta) decide; a guarda no corpo só dá o
-- erro certo (42501, o mesmo para "não existe" e "não é seu").
--
-- `UNIQUE (form_id, key)` é adiado e reconferido no fim (trocar a ordem
-- de dois blocos não colide no meio); `is_identity` é limpo antes (o
-- índice parcial não é adiável) e regravado item a item. `forms.version`
-- sobe a cada substituição — `form_responses.form_version` diz com qual
-- definição a resposta foi dada.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_fields_replace(
  p_form_id UUID,
  p_fields  JSONB
)
RETURNS SETOF public.form_fields
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_item       JSONB;
  v_id         UUID;
  v_pos        INTEGER := 0;
  v_keep       UUID[]  := ARRAY[]::UUID[];
BEGIN
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array' THEN
    RAISE EXCEPTION 'p_fields must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_fields) > 100 THEN
    RAISE EXCEPTION 'A form can have at most 100 blocks' USING ERRCODE = '22023';
  END IF;

  SELECT f.account_id INTO v_account_id FROM forms f WHERE f.id = p_form_id;
  IF v_account_id IS NULL OR NOT is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'Form not found or not accessible' USING ERRCODE = '42501';
  END IF;

  -- Serializa duas gravações do mesmo formulário.
  PERFORM 1 FROM forms f WHERE f.id = p_form_id FOR UPDATE;

  SET CONSTRAINTS ALL DEFERRED;

  SELECT COALESCE(array_agg(ff.id), ARRAY[]::UUID[]) INTO v_keep
    FROM form_fields ff
   WHERE ff.form_id = p_form_id
     AND ff.id IN (
       SELECT NULLIF(e ->> 'id', '')::uuid
         FROM jsonb_array_elements(p_fields) AS e
     );

  DELETE FROM form_fields ff
   WHERE ff.form_id = p_form_id AND NOT (ff.id = ANY (v_keep));

  UPDATE form_fields ff SET is_identity = FALSE
   WHERE ff.form_id = p_form_id AND ff.is_identity;

  FOR v_item IN SELECT e FROM jsonb_array_elements(p_fields) AS e LOOP
    v_id := NULLIF(v_item ->> 'id', '')::uuid;

    IF v_id IS NOT NULL AND v_id = ANY (v_keep) THEN
      UPDATE form_fields ff SET
        key         = v_item ->> 'key',
        position    = v_pos,
        type        = v_item ->> 'type',
        label       = v_item ->> 'label',
        description = NULLIF(v_item ->> 'description', ''),
        required    = COALESCE((v_item ->> 'required')::boolean, FALSE),
        is_identity = COALESCE((v_item ->> 'is_identity')::boolean, FALSE),
        options     = NULLIF(v_item -> 'options', 'null'::jsonb),
        validation  = COALESCE(NULLIF(v_item -> 'validation', 'null'::jsonb), '{}'::jsonb),
        media       = NULLIF(v_item -> 'media', 'null'::jsonb),
        mapping     = NULLIF(v_item -> 'mapping', 'null'::jsonb),
        show_if     = NULLIF(v_item -> 'show_if', 'null'::jsonb)
       WHERE ff.id = v_id AND ff.form_id = p_form_id;
    ELSE
      INSERT INTO form_fields (
        form_id, account_id, key, position, type, label, description,
        required, is_identity, options, validation, media, mapping, show_if
      ) VALUES (
        p_form_id, v_account_id,
        v_item ->> 'key', v_pos, v_item ->> 'type', v_item ->> 'label',
        NULLIF(v_item ->> 'description', ''),
        COALESCE((v_item ->> 'required')::boolean, FALSE),
        COALESCE((v_item ->> 'is_identity')::boolean, FALSE),
        NULLIF(v_item -> 'options', 'null'::jsonb),
        COALESCE(NULLIF(v_item -> 'validation', 'null'::jsonb), '{}'::jsonb),
        NULLIF(v_item -> 'media', 'null'::jsonb),
        NULLIF(v_item -> 'mapping', 'null'::jsonb),
        NULLIF(v_item -> 'show_if', 'null'::jsonb)
      );
    END IF;

    v_pos := v_pos + 1;
  END LOOP;

  -- Reconfere `UNIQUE (form_id, key)` AQUI, para o erro sair desta chamada.
  SET CONSTRAINTS ALL IMMEDIATE;

  UPDATE forms f SET version = f.version + 1 WHERE f.id = p_form_id;

  RETURN QUERY
    SELECT ff.* FROM form_fields ff
     WHERE ff.form_id = p_form_id
     ORDER BY ff.position;
END;
$$;

ALTER FUNCTION public.form_fields_replace(UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.form_fields_replace(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.form_fields_replace(UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.form_fields_replace(UUID, JSONB)
  TO authenticated, service_role;
COMMENT ON FUNCTION public.form_fields_replace(UUID, JSONB) IS
  'SPEC 085 §7.1: substitui os blocos do formulario em transacao, mantendo ids; sobe forms.version. INVOKER (admin da conta pela RLS).';

-- ------------------------------------------------------------
-- 10) Asserções — falham alto (padrão 078/093/096)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  -- Tabelas e RLS.
  IF (SELECT count(*) FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('forms','form_fields','form_responses')
         AND rowsecurity) <> 3 THEN
    RAISE EXCEPTION '097: tabela de formulario sem RLS.' USING ERRCODE = '55006';
  END IF;

  -- `anon` sem nada nas três tabelas, nem GRANT nem policy.
  IF has_table_privilege('anon', 'public.forms', 'SELECT')
     OR has_table_privilege('anon', 'public.form_fields', 'SELECT')
     OR has_table_privilege('anon', 'public.form_responses', 'SELECT') THEN
    RAISE EXCEPTION '097: anon tem SELECT em tabela de formulario.' USING ERRCODE = '55006';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND tablename IN ('forms','form_fields','form_responses')
                AND ('anon' = ANY(roles) OR 'public' = ANY(roles))) THEN
    RAISE EXCEPTION '097: policy de formulario aberta a anon/PUBLIC.' USING ERRCODE = '55006';
  END IF;

  -- Respostas: a equipe só lê (escrita é do servidor).
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'form_responses'
                AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '097: form_responses nao pode ter policy de escrita pelo cliente.' USING ERRCODE = '55006';
  END IF;
  IF has_table_privilege('authenticated', 'public.form_responses', 'INSERT')
     OR has_table_privilege('authenticated', 'public.form_responses', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.form_responses', 'DELETE') THEN
    RAISE EXCEPTION '097: authenticated com privilegio de escrita em form_responses.' USING ERRCODE = '55006';
  END IF;

  -- Funções: só os papéis previstos.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.form_responses_delete(uuid,uuid[])',
    'public.form_public_availability(text,boolean)',
    'public.set_contact_opt_in(uuid,text,text,text,text)',
    'public.reassign_user_rows_to_owner()',
    'public.forms_list_stats(uuid)',
    'public.form_fields_replace(uuid,jsonb)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '097: % executavel por anon/PUBLIC.', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.form_public_availability(text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '097: form_public_availability executavel por authenticated.' USING ERRCODE = '55006';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.form_public_availability(text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '097: form_public_availability sem EXECUTE para service_role.' USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid IN ('public.form_responses_delete(uuid,uuid[])'::regprocedure,
                   'public.form_public_availability(text,boolean)'::regprocedure)
       AND prosecdef
       AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=public')
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION '097: funcao de formulario sem SECURITY DEFINER ou sem search_path fixo.' USING ERRCODE = '55006';
  END IF;

  -- CHECKs estendidos.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.contacts'::regclass
                    AND conname = 'contacts_created_via_check'
                    AND pg_get_constraintdef(oid) LIKE '%''form''%') THEN
    RAISE EXCEPTION '097: contacts.created_via nao aceita form.' USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.account_activity_log'::regclass
                    AND conname = 'account_activity_log_resource_type_check'
                    AND pg_get_constraintdef(oid) LIKE '%''form''%') THEN
    RAISE EXCEPTION '097: account_activity_log.resource_type nao aceita form.' USING ERRCODE = '55006';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.account_activity_log'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%resource_type%') <> 1 THEN
    RAISE EXCEPTION '097: account_activity_log deve ter exatamente UM check de resource_type.' USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.contact_consent_events'::regclass
                    AND conname = 'contact_consent_events_source_check'
                    AND pg_get_constraintdef(oid) LIKE '%''form''%') THEN
    RAISE EXCEPTION '097: contact_consent_events.source nao aceita form.' USING ERRCODE = '55006';
  END IF;

  -- Buckets privados.
  IF EXISTS (SELECT 1 FROM storage.buckets
              WHERE id IN ('form-uploads','form-media') AND public) THEN
    RAISE EXCEPTION '097: bucket de formulario publico.' USING ERRCODE = '55006';
  END IF;
  IF (SELECT count(*) FROM storage.buckets WHERE id IN ('form-uploads','form-media')) <> 2 THEN
    RAISE EXCEPTION '097: bucket de formulario ausente.' USING ERRCODE = '55006';
  END IF;
  -- Nenhuma policy de escrita em `form-uploads` para o cliente.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'storage' AND tablename = 'objects'
                AND cmd <> 'SELECT'
                AND (qual LIKE '%form-uploads%' OR with_check LIKE '%form-uploads%')) THEN
    RAISE EXCEPTION '097: form-uploads nao pode ter policy de escrita pelo cliente.' USING ERRCODE = '55006';
  END IF;

  -- 088 cobre `forms`.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.reassign_user_rows_to_owner()'::regprocedure)
       NOT LIKE '%''forms''%' THEN
    RAISE EXCEPTION '097: reassign_user_rows_to_owner nao cobre forms.' USING ERRCODE = '55006';
  END IF;
END;
$$;
