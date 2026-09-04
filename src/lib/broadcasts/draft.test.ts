import { describe, expect, it } from 'vitest';

import type { AudienceConfig } from '@/lib/audience/estimate';
import type { MessageTemplate } from '@/types';

import { createSupabaseMock, opArgs } from '../audience/supabase-mock';
import {
  describeDraftAudience,
  hasDraftChanges,
  hydrateAudienceConfig,
  loadBroadcastDraft,
  persistableAudience,
  saveBroadcastDraft,
  type DraftSnapshot,
} from './draft';

const BROADCAST = 'broadcast-1';
const ACCOUNT = 'acct-1';

describe('hydrateAudienceConfig', () => {
  it('audience_filter com tags e staging vazio devolve o filtro, não staged', () => {
    const result = hydrateAudienceConfig({
      broadcastId: BROADCAST,
      audienceFilter: { type: 'tags', tagIds: ['tag-1', 'tag-2'] },
      stagedRowCount: 0,
    });
    expect(result).toEqual({ type: 'tags', tagIds: ['tag-1', 'tag-2'] });
  });

  it('audience_filter com tags E staging cheio ainda devolve o filtro — a origem vence', () => {
    const result = hydrateAudienceConfig({
      broadcastId: BROADCAST,
      audienceFilter: { type: 'tags', tagIds: ['tag-1'] },
      stagedRowCount: 3000,
    });
    expect(result).toEqual({ type: 'tags', tagIds: ['tag-1'] });
  });

  it('audience_filter nulo + staging com linhas (rascunho de hoje, D-10) devolve staged', () => {
    const result = hydrateAudienceConfig({
      broadcastId: BROADCAST,
      audienceFilter: null,
      stagedRowCount: 3000,
    });
    expect(result).toEqual({ type: 'staged', draftId: BROADCAST });
  });

  it('audience_filter nulo + staging vazio (D-12) devolve all', () => {
    const result = hydrateAudienceConfig({
      broadcastId: BROADCAST,
      audienceFilter: null,
      stagedRowCount: 0,
    });
    expect(result).toEqual({ type: 'all' });
  });

  it('audience_filter com type "contact_ids" nunca é devolvido — cai em staged quando há staging', () => {
    const result = hydrateAudienceConfig({
      broadcastId: BROADCAST,
      audienceFilter: { type: 'contact_ids', contactIds: ['c1', 'c2'] },
      stagedRowCount: 5,
    });
    expect(result).toEqual({ type: 'staged', draftId: BROADCAST });
  });

  it('audience_filter com type "contact_ids" e staging vazio cai em all (vazio)', () => {
    const result = hydrateAudienceConfig({
      broadcastId: BROADCAST,
      audienceFilter: { type: 'contact_ids', contactIds: ['c1'] },
      stagedRowCount: 0,
    });
    expect(result).toEqual({ type: 'all' });
  });

  it('audience_filter com JSON corrompido não lança — cai no caminho do staging', () => {
    expect(() =>
      hydrateAudienceConfig({
        broadcastId: BROADCAST,
        audienceFilter: 'not even an object',
        stagedRowCount: 10,
      })
    ).not.toThrow();

    expect(
      hydrateAudienceConfig({
        broadcastId: BROADCAST,
        audienceFilter: 'not even an object',
        stagedRowCount: 10,
      })
    ).toEqual({ type: 'staged', draftId: BROADCAST });
  });

  it('audience_filter com tipo desconhecido não lança — cai no caminho do staging', () => {
    const result = hydrateAudienceConfig({
      broadcastId: BROADCAST,
      audienceFilter: { type: 'some_future_type', foo: 'bar' },
      stagedRowCount: 0,
    });
    expect(result).toEqual({ type: 'all' });
  });

  it('marcador csv (D-4, sem csvContacts) com staging cheio devolve staged', () => {
    const result = hydrateAudienceConfig({
      broadcastId: BROADCAST,
      audienceFilter: { type: 'csv', importedRows: 3000 },
      stagedRowCount: 3000,
    });
    expect(result).toEqual({ type: 'staged', draftId: BROADCAST });
  });
});

describe('persistableAudience', () => {
  it('csv com 3000 linhas grava só o marcador — sem csvContacts', () => {
    const audience: AudienceConfig = {
      type: 'csv',
      csvContacts: Array.from({ length: 3000 }, (_, i) => ({
        phone: `55119999${i}`,
      })),
    };
    const result = persistableAudience(audience);
    expect(result).toEqual({ type: 'csv', importedRows: 3000 });
    expect(result).not.toHaveProperty('csvContacts');
  });

  it('contact_ids devolve null — nunca persiste', () => {
    const audience: AudienceConfig = {
      type: 'contact_ids',
      contactIds: ['c1', 'c2'],
    };
    expect(persistableAudience(audience)).toBeNull();
  });

  it('tags preserva tagIds/excludeTagIds', () => {
    const audience: AudienceConfig = {
      type: 'tags',
      tagIds: ['t1'],
      excludeTagIds: ['t2'],
    };
    expect(persistableAudience(audience)).toMatchObject({
      type: 'tags',
      tagIds: ['t1'],
      excludeTagIds: ['t2'],
    });
  });
});

