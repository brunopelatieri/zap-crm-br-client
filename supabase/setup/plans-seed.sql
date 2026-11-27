-- ============================================================
-- plans-seed.sql — catálogo comercial (SPEC 059 D-2, PRD 058 §7)
--
-- NÃO é migração. Carrega uma decisão comercial de UM deployment
-- específico (o do mantenedor) — mesma regra que já vale para
-- `cron-jobs.sql`: se isto entrasse em `supabase/migrations/`, todo
-- fork de terceiro herdaria a tabela de preços do mantenedor no
-- próximo `git pull`.
--
-- Rodar de novo depois de editar um preço/limite é seguro — o
-- `ON CONFLICT (code) DO UPDATE` torna este script idempotente. Os
-- planos aqui nascem `is_public = TRUE`: aparecem no catálogo de
-- `GET /api/account/plan` e na aba "Plano e uso" assim que
-- `platform_settings.quotas_enforced` for ligado.
--
-- "Sob medida" (preço negociado) fica de fora de propósito — não tem
-- um price_cents fixo para caber neste catálogo. O operador cria esse
-- plano por conta, quando negociar, via POST /api/admin/plans
-- (is_public = FALSE) + PUT /api/admin/accounts/[accountId]/plan.
--
-- Chaves de `limits`/`features` validadas contra src/lib/plans/types.ts
-- pelo teste de contrato em src/lib/plans/catalog.test.ts — o marcador
-- `-- PLAN: <code>` antes de cada tupla é o que esse teste usa para
-- recortar o bloco; não remover ao editar.
-- ============================================================

INSERT INTO plans (code, name, description, price_cents, currency, billing_period,
                   limits, features, is_public, is_active, sort_order)
VALUES
  -- PLAN: free
  ('free', 'Grátis',
   'Demonstração do ZAP CRM BR — sem WhatsApp oficial e sem disparo em massa.',
   0, 'BRL', 'monthly',
   '{"contacts":250,"members_total":2,"members_admin":1,"members_agent":1,"members_viewer":0,"channels_whatsapp_qr":1,"channels_whatsapp_cloud":0,"forms":0,"form_responses_month":0,"form_upload_mb":0}'::jsonb,
   '{"ai_enabled":false,"api_v1_enabled":false,"flows_enabled":false,"broadcasts_enabled":false,"webhooks_out_enabled":false,"contact_portal_enabled":false,"forms_enabled":false}'::jsonb,
   TRUE, TRUE, 10),

  -- PLAN: essential
  ('essential', 'Essencial',
   'Para quem já opera de verdade: WhatsApp oficial, disparo em massa e API pública.',
   14900, 'BRL', 'monthly',
   '{"contacts":2000,"members_total":5,"members_admin":2,"members_agent":3,"members_viewer":1,"channels_whatsapp_qr":1,"channels_whatsapp_cloud":1,"forms":1,"form_responses_month":200,"form_upload_mb":100}'::jsonb,
   '{"ai_enabled":false,"api_v1_enabled":true,"flows_enabled":false,"broadcasts_enabled":true,"webhooks_out_enabled":true,"contact_portal_enabled":false,"forms_enabled":true}'::jsonb,
   TRUE, TRUE, 20),

  -- PLAN: professional
  ('professional', 'Profissional',
   'Adiciona IA (rascunho/auto-resposta), Flows e uma segunda instância QRCode.',
   34900, 'BRL', 'monthly',
   '{"contacts":10000,"members_total":12,"members_admin":4,"members_agent":8,"members_viewer":4,"channels_whatsapp_qr":2,"channels_whatsapp_cloud":1,"forms":5,"form_responses_month":2000,"form_upload_mb":1024}'::jsonb,
   '{"ai_enabled":true,"api_v1_enabled":true,"flows_enabled":true,"broadcasts_enabled":true,"webhooks_out_enabled":true,"contact_portal_enabled":false,"forms_enabled":true}'::jsonb,
   TRUE, TRUE, 30),

  -- PLAN: enterprise
  ('enterprise', 'Empresarial',
   'Encosta no teto físico da VPS (EVOLUTION_MAX_INSTANCES_TOTAL) — acima disso, "Sob medida".',
   79900, 'BRL', 'monthly',
   '{"contacts":50000,"members_total":30,"members_admin":10,"members_agent":20,"members_viewer":10,"channels_whatsapp_qr":3,"channels_whatsapp_cloud":1,"forms":20,"form_responses_month":10000,"form_upload_mb":5120}'::jsonb,
   '{"ai_enabled":true,"api_v1_enabled":true,"flows_enabled":true,"broadcasts_enabled":true,"webhooks_out_enabled":true,"contact_portal_enabled":false,"forms_enabled":true}'::jsonb,
   TRUE, TRUE, 40)

ON CONFLICT (code) DO UPDATE SET
  name           = EXCLUDED.name,
  description    = EXCLUDED.description,
  price_cents    = EXCLUDED.price_cents,
  currency       = EXCLUDED.currency,
  billing_period = EXCLUDED.billing_period,
  limits         = EXCLUDED.limits,
  features       = EXCLUDED.features,
  is_public      = EXCLUDED.is_public,
  is_active      = EXCLUDED.is_active,
  sort_order     = EXCLUDED.sort_order,
  updated_at     = NOW();
