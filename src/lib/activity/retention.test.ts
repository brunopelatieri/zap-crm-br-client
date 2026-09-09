import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  activityRetentionCutoffIso,
  readActivityRetentionConfig,
  sweepActivityLog,
} from './retention';

describe('readActivityRetentionConfig', () => {
  it('ausente/vazio → desligada ("nasce desligada", §8)', () => {
    expect(readActivityRetentionConfig({})).toEqual({
      enabled: false,
      days: 0,
    });
    expect(
      readActivityRetentionConfig({ ACTIVITY_LOG_RETENTION_DAYS: '' })
    ).toEqual({ enabled: false, days: 0 });
  });

  it('"0" → ligada, mas dias=0 (nunca apagar)', () => {
    expect(
      readActivityRetentionConfig({ ACTIVITY_LOG_RETENTION_DAYS: '0' })
    ).toEqual({ enabled: true, days: 0 });
  });

  it('positivo → ligada com aquele prazo', () => {
    expect(
      readActivityRetentionConfig({ ACTIVITY_LOG_RETENTION_DAYS: '180' })
    ).toEqual({ enabled: true, days: 180 });
  });

  it('valor inválido (negativo, não numérico) vira desligada, com aviso — nunca lança', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      readActivityRetentionConfig({ ACTIVITY_LOG_RETENTION_DAYS: '-5' })
    ).toEqual({ enabled: false, days: 0 });
    expect(
      readActivityRetentionConfig({ ACTIVITY_LOG_RETENTION_DAYS: 'abc' })
    ).toEqual({ enabled: false, days: 0 });
    expect(
      readActivityRetentionConfig({ ACTIVITY_LOG_RETENTION_DAYS: '1.5' })
    ).toEqual({ enabled: false, days: 0 });
    expect(spy).toHaveBeenCalledTimes(3);

    spy.mockRestore();
  });
});

describe('activityRetentionCutoffIso', () => {
  const NOW = new Date('2026-09-09T12:00:00.000Z');

  it('desligada → sem corte', () => {
    expect(
      activityRetentionCutoffIso({ enabled: false, days: 180 }, NOW)
    ).toBeNull();
  });

  it('dias=0 → sem corte, mesmo ligada', () => {
    expect(
      activityRetentionCutoffIso({ enabled: true, days: 0 }, NOW)
    ).toBeNull();
  });

  it('180 dias → exatos 180×24h atrás', () => {
    const cutoff = activityRetentionCutoffIso(
      { enabled: true, days: 180 },
      NOW
    );
    expect(cutoff).toBe(
      new Date(NOW.getTime() - 180 * 86_400_000).toISOString()
    );
  });
});

// ------------------------------------------------------------
// sweepActivityLog — o dry-run que a verificação do F8 exige "antes de
// qualquer apagamento" (§12).
// ------------------------------------------------------------
describe('sweepActivityLog', () => {
  const ORIGINAL_ENV = process.env.ACTIVITY_LOG_RETENTION_DAYS;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  function makeDb(opts: {
    count?: number | null;
    countError?: { message: string } | null;
    rpcResult?: number | null;
    rpcError?: { message: string } | null;
  }) {
    const rpc = vi.fn(async () => ({
      data: opts.rpcResult ?? null,
      error: opts.rpcError ?? null,
    }));
    const db = {
      from: () => ({
        select: () => ({
          lt: () =>
            Promise.resolve({
              count: opts.count ?? 0,
              error: opts.countError ?? null,
            }),
        }),
      }),
      rpc,
    } as unknown as SupabaseClient;
    return { db, rpc };
  }

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ACTIVITY_LOG_RETENTION_DAYS;
    } else {
      process.env.ACTIVITY_LOG_RETENTION_DAYS = ORIGINAL_ENV;
    }
  });

  it('desligada: não conta, não chama RPC', async () => {
    delete process.env.ACTIVITY_LOG_RETENTION_DAYS;
    const { db, rpc } = makeDb({});

    const result = await sweepActivityLog(db);

    expect(result).toEqual({
      enabled: false,
      cutoff: null,
      deleted: 0,
      candidates: 0,
      dryRun: false,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('dias=0: ligada, mas não apaga — não chama RPC', async () => {
    process.env.ACTIVITY_LOG_RETENTION_DAYS = '0';
    const { db, rpc } = makeDb({});

    const result = await sweepActivityLog(db);

    expect(result.enabled).toBe(true);
    expect(result.cutoff).toBeNull();
    expect(result.deleted).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('dryRun: conta candidatas mas NUNCA chama a RPC de exclusão', async () => {
    process.env.ACTIVITY_LOG_RETENTION_DAYS = '180';
    const { db, rpc } = makeDb({ count: 42 });

    const result = await sweepActivityLog(db, new Date(), { dryRun: true });

    expect(result).toMatchObject({
      enabled: true,
      deleted: 0,
      candidates: 42,
      dryRun: true,
    });
    expect(result.cutoff).not.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('candidates=0 (nada a apagar): não chama a RPC mesmo fora de dry-run', async () => {
    process.env.ACTIVITY_LOG_RETENTION_DAYS = '180';
    const { db, rpc } = makeDb({ count: 0 });

    const result = await sweepActivityLog(db);

    expect(result).toMatchObject({ deleted: 0, candidates: 0, dryRun: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('execução real: conta, chama a RPC, devolve o total apagado', async () => {
    process.env.ACTIVITY_LOG_RETENTION_DAYS = '180';
    const { db, rpc } = makeDb({ count: 10, rpcResult: 10 });

    const result = await sweepActivityLog(db);

    expect(result).toMatchObject({
      enabled: true,
      deleted: 10,
      candidates: 10,
      dryRun: false,
    });
    expect(rpc).toHaveBeenCalledWith('purge_account_activity_log', {
      p_older_than_days: 180,
    });
  });

  it('erro na contagem: não lança, marca o erro', async () => {
    process.env.ACTIVITY_LOG_RETENTION_DAYS = '180';
    const { db, rpc } = makeDb({ countError: { message: 'boom' } });

    const result = await sweepActivityLog(db);

    expect(result.error).toBe('boom');
    expect(result.deleted).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('erro na RPC de exclusão: não lança, marca o erro, deleted=0', async () => {
    process.env.ACTIVITY_LOG_RETENTION_DAYS = '180';
    const { db } = makeDb({ count: 5, rpcError: { message: 'rpc caiu' } });

    const result = await sweepActivityLog(db);

    expect(result.error).toBe('rpc caiu');
    expect(result.deleted).toBe(0);
    expect(result.candidates).toBe(5);
  });

  it('exceção síncrona/assíncrona nunca escapa', async () => {
    process.env.ACTIVITY_LOG_RETENTION_DAYS = '180';
    const db = {
      from: () => {
        throw new Error('conexão caiu');
      },
    } as unknown as SupabaseClient;

    await expect(sweepActivityLog(db)).resolves.toMatchObject({
      error: 'conexão caiu',
    });
  });
});
