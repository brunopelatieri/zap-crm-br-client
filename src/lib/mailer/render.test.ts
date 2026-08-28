import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSystemEmail } from './render';
import {
  buildEventPayload,
  type SystemEventType,
} from '@/lib/notifications/types';

const now = new Date('2026-08-26T12:00:00.000Z');
const account = { id: 'acc-1', name: 'Acme Ltda', ownerEmail: 'ana@acme.com' };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.zapcrmbr.com');
});

const CASES: { type: SystemEventType; data?: Record<string, unknown> }[] = [
  { type: 'account.created' },
  {
    type: 'plan.changed',
    data: {
      plan: {
        fromPlanCode: 'essential',
        toPlanCode: 'professional',
        toPlanName: 'Profissional',
        billingCycle: 'yearly',
        priceCents: 298800,
        currency: 'BRL',
        currentPeriodEnd: '2027-08-26T14:03:11.482Z',
      },
    },
  },
  {
    type: 'plan.requested',
    data: { planCode: 'enterprise', planName: 'Empresarial' },
  },
  {
    type: 'plan.canceled',
    data: {
      plan: {
        planCode: 'professional',
        currentPeriodEnd: '2026-09-26T00:00:00Z',
      },
    },
  },
  {
    type: 'plan.cancel_reverted',
    data: { plan: { planCode: 'professional' } },
  },
  {
    type: 'plan.canceled_applied',
    data: { plan: { fromPlanCode: 'professional', toPlanCode: 'free' } },
  },
  {
    type: 'plan.renewed',
    data: {
      plan: {
        paymentRef: 'fatura-2026-08-1042',
        periods: 1,
        currentPeriodEnd: '2026-09-26T00:00:00Z',
      },
    },
  },
  {
    type: 'plan.expiring',
    data: { plan: { periodEnd: '2026-09-02T00:00:00Z', daysUntil: 7 } },
  },
  {
    type: 'plan.expired',
    data: {
      plan: {
        periodEnd: '2026-08-26T00:00:00Z',
        graceUntil: '2026-09-02T00:00:00Z',
      },
    },
  },
  {
    type: 'plan.grace_ended',
    data: { plan: { graceUntil: '2026-09-02T00:00:00Z' } },
  },
  { type: 'account.blocked', data: { block: { reason: 'inadimplência' } } },
  { type: 'account.unblocked' },
  {
    type: 'member.blocked',
    data: {
      block: { memberEmail: 'carlos@acme.com', reason: 'saiu da empresa' },
    },
  },
  {
    type: 'member.unblocked',
    data: { block: { memberEmail: 'carlos@acme.com' } },
  },
  {
    type: 'quota.exceeded',
    data: { quota: { metric: 'contacts', used: 2100, limit: 2000 } },
  },
];

describe('renderSystemEmail — um caso por tipo de evento (§7.1)', () => {
  for (const { type, data } of CASES) {
    it(`${type}: assunto contém a conta, corpo é privado, link presente`, () => {
      const payload = buildEventPayload(
        {
          type,
          accountId: account.id,
          account,
          actor: 'console:bruno@zapcrmbr.com',
          data,
        },
        now
      );
      const email = renderSystemEmail(payload);

      expect(email.subject).toContain('Acme Ltda');
      expect(email.subject.startsWith('[ZAP CRM BR]')).toBe(true);

      expect(email.text).toContain(
        'https://app.zapcrmbr.com/admin/accounts/acc-1'
      );
      expect(email.html).toContain(
        'https://app.zapcrmbr.com/admin/accounts/acc-1'
      );

      // Regra de privacidade da §4.2, virando teste: nenhum dado de
      // conversa ou contato de cliente final no corpo. `ownerEmail` da
      // CONTA e e-mail de MEMBRO da conta não são dados de contato do
      // WhatsApp — são identidade de quem administra o CRM, e ficam de
      // fora deliberadamente do corpo (o payload os carrega, o
      // renderer não os imprime, exceto o e-mail do membro em
      // member.*, que é sobre o próprio usuário bloqueado/desbloqueado,
      // não um contato de conversa).
      expect(email.text).not.toContain('ana@acme.com');
      expect(email.html).not.toContain('ana@acme.com');
    });
  }

  it('HTML has no external stylesheet, remote image, or web font', () => {
    const payload = buildEventPayload(
      {
        type: 'plan.changed',
        accountId: account.id,
        account,
        data: CASES[1].data,
      },
      now
    );
    const { html } = renderSystemEmail(payload);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/@font-face/i);
    expect(html).not.toMatch(/https?:\/\/(?!app\.zapcrmbr\.com)/i);
  });
});
