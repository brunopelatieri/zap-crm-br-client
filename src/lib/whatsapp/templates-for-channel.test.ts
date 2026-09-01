import { describe, it, expect, vi } from 'vitest';

import {
  createSupabaseMock,
  type MockResult,
  type QueryOp,
} from '@/lib/audience/supabase-mock';
import type { MessageTemplate } from '@/types';
import { templatesForChannel, wabaIdOfChannel } from './templates-for-channel';

const ACCOUNT = 'acct-1';

function tpl(over: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: 't',
    user_id: 'u',
    account_id: ACCOUNT,
    name: 'promo',
    category: 'Marketing',
    body_text: 'oi',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  } as MessageTemplate;
}

const fromA = tpl({ id: 't-a', waba_id: 'waba-a' });
const fromB = tpl({ id: 't-b', waba_id: 'waba-b' });
const legacy = tpl({ id: 't-legacy', waba_id: null });
const noKey = tpl({ id: 't-nokey' }); // linha anterior à 072, sem a coluna

describe('templatesForChannel (SPEC 065 §5.2)', () => {
  it('mantém os do WABA pedido e os legados, e descarta os do outro WABA', () => {
    const out = templatesForChannel([fromA, fromB, legacy, noKey], 'waba-a');

    expect(out.map((t) => t.id)).toEqual(['t-a', 't-legacy', 't-nokey']);
  });

  it('WABA nulo (canal Cloud anterior à 072) deixa só os legados', () => {
    const out = templatesForChannel([fromA, fromB, legacy], null);

    expect(out.map((t) => t.id)).toEqual(['t-legacy']);
  });

  // Falha ABERTA — é o comportamento que `template-picker.tsx:170-190`
  // documenta como achado de code review: sem saber o WABA (nenhum canal
  // escolhido, canal sem linha de config, erro de leitura), reduzir a
  // lista aos legados é pior do que mostrar tudo. `undefined` é
  // exatamente "não sei", e não se confunde com `null` ("sei, e é nulo").
  it('WABA desconhecido (`undefined`) devolve a lista INTEIRA, sem filtrar', () => {
    const all = [fromA, fromB, legacy];

    expect(templatesForChannel(all, undefined).map((t) => t.id)).toEqual([
      't-a',
      't-b',
      't-legacy',
    ]);
  });

  it('não muta o array recebido', () => {
    const all = [fromA, fromB];
    templatesForChannel(all, 'waba-a');
    expect(all.map((t) => t.id)).toEqual(['t-a', 't-b']);
  });
});

function makeDb(
  handler: (table: string, ops: QueryOp[]) => MockResult | undefined
) {
  return createSupabaseMock(handler);
}

describe('wabaIdOfChannel (SPEC 065 §5.2)', () => {
  it('devolve o waba_id gravado para o canal', async () => {
    const { db } = makeDb((table) =>
      table === 'whatsapp_config' ? { data: { waba_id: 'waba-a' } } : undefined
    );

    await expect(wabaIdOfChannel(db, ACCOUNT, 'ch-1')).resolves.toBe('waba-a');
  });

  it('devolve `null` quando a linha existe mas o WABA não foi gravado', async () => {
    const { db } = makeDb((table) =>
      table === 'whatsapp_config' ? { data: { waba_id: null } } : undefined
    );

    await expect(wabaIdOfChannel(db, ACCOUNT, 'ch-1')).resolves.toBeNull();
  });

  // Canal de OUTRA conta: a consulta casa `account_id` junto do
  // `channel_id`, então a linha simplesmente não existe para esta conta
  // — e "não existe" tem de virar "não sei" (`undefined`), nunca "o WABA
  // é nulo", que estreitaria a lista de templates aos legados.
  it('canal de outra conta vira `undefined` (não vaza, não vira `null`)', async () => {
    // A linha existe no banco, mas pertence a `acct-2`. O mock só a
    // devolve quando a cadeia casa AS DUAS chaves — é o `account_id` na
    // consulta que faz o resultado ser vazio, e não sorte.
    const ROW = {
      account_id: 'acct-2',
      channel_id: 'ch-de-outra-conta',
      waba_id: 'waba-secreto',
    };
    const { db, callsFor } = makeDb((table, ops) => {
      if (table !== 'whatsapp_config') return undefined;
      const eqs = ops
        .filter((o) => o.fn === 'eq')
        .map((o) => o.args as [string, unknown]);
      const wanted = Object.fromEntries(eqs);
      const match =
        wanted.account_id === ROW.account_id &&
        wanted.channel_id === ROW.channel_id;
      return { data: match ? { waba_id: ROW.waba_id } : null };
    });

    await expect(
      wabaIdOfChannel(db, ACCOUNT, 'ch-de-outra-conta')
    ).resolves.toBeUndefined();

    const chain = callsFor('whatsapp_config')[0];
    const eqs = chain.ops.filter((o) => o.fn === 'eq').map((o) => o.args);
    expect(eqs).toContainEqual(['account_id', ACCOUNT]);
    expect(eqs).toContainEqual(['channel_id', 'ch-de-outra-conta']);
  });

  it('canal sem `channel_id` resolvido devolve `undefined` sem consultar', async () => {
    const { db, calls } = makeDb(() => undefined);

    await expect(wabaIdOfChannel(db, ACCOUNT, null)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('erro de leitura degrada para `undefined` e loga — nunca estreita a lista', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb((table) =>
      table === 'whatsapp_config'
        ? { data: null, error: { message: 'connection reset' } }
        : undefined
    );

    await expect(wabaIdOfChannel(db, ACCOUNT, 'ch-1')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
