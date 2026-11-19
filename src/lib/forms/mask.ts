// ============================================================
// Máscaras de texto curto (`short_text.validation.mask`, SPEC 085 §4.1):
// `cpf` e `cep`. Só formatação de DIGITAÇÃO — não validam dígito
// verificador (PRD 084 §3.1: validação fiscal fica de fora).
// ============================================================

import type { TextMask } from './types';

export function applyTextMask(
  value: string,
  mask: TextMask | undefined
): string {
  if (!mask || mask === 'none') return value;
  const digits = value.replace(/\D/g, '');
  if (mask === 'cep') {
    const d = digits.slice(0, 8);
    return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
  }
  const d = digits.slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
