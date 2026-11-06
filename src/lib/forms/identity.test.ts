import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveIdentity } from './identity';
import { FORM_LINK_SECRET_ENV, signFormLink } from './link-token';
import {
  ACCOUNT_ID,
  CONTACT_ID,
  fakeDb,
  FORM_ID,
  USER_ID,
} from './test-fixtures';

const SECRET = 'segredo-de-teste-com-mais-de-trinta-e-dois-bytes-ok';
const base = {
  formId: FORM_ID,
  accountId: ACCOUNT_ID,
  auditUserId: USER_ID,
  brMode: true,
};

const asDb = (db: ReturnType<typeof fakeDb>) =>
  db as unknown as Pick<SupabaseClient, 'from'>;

describe('resolveIdentity (PRD 084 D-2/D-3)', () => {
  beforeEach(() => {
    process.env[FORM_LINK_SECRET_ENV] = SECRET;
  });
  afterEach(() => {
    delete process.env[FORM_LINK_SECRET_ENV];
  });

  it('token válido resolve o contato do token, sem olhar telefone', async () => {
    const token = signFormLink({
      formId: FORM_ID,
      contactId: CONTACT_ID,
      source: 'inbox',
    })!;
    const db = fakeDb({ contacts: [{ data: { id: CONTACT_ID } }] });
    const r = await resolveIdentity(asDb(db), {
      ...base,
      token,
      phone: 'lixo',
    });
    expect(r).toEqual({
      ok: true,
      contactId: CONTACT_ID,
      created: false,
      mode: 'token',
      source: 'inbox',
      phone: null,
    });
    // A busca do contato é restrita à conta do formulário.
    const eqs = db.callsTo('contacts', 'eq').map((c) => c.args);
    expect(eqs).toContainEqual(['account_id', ACCOUNT_ID]);
    expect(db.callsTo('contacts', 'insert')).toHaveLength(0);
  });

  it('token de contato apagado cai para o telefone; sem telefone → contact_not_found', async () => {
    const token = signFormLink({
      formId: FORM_ID,
      contactId: CONTACT_ID,
      source: 'inbox',
    })!;
    const db = fakeDb({ contacts: [{ data: null }] });
    expect(await resolveIdentity(asDb(db), { ...base, token })).toEqual({
      ok: false,
      reason: 'contact_not_found',
    });
  });

  it('sem token e sem telefone → missing_identity; telefone inválido → invalid_phone', async () => {
    expect(await resolveIdentity(asDb(fakeDb()), { ...base })).toEqual({
      ok: false,
      reason: 'missing_identity',
    });
    expect(
      await resolveIdentity(asDb(fakeDb()), {
        ...base,
        token: 'invalido',
        phone: '12',
      })
    ).toEqual({ ok: false, reason: 'invalid_phone' });
  });

  it('telefone conhecido na conta reaproveita o contato', async () => {
    const db = fakeDb({ contacts: [{ data: { id: CONTACT_ID } }] });
    const r = await resolveIdentity(asDb(db), {
      ...base,
      phone: '(11) 99999-9999',
    });
    expect(r).toMatchObject({
      ok: true,
      contactId: CONTACT_ID,
      created: false,
      mode: 'phone',
    });
    expect(db.callsTo('contacts', 'eq').map((c) => c.args)).toContainEqual([
      'phone_normalized',
      '5511999999999',
    ]);
  });

  it('telefone novo cria contato com created_via=form, nome vazio e o user de auditoria', async () => {
    const db = fakeDb({
      contacts: [{ data: null }, { data: { id: 'novo' } }],
    });
    const r = await resolveIdentity(asDb(db), {
      ...base,
      phone: '11999999999',
    });
    expect(r).toMatchObject({
      ok: true,
      contactId: 'novo',
      created: true,
      phone: '5511999999999',
    });
    const [insert] = db.callsTo('contacts', 'insert');
    expect(insert.args[0]).toEqual({
      account_id: ACCOUNT_ID,
      user_id: USER_ID,
      phone: '5511999999999',
      name: null,
      created_via: 'form',
    });
  });

  it('corrida (23505) relê e devolve o vencedor; quota de contatos vira contacts_quota', async () => {
    const raced = fakeDb({
      contacts: [
        { data: null },
        { data: null, error: { code: '23505', message: 'duplicate key' } },
        { data: { id: 'vencedor' } },
      ],
    });
    expect(
      await resolveIdentity(asDb(raced), { ...base, phone: '11999999999' })
    ).toMatchObject({ ok: true, contactId: 'vencedor', created: false });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const quota = fakeDb({
      contacts: [
        { data: null },
        {
          data: null,
          error: { code: 'P0001', message: 'QUOTA_EXCEEDED:contacts:10:10' },
        },
      ],
    });
    expect(
      await resolveIdentity(asDb(quota), { ...base, phone: '11999999999' })
    ).toEqual({ ok: false, reason: 'contacts_quota' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('origem do token sobrevive à queda para telefone (achado da revisão)', () => {
  it('contato do token apagado + telefone informado → mode phone, source do token', async () => {
    process.env[FORM_LINK_SECRET_ENV] = SECRET;
    const token = signFormLink({
      formId: FORM_ID,
      contactId: CONTACT_ID,
      source: 'broadcast',
    })!;
    const db = fakeDb({
      contacts: [{ data: null }, { data: { id: 'por-telefone' } }],
    });
    const r = await resolveIdentity(asDb(db), {
      ...base,
      token,
      phone: '11999999999',
    });
    expect(r).toMatchObject({
      ok: true,
      contactId: 'por-telefone',
      mode: 'phone',
      source: 'broadcast',
    });
  });
});
