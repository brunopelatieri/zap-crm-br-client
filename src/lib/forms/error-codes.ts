// ============================================================
// Códigos de erro estáveis das rotas `/api/forms/**` (SPEC 085 §7.1).
//
// A API responde em inglês, com um destes códigos em `error`; a UI traduz
// por `Forms.errors.<código>`. Qualquer OUTRO texto (403 de papel, 401 de
// sessão, 500) cai em `Forms.errors.generic` — nunca vira chave inexistente.
// ============================================================

export const FORMS_API_ERROR_CODES = [
  'FEATURE_NOT_IN_PLAN',
  'QUOTA_EXCEEDED',
  'FORM_LINK_SECRET_MISSING',
  'FORM_HAS_RESPONSES',
  'INVALID_FORM',
  'INVALID_STATE',
  'SLUG_TAKEN',
  'INVALID_FILE',
] as const;

export type FormsApiErrorCode = (typeof FORMS_API_ERROR_CODES)[number];

export function isFormsApiErrorCode(
  value: unknown
): value is FormsApiErrorCode {
  return (
    typeof value === 'string' &&
    (FORMS_API_ERROR_CODES as readonly string[]).includes(value)
  );
}
