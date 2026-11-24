import { describe, expect, it } from 'vitest';
import IntlMessageFormat from 'intl-messageformat';

import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';
import { ACTIVITY_CATALOG, isValidActivityAction } from '@/lib/activity/types';
import { MAX_CONSECUTIVE_FAILURES } from './deliver';
import { planRelaySaveActivity, relayHost } from './meta-relay-activity';
import type { ApiMetaRelay } from './meta-relay-config';
import {
  RELAY_AUTO_DISABLE_AFTER,
  hasOfficialChannel,
  relayApiErrorKey,
  relayFormState,
  toTestView,
  wasAutoDisabled,
} from './meta-relay-ui';

const saved = (over: Partial<ApiMetaRelay> = {}): ApiMetaRelay => ({
  url: 'https://a.test/hook',
  is_enabled: false,
  failure_count: 0,
  last_delivery_at: null,
  last_failure_at: null,
  auto_disabled_at: null,
  updated_at: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('constantes e catálogo', () => {
  it('o limite de falhas da UI é o mesmo da entrega', () => {
    expect(RELAY_AUTO_DISABLE_AFTER).toBe(MAX_CONSECUTIVE_FAILURES);
  });

  it('as ações do repetidor pertencem ao catálogo de atividade', () => {
    for (const a of [
      'webhook.relay_enabled',
      'webhook.relay_disabled',
      'webhook.relay_url_changed',
      'webhook.relay_secret_rotated',
      'webhook.relay_removed',
    ]) {
      expect(isValidActivityAction('webhook', a)).toBe(true);
      expect(ACTIVITY_CATALOG.webhook).toContain(a);
    }
  });
});

describe('relayHost', () => {
  it('devolve só o host: sem porta, caminho, query nem credenciais', () => {
    expect(relayHost('https://user:pw@hooks.example.com:8443/a/b?t=1#f')).toBe(
      'hooks.example.com'
    );
  });
  it('lixo vira null', () => {
    expect(relayHost('not a url')).toBeNull();
  });
});

describe('planRelaySaveActivity', () => {
  const on = { url: 'https://a.test/h', is_enabled: true };
  const off = { url: 'https://a.test/h', is_enabled: false };

  it('primeira gravação', () => {
    expect(planRelaySaveActivity(null, on)).toEqual(['webhook.relay_enabled']);
    expect(planRelaySaveActivity(null, off)).toEqual([
      'webhook.relay_url_changed',
    ]);
  });
  it('liga, desliga, troca e combina', () => {
    expect(planRelaySaveActivity(off, on)).toEqual(['webhook.relay_enabled']);
    expect(planRelaySaveActivity(on, off)).toEqual(['webhook.relay_disabled']);
    expect(
      planRelaySaveActivity(on, { ...on, url: 'https://b.test/h' })
    ).toEqual(['webhook.relay_url_changed']);
    expect(
      planRelaySaveActivity(off, { url: 'https://b.test/h', is_enabled: true })
    ).toEqual(['webhook.relay_url_changed', 'webhook.relay_enabled']);
  });
  it('nada mudou, nada registrado', () => {
    expect(planRelaySaveActivity(on, on)).toEqual([]);
  });
});

describe('relayFormState', () => {
  it('sem config: só salva com URL; não liga nem testa', () => {
    expect(relayFormState(null, { url: '', isEnabled: false })).toEqual({
      dirty: false,
      canToggle: false,
      canTest: false,
      canSave: false,
    });
    expect(
      relayFormState(null, { url: ' https://x.test ', isEnabled: false })
    ).toMatchObject({ dirty: true, canSave: true, canTest: false });
  });

  it('com config e sem edição: pode testar, não salva', () => {
    expect(
      relayFormState(saved(), { url: 'https://a.test/hook', isEnabled: false })
    ).toEqual({ dirty: false, canToggle: true, canTest: true, canSave: false });
  });

  it('com alteração não salva: não testa, salva', () => {
    expect(
      relayFormState(saved(), { url: 'https://b.test/hook', isEnabled: false })
    ).toMatchObject({ dirty: true, canTest: false, canSave: true });
    expect(
      relayFormState(saved(), { url: 'https://a.test/hook', isEnabled: true })
    ).toMatchObject({ dirty: true, canTest: false, canSave: true });
  });

  it('URL apagada não deixa salvar', () => {
    expect(
      relayFormState(saved(), { url: '  ', isEnabled: false })
    ).toMatchObject({ canSave: false });
  });
});

describe('wasAutoDisabled', () => {
  it('só quando desligado E marcado pelo desligamento automático', () => {
    expect(wasAutoDisabled(null)).toBe(false);
    expect(
      wasAutoDisabled(saved({ auto_disabled_at: '2026-11-20T00:00:00Z' }))
    ).toBe(true);
    expect(
      wasAutoDisabled(
        saved({ is_enabled: true, auto_disabled_at: '2026-11-20T00:00:00Z' })
      )
    ).toBe(false);
    expect(wasAutoDisabled(saved())).toBe(false);
  });
});

describe('hasOfficialChannel', () => {
  it('conta só Cloud API que não esteja desativado', () => {
    expect(hasOfficialChannel([])).toBe(false);
    expect(
      hasOfficialChannel([{ type: 'whatsapp_qr', status: 'connected' }])
    ).toBe(false);
    expect(
      hasOfficialChannel([{ type: 'whatsapp_cloud', status: 'disabled' }])
    ).toBe(false);
    expect(
      hasOfficialChannel([
        { type: 'whatsapp_qr', status: 'connected' },
        { type: 'whatsapp_cloud', status: 'connected' },
      ])
    ).toBe(true);
  });
});

describe('toTestView e relayApiErrorKey', () => {
  it('sucesso e falhas', () => {
    expect(
      toTestView({ ok: true, status: 200, duration_ms: 122.6, error: null })
    ).toEqual({ kind: 'connected', status: 200, durationMs: 123 });
    expect(
      toTestView({
        ok: false,
        status: 502,
        duration_ms: 10,
        error: 'http_error',
      })
    ).toEqual({ kind: 'failed', reason: 'http_error', status: 502 });
    expect(
      toTestView({
        ok: false,
        status: null,
        duration_ms: 5000,
        error: 'timeout',
      })
    ).toEqual({ kind: 'failed', reason: 'timeout', status: null });
  });

  it('mapeia erros da API para chaves', () => {
    expect(relayApiErrorKey(429, 'Rate limit exceeded')).toBe('rateLimited');
    expect(relayApiErrorKey(400, "'url' must point to a public host")).toBe(
      'urlNotPublic'
    );
    expect(relayApiErrorKey(400, "'url' must be a valid https:// URL")).toBe(
      'invalidUrl'
    );
    expect(relayApiErrorKey(500, 'Internal server error')).toBeNull();
  });
});

describe('i18n — Settings.apiKeys.metaRelay', () => {
  type Block = Record<string, unknown>;
  const SAMPLE = { status: 200, ms: 123, count: 15, date: '23 de nov.' };
  const blocks: Array<[string, Block]> = [
    ['en', (en as Block & { Settings: Block }).Settings as Block],
    ['pt-BR', (ptBR as Block & { Settings: Block }).Settings as Block],
  ];

  for (const [locale, settings] of blocks) {
    it(`${locale}: toda mensagem compila e formata`, () => {
      const block = (settings.apiKeys as Block).metaRelay as Record<
        string,
        string
      >;
      expect(Object.keys(block).length).toBeGreaterThan(30);
      for (const [key, message] of Object.entries(block)) {
        expect(
          () => new IntlMessageFormat(message, locale).format(SAMPLE),
          `chave ${key}: ${message}`
        ).not.toThrow();
      }
    });
  }

  it('o resultado do teste sai no formato pedido', () => {
    const pt = ((ptBR as Block).Settings as Block).apiKeys as Block;
    const msg = (pt.metaRelay as Record<string, string>).testConnected;
    expect(
      new IntlMessageFormat(msg, 'pt-BR').format({ status: 200, ms: 123 })
    ).toBe('Conectado (HTTP 200, 123 ms)');
  });
});
