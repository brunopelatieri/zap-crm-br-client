import { describe, expect, it } from 'vitest';

import type { ColdSendDecision } from '@/lib/channels/cold-send-limit';
import { planCheckBatch, type CheckQueueItem } from './check-queue';

const now = new Date('2026-09-03T12:00:00Z');

function item(id: string, over: Partial<CheckQueueItem> = {}): CheckQueueItem {
  return {
    id,
    source: 'contacts_import',
    attempts: 0,
    createdAt: now,
    ...over,
  };
}

function decision(over: Partial<ColdSendDecision> = {}): ColdSendDecision {
  return {
    allowed: true,
    remainingToday: 100,
    remainingThisHour: 100,
    dailyLimit: 300,
    hourlyLimit: 60,
    warmingUp: false,
    ...over,
  };
}

describe('planCheckBatch — higiene primeiro (max_attempts / TTL)', () => {
  it('item com attempts >= maxAttempts vira toFail, não compete pelo lote', () => {
    const plan = planCheckBatch({
      pending: [item('a', { attempts: 3 }), item('b', { attempts: 0 })],
      decision: decision(),
      batchSize: 10,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toFail.map((i) => i.id)).toEqual(['a']);
    expect(plan.toProcess.map((i) => i.id)).toEqual(['b']);
  });

  it('item mais velho que o TTL vira toExpire', () => {
    const old = new Date(now.getTime() - 200 * 3_600_000); // 200h atrás
    const plan = planCheckBatch({
      pending: [item('old', { createdAt: old }), item('fresh')],
      decision: decision(),
      batchSize: 10,
      maxAttempts: 3,
      ttlHours: 168, // 7 dias
      now,
    });
    expect(plan.toExpire.map((i) => i.id)).toEqual(['old']);
    expect(plan.toProcess.map((i) => i.id)).toEqual(['fresh']);
  });

  it('item exatamente no limite de idade NÃO expira (a checagem é now - created > ttl, não >=)', () => {
    const exact = new Date(now.getTime() - 168 * 3_600_000);
    const plan = planCheckBatch({
      pending: [item('exact', { createdAt: exact })],
      decision: decision(),
      batchSize: 10,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toExpire).toEqual([]);
    expect(plan.toProcess.map((i) => i.id)).toEqual(['exact']);
  });

  it('max_attempts vence sobre TTL quando os dois se aplicam — higiene por tentativa primeiro', () => {
    const old = new Date(now.getTime() - 200 * 3_600_000);
    const plan = planCheckBatch({
      pending: [item('a', { attempts: 5, createdAt: old })],
      decision: decision(),
      batchSize: 10,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toFail.map((i) => i.id)).toEqual(['a']);
    expect(plan.toExpire).toEqual([]);
  });

  it('itens descartados por higiene não contam no allowed cut nem em remaining', () => {
    const old = new Date(now.getTime() - 200 * 3_600_000);
    const plan = planCheckBatch({
      pending: [
        item('a', { attempts: 5 }),
        item('b', { createdAt: old }),
        item('c'),
      ],
      decision: decision({ remainingToday: 1, remainingThisHour: 1 }),
      batchSize: 10,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess.map((i) => i.id)).toEqual(['c']);
    expect(plan.remaining).toBe(0);
  });
});

describe('planCheckBatch — prioridade: campanha antes de importação', () => {
  it('item de broadcast sai antes de item de import, mesmo entrando depois', () => {
    const earlier = new Date(now.getTime() - 3600_000);
    const plan = planCheckBatch({
      pending: [
        item('import-early', { source: 'contacts_import', createdAt: earlier }),
        item('broadcast-late', { source: 'broadcast', createdAt: now }),
      ],
      decision: decision(),
      batchSize: 10,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess.map((i) => i.id)).toEqual([
      'broadcast-late',
      'import-early',
    ]);
  });

  it('dentro da mesma fonte, FIFO por createdAt', () => {
    const t1 = new Date(now.getTime() - 3 * 3600_000);
    const t2 = new Date(now.getTime() - 2 * 3600_000);
    const t3 = new Date(now.getTime() - 1 * 3600_000);
    const plan = planCheckBatch({
      pending: [
        item('c', { createdAt: t3 }),
        item('a', { createdAt: t1 }),
        item('b', { createdAt: t2 }),
      ],
      decision: decision(),
      batchSize: 10,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('planCheckBatch — o corte é o MENOR dos três tetos', () => {
  const many = Array.from({ length: 20 }, (_, i) => item(`item-${i}`));

  it('batchSize é o menor', () => {
    const plan = planCheckBatch({
      pending: many,
      decision: decision({ remainingToday: 100, remainingThisHour: 100 }),
      batchSize: 5,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess).toHaveLength(5);
    expect(plan.remaining).toBe(15);
  });

  it('remainingThisHour é o menor', () => {
    const plan = planCheckBatch({
      pending: many,
      decision: decision({ remainingToday: 100, remainingThisHour: 3 }),
      batchSize: 25,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess).toHaveLength(3);
  });

  it('remainingToday é o menor', () => {
    const plan = planCheckBatch({
      pending: many,
      decision: decision({ remainingToday: 2, remainingThisHour: 100 }),
      batchSize: 25,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess).toHaveLength(2);
  });

  it('cota zerada (remainingToday: 0) processa zero, não "sem limite"', () => {
    const plan = planCheckBatch({
      pending: many,
      decision: decision({ remainingToday: 0 }),
      batchSize: 25,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess).toEqual([]);
    expect(plan.remaining).toBe(20);
  });

  it('fila menor que o lote processa a fila inteira', () => {
    const plan = planCheckBatch({
      pending: [item('a'), item('b')],
      decision: decision(),
      batchSize: 25,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess).toHaveLength(2);
    expect(plan.remaining).toBe(0);
  });

  it('negativa por min_interval corta em zero mesmo com remainingToday/remainingThisHour positivos (achado de code review)', () => {
    // O intervalo mínimo nega SEM zerar os outros dois campos — é a
    // diferença de `daily_limit`/`hourly_limit`, que já zeram um deles.
    // Sem olhar `decision.allowed`, o `Math.min` sozinho deixaria passar
    // o lote inteiro, furando o antispam do intervalo mínimo.
    const plan = planCheckBatch({
      pending: many,
      decision: decision({
        allowed: false,
        reason: 'min_interval',
        remainingToday: 100,
        remainingThisHour: 100,
      }),
      batchSize: 25,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan.toProcess).toEqual([]);
    expect(plan.remaining).toBe(20);
  });

  it('fila vazia não lança e devolve tudo zerado', () => {
    const plan = planCheckBatch({
      pending: [],
      decision: decision(),
      batchSize: 25,
      maxAttempts: 3,
      ttlHours: 168,
      now,
    });
    expect(plan).toEqual({
      toProcess: [],
      toFail: [],
      toExpire: [],
      remaining: 0,
    });
  });
});
