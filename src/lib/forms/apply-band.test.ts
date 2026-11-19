import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isAssignableMember } from '@/lib/inbox/assignment';
import { createDeal } from '@/lib/pipelines/deals';

import { applyBandActions, renderDealTitle } from './apply-band';
import {
  ACCOUNT_ID,
  CONTACT_ID,
  fakeDb,
  FORM_ID,
  OTHER_ACCOUNT_ID,
  PIPELINE_ID,
  RESPONSE_ID,
  STAGE_ID,
  TAG_ID,
  USER_ID,
} from './test-fixtures';
import type { Band } from './types';

vi.mock('@/lib/pipelines/deals', () => ({ createDeal: vi.fn() }));
vi.mock('@/lib/inbox/assignment', () => ({ isAssignableMember: vi.fn() }));

const asDb = (db: ReturnType<typeof fakeDb>) => db as unknown as SupabaseClient;

const baseInput = {
  accountId: ACCOUNT_ID,
  contactId: CONTACT_ID,
  formId: FORM_ID,
  formName: 'Captação',
  responseId: RESPONSE_ID,
  contactName: 'Ana',
  contactPhone: '5511999999999',
  auditUserId: USER_ID,
};

const band = (actions: Band['actions']): Band => ({
  key: 'hot',
  label: 'Quente',
  min: 0,
  max: null,
  actions,
});

describe('renderDealTitle', () => {
  it('padrão {{contact.name}} — {{form.name}}, com telefone quando não há nome', () => {
    expect(
      renderDealTitle(undefined, {
        contactName: 'Ana',
        contactPhone: '55',
        formName: 'Captação',
        bandLabel: 'Quente',
      })
    ).toBe('Ana — Captação');
    expect(
      renderDealTitle(undefined, {
        contactName: null,
        contactPhone: '5511999999999',
        formName: 'Captação',
        bandLabel: 'Quente',
      })
    ).toBe('5511999999999 — Captação');
    expect(
      renderDealTitle('[{{ band.label }}] {{contact.name}}', {
        contactName: '',
        contactPhone: null,
        formName: 'F',
        bandLabel: 'Quente',
      })
    ).toBe('[Quente]');
  });
});

