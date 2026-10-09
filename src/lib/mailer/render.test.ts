import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderEmailChangedNotice, renderSystemEmail } from './render';
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

describe('renderSystemEmail — account.deleted (SPEC 073 §5.4, um caso à parte)', () => {
  // Foge do loop genérico acima em dois pontos: o e-mail do titular é a
  // EXCEÇÃO deliberada à regra de privacidade (§5.4 pede explicitamente
  // "nome, e-mail, contagens" — é a única forma de identificar qual conta
  // foi apagada quando o nome não é único), e o link do console é sempre
  // omitido, porque a conta já não existe quando este e-mail é montado.
  const payload = buildEventPayload(
    {
      type: 'account.deleted',
      accountId: null,
      account,
      data: {
        deletion: {
          counts: { contacts: 3, conversations: 1, messages: 12, channels: 1 },
          detachedMembers: [
            { userId: 'user-2', newAccountId: 'acct-personal-2' },
          ],
          leftovers: ['instância X não apagada na VPS'],
        },
      },
    },
    now
  );
  const email = renderSystemEmail(payload);

  it('assunto contém a conta', () => {
    expect(email.subject).toContain('Acme Ltda');
    expect(email.subject.startsWith('[ZAP CRM BR]')).toBe(true);
  });

  it('corpo contém o e-mail do titular (exceção documentada)', () => {
    expect(email.text).toContain('ana@acme.com');
    expect(email.html).toContain('ana@acme.com');
  });

  it('corpo conta membros DESLIGADOS (detachedMembers.length), não o total de members', () => {
    expect(email.text).toContain('Membros desligados: 1');
  });

  it('não tem link para o console — a conta já não existe', () => {
    expect(email.text).not.toContain('/admin/accounts/');
    expect(email.html).not.toContain('/admin/accounts/');
  });

  it('assunto diz "pelo titular" quando o actor é self-service (ou ausente)', () => {
    const selfServicePayload = buildEventPayload(
      {
        type: 'account.deleted',
        accountId: null,
        account,
        actor: 'self-service:ana@acme.com',
        data: { deletion: { counts: {}, leftovers: [] } },
      },
      now
    );
    expect(renderSystemEmail(selfServicePayload).subject).toContain(
      'foi excluída pelo titular'
    );
    expect(email.subject).toContain('foi excluída pelo titular');
  });

  it('assunto diz "pelo console do proprietário" quando o actor é console:<email>', () => {
    const adminPayload = buildEventPayload(
      {
        type: 'account.deleted',
        accountId: null,
        account,
        actor: 'console:bruno@zapcrmbr.com',
        data: { deletion: { counts: {}, leftovers: [] } },
      },
      now
    );
    expect(renderSystemEmail(adminPayload).subject).toContain(
      'foi excluída pelo console do proprietário'
    );
  });
});

describe('renderEmailChangedNotice (SPEC 078 §5.5, D-11)', () => {
  const rendered = renderEmailChangedNotice(new Date('2026-10-09T15:00:00Z'));

  it('diz que o e-mail de acesso foi alterado pelo suporte, na data de São Paulo', () => {
    expect(rendered.subject).toContain('e-mail de acesso');
    expect(rendered.text).toContain('alterado pelo suporte em 09/10/2026');
  });

  it('a data é a de São Paulo, não a de UTC (02:00 UTC ainda é o dia anterior)', () => {
    const late = renderEmailChangedNotice(new Date('2026-10-10T02:00:00Z'));
    expect(late.text).toContain('09/10/2026');
  });

  it('orienta a responder, sem trazer o endereço novo, a conta nem link do console', () => {
    expect(rendered.text).toContain('responda a este e-mail');
    expect(rendered.text).not.toContain('@');
    expect(rendered.text).not.toContain('/admin');
    expect(rendered.html).not.toContain('<a ');
  });

  it('HTML mínimo: parágrafos, sem imagem remota nem CSS externo', () => {
    expect(rendered.html).toContain('<p>');
    expect(rendered.html).not.toMatch(/<img|<link|@import|http/i);
  });
});
