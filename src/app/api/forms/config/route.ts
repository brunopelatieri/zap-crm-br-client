// ============================================================
// GET /api/forms/config — SPEC 085 §10 (Configurações → Formulários, F4)
//
// Estado (presente/ausente) das variáveis de ambiente que o construtor
// usa. NUNCA devolve valor: só booleanos. `admin`+. Conta sem o item no
// plano recebe `featureInPlan: false` (a tela mostra o aviso) em vez de
// 403 — é uma tela de configuração, como as outras.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isFormLinkConfigured } from '@/lib/forms/link-token';
import { hasFormsFeature } from '@/lib/forms/plan-gate';

// EXCEÇÃO deliberada ao padrão `requireRole` -> `requireFormsFeature` das demais
// rotas da conta (como `GET /api/forms`): é tela de configuração e responde 200
// com `featureInPlan: false` em vez de 403. NÃO copie esta guarda para rota nova.
export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const featureInPlan = await hasFormsFeature(ctx.accountId);
    return NextResponse.json({
      featureInPlan,
      linkSecret: isFormLinkConfigured(),
      turnstile: {
        siteKey: !!process.env.TURNSTILE_SITE_KEY?.trim(),
        secretKey: !!process.env.TURNSTILE_SECRET_KEY?.trim(),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
