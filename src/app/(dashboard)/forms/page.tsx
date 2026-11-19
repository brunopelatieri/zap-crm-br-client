import { FormList } from '@/components/forms/form-list';

/**
 * `/forms` — lista de formulários de captação (SPEC 085 §4.4). Sessão e
 * conta bloqueada são resolvidas pelo layout do dashboard e pelo
 * middleware; o plano, por `GET /api/forms` (`featureInPlan`).
 */
export default function FormsPage() {
  return <FormList />;
}
