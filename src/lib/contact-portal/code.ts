// ============================================================
// Código de 6 dígitos (SPEC 083 E-4).
//
// Nasce aqui, com gerador criptográfico; o banco só recebe para gravar
// o hash bcrypt. O código em claro existe na memória da rota até o
// envio pelo WhatsApp — nunca em log, nunca em `messages` (PRD 082 §6, SPEC 083 E-5).
// ============================================================

import { randomInt } from 'node:crypto';

export const CODE_LENGTH = 6;

export function generateCode(): string {
  return randomInt(0, 10 ** CODE_LENGTH)
    .toString()
    .padStart(CODE_LENGTH, '0');
}

/**
 * O que a pessoa digita ou cola ("123 456", "123-456") → só dígitos.
 * `null` se não sobrarem exatamente 6.
 */
export function normalizeCodeInput(raw: string): string | null {
  const digits = raw.replace(/[\s.-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * Código curto da conta em `/area/c/<código>` e em `?conta=` (migração
 * 093: 8 caracteres sem I, L, O). Caixa baixa vale; o resto é `null` e
 * a tela cai no endereço genérico.
 */
export function normalizePublicCode(
  raw: string | null | undefined
): string | null {
  const v = raw?.trim().toUpperCase() ?? '';
  return /^[2-9A-HJKMNP-Z]{8}$/.test(v) ? v : null;
}