describe('describeDraftAudience', () => {
  it('tags', () => {
    expect(
      describeDraftAudience(
        { type: 'tags', tagIds: ['a', 'b'] },
        { selected: 0, total: 0, invalid: 0 }
      )
    ).toEqual({ key: 'tags', tagIds: ['a', 'b'] });
  });

  it('customField', () => {
    expect(
      describeDraftAudience(
        {
          type: 'custom_field',
          customField: { fieldId: 'f1', operator: 'is', value: 'x' },
        },
        { selected: 0, total: 0, invalid: 0 }
      )
    ).toEqual({
      key: 'customField',
      fieldId: 'f1',
      operator: 'is',
      value: 'x',
    });
  });

  it('imported — staged cuja origem é uma planilha importada', () => {
    expect(
      describeDraftAudience(
        { type: 'staged', draftId: BROADCAST },
        { selected: 2840, total: 3000, invalid: 12, imported: true }
      )
    ).toEqual({ key: 'imported', selected: 2840, total: 3000 });
  });

  it('staged — D-10, sem marcador de importação', () => {
    expect(
      describeDraftAudience(
        { type: 'staged', draftId: BROADCAST },
        { selected: 3000, total: 3000, invalid: 0 }
      )
    ).toEqual({ key: 'staged', selected: 3000, total: 3000 });
  });

  it('vazio (D-12) — resumo com total zero', () => {
    expect(
      describeDraftAudience(
        { type: 'all' },
        { selected: 0, total: 0, invalid: 0 }
      )
    ).toEqual({ key: 'empty' });
  });
});

describe('hasDraftChanges', () => {
  function baseSnapshot(): DraftSnapshot {
    return {
      name: 'Campanha',
      templateName: 'boas_vindas',
      templateLanguage: 'pt_BR',
      channelId: 'chan-1',
      audience: { type: 'tags', tagIds: ['t1', 't2'] },
      variables: { '1': { type: 'field', value: 'name' } },
      headerMediaUrl: '',
      checkBeforeSend: false,
    };
  }

  it('objetos equivalentes com referências distintas não conta como mudança', () => {
    const loaded = baseSnapshot();
    const current: DraftSnapshot = {
      ...baseSnapshot(),
      audience: { type: 'tags', tagIds: ['t1', 't2'] },
      variables: { '1': { type: 'field', value: 'name' } },
    };
    expect(hasDraftChanges(loaded, current)).toBe(false);
  });

  it('uma variável trocada conta como mudança', () => {
    const loaded = baseSnapshot();
    const current: DraftSnapshot = {
      ...baseSnapshot(),
      variables: { '1': { type: 'field', value: 'company' } },
    };
    expect(hasDraftChanges(loaded, current)).toBe(true);
  });

  it('audiência trocada conta como mudança', () => {
    const loaded = baseSnapshot();
    const current: DraftSnapshot = {
      ...baseSnapshot(),
      audience: { type: 'tags', tagIds: ['t3'] },
    };
    expect(hasDraftChanges(loaded, current)).toBe(true);
  });

  it('nome trocado conta como mudança', () => {
    const loaded = baseSnapshot();
    const current: DraftSnapshot = { ...baseSnapshot(), name: 'Outro nome' };
    expect(hasDraftChanges(loaded, current)).toBe(true);
  });
});

// ------------------------------------------------------------
// F2 — loadBroadcastDraft / saveBroadcastDraft
// ------------------------------------------------------------

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tmpl-1',
    user_id: 'user-1',
    account_id: ACCOUNT,
    waba_id: null,
    name: 'boas_vindas',
    language: 'pt_BR',
    category: 'Marketing',
    body_text: 'Olá {{1}}',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function broadcastRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BROADCAST,
    name: 'Campanha X',
    status: 'draft',
    source: 'dashboard',
    variant_label: null,
    parent_broadcast_id: null,
    template_name: 'boas_vindas',
    template_language: 'pt_BR',
    template_variables: {},
    audience_filter: null,
    channel_id: null,
    header_media_url: null,
    check_before_send: false,
    scheduled_at: null,
    ...overrides,
  };
}

