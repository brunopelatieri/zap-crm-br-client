import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMailerConfig = vi.fn();
vi.mock('./config', () => ({ readMailerConfig: () => readMailerConfig() }));

const sendMail = vi.fn();
vi.mock('./transport', () => ({ getMailTransport: () => ({ sendMail }) }));

import { deliverEmailChangeNotice } from './send';

const CONFIG = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: null,
  password: null,
  from: 'noreply@zapcrmbr.com',
  to: 'suporte@zapcrmbr.com',
};

beforeEach(() => {
  readMailerConfig.mockReset();
  sendMail.mockReset();
});

describe('deliverEmailChangeNotice (SPEC 078 D-11)', () => {
  it('sem SMTP configurado: skipped, nada é enviado', async () => {
    readMailerConfig.mockReturnValue(null);
    expect(await deliverEmailChangeNotice('antigo@cliente.com')).toEqual({
      ok: true,
      skipped: true,
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('envia ao destinatário explícito (não ao mantenedor) com reply-to do mantenedor', async () => {
    readMailerConfig.mockReturnValue(CONFIG);
    sendMail.mockResolvedValue({});
    const outcome = await deliverEmailChangeNotice(
      'antigo@cliente.com',
      new Date('2026-10-09T15:00:00Z')
    );
    expect(outcome).toEqual({ ok: true, skipped: false });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'noreply@zapcrmbr.com',
        to: 'antigo@cliente.com',
        replyTo: 'suporte@zapcrmbr.com',
      })
    );
    const mail = sendMail.mock.calls[0][0];
    expect(mail.text).toContain('09/10/2026');
  });

  it('falha do SMTP vira { ok: false, error }, nunca lança', async () => {
    readMailerConfig.mockReturnValue(CONFIG);
    sendMail.mockRejectedValue(new Error('connect ETIMEDOUT'));
    expect(await deliverEmailChangeNotice('antigo@cliente.com')).toEqual({
      ok: false,
      skipped: false,
      error: 'connect ETIMEDOUT',
    });
  });
});
