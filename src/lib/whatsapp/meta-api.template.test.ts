import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendTemplateMessage } from './meta-api';
import { buildAuthenticationSendComponents } from './template-send-builder';

function captureFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), {
        status: 200,
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return () =>
    JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendTemplateMessage — rawComponents (SPEC 083)', () => {
  it('usa os componentes prontos como estão, acima de params legados', async () => {
    const body = captureFetch();
    const r = await sendTemplateMessage({
      phoneNumberId: 'pn',
      accessToken: 'tk',
      to: '5519992496598',
      templateName: 'area_codigo',
      language: 'pt_BR',
      params: ['ignorado'],
      rawComponents: buildAuthenticationSendComponents('123456'),
    });
    expect(r.messageId).toBe('wamid.X');
    expect(body().template).toEqual({
      name: 'area_codigo',
      language: { code: 'pt_BR' },
      components: buildAuthenticationSendComponents('123456'),
    });
  });

  it('sem rawComponents, o caminho legado de corpo continua igual', async () => {
    const body = captureFetch();
    await sendTemplateMessage({
      phoneNumberId: 'pn',
      accessToken: 'tk',
      to: '5519992496598',
      templateName: 'aviso',
      params: ['Ana'],
    });
    expect(body().template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
    ]);
  });
});
