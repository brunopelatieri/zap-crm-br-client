import { describe, expect, it } from 'vitest';

import { detectImageSignature } from './image-format';

// PNG 1x1 real (assinatura completa) — mesma amostra usada em
// `evolution/avatar.test.ts` e `inbox/export/pdf.test.ts`.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

describe('detectImageSignature — pelos MAGIC BYTES, nunca por campo declarado', () => {
  it('reconhece PNG pela assinatura completa', () => {
    expect(detectImageSignature(PNG_BYTES)).toBe('png');
  });

  it('reconhece JPEG pelos 3 primeiros bytes', () => {
    expect(detectImageSignature(JPEG_BYTES)).toBe('jpeg');
  });

  it('GIF (nem PNG nem JPEG) devolve null', () => {
    expect(detectImageSignature(GIF_BYTES)).toBeNull();
  });

  it('null e vazio devolvem null, nunca lançam', () => {
    expect(detectImageSignature(null)).toBeNull();
    expect(detectImageSignature(new Uint8Array(0))).toBeNull();
  });

  it('bytes curtos demais para qualquer assinatura devolvem null', () => {
    expect(detectImageSignature(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(detectImageSignature(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
  });

  it('não confia num MIME/extensão declarado — só olha os bytes', () => {
    // "Arquivo" com extensão .png mas bytes de JPEG — a assinatura vence.
    expect(detectImageSignature(JPEG_BYTES)).toBe('jpeg');
  });
});
