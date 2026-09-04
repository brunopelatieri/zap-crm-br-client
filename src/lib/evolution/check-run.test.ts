import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { EvolutionApiError } from './client';

vi.mock('@/lib/contacts/whatsapp-status', () => ({
  applyQrCheckVerdict: vi.fn().mockResolvedValue(undefined),
}));

const checkWhatsappUsers = vi.fn();
const fetchWhatsappAvatar = vi.fn();
vi.mock('./user', async () => {
  const actual = await vi.importActual<typeof import('./user')>('./user');
  return {
    ...actual,
    checkWhatsappUsers: (...args: unknown[]) => checkWhatsappUsers(...args),
    fetchWhatsappAvatar: (...args: unknown[]) => fetchWhatsappAvatar(...args),
  };
});

import { applyQrCheckVerdict } from '@/lib/contacts/whatsapp-status';
import {
  runCheckBatch,
  type CheckRunItem,
  type CheckRunParams,
} from './check-run';

const config = {
  apiUrl: 'https://evo.example.com',
  globalApiKey: 'global',
  maxInstancesPerAccount: 3,
  maxInstancesTotal: 20,
  instancePrefix: 'zapcrm',
  webhookPublicUrl: null,
  requestTimeoutMs: 15_000,
  mediaRequestTimeoutMs: 60_000,
};

/**
 * Fake DB propositalmente simples: registra toda operação por tabela e
 * verbo, e devolve o que o teste configurar. `contact_check_queue`
 * distingue "claim" (update+eq+eq+select+maybeSingle) de "revert"/
 * "markDone" (update+eq, sem select) pela presença de `.select()` na
 * cadeia.
 */
function makeDb(opts: {
  claimResults?: Array<{ data: unknown } | undefined>;
  attemptsOnRevert?: number;
  storageUploadError?: { message: string } | null;
  contactsUpdateError?: { message: string } | null;
}) {
  const ops: Array<{ table: string; verb: string; payload?: unknown }> = [];
  let claimCallIndex = 0;

  function contactCheckQueue() {
    const chain: Record<string, unknown> = {};
    let hasSelect = false;
    let updatePayload: Record<string, unknown> | undefined;

    chain.update = (p: Record<string, unknown>) => {
      updatePayload = p;
      return chain;
    };
    chain.eq = () => chain;
    chain.select = () => {
      hasSelect = true;
      return chain;
    };
    chain.maybeSingle = () => {
      if (hasSelect && updatePayload?.status === 'in_progress') {
        // Chamada de CLAIM.
        const result = opts.claimResults?.[claimCallIndex] ?? {
          data: { id: 'x' },
        };
        claimCallIndex++;
        ops.push({
          table: 'contact_check_queue',
          verb: 'claim',
          payload: updatePayload,
        });
        return Promise.resolve(result);
      }
      // SELECT de attempts (dentro de revertClaim).
      ops.push({ table: 'contact_check_queue', verb: 'select-attempts' });
      return Promise.resolve({
        data: { attempts: opts.attemptsOnRevert ?? 0 },
      });
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      // UPDATE sem .select() — markDone ou o segundo update de revertClaim.
      ops.push({
        table: 'contact_check_queue',
        verb: 'update',
        payload: updatePayload,
      });
      return Promise.resolve({ error: null }).then(resolve);
    };
    return chain;
  }

  function channelColdSends() {
    return {
      insert: (payload: unknown) => {
        ops.push({ table: 'channel_cold_sends', verb: 'insert', payload });
        return Promise.resolve({ error: null });
      },
    };
  }

  function contacts() {
    const chain: Record<string, unknown> = {};
    let updatePayload: unknown;
    chain.update = (p: unknown) => {
      updatePayload = p;
      return chain;
    };
    chain.eq = () => {
      ops.push({ table: 'contacts', verb: 'update', payload: updatePayload });
      return Promise.resolve({
        error: opts.contactsUpdateError ?? null,
      });
    };
    return chain;
  }

  const db = {
    from: (table: string) => {
      if (table === 'contact_check_queue') return contactCheckQueue();
      if (table === 'channel_cold_sends') return channelColdSends();
      if (table === 'contacts') return contacts();
      throw new Error(`tabela não esperada no fake db: ${table}`);
    },
    storage: {
      from: () => ({
        upload: (path: string) => {
          ops.push({ table: 'storage', verb: 'upload', payload: path });
          return Promise.resolve({ error: opts.storageUploadError ?? null });
        },
      }),
    },
  } as unknown as SupabaseClient;

  return { db, ops };
}

