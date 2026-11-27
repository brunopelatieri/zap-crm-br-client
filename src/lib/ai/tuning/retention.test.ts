import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TOOL_CALLS_PURGE_LIMIT,
  TOOL_CALLS_RETENTION_DAYS,
  TUNING_RETENTION,
  resetTuningRetentionThrottle,
  sweepAiTuningRetention,
  tuningRetentionEnabled,
} from './retention';
import { tuningDb, type Row } from './test-db';

const NOW = new Date('2026-11-27T12:00:00Z');
const ago = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 3600 * 1000).toISOString();

beforeEach(() => {
  resetTuningRetentionThrottle();
});

const example = (
  id: string,
  status: string,
  createdDays: number,
  updatedDays = createdDays
): Row => ({
  id,
  account_id: 'a',
  status,
  created_at: ago(createdDays),
  updated_at: ago(updatedDays),
});

describe('sweepAiTuningRetention (P-5)', () => {
  it('deletes by age and keeps approved examples and cases forever', async () => {
    const { db, tables } = tuningDb({
      ai_drafts: [
        { id: 'd-old', created_at: ago(TUNING_RETENTION.draftDays + 1) },
        { id: 'd-new', created_at: ago(0.5) },
      ],
      ai_examples: [
        example('cand-old', 'candidate', TUNING_RETENTION.candidateDays + 1),
        example('cand-new', 'candidate', 5),
        example('rej-old', 'rejected', 200, TUNING_RETENTION.rejectedDays + 1),
        example('rej-new', 'rejected', 200, 2),
        example('appr-ancient', 'approved', 900),
      ],
      ai_eval_runs: [
        { id: 'run-old', created_at: ago(TUNING_RETENTION.evalRunDays + 1) },
        { id: 'run-new', created_at: ago(10) },
      ],
      ai_eval_cases: [{ id: 'case-ancient', created_at: ago(900) }],
    });
    const result = await sweepAiTuningRetention(db, NOW);
    expect(result).toEqual({
      ran: true,
      drafts: 1,
      candidates: 1,
      rejected: 1,
      evalRuns: 1,
      toolCalls: 0,
    });
    expect(tables.ai_drafts.map((r) => r.id)).toEqual(['d-new']);
    expect(tables.ai_examples.map((r) => r.id).sort()).toEqual([
      'appr-ancient',
      'cand-new',
      'rej-new',
    ]);
    expect(tables.ai_eval_runs.map((r) => r.id)).toEqual(['run-new']);
    expect(tables.ai_eval_cases).toHaveLength(1);
  });

  it('a candidate an admin touched recently is not purged, whatever its age', async () => {
    const { db, tables } = tuningDb({
      ai_drafts: [],
      ai_examples: [
        example('reopened', 'candidate', 200, 1),
        example('untouched', 'candidate', 200, 200),
      ],
      ai_eval_runs: [],
    });
    await sweepAiTuningRetention(db, NOW);
    expect(tables.ai_examples.map((r) => r.id)).toEqual(['reopened']);
  });

  it('runs at most once an hour per process (the cron fires every 5 minutes)', async () => {
    const { db } = tuningDb({
      ai_drafts: [],
      ai_examples: [],
      ai_eval_runs: [],
    });
    expect((await sweepAiTuningRetention(db, NOW)).ran).toBe(true);
    expect(
      (
        await sweepAiTuningRetention(
          db,
          new Date(NOW.getTime() + 5 * 60 * 1000)
        )
      ).ran
    ).toBe(false);
    expect(
      (
        await sweepAiTuningRetention(
          db,
          new Date(NOW.getTime() + 61 * 60 * 1000)
        )
      ).ran
    ).toBe(true);
  });

  // SPEC 089 F8: the audit of tool calls is kept 90 days (maintainer's
  // decision), purged by the RPC of migration 110 — the table grants DELETE
  // to nobody.
  it('purges ai_tool_calls older than 90 days through the RPC, even with AI_TUNING_RETENTION=off', async () => {
    const prev = process.env.AI_TUNING_RETENTION;
    process.env.AI_TUNING_RETENTION = 'off';
    try {
      const { db, rpcCalls } = tuningDb(
        { ai_drafts: [{ id: 'd-old', created_at: ago(30) }] },
        { rpc: { purge_ai_tool_calls: () => ({ data: 7, error: null }) } }
      );
      const result = await sweepAiTuningRetention(db, NOW);
      expect(result).toMatchObject({ ran: true, toolCalls: 7, drafts: 0 });
      expect(rpcCalls).toEqual([
        {
          name: 'purge_ai_tool_calls',
          args: {
            p_older_than_days: TOOL_CALLS_RETENTION_DAYS,
            p_limit: TOOL_CALLS_PURGE_LIMIT,
          },
        },
      ]);
      expect(TOOL_CALLS_RETENTION_DAYS).toBe(90);
    } finally {
      if (prev === undefined) delete process.env.AI_TUNING_RETENTION;
      else process.env.AI_TUNING_RETENTION = prev;
    }
  });

  it('a database without migration 110 purges nothing and does not complain', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = tuningDb(
      {},
      {
        rpc: {
          purge_ai_tool_calls: () => ({
            data: null,
            error: { code: 'PGRST202', message: 'not found' },
          }),
        },
      }
    );
    const result = await sweepAiTuningRetention(db, NOW);
    expect(result.toolCalls).toBe(0);
    expect(err).not.toHaveBeenCalledWith(
      '[ai tuning] ai_tool_calls retention failed:',
      expect.anything(),
      expect.anything()
    );
    err.mockRestore();
  });

  it('can be turned off with AI_TUNING_RETENTION=off', () => {
    expect(tuningRetentionEnabled({})).toBe(true);
    expect(tuningRetentionEnabled({ AI_TUNING_RETENTION: 'off' })).toBe(false);
    expect(tuningRetentionEnabled({ AI_TUNING_RETENTION: ' OFF ' })).toBe(
      false
    );
    expect(tuningRetentionEnabled({ AI_TUNING_RETENTION: 'on' })).toBe(true);
  });

  it('a database failure is logged and counted as zero, never raised', async () => {
    const { db } = tuningDb(
      {},
      { failOn: ['ai_drafts', 'ai_examples', 'ai_eval_runs'] }
    );
    await expect(sweepAiTuningRetention(db, NOW)).resolves.toMatchObject({
      drafts: 0,
      candidates: 0,
      rejected: 0,
      evalRuns: 0,
    });
  });
});
