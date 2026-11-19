import { FormBuilder } from '@/components/forms/form-builder/form-builder';
import { loadPublicFormMessages } from '@/lib/forms/public-messages';

/**
 * `/forms/[id]` — construtor (SPEC 085 §4.3).
 *
 * Server component só para entregar ao cliente os textos de sistema da
 * página pública nos DOIS idiomas: a prévia renderiza no idioma do
 * FORMULÁRIO (PRD 084 D-8), que o owner pode trocar sem recarregar.
 * O resto é cliente (fetch em `/api/forms/[id]`).
 */
export default async function FormBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [ptBR, en] = await Promise.all([
    loadPublicFormMessages('pt-BR'),
    loadPublicFormMessages('en'),
  ]);

  return (
    <div className="-m-4 h-[calc(100vh-3.5rem)] overflow-hidden sm:-m-6">
      <FormBuilder formId={id} publicMessages={{ 'pt-BR': ptBR, en }} />
    </div>
  );
}
