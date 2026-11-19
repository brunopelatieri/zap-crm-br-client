// ============================================================
// Contraste de cor do tema (SPEC 085 §4.2, acessibilidade mínima):
// o construtor AVISA quando a cor do texto sobre o fundo fica abaixo de
// 4.5:1 (WCAG AA, texto normal). É aviso, não bloqueio: o owner decide.
//
// Cores são hex (`isCssHexColor`); com alfa, compõe sobre branco só para
// medir. Puro.
// ============================================================

export const MIN_TEXT_CONTRAST = 4.5;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` → RGB (0–255); alfa composto sobre branco. */
export function parseHexColor(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  const alpha = h.length === 8 ? n(6) / 255 : 1;
  const over = (c: number) => Math.round(c * alpha + 255 * (1 - alpha));
  return { r: over(n(0)), g: over(n(2)), b: over(n(4)) };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
  );
}

/** Razão de contraste WCAG (1–21); `null` se alguma cor não for hex válido. */
export function contrastRatio(fg: string, bg: string): number | null {
  const a = parseHexColor(fg);
  const b = parseHexColor(bg);
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Cor de texto legível sobre `bg` (botão do tema): preto ou branco, o que
 * tiver mais contraste. `bg` inválido → branco.
 */
export function readableTextColor(
  bg: string | undefined
): '#000000' | '#ffffff' {
  if (!bg) return '#ffffff';
  const onBlack = contrastRatio('#000000', bg);
  const onWhite = contrastRatio('#ffffff', bg);
  if (onBlack === null || onWhite === null) return '#ffffff';
  return onBlack > onWhite ? '#000000' : '#ffffff';
}

/** `true` quando as duas cores são válidas e o contraste fica abaixo do mínimo. */
export function isLowContrast(
  fg: string | undefined,
  bg: string | undefined,
  min: number = MIN_TEXT_CONTRAST
): boolean {
  if (!fg || !bg) return false;
  const ratio = contrastRatio(fg, bg);
  return ratio !== null && ratio < min;
}
