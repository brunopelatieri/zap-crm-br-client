import { describe, it, expect, vi, afterEach } from 'vitest';

import { readRetentionDefaults } from './defaults';

describe('readRetentionDefaults', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('.env vazio: interruptor desligado e tudo sem limite', () => {
    const defaults = readRetentionDefaults({});
    expect(defaults.enabled).toBe(false);
    expect(defaults.minAgeHours).toBe(72);
    expect(defaults.intervalHours).toBe(6);
    expect(defaults.batchLimit).toBe(5000);
    expect(defaults.whatsapp_qr).toEqual({
      maxMessages: null,
      retentionDays: null,
      maxFavorites: null,
    });
    expect(defaults.whatsapp_cloud).toEqual({
      maxMessages: null,
      retentionDays: null,
      maxFavorites: null,
    });
  });

  it('valor inválido numa dimensão de limite vira sem limite, com warn, e não lança', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      readRetentionDefaults({
        MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES: 'abc',
      })
    ).not.toThrow();
    const defaults = readRetentionDefaults({
      MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES: 'abc',
    });
    expect(defaults.whatsapp_qr.maxMessages).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('valor negativo numa dimensão de limite vira sem limite, com warn', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defaults = readRetentionDefaults({
      MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS: '-5',
    });
    expect(defaults.whatsapp_cloud.retentionDays).toBeNull();
  });

  it('zero explícito numa dimensão de limite significa sem limite, não "apagar tudo"', () => {
    const defaults = readRetentionDefaults({
      MESSAGE_RETENTION_WHATSAPP_QR_DAYS: '0',
    });
    expect(defaults.whatsapp_qr.retentionDays).toBeNull();
  });

  it('todas as seis variáveis preenchidas — cada canal com seus três limites', () => {
    const defaults = readRetentionDefaults({
      MESSAGE_RETENTION_ENABLED: 'true',
      MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES: '5000',
      MESSAGE_RETENTION_WHATSAPP_QR_DAYS: '30',
      MESSAGE_RETENTION_WHATSAPP_QR_MAX_FAVORITES: '200',
      MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES: '50000',
      MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS: '365',
      MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_FAVORITES: '2000',
    });
    expect(defaults.enabled).toBe(true);
    expect(defaults.whatsapp_qr).toEqual({
      maxMessages: 5000,
      retentionDays: 30,
      maxFavorites: 200,
    });
    expect(defaults.whatsapp_cloud).toEqual({
      maxMessages: 50000,
      retentionDays: 365,
      maxFavorites: 2000,
    });
  });

  it('trilhos de ritmo inválidos caem no padrão documentado, não em sem limite', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defaults = readRetentionDefaults({
      MESSAGE_RETENTION_MIN_AGE_HOURS: 'nope',
      MESSAGE_RETENTION_INTERVAL_HOURS: '0',
      MESSAGE_RETENTION_BATCH_LIMIT: '-1',
    });
    expect(defaults.minAgeHours).toBe(72);
    expect(defaults.intervalHours).toBe(6);
    expect(defaults.batchLimit).toBe(5000);
  });

  it('MESSAGE_RETENTION_ENABLED só é true com o literal "true"', () => {
    expect(
      readRetentionDefaults({ MESSAGE_RETENTION_ENABLED: 'TRUE' }).enabled
    ).toBe(true);
    expect(
      readRetentionDefaults({ MESSAGE_RETENTION_ENABLED: '1' }).enabled
    ).toBe(false);
    expect(
      readRetentionDefaults({ MESSAGE_RETENTION_ENABLED: 'false' }).enabled
    ).toBe(false);
  });
});
