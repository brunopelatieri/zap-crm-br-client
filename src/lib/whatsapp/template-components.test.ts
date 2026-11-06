import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_CODE_EXPIRATION_MINUTES,
  buildMetaTemplatePayload,
} from './template-components';
import type { TemplatePayload } from './template-validators';

const base: TemplatePayload = {
  name: 'order_confirmation',
  category: 'Utility',
  language: 'en_US',
  body_text: 'Your order is on its way.',
};

describe('buildMetaTemplatePayload', () => {
  it('upcases category and produces minimal components (body only)', () => {
    const payload = buildMetaTemplatePayload(base);
    expect(payload).toEqual({
      name: 'order_confirmation',
      category: 'UTILITY',
      language: 'en_US',
      components: [{ type: 'BODY', text: 'Your order is on its way.' }],
    });
  });

  it('includes body_text example as a 2D array (Meta spec)', () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      body_text: 'Hi {{1}}, order {{2}}.',
      sample_values: { body: ['John', 'ORD-42'] },
    });
    const body = payload.components.find((c) => c.type === 'BODY');
    expect(body?.example?.body_text).toEqual([['John', 'ORD-42']]);
  });

  it('emits TEXT header in canonical first position', () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      header_type: 'text',
      header_content: 'Hello {{1}}',
      sample_values: { header: ['Sara'] },
    });
    expect(payload.components[0]).toEqual({
      type: 'HEADER',
      format: 'TEXT',
      text: 'Hello {{1}}',
      example: { header_text: ['Sara'] },
    });
  });

  it('uses header_url for media headers when no handle is set', () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      header_type: 'image',
      header_media_url: 'https://example.com/img.jpg',
    });
    expect(payload.components[0]).toEqual({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_url: ['https://example.com/img.jpg'] },
    });
  });

  it('prefers header_handle over header_media_url', () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      header_type: 'video',
      header_handle: '4::aW1...',
      header_media_url: 'https://example.com/v.mp4',
    });
    expect(payload.components[0]).toEqual({
      type: 'HEADER',
      format: 'VIDEO',
      example: { header_handle: ['4::aW1...'] },
    });
  });

  it('emits footer when present, skips when empty', () => {
    const withFooter = buildMetaTemplatePayload({
      ...base,
      footer_text: 'Reply STOP to opt out',
    });
    expect(
      withFooter.components.some(
        (c) => c.type === 'FOOTER' && c.text === 'Reply STOP to opt out'
      )
    ).toBe(true);

    const withoutFooter = buildMetaTemplatePayload({
      ...base,
      footer_text: '',
    });
    expect(withoutFooter.components.some((c) => c.type === 'FOOTER')).toBe(
      false
    );
  });

  it('emits the buttons component with correct per-type fields', () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Yes' },
        { type: 'URL', text: 'Track', url: 'https://x/{{1}}', example: 'abc' },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+15551234567' },
        { type: 'COPY_CODE', text: 'Copy', example: 'SUMMER20' },
      ],
    });
    const buttons = payload.components.find((c) => c.type === 'BUTTONS');
    expect(buttons?.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Yes' },
      { type: 'URL', text: 'Track', url: 'https://x/{{1}}', example: ['abc'] },
      { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+15551234567' },
      // Meta hard-codes this text; input 'Copy' above is intentionally
      // discarded regardless of what's stored locally.
      { type: 'COPY_CODE', text: 'Copy offer code', example: 'SUMMER20' },
    ]);
  });

  it('orders components HEADER → BODY → FOOTER → BUTTONS', () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      header_type: 'text',
      header_content: 'Hi',
      footer_text: 'Footer',
      buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }],
    });
    expect(payload.components.map((c) => c.type)).toEqual([
      'HEADER',
      'BODY',
      'FOOTER',
      'BUTTONS',
    ]);
  });
});

describe('buildMetaTemplatePayload — AUTHENTICATION (SPEC 083)', () => {
  const auth: TemplatePayload = {
    name: 'area_codigo',
    category: 'Authentication',
    language: 'pt_BR',
    // O formulário exige corpo; a Meta recusa corpo livre em AUTHENTICATION.
    body_text: 'Seu código é {{1}}',
    footer_text: 'Rodapé que não vai',
    buttons: [{ type: 'QUICK_REPLY', text: 'Não vai' }],
  };

  it('formato fixo da Meta: segurança, validade e botão OTP de copiar', () => {
    expect(buildMetaTemplatePayload(auth)).toEqual({
      name: 'area_codigo',
      category: 'AUTHENTICATION',
      language: 'pt_BR',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
      ],
    });
  });

  it('ignora corpo, rodapé e botões do formulário', () => {
    const json = JSON.stringify(buildMetaTemplatePayload(auth));
    expect(json).not.toContain('Seu código');
    expect(json).not.toContain('Rodapé');
    expect(json).not.toContain('QUICK_REPLY');
  });

  it('validade anunciada = código da área (10 min) e dentro do limite da Meta', () => {
    expect(AUTHENTICATION_CODE_EXPIRATION_MINUTES).toBe(10);
    expect(AUTHENTICATION_CODE_EXPIRATION_MINUTES).toBeLessThanOrEqual(90);
  });
});