function item(over: Partial<CheckRunItem> = {}): CheckRunItem {
  return {
    queueItemId: 'q1',
    contactId: 'c1',
    phoneNormalized: '5511900000001',
    avatarFetchedAt: null,
    ...over,
  };
}

function baseParams(over: Partial<CheckRunParams> = {}): CheckRunParams {
  return {
    items: [item()],
    accountId: 'acct-1',
    channelId: 'chan-1',
    instanceToken: 'tok',
    minIntervalSeconds: 5,
    infoAvatarTimeoutMs: 20_000,
    avatarTtlDays: 30,
    avatarMaxBytes: 1_048_576,
    // Bem no futuro, de propósito: os testes que NÃO exercitam o corte
    // por deadline usam `defaultDeps.now = () => new Date()` (relógio
    // real), e um deadline fixo próximo ao "hoje" da escrita deste
    // arquivo viraria passado — e todo item pararia de ser processado
    // — assim que tempo real suficiente passasse na sessão.
    deadline: new Date('2099-01-01T00:00:00Z'),
    ...over,
  };
}

const NOOP_SLEEP = { sleep: () => Promise.resolve() };

beforeEach(() => {
  checkWhatsappUsers.mockReset();
  fetchWhatsappAvatar.mockReset();
  vi.mocked(applyQrCheckVerdict).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('runCheckBatch — caminho feliz', () => {
  it('IsInWhatsapp:true grava uso, aplica o veredito e marca done', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: 'x',
        lid: 'y',
        verifiedName: null,
      },
    ]);
    fetchWhatsappAvatar.mockResolvedValue(null); // sem foto — não é erro.
    const { db, ops } = makeDb({});

    const summary = await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    expect(summary.checked).toBe(1);
    expect(summary.invalid).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({
      outcome: 'done',
      isInWhatsapp: true,
    });
    expect(applyQrCheckVerdict).toHaveBeenCalledWith(db, {
      contactId: 'c1',
      channelId: 'chan-1',
      isInWhatsapp: true,
    });
    expect(
      ops.some((o) => o.table === 'channel_cold_sends' && o.verb === 'insert')
    ).toBe(true);
    const insertOp = ops.find((o) => o.table === 'channel_cold_sends');
    expect(insertOp?.payload).toMatchObject({
      kind: 'check',
      origin: 'engine',
    });
  });

  it('IsInWhatsapp:false conta como invalid, ainda assim done', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: false,
        jid: null,
        lid: null,
        verifiedName: null,
      },
    ]);
    const { db } = makeDb({});

    const summary = await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    expect(summary.checked).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(fetchWhatsappAvatar).not.toHaveBeenCalled();
  });

  it('NÃO chama /user/info — decisão de design pós-F3 (só /user/avatar)', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: 'x',
        lid: null,
        verifiedName: null,
      },
    ]);
    fetchWhatsappAvatar.mockResolvedValue(null);
    const { db } = makeDb({});

    await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    // Nenhuma forma de "user/info" foi importada/chamada — a ausência
    // do mock cobre isso: se o código chamasse, o teste já teria
    // falhado por método indefinido.
    expect(checkWhatsappUsers).toHaveBeenCalledTimes(1);
  });
});

