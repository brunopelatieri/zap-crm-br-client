import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';

/**
 * Regra de rótulo D-9 (SPEC 076 §15.1 e critério de aceite 16): o "Saldo
 * atual" do Billing Hub é valor A PAGAR (pós-pago), não crédito. A UI nunca
 * pode chamar o consumo de "saldo"/"crédito" — o usuário concluiria o
 * contrário do que a Meta mostra.
 */
const FORBIDDEN = /saldo|cr[eé]dito|credit\b|credits\b|balance/i;

function leaves(node: unknown, path: string[] = []): [string, string][] {
  if (typeof node === 'string') return [[path.join('.'), node]];
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, [...path, k]));
  }
  return [];
}

describe.each([
  ['en', en],
  ['pt-BR', ptBR],
])('Settings.whatsapp.billing (%s)', (_name, messages) => {
  const billing = (messages as { Settings: { whatsapp: { billing: unknown } } })
    .Settings.whatsapp.billing;
  const all = leaves(billing);

  it('existe e tem textos', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it('nenhum texto usa saldo/crédito/credit/balance (D-9)', () => {
    const offenders = all.filter(([, text]) => FORBIDDEN.test(text));
    expect(offenders).toEqual([]);
  });

  it('o aviso de estimativa existe (D-9)', () => {
    expect(all.some(([k]) => k === 'disclaimer')).toBe(true);
  });
});