describe('applyBandActions (PRD 084 D-5)', () => {
  beforeEach(() => {
    vi.mocked(createDeal).mockResolvedValue({ id: 'deal-1' } as never);
    vi.mocked(isAssignableMember).mockResolvedValue(true);
  });

  it('etiquetas: aplica as da conta, avisa sobre as desconhecidas, nunca remove', async () => {
    const db = fakeDb({
      tags: [{ data: [{ id: TAG_ID }] }],
      contact_tags: [{}],
    });
    const r = await applyBandActions(asDb(db), {
      ...baseInput,
      band: band({ tag_ids: [TAG_ID, 'alheia'] }),
    });
    expect(r.tagsApplied).toEqual([TAG_ID]);
    expect(r.warnings).toEqual([
      { action: 'tags', detail: 'unknown tag ids: alheia' },
    ]);
    expect(db.callsTo('contact_tags', 'upsert')[0].args[1]).toEqual({
      onConflict: 'contact_id,tag_id',
      ignoreDuplicates: true,
    });
    expect(db.callsTo('contact_tags', 'delete')).toHaveLength(0);
  });

  it('negócio: etapa de outra conta não cria nada', async () => {
    const db = fakeDb({
      pipeline_stages: [
        {
          data: {
            id: STAGE_ID,
            pipeline_id: PIPELINE_ID,
            pipelines: { account_id: OTHER_ACCOUNT_ID },
          },
        },
      ],
    });
    const r = await applyBandActions(asDb(db), {
      ...baseInput,
      band: band({ deal: { pipeline_id: PIPELINE_ID, stage_id: STAGE_ID } }),
    });
    expect(r.dealId).toBeNull();
    expect(r.warnings).toEqual([
      { action: 'deal', detail: 'stage not found in this account' },
    ]);
    expect(createDeal).not.toHaveBeenCalled();
  });

  it('negócio: cria com título renderizado e atribuição específica validada', async () => {
    const db = fakeDb({
      pipeline_stages: [
        {
          data: {
            id: STAGE_ID,
            pipeline_id: PIPELINE_ID,
            pipelines: { account_id: ACCOUNT_ID },
          },
        },
      ],
    });
    const r = await applyBandActions(asDb(db), {
      ...baseInput,
      band: band({
        deal: {
          pipeline_id: PIPELINE_ID,
          stage_id: STAGE_ID,
          assign: { mode: 'specific', user_id: USER_ID },
        },
      }),
    });
    expect(r).toMatchObject({
      dealId: 'deal-1',
      assignedTo: USER_ID,
      warnings: [],
    });
    expect(createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        pipelineId: PIPELINE_ID,
        stageId: STAGE_ID,
        contactId: CONTACT_ID,
        title: 'Ana — Captação',
        currency: 'BRL',
        assignedTo: USER_ID,
      })
    );
    expect(isAssignableMember).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      USER_ID
    );
  });

  it('negócio: usuário não atribuível cria sem responsável e avisa', async () => {
    vi.mocked(isAssignableMember).mockResolvedValue(false);
    const db = fakeDb({
      pipeline_stages: [
        {
          data: {
            id: STAGE_ID,
            pipeline_id: PIPELINE_ID,
            pipelines: { account_id: ACCOUNT_ID },
          },
        },
      ],
    });
    const r = await applyBandActions(asDb(db), {
      ...baseInput,
      band: band({
        deal: {
          pipeline_id: PIPELINE_ID,
          stage_id: STAGE_ID,
          assign: { mode: 'specific', user_id: 'intruso' },
        },
      }),
    });
    expect(r.dealId).toBe('deal-1');
    expect(r.assignedTo).toBeNull();
    expect(r.warnings).toEqual([
      { action: 'assign', detail: 'user is not an assignable member' },
    ]);
  });

  it('rodízio: alterna entre os membros atribuíveis pela contagem de respostas', async () => {
    const stage = {
      data: {
        id: STAGE_ID,
        pipeline_id: PIPELINE_ID,
        pipelines: { account_id: ACCOUNT_ID },
      },
    };
    const members = { data: [{ user_id: 'u1' }, { user_id: 'u2' }] };
    const run = async (count: number) => {
      const db = fakeDb({
        pipeline_stages: [stage],
        profiles: [members],
        form_responses: [{ count }],
      });
      return applyBandActions(asDb(db), {
        ...baseInput,
        band: band({
          deal: {
            pipeline_id: PIPELINE_ID,
            stage_id: STAGE_ID,
            assign: { mode: 'round_robin' },
          },
        }),
      });
    };
    expect((await run(1)).assignedTo).toBe('u1');
    expect((await run(2)).assignedTo).toBe('u2');
    expect((await run(3)).assignedTo).toBe('u1');
  });

  it('notificação: só para membros da conta, com o tipo form_response_received', async () => {
    const db = fakeDb({
      profiles: [{ data: [{ user_id: USER_ID }] }],
      notifications: [{}],
    });
    const r = await applyBandActions(asDb(db), {
      ...baseInput,
      band: band({ notify_user_ids: [USER_ID, 'fora'] }),
      notification: { title: 'Nova resposta', body: 'Ana respondeu' },
    });
    expect(r.notified).toEqual([USER_ID]);
    const [insert] = db.callsTo('notifications', 'insert');
    expect(insert.args[0]).toEqual([
      {
        account_id: ACCOUNT_ID,
        user_id: USER_ID,
        type: 'form_response_received',
        contact_id: CONTACT_ID,
        // Link profundo de /notifications (F4).
        form_id: FORM_ID,
        form_response_id: RESPONSE_ID,
        actor_user_id: null,
        title: 'Nova resposta',
        body: 'Ana respondeu',
      },
    ]);
  });

  it('falha de uma ação não derruba as outras nem lança', async () => {
    vi.mocked(createDeal).mockRejectedValue(new Error('deal down'));
    const db = fakeDb({
      tags: [{ data: null, error: { message: 'tags down' } }],
      pipeline_stages: [
        {
          data: {
            id: STAGE_ID,
            pipeline_id: PIPELINE_ID,
            pipelines: { account_id: ACCOUNT_ID },
          },
        },
      ],
      profiles: [{ data: [{ user_id: USER_ID }] }],
      notifications: [{}],
    });
    const r = await applyBandActions(asDb(db), {
      ...baseInput,
      band: band({
        tag_ids: [TAG_ID],
        deal: { pipeline_id: PIPELINE_ID, stage_id: STAGE_ID },
        notify_user_ids: [USER_ID],
      }),
      notification: { title: 't' },
    });
    expect(r.notified).toEqual([USER_ID]);
    expect(r.warnings.map((w) => w.action).sort()).toEqual(['deal', 'tags']);
  });
});
