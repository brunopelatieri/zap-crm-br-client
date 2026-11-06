import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { recordActivity } from '@/lib/activity/record';
import { ACTIVITY_CATALOG } from '@/lib/activity/types';

import { recordFormActivity, recordFormSubmitted } from './activity';
import {
  ACCOUNT_ID,
  CONTACT_ID,
  FORM_ID,
  RESPONSE_ID,
  USER_ID,
} from './test-fixtures';

vi.mock('@/lib/activity/record', () => ({ recordActivity: vi.fn() }));

const db = {} as SupabaseClient;

describe('catálogo de atividade dos formulários (SPEC 085 §9)', () => {
  it('as oito ações de form e contact.form_submitted estão no catálogo', () => {
    expect(ACTIVITY_CATALOG.form).toEqual([
      'form.created',
      'form.published',
      'form.unpublished',
      'form.archived',
      'form.restored',
      'form.deleted',
      'form.responses_deleted',
      'form.exported',
    ]);
    expect(ACTIVITY_CATALOG.contact).toContain('contact.form_submitted');
  });
});

describe('recordFormActivity / recordFormSubmitted', () => {
  it('ação do formulário grava recurso form com o nome como rótulo', async () => {
    await recordFormActivity(db, {
      accountId: ACCOUNT_ID,
      action: 'form.published',
      form: { id: FORM_ID, name: 'Captação' },
      actor: { kind: 'user', userId: USER_ID, name: 'Bruno' },
      metadata: { version: 2 },
    });
    expect(recordActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        action: 'form.published',
        resourceType: 'form',
        resourceId: FORM_ID,
        resourceLabel: 'Captação',
        source: { table: 'forms', id: FORM_ID },
        metadata: { version: 2 },
      })
    );
  });

  it('envio grava com o contato como ator e o telefone mascarado no rótulo', async () => {
    await recordFormSubmitted(db, {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      contactPhone: '5511999998888',
      contactName: null,
      formId: FORM_ID,
      formName: 'Captação',
      responseId: RESPONSE_ID,
      score: 40,
      bandKey: 'hot',
    });
    const [, entry] = vi.mocked(recordActivity).mock.calls[0];
    expect(entry).toMatchObject({
      action: 'contact.form_submitted',
      resourceType: 'contact',
      resourceId: CONTACT_ID,
      actor: { kind: 'contact', contactId: CONTACT_ID },
      contactId: CONTACT_ID,
      source: { table: 'form_responses', id: RESPONSE_ID },
      metadata: {
        form_id: FORM_ID,
        form_name: 'Captação',
        response_id: RESPONSE_ID,
        score: 40,
        band_key: 'hot',
      },
    });
    expect(entry.resourceLabel).not.toContain('5511999998888');
    expect(entry.resourceLabel).toMatch(/\*/);
    // Nada do que foi respondido vai para o log.
    expect(JSON.stringify(entry)).not.toMatch(/answers/);
  });

  it('com nome, o rótulo é o nome (sem telefone)', async () => {
    await recordFormSubmitted(db, {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      contactPhone: '5511999998888',
      contactName: 'Ana',
      formId: FORM_ID,
      formName: 'Captação',
      responseId: RESPONSE_ID,
      score: null,
      bandKey: null,
    });
    const [, entry] = vi.mocked(recordActivity).mock.calls[0];
    expect(entry.resourceLabel).toBe('Ana');
  });
});
