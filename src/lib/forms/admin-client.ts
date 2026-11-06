// ============================================================
// Cliente service-role dos formulários — só reexporta o canônico.
//
// Existe para o teste de isolamento (`isolation.test.ts`) ter um alvo
// único: nenhum arquivo de `src/components/forms/**` nem da página
// pública (`src/app/(public)/f/**`) pode importar isto nem
// `@/lib/supabase/admin`. A página pública usa service-role ESCOPADO
// por slug (PRD 084 D-9): a rota chama `form_public_availability`
// primeiro e só então lê o formulário por id.
// ============================================================

export { supabaseAdmin } from '@/lib/supabase/admin';