describe('loadBroadcastDraft', () => {
  it('not_found quando a linha não existe (id inexistente ou de outra conta)', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcasts') return { data: null };
      return undefined;
    });

    const result = await loadBroadcastDraft(mock.db, {
      accountId: ACCOUNT,
      broadcastId: BROADCAST,
    });
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });

  it('not_a_draft quando o status já saiu de draft', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcasts') {
        return { data: broadcastRow({ status: 'sent' }) };
      }
      return undefined;
    });

    const result = await loadBroadcastDraft(mock.db, {
      accountId: ACCOUNT,
      broadcastId: BROADCAST,
    });
    expect(result).toEqual({
      ok: false,
      error: 'not_a_draft',
      status: 'sent',
    });
  });

  it('webhook_funnel quando source = webhook', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcasts') {
        return { data: broadcastRow({ source: 'webhook' }) };
      }
      return undefined;
    });

    const result = await loadBroadcastDraft(mock.db, {
      accountId: ACCOUNT,
      broadcastId: BROADCAST,
    });
    expect(result).toEqual({ ok: false, error: 'webhook_funnel' });
  });

  it('ab_variant quando é uma variante de teste A/B (D-8)', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcasts') {
        return {
          data: broadcastRow({
            variant_label: 'B',
            parent_broadcast_id: 'parent-1',
          }),
        };
      }
      return undefined;
    });

    const result = await loadBroadcastDraft(mock.db, {
      accountId: ACCOUNT,
      broadcastId: BROADCAST,
    });
    expect(result).toEqual({ ok: false, error: 'ab_variant' });
  });

  it('template ausente é recuperável: reidrata ok:true com template:null, templateMissing:true e o resto preservado', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcasts') {
        return {
          data: broadcastRow({
            channel_id: 'chan-1',
            audience_filter: { type: 'tags', tagIds: ['t1'] },
          }),
        };
      }
      if (table === 'whatsapp_config') return { data: { waba_id: 'waba-a' } };
      if (table === 'message_templates') return { data: [] };
      if (table === 'broadcast_audience_staging') {
        const hasSelectedFilter = ops.some(
          (o) => o.fn === 'eq' && o.args[0] === 'selected'
        );
        if (hasSelectedFilter) return { count: 0 };
        return { count: 0 };
      }
      return undefined;
    });

    const result = await loadBroadcastDraft(mock.db, {
      accountId: ACCOUNT,
      broadcastId: BROADCAST,
    });

    if (!result.ok)
      throw new Error('expected ok:true, got error ' + result.error);
    expect(result.draft.template).toBeNull();
    expect(result.draft.templateMissing).toBe(true);
    expect(result.draft.audience).toEqual({ type: 'tags', tagIds: ['t1'] });
  });

  it('reidrata com sucesso: template, audiência de origem e resumo do staging', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcasts') {
        return {
          data: broadcastRow({
            audience_filter: { type: 'tags', tagIds: ['t1'] },
            template_variables: { '1': { type: 'field', value: 'name' } },
            header_media_url: 'https://cdn/img.jpg',
            check_before_send: true,
          }),
        };
      }
      if (table === 'message_templates') return { data: [templateRow()] };
      if (table === 'broadcast_audience_staging') {
        const hasSelectedFilter = ops.some(
          (o) => o.fn === 'eq' && o.args[0] === 'selected'
        );
        const hasInvalidFilter = ops.some((o) => o.fn === 'not');
        if (hasSelectedFilter) return { count: 2840 };
        if (hasInvalidFilter) return { count: 12 };
        return { count: 3000 };
      }
      return undefined;
    });

    const result = await loadBroadcastDraft(mock.db, {
      accountId: ACCOUNT,
      broadcastId: BROADCAST,
    });

    if (!result.ok)
      throw new Error('expected ok:true, got error ' + result.error);
    expect(result.draft.template?.id).toBe('tmpl-1');
    expect(result.draft.templateMissing).toBe(false);
    expect(result.draft.audience).toEqual({ type: 'tags', tagIds: ['t1'] });
    expect(result.draft.audienceSummary).toEqual({
      selected: 2840,
      total: 3000,
      invalid: 12,
      imported: false,
    });
    expect(result.draft.headerMediaUrl).toBe('https://cdn/img.jpg');
    expect(result.draft.checkBeforeSend).toBe(true);
    expect(result.draft.variables).toEqual({
      '1': { type: 'field', value: 'name' },
    });
  });

  it('rascunho antigo sem audience_filter (D-10) reidrata como staged, com imported=false', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcasts') return { data: broadcastRow() };
      if (table === 'message_templates') return { data: [templateRow()] };
      if (table === 'broadcast_audience_staging') {
        const hasSelectedFilter = ops.some(
          (o) => o.fn === 'eq' && o.args[0] === 'selected'
        );
        if (hasSelectedFilter) return { count: 3000 };
        return { count: 3000 };
      }
      return undefined;
    });

    const result = await loadBroadcastDraft(mock.db, {
      accountId: ACCOUNT,
      broadcastId: BROADCAST,
    });

    if (!result.ok)
      throw new Error('expected ok:true, got error ' + result.error);
    expect(result.draft.audience).toEqual({
      type: 'staged',
      draftId: BROADCAST,
    });
    expect(result.draft.audienceSummary.imported).toBe(false);
  });
});

