import { describe, expect, it } from 'vitest';

import { isWithinHarvestWindow } from './harvest-window';

const SP = 'America/Sao_Paulo';

describe('isWithinHarvestWindow — janela padrão [0,6) em America/Sao_Paulo', () => {
  it('meia-noite em ponto: dentro', () => {
    // 2026-09-03T03:00:00Z = 2026-09-03T00:00:00-03:00 em SP.
    const now = new Date('2026-09-03T03:00:00Z');
    expect(
      isWithinHarvestWindow(now, { startHour: 0, endHour: 6, timeZone: SP })
    ).toBe(true);
  });

  it('05:59 local: dentro (a última execução válida é 05:00)', () => {
    const now = new Date('2026-09-03T08:59:00Z'); // 05:59 em SP
    expect(
      isWithinHarvestWindow(now, { startHour: 0, endHour: 6, timeZone: SP })
    ).toBe(true);
  });

  it('06:00 local: FORA — endHour é exclusivo', () => {
    const now = new Date('2026-09-03T09:00:00Z'); // 06:00 em SP
    expect(
      isWithinHarvestWindow(now, { startHour: 0, endHour: 6, timeZone: SP })
    ).toBe(false);
  });

  it('12:00 local (meio-dia): fora', () => {
    const now = new Date('2026-09-03T15:00:00Z'); // 12:00 em SP
    expect(
      isWithinHarvestWindow(now, { startHour: 0, endHour: 6, timeZone: SP })
    ).toBe(false);
  });

  it('23:59 local (véspera): fora', () => {
    const now = new Date('2026-09-03T02:59:00Z'); // 23:59 do dia 02 em SP
    expect(
      isWithinHarvestWindow(now, { startHour: 0, endHour: 6, timeZone: SP })
    ).toBe(false);
  });
});

describe('isWithinHarvestWindow — fuso ≠ UTC é o caso que importa', () => {
  it('09:30 UTC (06:30 em SP) já é fora da janela — a hora lida é a de SP, não a de UTC', () => {
    const now = new Date('2026-09-03T09:30:00Z');
    expect(
      isWithinHarvestWindow(now, { startHour: 0, endHour: 6, timeZone: SP })
    ).toBe(false);
  });

  it('o mesmo instante é "dentro" em SP e "fora" em Tóquio — prova que o fuso passado é o que é lido, não o do processo', () => {
    const now = new Date('2026-09-03T04:00:00Z'); // 01:00 em SP
    expect(
      isWithinHarvestWindow(now, { startHour: 0, endHour: 6, timeZone: SP })
    ).toBe(true);
    // O MESMO instante, lido em Tóquio (UTC+9), é 13:00 — bem fora de [0,6).
    expect(
      isWithinHarvestWindow(now, {
        startHour: 0,
        endHour: 6,
        timeZone: 'Asia/Tokyo',
      })
    ).toBe(false);
  });
});

describe('isWithinHarvestWindow — virada de meia-noite (startHour > endHour)', () => {
  const cfg = { startHour: 22, endHour: 6, timeZone: SP };

  it('23:00 local: dentro (depois de start)', () => {
    const now = new Date('2026-09-03T02:00:00Z'); // 23:00 do dia 02 em SP
    expect(isWithinHarvestWindow(now, cfg)).toBe(true);
  });

  it('03:00 local: dentro (antes de end, já no dia seguinte)', () => {
    const now = new Date('2026-09-03T06:00:00Z'); // 03:00 em SP
    expect(isWithinHarvestWindow(now, cfg)).toBe(true);
  });

  it('12:00 local: fora (no meio do dia, fora dos dois lados)', () => {
    const now = new Date('2026-09-03T15:00:00Z'); // 12:00 em SP
    expect(isWithinHarvestWindow(now, cfg)).toBe(false);
  });

  it('06:00 local: fora — end ainda é exclusivo na virada', () => {
    const now = new Date('2026-09-03T09:00:00Z'); // 06:00 em SP
    expect(isWithinHarvestWindow(now, cfg)).toBe(false);
  });

  it('21:59 local: fora (um minuto antes de start)', () => {
    const now = new Date('2026-09-03T00:59:00Z'); // 21:59 do dia 02 em SP
    expect(isWithinHarvestWindow(now, cfg)).toBe(false);
  });
});

describe('isWithinHarvestWindow — janela de tamanho zero', () => {
  it('startHour === endHour nunca é "dentro" — não é 24h por acidente', () => {
    const now = new Date('2026-09-03T12:00:00Z');
    expect(
      isWithinHarvestWindow(now, { startHour: 3, endHour: 3, timeZone: SP })
    ).toBe(false);
  });
});
