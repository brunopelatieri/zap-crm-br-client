import { describe, expect, it } from 'vitest';

import {
  createSupabaseMock,
  hasOp,
  opArgs,
  type MockResult,
  type QueryOp,
} from '@/lib/audience/supabase-mock';

import {
  applyQrCheckVerdict,
  detectDeadNumberOnFailure,
  isWhatsappInvalid,
  markWhatsappInvalid,
  markWhatsappValid,
} from './whatsapp-status';

describe('isWhatsappInvalid', () => {
  it('true só quando whatsapp_status é invalid', () => {
    expect(isWhatsappInvalid({ whatsapp_status: 'invalid' })).toBe(true);
    expect(isWhatsappInvalid({ whatsapp_status: 'valid' })).toBe(false);
    expect(isWhatsappInvalid({})).toBe(false);
  });
});

describe('markWhatsappInvalid', () => {
  it('grava status, motivo e timestamp, e só casa quem ainda está valid', async () => {
    const updates: Record<string, unknown>[] = [];
    const filters: unknown[][] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const upd = opArgs(ops, 'update');
      if (upd) updates.push(upd[0] as Record<string, unknown>);
      filters.push(ops.filter((o) => o.fn === 'eq').map((o) => o.args));
      return { data: null };
    });

    await markWhatsappInvalid(mock.db, 'c1', 'meta_error');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      whatsapp_status: 'invalid',
      whatsapp_status_reason: 'meta_error',
    });
    expect(updates[0].whatsapp_status_updated_at).toEqual(expect.any(String));
    expect(filters[0]).toEqual([
      ['id', 'c1'],
      ['whatsapp_status', 'valid'],
    ]);
  });

  it('não lança quando o UPDATE falha — best-effort', async () => {
    const mock = createSupabaseMock(() => ({
      data: null,
      error: { message: 'boom' },
    }));
    await expect(
      markWhatsappInvalid(mock.db, 'c1', 'consecutive_failures')
    ).resolves.toBeUndefined();
  });
});

describe('markWhatsappValid', () => {
  it('grava valid + motivo manual', async () => {
    const updates: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      const upd = opArgs(ops, 'update');
      if (upd) updates.push(upd[0] as Record<string, unknown>);
      return { data: null };
    });

    await markWhatsappValid(mock.db, 'c1');

    expect(updates[0]).toMatchObject({
      whatsapp_status: 'valid',
      whatsapp_status_reason: 'manual',
    });
  });

  it('lança quando o UPDATE falha — ação manual, o chamador mostra o toast', async () => {
    const mock = createSupabaseMock(() => ({
      data: null,
      error: { message: 'boom' },
    }));
    await expect(markWhatsappValid(mock.db, 'c1')).rejects.toBeTruthy();
  });
});

describe('detectDeadNumberOnFailure', () => {
  function makeDb(
    recipientRows: { status: string }[],
    handler?: (table: string, ops: QueryOp[]) => MockResult | undefined
  ) {
    const updates: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (handler) {
        const custom = handler(table, ops);
        if (custom !== undefined) return custom;
      }
      if (table === 'contacts') {
        const upd = opArgs(ops, 'update');
        if (upd) updates.push(upd[0] as Record<string, unknown>);
        return { data: null };
      }
      if (table === 'broadcast_recipients') {
        return { data: recipientRows };
      }
      return undefined;
    });
    return { ...mock, updates };
  }

  it('um erro 131026 marca invalid na hora, sem consultar o histórico', async () => {
    const { db, updates, callsFor } = makeDb([]);

    await detectDeadNumberOnFailure(db, {
      contactId: 'c1',
      errorMessage:
        '(#131026) Message Undeliverable: recipient not on WhatsApp',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].whatsapp_status_reason).toBe('meta_error');
    expect(callsFor('broadcast_recipients')).toHaveLength(0);
  });

  it('duas falhas seguidas (as mais recentes) marcam invalid', async () => {
    const { db, updates } = makeDb([
      { status: 'failed' },
      { status: 'failed' },
    ]);

    await detectDeadNumberOnFailure(db, {
      contactId: 'c1',
      errorMessage: 'Some generic send error',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].whatsapp_status_reason).toBe('consecutive_failures');
  });

  it('uma falha isolada (só uma tentativa no histórico) não marca invalid', async () => {
    const { db, updates } = makeDb([{ status: 'failed' }]);

    await detectDeadNumberOnFailure(db, {
      contactId: 'c1',
      errorMessage: 'Some generic send error',
    });

    expect(updates).toHaveLength(0);
  });

  it('falha + sucesso mais recente não conta como consecutivo', async () => {
    const { db, updates } = makeDb([{ status: 'failed' }, { status: 'sent' }]);

    await detectDeadNumberOnFailure(db, {
      contactId: 'c1',
      errorMessage: 'Some generic send error',
    });

    expect(updates).toHaveLength(0);
  });

  it('pede as 2 mais recentes ordenadas por created_at desc', async () => {
    let sawOrder: unknown[] | undefined;
    const { db } = makeDb(
      [{ status: 'failed' }, { status: 'failed' }],
      (table, ops) => {
        if (table === 'broadcast_recipients') {
          sawOrder = opArgs(ops, 'order');
          expect(opArgs(ops, 'limit')).toEqual([2]);
          return { data: [{ status: 'failed' }, { status: 'failed' }] };
        }
        return undefined;
      }
    );

    await detectDeadNumberOnFailure(db, { contactId: 'c1', errorMessage: '' });

    expect(sawOrder?.[0]).toBe('created_at');
  });
});

