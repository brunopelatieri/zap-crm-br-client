// ============================================================
// Prévia do construtor (SPEC 085 §4.3).
//
// A moldura de celular renderiza o MESMO componente da página pública com
// `identity = { mode: 'preview' }`. Para não ter dois formatos, a prévia
// passa pela MESMA projeção oficial (`toPublicPayload`, E-9): o que o
// visitante não pode ver (pontos, mapeamentos, ids) também não chega à
// prévia — se a projeção vazasse algo, a prévia mostraria o vazamento.
//
// O que a F3 NÃO deve fazer: montar `PublicFormPayload` por outro caminho
// (`admin-client.test.ts` acusa).
// ============================================================

import { toPublicPayload } from './project-public';
import type {
  Form,
  FormField,
  FormFieldInput,
  PublicFormPayload,
} from './types';

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Blocos do construtor (sem id de linha) → `FormField[]` para a projeção. */
export function draftsToFormFields(
  form: Pick<Form, 'id' | 'account_id'>,
  drafts: readonly FormFieldInput[]
): FormField[] {
  return drafts.map((d, i) => ({
    ...d,
    id: d.id ?? `draft-${i}`,
    form_id: form.id,
    account_id: form.account_id,
    position: i,
    created_at: EPOCH,
    updated_at: EPOCH,
  }));
}

export function buildPreviewPayload(
  form: Form,
  drafts: readonly FormFieldInput[],
  signedMedia: Record<string, string> = {}
): PublicFormPayload {
  return toPublicPayload(form, draftsToFormFields(form, drafts), {
    identity: 'preview',
    signedMedia,
    turnstileSiteKey: null,
  });
}
