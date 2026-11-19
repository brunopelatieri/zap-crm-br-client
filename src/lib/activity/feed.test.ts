import { describe, expect, it } from 'vitest';

import { activityHref, activityValues, toFeedEntry } from './feed';
import type { ActivityRow } from './query';

function makeRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'evt-1',
    created_at: '2026-09-09T12:00:00.000Z',
    actor_kind: 'user',
    actor_user_id: 'user-1',
    actor_name: 'Bruno',
    actor_role: 'owner',
    resource_type: 'contact',
    action: 'contact.created',
    resource_id: 'contact-1',
    resource_label: 'Ana Paula',
    channel_id: null,
    channel_type: null,
    conversation_id: null,
    contact_id: 'contact-1',
    source_table: null,
    source_id: null,
    metadata: {},
    ...overrides,
  };
}

describe('activityHref', () => {
  it('mensagem/conversa levam à thread quando há conversation_id', () => {
    expect(
      activityHref(
        makeRow({
          resource_type: 'message',
          action: 'message.deleted',
          conversation_id: 'conv-1',
        })
      )
    ).toBe('/inbox?c=conv-1');
  });

  it('sem conversation_id, mensagem não inventa destino', () => {
    expect(
      activityHref(
        makeRow({
          resource_type: 'message',
          action: 'message.deleted',
          conversation_id: null,
        })
      )
    ).toBeNull();
  });

  it('campanha leva ao detalhe pelo id', () => {
    expect(
      activityHref(
        makeRow({
          resource_type: 'broadcast',
          action: 'broadcast.dispatched',
          resource_id: 'bcast-1',
        })
      )
    ).toBe('/broadcasts/bcast-1');
  });

  it('formulário leva ao construtor; excluído não tem destino (SPEC 085 F2)', () => {
    expect(
      activityHref(
        makeRow({
          resource_type: 'form',
          action: 'form.published',
          resource_id: 'form-1',
        })
      )
    ).toBe('/forms/form-1');
    expect(
      activityHref(
        makeRow({
          resource_type: 'form',
          action: 'form.exported',
          resource_id: null,
        })
      )
    ).toBe('/forms');
    expect(
      activityHref(
        makeRow({
          resource_type: 'form',
          action: 'form.deleted',
          resource_id: 'form-1',
        })
      )
    ).toBeNull();
  });

  it('campanha sem id cai na listagem', () => {
    expect(
      activityHref(
        makeRow({
          resource_type: 'broadcast',
          action: 'broadcast.dispatched',
          resource_id: null,
        })
      )
    ).toBe('/broadcasts');
  });

  // A regra que justifica a existência desta função: o recurso apagado
  // é justamente o que a auditoria mais nomeia, e um link para ele é
  // uma promessa que o clique não cumpre.
  it.each([
    ['contact.deleted', 'contact'],
    ['deal.deleted', 'deal'],
    ['message.purged', 'message'],
    ['automation.deleted', 'automation'],
    ['channel.deleted', 'channel'],
    ['member.removed', 'member'],
  ] as const)('%s não gera link', (action, resourceType) => {
    expect(
      activityHref(
        makeRow({
          action,
          resource_type: resourceType,
          resource_id: 'x',
          conversation_id: 'conv-1',
        })
      )
    ).toBeNull();
  });

  it('automação viva leva ao editor', () => {
    expect(
      activityHref(
        makeRow({
          resource_type: 'automation',
          action: 'automation.enabled',
          resource_id: 'auto-1',
        })
      )
    ).toBe('/automations/auto-1/edit');
  });

  it('plano leva a /plan; canal, membro e webhook a /settings', () => {
    expect(
      activityHref(makeRow({ resource_type: 'plan', action: 'plan.changed' }))
    ).toBe('/plan');
    expect(
      activityHref(
        makeRow({ resource_type: 'channel', action: 'channel.connected' })
      )
    ).toBe('/settings');
    expect(
      activityHref(
        makeRow({ resource_type: 'member', action: 'member.invited' })
      )
    ).toBe('/settings');
    expect(
      activityHref(
        makeRow({ resource_type: 'webhook', action: 'webhook.ingest_failed' })
      )
    ).toBe('/settings');
  });
});

describe('activityValues', () => {
  it('label sai de resource_label; null vira string vazia (fallback é da UI)', () => {
    expect(activityValues(makeRow({ resource_label: null }))).toEqual({
      label: '',
    });
  });

  it('deal.stage_changed carrega os NOMES de/para', () => {
    expect(
      activityValues(
        makeRow({
          action: 'deal.stage_changed',
          resource_label: 'Loja X',
          metadata: { from: 'Proposta', to: 'Fechado' },
        })
      )
    ).toEqual({ label: 'Loja X', from: 'Proposta', to: 'Fechado' });
  });

  it('estágio apagado (from/to ausentes) não quebra — vira string vazia', () => {
    expect(
      activityValues(
        makeRow({ action: 'deal.stage_changed', metadata: { from: null } })
      )
    ).toMatchObject({ from: '', to: '' });
  });

  it('contact.imported carrega o contador como número (ICU plural)', () => {
    expect(
      activityValues(
        makeRow({ action: 'contact.imported', metadata: { count: 500 } })
      )
    ).toMatchObject({ count: 500 });
  });

  it('contador ausente ou de tipo errado vira 0, nunca NaN', () => {
    expect(
      activityValues(
        makeRow({ action: 'contact.imported', metadata: { count: 'muitos' } })
      )
    ).toMatchObject({ count: 0 });
  });

  it('member.role_changed carrega o novo papel', () => {
    expect(
      activityValues(
        makeRow({
          action: 'member.role_changed',
          metadata: { new_role: 'admin' },
        })
      )
    ).toMatchObject({ role: 'admin' });
  });

  it('exportação carrega o formato em maiúsculas', () => {
    expect(
      activityValues(
        makeRow({ action: 'contact.exported', metadata: { format: 'xlsx' } })
      )
    ).toMatchObject({ format: 'XLSX' });
  });

  it('metadata null não lança', () => {
    expect(() =>
      activityValues(makeRow({ metadata: null as never }))
    ).not.toThrow();
  });
});

describe('toFeedEntry', () => {
  it('achata a linha no que a UI precisa, com source só quando completo', () => {
    const entry = toFeedEntry(
      makeRow({
        source_table: 'message_deletion_log',
        source_id: 'msg-1',
        channel_id: 'chan-1',
      })
    );

    expect(entry).toMatchObject({
      id: 'evt-1',
      kind: 'contact',
      action: 'contact.created',
      actorName: 'Bruno',
      actorKind: 'user',
      actorRole: 'owner',
      channelId: 'chan-1',
      source: { table: 'message_deletion_log', id: 'msg-1' },
      href: '/contacts',
    });
  });

  it('source pela metade (tabela sem id) é descartado', () => {
    const entry = toFeedEntry(
      makeRow({ source_table: 'contact_exports', source_id: null })
    );
    expect(entry.source).toBeNull();
  });
});
