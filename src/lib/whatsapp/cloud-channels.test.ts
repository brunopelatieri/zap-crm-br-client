/**
 * Credencial oficial por canal (SPEC 064 §4.5, fase F2).
 *
 * O que estes testes protegem
 *
 *   O erro que esta camada existe para evitar não quebra teste nenhum
 *   por acidente: mandar a mensagem PELO NÚMERO ERRADO entrega, grava e
 *   não loga nada. Por isso cada recusa aqui é afirmada pelo MOTIVO
 *   (canal de outra conta, de outro tipo, desativado, sem credencial), e
 *   não só por "lançou".
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import {
  countCloudChannels,
  listCloudChannels,
  resolveCloudConfig,
  resolveWabaIdForChannel,
} from './cloud-channels';

// ------------------------------------------------------------
// Supabase de mentira — filtros gravados, resposta por consulta.
// ------------------------------------------------------------

interface RecordedOp {
  table: string;
  filters: Array<[string, ...unknown[]]>;
}

interface FakeResult {
  data?: unknown;
  error?: unknown;
  count?: number;
}

/**
 * O fake responde em função dos FILTROS, não da tabela só: `channels`
 * recebe duas perguntas diferentes no mesmo caminho — a lista dos canais
 * ativos (`resolveDefaultChannelId`) e a linha de um id
 * (`resolveCloudConfig`). Responder a lista onde o código espera a linha
 * faria o teste exercitar um caminho que produção não tem.
 */
function makeDb(handlers: Record<string, (op: RecordedOp) => FakeResult>) {
  const ops: RecordedOp[] = [];

  function builder(table: string) {
    const op: RecordedOp = { table, filters: [] };
    let recorded = false;
    const settle = () => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      const handler = handlers[table];
      return handler ? handler(op) : { data: null, error: null };
    };
    const push =
      (verb: string) =>
      (...args: unknown[]) => {
        op.filters.push([verb, ...args]);
        return chain;
      };
    const chain: Record<string, unknown> = {
      select: push('select'),
      eq: push('eq'),
      neq: push('neq'),
      in: push('in'),
      order: push('order'),
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(onF, onR),
    };
    return chain;
  }

  return { client: { from: builder } as unknown as SupabaseClient, ops };
}

/** Filtro `eq` gravado numa operação, para as asserções de escopo. */
function eqValue(op: RecordedOp, key: string) {
  return op.filters.find((f) => f[0] === 'eq' && f[1] === key)?.[2];
}

