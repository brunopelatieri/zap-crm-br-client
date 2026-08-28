import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetMailerConfigWarningForTests, readMailerConfig } from './config';

describe('readMailerConfig', () => {
  beforeEach(() => {
    _resetMailerConfigWarningForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('is null on an empty env, and never throws', () => {
    expect(() => readMailerConfig({})).not.toThrow();
    expect(readMailerConfig({})).toBeNull();
  });

  it('is null when SMTP_HOST is present but SYSTEM_NOTIFICATION_EMAIL is missing', () => {
    expect(readMailerConfig({ SMTP_HOST: 'smtp.example.com' })).toBeNull();
  });

  it('is null when SYSTEM_NOTIFICATION_EMAIL is present but SMTP_HOST is missing', () => {
    expect(
      readMailerConfig({
        SYSTEM_NOTIFICATION_EMAIL: 'bruno@zapcrmbr.com',
      })
    ).toBeNull();
  });

  it('defaults port to 587 when absent', () => {
    const config = readMailerConfig({
      SMTP_HOST: 'smtp.example.com',
      SYSTEM_NOTIFICATION_EMAIL: 'bruno@zapcrmbr.com',
    });
    expect(config?.port).toBe(587);
  });

  it('is null on a non-numeric port', () => {
    const config = readMailerConfig({
      SMTP_HOST: 'smtp.example.com',
      SYSTEM_NOTIFICATION_EMAIL: 'bruno@zapcrmbr.com',
      SMTP_PORT: 'not-a-number',
    });
    expect(config).toBeNull();
  });

  it('parses SMTP_SECURE case-insensitively, and "1" as true', () => {
    const base = {
      SMTP_HOST: 'smtp.example.com',
      SYSTEM_NOTIFICATION_EMAIL: 'bruno@zapcrmbr.com',
    };
    expect(readMailerConfig({ ...base, SMTP_SECURE: 'TRUE' })?.secure).toBe(
      true
    );
    expect(readMailerConfig({ ...base, SMTP_SECURE: 'True' })?.secure).toBe(
      true
    );
    expect(readMailerConfig({ ...base, SMTP_SECURE: '1' })?.secure).toBe(true);
    expect(readMailerConfig({ ...base, SMTP_SECURE: 'false' })?.secure).toBe(
      false
    );
    expect(readMailerConfig(base)?.secure).toBe(false);
  });

  it('reads user/password/from when present', () => {
    const config = readMailerConfig({
      SMTP_HOST: 'smtp.example.com',
      SYSTEM_NOTIFICATION_EMAIL: 'bruno@zapcrmbr.com',
      SMTP_USER: 'avisos@zapcrmbr.com',
      SMTP_PASSWORD: 'secret',
      SMTP_FROM: 'ZAP CRM BR <avisos@zapcrmbr.com>',
    });
    expect(config).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'avisos@zapcrmbr.com',
      password: 'secret',
      from: 'ZAP CRM BR <avisos@zapcrmbr.com>',
      to: 'bruno@zapcrmbr.com',
    });
  });

  // Achado de code review: o fallback antigo era `host` (um nome de
  // servidor, não um endereço) — praticamente todo MTA rejeita
  // `MAIL FROM:<smtp.example.com>`. Sem `SMTP_FROM`, o remetente cai
  // para `to` (`SYSTEM_NOTIFICATION_EMAIL`), o único outro endereço
  // real que este módulo conhece.
  it('falls back "from" to the notification address, not the SMTP host, when SMTP_FROM is absent', () => {
    const config = readMailerConfig({
      SMTP_HOST: 'smtp.example.com',
      SYSTEM_NOTIFICATION_EMAIL: 'bruno@zapcrmbr.com',
    });
    expect(config?.from).toBe('bruno@zapcrmbr.com');
    expect(config?.from).not.toBe('smtp.example.com');
  });

  it('warns only once per process across repeated calls', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readMailerConfig({});
    readMailerConfig({});
    readMailerConfig({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
