import { ResponsesView } from '@/components/forms/responses/responses-view';

/**
 * `/forms/[id]/respostas` — respostas do formulário (SPEC 085 §4.4, F4).
 * Cliente (fetch em `/api/forms/[id]/responses`); `viewer`+ lê, `admin`+
 * exporta e apaga. Conta sem o item no plano: a rota responde 403
 * `FEATURE_NOT_IN_PLAN` e a tela mostra o erro de carga.
 */
export default async function FormResponsesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ResponsesView formId={id} />;
}
