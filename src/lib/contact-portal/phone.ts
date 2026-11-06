// ============================================================
// Telefone digitado → candidatos de busca (SPEC 083 E-2).
//
// `contacts.phone_normalized` é só "tira não dígito" (migração 022),
// não o canônico da SPEC 050, e há celulares salvos sem o nono dígito.
// Por isso a busca leva até dois valores: o canônico de 13 dígitos e a
// variante legada de 12. O PRIMEIRO é sempre o canônico — é a chave dos
// contadores por telefone no banco e o `access.phone` gravado.
// ============================================================

import { normalizeContactPhone } from '@/lib/phone/br';

/**
 * `null` quando o número não normaliza: a rota responde a mesma frase
 * neutra de quem não é contato, sem chamar o banco.
 */
export function phoneCandidates(
  raw: string,
  opts?: { brMode?: boolean }
): string[] | null {
  const r = normalizeContactPhone(raw, opts);
  if (!r.ok) return null;

  if (r.kind === 'mobile') {
    // 55 + DDD + 9XXXXXXXX → também 55 + DDD + XXXXXXXX (salvo antigo).
    return [r.phone, r.phone.slice(0, 4) + r.phone.slice(5)];
  }
  if (r.kind === 'mobile_legacy') {
    // Digitado sem o nono dígito: o canônico é com ele.
    return [r.phone.slice(0, 4) + '9' + r.phone.slice(4), r.phone];
  }
  return [r.phone];
}