describe('saveBroadcastDraft', () => {
  function template(): MessageTemplate {
    return {
      id: 'tmpl-1',
      user_id: 'user-1',
      name: 'boas_vindas',
      category: 'Marketing',
      language: 'pt_BR',
      body_text: 'Olá {{1}}',
      created_at: '2026-01-01T00:00:00.000Z',
    };
  }

  function baseParams() {
    return {
      accountId: ACCOUNT,
      broadcastId: BROADCAST,
      name: 'Campanha Y',
      template: template(),
      channelId: null as string | null,
      audience: { type: 'tags', tagIds: ['t1'] } as AudienceConfig,
      variables: {},
      headerMediaUrl: '',
      checkBeforeSend: false,
    };
  }

  it('faz UPDATE (nunca INSERT) e devolve ok quando a linha ainda é draft', async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcasts') {
        const args = opArgs(ops, 'update');
        if (args) updatePayload = args[0] as Record<string, unknown>;
        return { data: { id: BROADCAST } };
      }
      return undefined;
    });

    const result = await saveBroadcastDraft(mock.db, baseParams());

    expect(result).toEqual({ ok: true });
    expect(
      mock
        .callsFor('broadcasts')
        .some((c) => c.ops.some((o) => o.fn === 'insert'))
    ).toBe(false);
    expect(updatePayload).toMatchObject({
      name: 'Campanha Y',
      template_name: 'boas_vindas',
      template_language: 'pt_BR',
      audience_filter: { type: 'tags', tagIds: ['t1'] },
      channel_id: null,
      channel_source: 'default',
    });
  });

  it('exige status=draft no filtro do UPDATE — a pré-condição de adoção', async () => {
    let sawStatusFilter = false;
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcasts') {
        sawStatusFilter = ops.some(
          (o) =>
            o.fn === 'eq' && o.args[0] === 'status' && o.args[1] === 'draft'
        );
        return { data: { id: BROADCAST } };
      }
      return undefined;
    });

    await saveBroadcastDraft(mock.db, baseParams());
    expect(sawStatusFilter).toBe(true);
  });

  it('draft_not_found quando nenhuma linha casa (já enviado, apagado ou outra conta)', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcasts') return { data: null, error: null };
      return undefined;
    });

    const result = await saveBroadcastDraft(mock.db, baseParams());
    expect(result).toEqual({ ok: false, error: 'draft_not_found' });
  });

  it('db_error quando o UPDATE falha de verdade (distinto de 0 linhas casadas)', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcasts') {
        return { data: null, error: { message: 'connection reset' } };
      }
      return undefined;
    });

    const result = await saveBroadcastDraft(mock.db, baseParams());
    expect(result).toEqual({ ok: false, error: 'db_error' });
  });

  it('channelId de outra conta não é gravado — degrada para null/default', async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'channels') return { data: null };
      if (table === 'broadcasts') {
        const args = opArgs(ops, 'update');
        if (args) updatePayload = args[0] as Record<string, unknown>;
        return { data: { id: BROADCAST } };
      }
      return undefined;
    });

    await saveBroadcastDraft(mock.db, {
      ...baseParams(),
      channelId: 'chan-other-account',
    });

    expect(updatePayload?.channel_id).toBeNull();
    expect(updatePayload?.channel_source).toBe('default');
  });

  it('channelId verificado na conta é gravado com channel_source=resource', async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'channels') return { data: { id: 'chan-1' } };
      if (table === 'broadcasts') {
        const args = opArgs(ops, 'update');
        if (args) updatePayload = args[0] as Record<string, unknown>;
        return { data: { id: BROADCAST } };
      }
      return undefined;
    });

    await saveBroadcastDraft(mock.db, { ...baseParams(), channelId: 'chan-1' });

    expect(updatePayload?.channel_id).toBe('chan-1');
    expect(updatePayload?.channel_source).toBe('resource');
  });

  it('audience contact_ids grava audience_filter nulo (nunca persiste)', async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcasts') {
        const args = opArgs(ops, 'update');
        if (args) updatePayload = args[0] as Record<string, unknown>;
        return { data: { id: BROADCAST } };
      }
      return undefined;
    });

    await saveBroadcastDraft(mock.db, {
      ...baseParams(),
      audience: { type: 'contact_ids', contactIds: ['c1'] },
    });

    expect(updatePayload?.audience_filter).toBeNull();
  });
});
