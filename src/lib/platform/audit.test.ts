import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { consoleActorTag, writePlatformAudit } from './audit';

describe('consoleActorTag', () => {
  it('prefixa o e-mail com console:', () => {
    expect(consoleActorTag('owner@zapcrmbr.com')).toBe(
      'console:owner@zapcrmbr.com'
    );
  });
});

describe('writePlatformAudit', () => {
  it('grava a linha com os campos default (accountId/targetUserId/payload ausentes viram null/{})', async () => {
    const inserts: Record<string, unknown>[] = [];
    const db = {
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          inserts.push(payload);
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    await writePlatformAudit(db, {
      actor: 'console:owner@zapcrmbr.com',
      action: 'settings.update',
    });

    expect(inserts).toEqual([
      {
        actor: 'console:owner@zapcrmbr.com',
        action: 'settings.update',
        account_id: null,
        target_user_id: null,
        payload: {},
      },
    ]);
  });

  it('propaga accountId/targetUserId/payload quando fornecidos', async () => {
    const inserts: Record<string, unknown>[] = [];
    const db = {
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          inserts.push(payload);
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    await writePlatformAudit(db, {
      actor: 'console:owner@zapcrmbr.com',
      action: 'account.block',
      accountId: 'acct-1',
      targetUserId: 'user-1',
      payload: { reason: 'inadimplência' },
    });

    expect(inserts).toEqual([
      {
        actor: 'console:owner@zapcrmbr.com',
        action: 'account.block',
        account_id: 'acct-1',
        target_user_id: 'user-1',
        payload: { reason: 'inadimplência' },
      },
    ]);
  });

  // Achado de code review (ausência de teste, AGENTS.md "adicione o
  // teste ao lado"): o contrato "nunca lança" é o que TODO chamador de
  // `/api/platform/**` e de `block.ts` depende — um erro de INSERT aqui
  // não pode virar uma exceção não tratada que transforma a ação real
  // (bloquear, trocar plano) num 500, só porque o rastro falhou.
  it('nunca lança quando o INSERT falha — só loga', async () => {
    const db = {
      from: () => ({
        insert: () => Promise.resolve({ error: { message: 'boom' } }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      writePlatformAudit(db, {
        actor: 'console:owner@zapcrmbr.com',
        action: 'plan.change',
      })
    ).resolves.toBeUndefined();
  });
});
