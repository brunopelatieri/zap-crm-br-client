import { describe, expect, it } from 'vitest';

import {
  buildAvatarPath,
  decodeAvatar,
  detectImageType,
  extensionForImageType,
  mimeTypeForImageType,
  shouldFetchAvatar,
} from './avatar';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
]);
const GIF_BYTES = Buffer.from('GIF89a', 'ascii');
const HTML_BYTES = Buffer.from(
  '<html><body>não é imagem</body></html>',
  'utf-8'
);

describe('detectImageType — pelos BYTES, nunca por campo declarado', () => {
  it('reconhece a assinatura PNG', () => {
    expect(detectImageType(PNG_BYTES)).toBe('png');
  });

  it('reconhece a assinatura JPEG', () => {
    expect(detectImageType(JPEG_BYTES)).toBe('jpeg');
  });

  it('GIF não é aceito — só PNG e JPEG, como o bucket exige', () => {
    expect(detectImageType(GIF_BYTES)).toBeNull();
  });

  it('HTML disfarçado de imagem (armadilha clássica de tipo declarado) é recusado', () => {
    expect(detectImageType(HTML_BYTES)).toBeNull();
  });

  it('buffer menor que a assinatura não lança, só recusa', () => {
    expect(detectImageType(Buffer.from([0xff]))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('extensionForImageType / mimeTypeForImageType', () => {
  it('png', () => {
    expect(extensionForImageType('png')).toBe('png');
    expect(mimeTypeForImageType('png')).toBe('image/png');
  });

  it('jpeg usa extensão .jpg (convenção do repositório) e mimetype image/jpeg', () => {
    expect(extensionForImageType('jpeg')).toBe('jpg');
    expect(mimeTypeForImageType('jpeg')).toBe('image/jpeg');
  });
});

describe('shouldFetchAvatar — D-13', () => {
  const now = new Date('2026-09-03T12:00:00Z');

  it('nunca buscado (null) sempre busca', () => {
    expect(shouldFetchAvatar(null, 30, now)).toBe(true);
  });

  it('dentro do TTL não busca de novo', () => {
    const fetchedAt = new Date(now.getTime() - 5 * 86_400_000); // 5 dias
    expect(shouldFetchAvatar(fetchedAt, 30, now)).toBe(false);
  });

  it('mais velho que o TTL busca de novo', () => {
    const fetchedAt = new Date(now.getTime() - 31 * 86_400_000);
    expect(shouldFetchAvatar(fetchedAt, 30, now)).toBe(true);
  });

  it('exatamente no limite do TTL ainda não busca (> estrito, não >=)', () => {
    const fetchedAt = new Date(now.getTime() - 30 * 86_400_000);
    expect(shouldFetchAvatar(fetchedAt, 30, now)).toBe(false);
  });
});

describe('buildAvatarPath', () => {
  it('monta account-<uuid>/contact-<uuid>.<ext> — casa com a policy da 078', () => {
    expect(buildAvatarPath('acct-1', 'contact-1', 'png')).toBe(
      'account-acct-1/contact-contact-1.png'
    );
    expect(buildAvatarPath('acct-1', 'contact-1', 'jpeg')).toBe(
      'account-acct-1/contact-contact-1.jpg'
    );
  });
});

describe('decodeAvatar', () => {
  const MAX = 1_048_576;

  it('PNG válido dentro do limite: ok', () => {
    const b64 = PNG_BYTES.toString('base64');
    const result = decodeAvatar(b64, MAX);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.avatar.type).toBe('png');
      expect(result.avatar.mimeType).toBe('image/png');
      expect(result.avatar.bytes.equals(PNG_BYTES)).toBe(true);
    }
  });

  it('JPEG válido dentro do limite: ok', () => {
    const result = decodeAvatar(JPEG_BYTES.toString('base64'), MAX);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.avatar.type).toBe('jpeg');
  });

  it('tipo não suportado (GIF): unsupported_type', () => {
    const result = decodeAvatar(GIF_BYTES.toString('base64'), MAX);
    expect(result).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('HTML disfarçado de imagem: unsupported_type, não invalid_base64', () => {
    // Base64 válido, conteúdo NÃO é imagem — a rejeição é pelo tipo, o
    // decode em si funciona.
    const result = decodeAvatar(HTML_BYTES.toString('base64'), MAX);
    expect(result).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('acima do tamanho máximo: too_large, mesmo sendo PNG válido', () => {
    const bigPng = Buffer.concat([PNG_BYTES, Buffer.alloc(100)]);
    const result = decodeAvatar(bigPng.toString('base64'), 50);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('exatamente no limite de tamanho é aceito (<=, não <)', () => {
    const result = decodeAvatar(PNG_BYTES.toString('base64'), PNG_BYTES.length);
    expect(result.ok).toBe(true);
  });

  it('string vazia: invalid_base64', () => {
    const result = decodeAvatar('', MAX);
    expect(result).toEqual({ ok: false, reason: 'invalid_base64' });
  });

  it('lixo que não é base64 de verdade não lança — vira unsupported_type ou invalid_base64', () => {
    const result = decodeAvatar('!!!não é base64!!!', MAX);
    expect(result.ok).toBe(false);
  });
});