function channel(over: Record<string, unknown> = {}) {
  return {
    id: 'ch-a',
    account_id: 'acct-1',
    user_id: 'user-1',
    type: 'whatsapp_cloud',
    name: 'Comercial',
    identifier: '5511988887777',
    status: 'connected',
    status_detail: null,
    is_default: true,
    connected_at: null,
    last_seen_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function config(over: Record<string, unknown> = {}) {
  return {
    id: 'cfg-a',
    account_id: 'acct-1',
    user_id: 'user-1',
    channel_id: 'ch-a',
    phone_number_id: 'pnid-a',
    waba_id: 'waba-1',
    access_token: 'cipher-a',
    status: 'connected',
    ...over,
  };
}

/**
 * Banco de uma conta com dois números oficiais (A padrão, B novo) e uma
 * instância QRCode — o cenário que a 072 tornou legal e que nenhuma
 * consulta por `account_id` sozinha sabe responder.
 */
const TWO_NUMBER_ROWS = () => [
  channel(),
  channel({
    id: 'ch-b',
    name: 'Suporte',
    identifier: '5511977776666',
    is_default: false,
    created_at: '2026-03-01T00:00:00.000Z',
  }),
  channel({
    id: 'ch-qr',
    type: 'whatsapp_qr',
    name: 'Vendas WhatsApp comum',
    is_default: true,
    created_at: '2025-06-01T00:00:00.000Z',
  }),
];

/** Resposta de `channels` do cenário de dois números (a consulta de escopo). */
function channelsAnswer(op: RecordedOp): FakeResult {
  const rows = TWO_NUMBER_ROWS();
  const id = eqValue(op, 'id');
  const account = eqValue(op, 'account_id');
  const scoped = rows.filter((r) => r.account_id === account);
  if (id !== undefined) {
    return { data: scoped.find((r) => r.id === id) ?? null, error: null };
  }
  const type = eqValue(op, 'type');
  const list = type ? scoped.filter((r) => r.type === type) : scoped;
  return { data: list, error: null, count: list.length };
}

function twoNumberAccount() {
  const rows = TWO_NUMBER_ROWS();
  const configs = [
    config(),
    config({
      id: 'cfg-b',
      channel_id: 'ch-b',
      phone_number_id: 'pnid-b',
      waba_id: 'waba-2',
      access_token: 'cipher-b',
    }),
  ];

  return makeDb({
    channels: (op) => {
      const id = eqValue(op, 'id');
      const account = eqValue(op, 'account_id');
      const scoped = rows.filter((r) => r.account_id === account);
      if (id !== undefined) {
        return { data: scoped.find((r) => r.id === id) ?? null, error: null };
      }
      const type = eqValue(op, 'type');
      const list = type ? scoped.filter((r) => r.type === type) : scoped;
      const inFilter = op.filters.find((f) => f[0] === 'in' && f[1] === 'type');
      const byIn = inFilter
        ? list.filter((r) => (inFilter[2] as string[]).includes(r.type))
        : list;
      const active = op.filters.some(
        (f) => f[0] === 'neq' && f[1] === 'status' && f[2] === 'disabled'
      )
        ? byIn.filter((r) => r.status !== 'disabled')
        : byIn;
      return { data: active, error: null, count: active.length };
    },
    whatsapp_config: (op) => {
      const account = eqValue(op, 'account_id');
      const channelId = eqValue(op, 'channel_id');
      const scoped = configs.filter((c) => c.account_id === account);
      if (channelId !== undefined) {
        return {
          data: scoped.find((c) => c.channel_id === channelId) ?? null,
          error: null,
        };
      }
      const inFilter = op.filters.find(
        (f) => f[0] === 'in' && f[1] === 'channel_id'
      );
      return {
        data: inFilter
          ? scoped.filter((c) =>
              (inFilter[2] as string[]).includes(c.channel_id)
            )
          : scoped,
        error: null,
      };
    },
  });
}

describe('resolveCloudConfig — a regra do D-7', () => {
  it('sem channelId, resolve o canal Cloud PADRÃO (não o QR padrão)', async () => {
    // D-11: a conta prefere o oficial, e o `is_default` do QRCode não
    // participa. Antes da 072 os dois disputavam a mesma vaga única.
    const db = twoNumberAccount();

    const { channel: resolved, config: row } = await resolveCloudConfig(
      db.client,
      'acct-1',
      undefined,
      db.client
    );

    expect(resolved.id).toBe('ch-a');
    expect(row.phone_number_id).toBe('pnid-a');
  });

  it('com channelId, resolve AQUELE número — não o padrão', async () => {
    // O teste que separa "funciona" de "funciona por acaso": ch-b não é
    // o padrão, e a credencial devolvida tem de ser a dele.
    const db = twoNumberAccount();

    const { channel: resolved, config: row } = await resolveCloudConfig(
      db.client,
      'acct-1',
      'ch-b',
      db.client
    );

    expect(resolved.id).toBe('ch-b');
    expect(row.phone_number_id).toBe('pnid-b');
    expect(row.access_token).toBe('cipher-b');
  });

  it('channelId de OUTRA conta é erro, nunca leitura', async () => {
    const db = twoNumberAccount();

    await expect(
      resolveCloudConfig(db.client, 'acct-2', 'ch-a')
    ).rejects.toThrow(/does not exist in account acct-2/);

    // O escopo tem de estar na consulta, não numa comparação depois: é
    // o que vale mesmo com `service_role`, que ignora RLS.
    const read = db.ops.find((o) => o.table === 'channels')!;
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-2']);
  });

  it('canal de outro TIPO é recusado com o motivo', async () => {
    // Um `channel_id` de instância QRCode chegando ao caminho Cloud
    // significa roteamento errado em algum lugar; devolver a credencial
    // oficial disfarçaria o bug.
    const db = twoNumberAccount();

    await expect(
      resolveCloudConfig(db.client, 'acct-1', 'ch-qr')
    ).rejects.toThrow(/is of type "whatsapp_qr"/);
  });

  it('canal desativado não chega nem a ler a credencial (D-12)', async () => {
    const db = makeDb({
      channels: () => ({
        data: channel({ status: 'disabled' }),
        error: null,
      }),
      whatsapp_config: () => ({ data: config(), error: null }),
    });

    await expect(
      resolveCloudConfig(db.client, 'acct-1', 'ch-a')
    ).rejects.toThrow(/is disabled/);
    // "Desativar" grava `access_token = ''` (NOT NULL desde a 001). Se a
    // leitura acontecesse, o `decrypt()` de `send.ts` estouraria com um
    // erro de criptografia que não explica nada ao operador.
    expect(db.ops.some((o) => o.table === 'whatsapp_config')).toBe(false);
  });

  it('canal órfão (criação em duas escritas que falhou) é erro nomeado', async () => {
    const db = makeDb({
      channels: () => ({ data: channel(), error: null }),
      whatsapp_config: () => ({ data: null, error: null }),
    });

    await expect(
      resolveCloudConfig(db.client, 'acct-1', 'ch-a', db.client)
    ).rejects.toThrow(/has no WhatsApp credentials/);
  });

  it('token vazio é recusado antes do decrypt', async () => {
    // O canal ficou `connected` mas o segredo foi zerado (o reparo de
    // ENCRYPTION_KEY do "Reset Configuration", D-12 consequência 3).
    const db = makeDb({
      channels: () => ({ data: channel(), error: null }),
      whatsapp_config: () => ({
        data: config({ access_token: '' }),
        error: null,
      }),
    });

    await expect(
      resolveCloudConfig(db.client, 'acct-1', 'ch-a', db.client)
    ).rejects.toThrow(/has no access token/);
  });

  it('conta sem canal Cloud lança ChannelNotConfiguredError', async () => {
    const db = makeDb({
      channels: () => ({ data: [], error: null }),
    });

    await expect(
      resolveCloudConfig(db.client, 'acct-1')
    ).rejects.toBeInstanceOf(ChannelNotConfiguredError);
  });

  it('erro de leitura não vira "conta sem canal"', async () => {
    const db = makeDb({
      channels: (op) =>
        eqValue(op, 'id') !== undefined
          ? { data: null, error: { message: 'PGRST301' } }
          : { data: [channel()], error: null },
    });

    await expect(
      resolveCloudConfig(db.client, 'acct-1', 'ch-a')
    ).rejects.toThrow(/PGRST301/);
  });

  it('dois canais e nenhum padrão marcado: escolha DETERMINÍSTICA, nunca sorteio', async () => {
    // A SPEC pede "não sorteio". A 072 vai além: as triggers
    // `claim_default_on_insert/reactivate` e a reeleição ao desativar
    // garantem que todo tipo com canal ativo tenha um padrão, então
    // este estado só existe se alguém escreveu `is_default` por fora.
    // Nesse caso `resolveDefaultChannelId` usa o MAIS ANTIGO — o mesmo
    // critério do backfill —, e não o primeiro que o PostgREST devolver.
    const novo = channel({ id: 'ch-novo', is_default: false });
    const antigo = channel({
      id: 'ch-antigo',
      is_default: false,
      created_at: '2025-01-01T00:00:00.000Z',
    });
    const db = makeDb({
      channels: (op) => {
        const id = eqValue(op, 'id');
        if (id !== undefined) {
          return {
            data: [novo, antigo].find((c) => c.id === id) ?? null,
            error: null,
          };
        }
        return { data: [novo, antigo], error: null };
      },
      whatsapp_config: () => ({
        data: config({ channel_id: 'ch-antigo' }),
        error: null,
      }),
    });

    const { channel: resolved } = await resolveCloudConfig(
      db.client,
      'acct-1',
      undefined,
      db.client
    );
    expect(resolved.id).toBe('ch-antigo');
  });
});

describe('resolveCloudConfig — credencial só por service role (P-15, migração 112)', () => {
  it('lê a linha de credencial pelo cliente de service role, não pelo da sessão', async () => {
    const admin = twoNumberAccount();
    // A sessão só responde `channels` (escopo); `whatsapp_config` dela
    // devolveria 42501 — se o código ainda a usasse, o teste falharia.
    const session = makeDb({
      channels: channelsAnswer,
      whatsapp_config: () => ({
        data: null,
        error: { code: '42501', message: 'permission denied' },
      }),
    });

    const { config: row } = await resolveCloudConfig(
      session.client,
      'acct-1',
      'ch-b',
      admin.client
    );

    expect(row.access_token).toBe('cipher-b');
    expect(session.ops.some((o) => o.table === 'whatsapp_config')).toBe(false);
    expect(admin.ops.some((o) => o.table === 'whatsapp_config')).toBe(true);
  });

  it('a leitura da credencial casa channel_id E account_id e nomeia as colunas (sem *)', async () => {
    const admin = twoNumberAccount();
    const session = makeDb({ channels: channelsAnswer });

    await resolveCloudConfig(session.client, 'acct-1', 'ch-a', admin.client);

    const read = admin.ops.find((o) => o.table === 'whatsapp_config')!;
    expect(read.filters).toContainEqual(['eq', 'channel_id', 'ch-a']);
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    const select = read.filters.find((f) => f[0] === 'select')![1] as string;
    expect(select).not.toBe('*');
    expect(select).not.toContain('*');
    // Os três segredos estão na lista (é o caminho de envio que precisa deles).
    expect(select).toContain('access_token');
    expect(select).toContain('app_secret');
    expect(select).toContain('verify_token');
    // Toda coluna que o código de envio usa continua na lista.
    for (const col of [
      'id',
      'account_id',
      'channel_id',
      'phone_number_id',
      'waba_id',
      'user_id',
    ]) {
      expect(select.split(', ')).toContain(col);
    }
  });

  it('canal de OUTRA conta nunca chega ao cliente de service role', async () => {
    // A sessão (RLS) não enxerga o canal da conta 1 sob a conta 2: erro na
    // consulta de `channels`, e a credencial nem é pedida.
    const admin = twoNumberAccount();
    const session = makeDb({
      channels: (op) => {
        const account = eqValue(op, 'account_id');
        return account === 'acct-1'
          ? channelsAnswer(op)
          : { data: null, error: null };
      },
    });

    await expect(
      resolveCloudConfig(session.client, 'acct-2', 'ch-a', admin.client)
    ).rejects.toThrow(/does not exist in account acct-2/);
    expect(admin.ops.some((o) => o.table === 'whatsapp_config')).toBe(false);
  });

  it('a credencial de uma conta não é devolvida para outra conta (filtro por account_id)', async () => {
    // Mesmo que a camada de escopo falhasse (sessão que enxerga o canal),
    // o service role só devolve a linha se `account_id` também casar.
    const admin = twoNumberAccount();
    const session = makeDb({
      channels: () => ({ data: channel(), error: null }),
    });

    await expect(
      // acct-2 pedindo o ch-a (que é da acct-1): a sessão "deixou passar".
      resolveCloudConfig(session.client, 'acct-2', 'ch-a', admin.client)
    ).rejects.toThrow(/has no WhatsApp credentials/);
    const read = admin.ops.find((o) => o.table === 'whatsapp_config')!;
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-2']);
  });
});

describe('listCloudChannels', () => {
  it('devolve do padrão para o mais novo, com o WABA de cada número', async () => {
    const db = twoNumberAccount();

    const list = await listCloudChannels(db.client, 'acct-1');

    expect(list.map((c) => c.channelId)).toEqual(['ch-a', 'ch-b']);
    expect(list.map((c) => c.phoneNumberId)).toEqual(['pnid-a', 'pnid-b']);
    expect(list.map((c) => c.wabaId)).toEqual(['waba-1', 'waba-2']);
    // O QRCode não é número oficial e não entra na lista.
    expect(list.some((c) => c.channelId === 'ch-qr')).toBe(false);
  });

  it('não seleciona segredo nenhum — a lista é servida à interface', async () => {
    const db = twoNumberAccount();

    await listCloudChannels(db.client, 'acct-1');

    const columns = db.ops
      .flatMap((o) => o.filters)
      .filter((f) => f[0] === 'select')
      .map((f) => String(f[1]))
      .join(' ');
    expect(columns).not.toContain('access_token');
    expect(columns).not.toContain('verify_token');
    expect(columns).not.toContain('*');
  });

  it('exclui canal desativado', async () => {
    const db = twoNumberAccount();

    await listCloudChannels(db.client, 'acct-1');

    const read = db.ops.find((o) => o.table === 'channels')!;
    expect(read.filters).toContainEqual(['neq', 'status', 'disabled']);
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
  });

  it('canal órfão aparece com phoneNumberId nulo, não some da lista', async () => {
    // Some seria pior: ele ocupa vaga de quota, e o operador ficaria
    // sem explicação para o número que "não existe" mas conta.
    const db = makeDb({
      channels: () => ({ data: [channel({ id: 'ch-orfao' })], error: null }),
      whatsapp_config: () => ({ data: [], error: null }),
    });

    const list = await listCloudChannels(db.client, 'acct-1');

    expect(list).toHaveLength(1);
    expect(list[0].phoneNumberId).toBeNull();
    expect(list[0].wabaId).toBeNull();
  });

  it('conta sem número oficial devolve lista vazia, sem consultar credencial', async () => {
    const db = makeDb({ channels: () => ({ data: [], error: null }) });

    await expect(listCloudChannels(db.client, 'acct-1')).resolves.toEqual([]);
    expect(db.ops.some((o) => o.table === 'whatsapp_config')).toBe(false);
  });

  it('erro de leitura não vira lista vazia', async () => {
    const db = makeDb({
      channels: () => ({ data: null, error: { message: 'timeout' } }),
    });

    await expect(listCloudChannels(db.client, 'acct-1')).rejects.toThrow(
      /timeout/
    );
  });
});

describe('countCloudChannels', () => {
  it('conta só os ativos do tipo Cloud, no escopo da conta', async () => {
    const db = twoNumberAccount();

    await expect(countCloudChannels(db.client, 'acct-1')).resolves.toBe(2);

    const read = db.ops.find((o) => o.table === 'channels')!;
    expect(read.filters).toContainEqual(['eq', 'type', 'whatsapp_cloud']);
    expect(read.filters).toContainEqual(['neq', 'status', 'disabled']);
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
  });

  it('erro de contagem não vira zero', async () => {
    // Zero silencioso liberaria um número além da quota do plano.
    const db = makeDb({
      channels: () => ({ count: undefined, error: { message: 'boom' } }),
    });

    await expect(countCloudChannels(db.client, 'acct-1')).rejects.toThrow(
      /boom/
    );
  });
});

// Achado de code review (SPEC 064 D-2): chamadores best-effort (ex.:
// `hydrateBroadcastReply`) precisam do `waba_id` de um canal já
// conhecido sem que uma falha vire exceção — ao contrário de
// `resolveCloudConfig`, que existe justamente para lançar.
describe('resolveWabaIdForChannel', () => {
  it('devolve o waba_id da linha de whatsapp_config do canal', async () => {
    const db = makeDb({
      whatsapp_config: (op) => {
        expect(eqValue(op, 'channel_id')).toBe('ch-b');
        expect(eqValue(op, 'account_id')).toBe('acct-1');
        return { data: { waba_id: 'waba-2' }, error: null };
      },
    });

    await expect(
      resolveWabaIdForChannel(db.client, 'acct-1', 'ch-b')
    ).resolves.toBe('waba-2');
  });

  it('devolve null (sem lançar) quando o canal não tem config', async () => {
    const db = makeDb({
      whatsapp_config: () => ({ data: null, error: null }),
    });

    await expect(
      resolveWabaIdForChannel(db.client, 'acct-1', 'ch-orfao')
    ).resolves.toBeNull();
  });

  it('loga e degrada para null (sem lançar) numa falha transitória de leitura', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb({
      whatsapp_config: () => ({
        data: null,
        error: { message: 'connection reset' },
      }),
    });

    await expect(
      resolveWabaIdForChannel(db.client, 'acct-1', 'ch-b')
    ).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});
