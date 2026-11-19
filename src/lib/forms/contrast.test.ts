import { describe, expect, it } from 'vitest';

import { applyTextMask } from './mask';
import { contrastRatio, isLowContrast, parseHexColor } from './contrast';

describe('parseHexColor', () => {
  it('aceita 3, 4, 6 e 8 dígitos', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor('#16a34a')).toEqual({ r: 22, g: 163, b: 74 });
    expect(parseHexColor('#0000')).toEqual({ r: 255, g: 255, b: 255 }); // alfa 0 sobre branco
    expect(parseHexColor('#00000080')).toEqual({ r: 127, g: 127, b: 127 });
  });
  it('recusa o que não é hex', () => {
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('#12')).toBeNull();
    expect(parseHexColor('rgb(0,0,0)')).toBeNull();
  });
});

describe('contrastRatio (WCAG)', () => {
  it('preto sobre branco é 21:1; igual é 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
  it('é simétrico', () => {
    expect(contrastRatio('#111827', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#111827') as number,
      8
    );
  });
  it('cor inválida → null', () => {
    expect(contrastRatio('x', '#fff')).toBeNull();
  });
});

describe('isLowContrast (aviso < 4.5:1)', () => {
  it('cinza claro sobre branco avisa; o padrão dos modelos não', () => {
    expect(isLowContrast('#aaaaaa', '#ffffff')).toBe(true);
    expect(isLowContrast('#111827', '#ffffff')).toBe(false);
  });
  it('limiar: #767676 sobre branco passa (4.54:1), #777777 não (4.48:1)', () => {
    expect(isLowContrast('#767676', '#ffffff')).toBe(false);
    expect(isLowContrast('#777777', '#ffffff')).toBe(true);
  });
  it('cor ausente ou inválida não avisa (o erro é da publicação)', () => {
    expect(isLowContrast(undefined, '#fff')).toBe(false);
    expect(isLowContrast('xyz', '#fff')).toBe(false);
  });
});

describe('applyTextMask', () => {
  it('cpf: 000.000.000-00, só dígitos, corta em 11', () => {
    expect(applyTextMask('12345678901234', 'cpf')).toBe('123.456.789-01');
    expect(applyTextMask('1234', 'cpf')).toBe('123.4');
    expect(applyTextMask('abc', 'cpf')).toBe('');
  });
  it('cep: 00000-000', () => {
    expect(applyTextMask('01310100', 'cep')).toBe('01310-100');
    expect(applyTextMask('0131', 'cep')).toBe('0131');
  });
  it('none/undefined deixam o texto como está', () => {
    expect(applyTextMask('a b', 'none')).toBe('a b');
    expect(applyTextMask('a b', undefined)).toBe('a b');
  });
});
