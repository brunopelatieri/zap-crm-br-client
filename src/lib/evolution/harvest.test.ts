import { describe, expect, it } from 'vitest';

import { planHarvestBatch, type HarvestCandidate } from './harvest';

function candidate(
  jid: string,
  over: Partial<HarvestCandidate> = {}
): HarvestCandidate {
  return {
    jid,
    found: true,
    firstName: null,
    fullName: null,
    pushName: `Contato ${jid}`,
    businessName: null,
    ...over,
  };
}

describe('planHarvestBatch — dedupe por Jid', () => {
  it('contato já existente (na triagem ou vinculado) não entra de novo', () => {
    const plan = planHarvestBatch({
      contacts: [candidate('a@s.whatsapp.net'), candidate('b@s.whatsapp.net')],
      existingJids: new Set(['a@s.whatsapp.net']),
      perRun: 50,
      remainingCapacity: 500,
    });

    expect(plan.toInsert.map((c) => c.jid)).toEqual(['b@s.whatsapp.net']);
    expect(plan.skippedDuplicate).toBe(1);
  });

  it('todos duplicados: toInsert vazio, sem lançar', () => {
    const plan = planHarvestBatch({
      contacts: [candidate('a'), candidate('b')],
      existingJids: new Set(['a', 'b']),
      perRun: 50,
      remainingCapacity: 500,
    });
    expect(plan.toInsert).toEqual([]);
    expect(plan.skippedDuplicate).toBe(2);
    expect(plan.capacityReached).toBe(false);
  });

  it('agenda vazia: tudo zerado, sem lançar', () => {
    const plan = planHarvestBatch({
      contacts: [],
      existingJids: new Set(),
      perRun: 50,
      remainingCapacity: 500,
    });
    expect(plan).toEqual({
      toInsert: [],
      skippedDuplicate: 0,
      capacityReached: false,
      cursor: null,
    });
  });
});

describe('planHarvestBatch — o corte é o MENOR entre perRun e remainingCapacity', () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    candidate(`c${String(i).padStart(3, '0')}@s.whatsapp.net`)
  );

  it('perRun é o menor', () => {
    const plan = planHarvestBatch({
      contacts: many,
      existingJids: new Set(),
      perRun: 10,
      remainingCapacity: 500,
    });
    expect(plan.toInsert).toHaveLength(10);
    expect(plan.capacityReached).toBe(false);
  });

  it('remainingCapacity é o menor', () => {
    const plan = planHarvestBatch({
      contacts: many,
      existingJids: new Set(),
      perRun: 50,
      remainingCapacity: 7,
    });
    expect(plan.toInsert).toHaveLength(7);
    expect(plan.capacityReached).toBe(true);
  });

  it('empatados: capacityReached true', () => {
    const plan = planHarvestBatch({
      contacts: many,
      existingJids: new Set(),
      perRun: 10,
      remainingCapacity: 10,
    });
    expect(plan.toInsert).toHaveLength(10);
    expect(plan.capacityReached).toBe(true);
  });
});

describe('planHarvestBatch — remainingCapacity <= 0: já no teto', () => {
  it('teto zerado: nada é processado, nem dedupe roda', () => {
    const plan = planHarvestBatch({
      contacts: [candidate('a'), candidate('b')],
      existingJids: new Set(),
      perRun: 50,
      remainingCapacity: 0,
    });
    expect(plan).toEqual({
      toInsert: [],
      skippedDuplicate: 0,
      capacityReached: true,
      cursor: null,
    });
  });

  it('remainingCapacity negativo (dado torto) também é tratado como teto atingido', () => {
    const plan = planHarvestBatch({
      contacts: [candidate('a')],
      existingJids: new Set(),
      perRun: 50,
      remainingCapacity: -5,
    });
    expect(plan.capacityReached).toBe(true);
    expect(plan.toInsert).toEqual([]);
  });
});

describe('planHarvestBatch — ordem estável por Jid', () => {
  it('o resultado não depende da ordem de entrada — sempre ordenado por Jid', () => {
    const shuffled = [candidate('c'), candidate('a'), candidate('b')];
    const plan = planHarvestBatch({
      contacts: shuffled,
      existingJids: new Set(),
      perRun: 2,
      remainingCapacity: 500,
    });
    expect(plan.toInsert.map((c) => c.jid)).toEqual(['a', 'b']);
  });
});

describe('planHarvestBatch — cursor', () => {
  it('avança para o último Jid INSERIDO, não o último Jid visto', () => {
    const plan = planHarvestBatch({
      contacts: [candidate('a'), candidate('b'), candidate('z')],
      existingJids: new Set(['z']), // o "maior" Jid é duplicata
      perRun: 50,
      remainingCapacity: 500,
    });
    expect(plan.toInsert.map((c) => c.jid)).toEqual(['a', 'b']);
    expect(plan.cursor).toBe('b');
  });

  it('ciclo sem nenhum novo (só duplicatas): cursor null — não é progresso', () => {
    const plan = planHarvestBatch({
      contacts: [candidate('a')],
      existingJids: new Set(['a']),
      perRun: 50,
      remainingCapacity: 500,
    });
    expect(plan.cursor).toBeNull();
  });
});