describe('runCheckBatch — busca de avatar (D-13)', () => {
  it('IsInWhatsapp:true + avatar nunca buscado → busca e sobe', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: 'x',
        lid: null,
        verifiedName: null,
      },
    ]);
    const pngBase64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]).toString('base64');
    fetchWhatsappAvatar.mockResolvedValue({ base64: pngBase64 });
    const { db, ops } = makeDb({});

    const summary = await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    expect(summary.avatarsFetched).toBe(1);
    expect(summary.results[0].avatarFetched).toBe(true);
    expect(ops.some((o) => o.table === 'storage' && o.verb === 'upload')).toBe(
      true
    );
    const contactsUpdate = ops.find((o) => o.table === 'contacts');
    expect(contactsUpdate?.payload).toMatchObject({
      avatar_source: 'whatsapp_qr',
    });
  });

  it('dentro do TTL: não busca avatar de novo', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: 'x',
        lid: null,
        verifiedName: null,
      },
    ]);
    const { db } = makeDb({});
    const recentFetch = new Date('2026-09-01T00:00:00Z'); // 2 dias atrás

    const summary = await runCheckBatch(
      db,
      config,
      baseParams({ items: [item({ avatarFetchedAt: recentFetch })] }),
      NOOP_SLEEP
    );

    expect(fetchWhatsappAvatar).not.toHaveBeenCalled();
    expect(summary.avatarsFetched).toBe(0);
  });

  it('avatar ausente (null) não é tratado como erro', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: 'x',
        lid: null,
        verifiedName: null,
      },
    ]);
    fetchWhatsappAvatar.mockResolvedValue(null);
    const { db } = makeDb({});

    const summary = await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    expect(summary.failed).toBe(0);
    expect(summary.results[0].outcome).toBe('done');
  });

  it('tipo de imagem não suportado não derruba o veredito de check já aplicado', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: 'x',
        lid: null,
        verifiedName: null,
      },
    ]);
    fetchWhatsappAvatar.mockResolvedValue({
      base64: Buffer.from('GIF89a').toString('base64'),
    });
    const { db } = makeDb({});

    const summary = await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    expect(summary.checked).toBe(1); // o check em si foi bem-sucedido
    expect(summary.results[0].outcome).toBe('done');
    expect(summary.results[0].avatarFetched).toBe(false);
  });

  it('falha no upload não derruba o veredito', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: 'x',
        lid: null,
        verifiedName: null,
      },
    ]);
    fetchWhatsappAvatar.mockResolvedValue({
      base64: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).toString('base64'),
    });
    const { db } = makeDb({ storageUploadError: { message: 'bucket boom' } });

    const summary = await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    expect(summary.results[0].outcome).toBe('done');
    expect(summary.results[0].avatarFetched).toBe(false);
  });
});

describe('runCheckBatch — sem resultado casado', () => {
  it('resposta sem número casado: falha leve, volta a pending com attempts+1', async () => {
    checkWhatsappUsers.mockResolvedValue([]); // nada casa
    const { db, ops } = makeDb({ attemptsOnRevert: 2 });

    const summary = await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    expect(summary.failed).toBe(1);
    expect(summary.checked).toBe(0);
    expect(summary.results[0]).toMatchObject({
      outcome: 'failed',
      error: 'no_match',
    });
    const revert = ops.find(
      (o) => o.table === 'contact_check_queue' && o.verb === 'update'
    );
    expect(revert?.payload).toMatchObject({ status: 'pending', attempts: 3 });
  });
});

