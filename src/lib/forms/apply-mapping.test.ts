import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { applyMappings, selectedOptionIds } from './apply-mapping';
import {
  ACCOUNT_ID,
  CONTACT_ID,
  CUSTOM_FIELD_ID,
  fakeDb,
  makeField,
  TAG_ID,
} from './test-fixtures';

const asDb = (db: ReturnType<typeof fakeDb>) =>
  db as unknown as Pick<SupabaseClient, 'from' | 'rpc'>;

const nameField = (overwrite?: boolean) =>
  makeField({
    key: 'name',
    type: 'short_text',
    mapping: { target: 'contact.name', overwrite },
  });

describe('applyMappings (PRD 084 D-4)', () => {
  it('contact.name preenche se vazio e não sobrescreve sem a opção', async () => {
    const empty = fakeDb({
      contacts: [{ data: { name: null, email: null, company: null } }, {}],
    });
    const r1 = await applyMappings(asDb(empty), {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      fields: [nameField()],
      answers: { name: 'Ana' },
    });
    expect(r1).toEqual({ applied: ['name'], warnings: [] });
    expect(empty.callsTo('contacts', 'update')[0].args[0]).toEqual({
      name: 'Ana',
    });

    const filled = fakeDb({
      contacts: [{ data: { name: 'Já tinha', email: null, company: null } }],
    });
    const r2 = await applyMappings(asDb(filled), {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      fields: [nameField()],
      answers: { name: 'Ana' },
    });
    expect(r2).toEqual({ applied: [], warnings: [] });
    expect(filled.callsTo('contacts', 'update')).toHaveLength(0);
  });

  it('overwrite por bloco sobrescreve', async () => {
    const db = fakeDb({
      contacts: [{ data: { name: 'Velho', email: null, company: null } }, {}],
    });
    const r = await applyMappings(asDb(db), {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      fields: [nameField(true)],
      answers: { name: 'Novo' },
    });
    expect(r.applied).toEqual(['name']);
    expect(db.callsTo('contacts', 'update')[0].args[0]).toEqual({
      name: 'Novo',
    });
  });

  it('custom:<id> faz upsert por (contact_id, custom_field_id) só para campo da conta', async () => {
    const known = makeField({
      key: 'cf',
      type: 'short_text',
      mapping: { target: `custom:${CUSTOM_FIELD_ID}` },
    });
    const unknown = makeField({
      key: 'cf2',
      type: 'number',
      mapping: { target: 'custom:99999999-9999-4999-8999-999999999999' },
    });
    const db = fakeDb({
      custom_fields: [{ data: [{ id: CUSTOM_FIELD_ID }] }],
      contact_custom_values: [{}],
    });
    const r = await applyMappings(asDb(db), {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      fields: [known, unknown],
      answers: { cf: 'valor', cf2: 7 },
    });
    expect(r.applied).toEqual(['cf']);
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'custom_field_not_found', key: 'cf2' }),
    ]);
    const [upsert] = db.callsTo('contact_custom_values', 'upsert');
    expect(upsert.args).toEqual([
      [
        {
          contact_id: CONTACT_ID,
          custom_field_id: CUSTOM_FIELD_ID,
          value: 'valor',
        },
      ],
      { onConflict: 'contact_id,custom_field_id' },
    ]);
    expect(db.callsTo('contact_custom_values', 'delete')).toHaveLength(0);
  });

  it('tag por opção é aditiva (upsert ignorando duplicata) e ignora etiqueta de outra conta', async () => {
    const field = makeField({
      key: 'tg',
      type: 'multi_select',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      mapping: { target: 'tag', tag_by_option: { a: TAG_ID, b: 'tag-alheia' } },
    });
    const db = fakeDb({
      tags: [{ data: [{ id: TAG_ID }] }],
      contact_tags: [{}],
    });
    const r = await applyMappings(asDb(db), {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      fields: [field],
      answers: { tg: ['a', 'b'] },
    });
    expect(r.applied).toEqual(['tg']);
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'tag_not_found', detail: 'tag-alheia' }),
    ]);
    const [upsert] = db.callsTo('contact_tags', 'upsert');
    expect(upsert.args).toEqual([
      [{ contact_id: CONTACT_ID, tag_id: TAG_ID }],
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
    ]);
    expect(db.callsTo('contact_tags', 'delete')).toHaveLength(0);
  });

  it('contact.opt_in chama set_contact_opt_in com source form, e só quando marcado', async () => {
    const consent = makeField({
      key: 'ok',
      type: 'consent',
      required: true,
      mapping: { target: 'contact.opt_in' },
    });
    const db = fakeDb();
    const r = await applyMappings(asDb(db), {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      fields: [consent],
      answers: { ok: true },
    });
    expect(r.applied).toEqual(['ok']);
    expect(db.rpc).toHaveBeenCalledWith('set_contact_opt_in', {
      p_contact_id: CONTACT_ID,
      p_status: 'opted_in',
      p_source: 'form',
    });

    const db2 = fakeDb();
    await applyMappings(asDb(db2), {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      fields: [consent],
      answers: { ok: false },
    });
    expect(db2.rpc).not.toHaveBeenCalled();
  });

  it('erro do banco vira aviso, nunca exceção', async () => {
    const db = fakeDb({
      contacts: [{ data: null, error: { message: 'down' } }],
    });
    const r = await applyMappings(asDb(db), {
      accountId: ACCOUNT_ID,
      contactId: CONTACT_ID,
      fields: [nameField()],
      answers: { name: 'Ana' },
    });
    expect(r.applied).toEqual([]);
    expect(r.warnings).toEqual([
      { code: 'contact_update_failed', key: 'name', detail: 'down' },
    ]);
  });

  it('selectedOptionIds normaliza sim/não para yes/no', () => {
    expect(selectedOptionIds({ type: 'yes_no' }, true)).toEqual(['yes']);
    expect(selectedOptionIds({ type: 'yes_no' }, 'no')).toEqual(['no']);
    expect(selectedOptionIds({ type: 'multi_select' }, ['a', 1])).toEqual([
      'a',
    ]);
    expect(selectedOptionIds({ type: 'short_text' }, 'a')).toEqual([]);
  });
});