describe('applyQrCheckVerdict — a Evolution como terceira fonte (SPEC 069 D-2)', () => {
  function makeContactMock(currentStatus: string) {
    let selectDone = false;
    const updates: Record<string, unknown>[] = [];
    const updateFilters: unknown[][] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      if (hasOp(ops, 'select') && !selectDone) {
        selectDone = true;
        return { data: { whatsapp_status: currentStatus } };
      }
      const upd = opArgs(ops, 'update');
      if (upd) {
        updates.push(upd[0] as Record<string, unknown>);
        updateFilters.push(ops.filter((o) => o.fn === 'eq').map((o) => o.args));
      }
      return { data: null };
    });
    return { ...mock, updates, updateFilters };
  }

  it('IsInWhatsapp:false + status valid → marca invalid com motivo qr_check E grava proveniência', async () => {
    const { db, updates } = makeContactMock('valid');

    await applyQrCheckVerdict(db, {
      contactId: 'c1',
      channelId: 'chan-1',
      isInWhatsapp: false,
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      whatsapp_status: 'invalid',
      whatsapp_status_reason: 'qr_check',
    });
    expect(updates[1]).toMatchObject({
      whatsapp_checked_channel_id: 'chan-1',
    });
    expect(updates[1].whatsapp_checked_at).toEqual(expect.any(String));
  });

  it('IsInWhatsapp:false + status JÁ invalid → NÃO chama markWhatsappInvalid de novo, só grava proveniência (regra 1: não sobrescreve motivo)', async () => {
    const { db, updates } = makeContactMock('invalid');

    await applyQrCheckVerdict(db, {
      contactId: 'c1',
      channelId: 'chan-1',
      isInWhatsapp: false,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('whatsapp_status');
    expect(updates[0]).toMatchObject({ whatsapp_checked_channel_id: 'chan-1' });
  });

  it('IsInWhatsapp:true + status invalid (outra fonte) → regra 2: NUNCA reverte; regra 3: grava qr_check_conflict', async () => {
    const { db, updates, updateFilters } = makeContactMock('invalid');

    await applyQrCheckVerdict(db, {
      contactId: 'c1',
      channelId: 'chan-1',
      isInWhatsapp: true,
    });

    // Dois UPDATEs, não um: proveniência (incondicional) e a nota de
    // conflito (condicionada no WHERE, não numa variável lida antes —
    // ver a correção abaixo).
    expect(updates).toHaveLength(2);
    expect(updates[0]).not.toHaveProperty('whatsapp_status');
    expect(updates[0]).not.toHaveProperty('whatsapp_check_note');
    expect(updates[0]).toMatchObject({ whatsapp_checked_channel_id: 'chan-1' });
    expect(updates[1]).toEqual({ whatsapp_check_note: 'qr_check_conflict' });
    expect(updateFilters[1]).toEqual([
      ['id', 'c1'],
      ['whatsapp_status', 'invalid'],
    ]);
  });

  it('IsInWhatsapp:true + status valid → concordância, sem nota persistida, só proveniência (a corrida vira um WHERE que só casa quem estiver invalid AGORA — achado de code review)', async () => {
    const { db, updates, updateFilters } = makeContactMock('valid');

    await applyQrCheckVerdict(db, {
      contactId: 'c1',
      channelId: 'chan-1',
      isInWhatsapp: true,
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]).not.toHaveProperty('whatsapp_check_note');
    expect(updates[0]).not.toHaveProperty('whatsapp_status');
    expect(updates[0]).toMatchObject({ whatsapp_checked_channel_id: 'chan-1' });
    // O segundo UPDATE é DISPARADO (o código não sabe mais, sem ir ao
    // banco, se o contato segue `valid`), mas seu WHERE só casa
    // `whatsapp_status = 'invalid'` — num banco real ele não persiste
    // nada aqui, e é exatamente essa condição que a asserção prova.
    expect(updates[1]).toEqual({ whatsapp_check_note: 'qr_check_conflict' });
    expect(updateFilters[1]).toEqual([
      ['id', 'c1'],
      ['whatsapp_status', 'invalid'],
    ]);
  });

  it('contato não encontrado — não lança, não grava nada', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'contacts') return { data: null };
      return undefined;
    });

    await expect(
      applyQrCheckVerdict(mock.db, {
        contactId: 'c-inexistente',
        channelId: 'chan-1',
        isInWhatsapp: true,
      })
    ).resolves.toBeUndefined();
  });

  it('erro na leitura do contato — não lança', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'contacts')
        return { data: null, error: { message: 'boom' } };
      return undefined;
    });

    await expect(
      applyQrCheckVerdict(mock.db, {
        contactId: 'c1',
        channelId: 'chan-1',
        isInWhatsapp: true,
      })
    ).resolves.toBeUndefined();
  });

  it('erro no UPDATE de proveniência é logado, não lança — best-effort de verdade', async () => {
    let selectDone = false;
    const mock = createSupabaseMock((table, ops) => {
      if (table !== 'contacts') return undefined;
      if (hasOp(ops, 'select') && !selectDone) {
        selectDone = true;
        return { data: { whatsapp_status: 'valid' } };
      }
      return { data: null, error: { message: 'boom' } };
    });

    await expect(
      applyQrCheckVerdict(mock.db, {
        contactId: 'c1',
        channelId: 'chan-1',
        isInWhatsapp: true,
      })
    ).resolves.toBeUndefined();
  });
});