describe('runCheckBatch — channel_unavailable (§7.1 ponto 2)', () => {
  it('não consome tentativa e aborta o restante do lote', async () => {
    checkWhatsappUsers.mockRejectedValue(
      new EvolutionApiError('channel_unavailable', 0, 'connection refused')
    );
    const { db, ops } = makeDb({});

    const summary = await runCheckBatch(
      db,
      config,
      baseParams({
        items: [item({ queueItemId: 'q1' }), item({ queueItemId: 'q2' })],
      }),
      NOOP_SLEEP
    );

    expect(summary.abortedChannelUnavailable).toBe(true);
    expect(summary.results).toHaveLength(1); // q2 nunca foi reivindicado
    expect(summary.results[0].outcome).toBe('aborted');
    // attempts NÃO incrementado — sem select-attempts na trilha.
    expect(ops.some((o) => o.verb === 'select-attempts')).toBe(false);
    const revert = ops.find(
      (o) => o.table === 'contact_check_queue' && o.verb === 'update'
    );
    expect(revert?.payload).toMatchObject({ status: 'pending' });
    expect(revert?.payload).not.toHaveProperty('attempts');
  });

  it('outro tipo de erro NÃO aborta o lote — segue para o próximo item', async () => {
    checkWhatsappUsers
      .mockRejectedValueOnce(new Error('erro qualquer'))
      .mockResolvedValueOnce([
        {
          query: '5511900000002',
          isInWhatsapp: true,
          jid: null,
          lid: null,
          verifiedName: null,
        },
      ]);
    const { db } = makeDb({});

    const summary = await runCheckBatch(
      db,
      config,
      baseParams({
        items: [
          item({ queueItemId: 'q1', phoneNormalized: '5511900000001' }),
          item({ queueItemId: 'q2', phoneNormalized: '5511900000002' }),
        ],
      }),
      NOOP_SLEEP
    );

    expect(summary.abortedChannelUnavailable).toBe(false);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0].outcome).toBe('failed');
    expect(summary.results[1].outcome).toBe('done');
  });
});

describe('runCheckBatch — orçamento de tempo (deadline)', () => {
  it('itens além do deadline não são sequer reivindicados', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: null,
        lid: null,
        verifiedName: null,
      },
    ]);
    const { db, ops } = makeDb({});
    let clock = new Date('2026-09-03T12:00:00Z');
    const now = () => clock;
    const sleep = async () => {
      clock = new Date(clock.getTime() + 30_000); // avança 30s por item
    };

    const summary = await runCheckBatch(
      db,
      config,
      baseParams({
        items: [
          item({ queueItemId: 'q1' }),
          item({ queueItemId: 'q2' }),
          item({ queueItemId: 'q3' }),
        ],
        // O relógio só avança durante o sleep (30s por item, no teste).
        // Um deadline ANTES do primeiro sleep completar garante que só
        // o item 0 é reivindicado: a checagem do item 1 já vê o
        // relógio pós-sleep, depois do corte.
        deadline: new Date('2026-09-03T12:00:15Z'),
      }),
      { now, sleep }
    );

    expect(summary.results).toHaveLength(1);
    expect(ops.filter((o) => o.verb === 'claim')).toHaveLength(1);
  });
});

describe('runCheckBatch — pausa entre itens', () => {
  it('chama sleep(minIntervalSeconds*1000) entre itens, mas não depois do último', async () => {
    checkWhatsappUsers.mockResolvedValue([
      {
        query: '5511900000001',
        isInWhatsapp: true,
        jid: null,
        lid: null,
        verifiedName: null,
      },
    ]);
    const { db } = makeDb({});
    const sleep = vi.fn().mockResolvedValue(undefined);

    await runCheckBatch(
      db,
      config,
      baseParams({
        items: [item({ queueItemId: 'q1' }), item({ queueItemId: 'q2' })],
        minIntervalSeconds: 7,
      }),
      { sleep }
    );

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(7000);
  });
});

describe('runCheckBatch — claim já tomado por outra invocação', () => {
  it('item não reivindicado (outra invocação já pegou) é pulado sem contar como falha', async () => {
    const { db } = makeDb({ claimResults: [{ data: null }] });

    const summary = await runCheckBatch(db, config, baseParams(), NOOP_SLEEP);

    expect(summary.results).toEqual([]);
    expect(summary.failed).toBe(0);
    expect(checkWhatsappUsers).not.toHaveBeenCalled();
  });
});
