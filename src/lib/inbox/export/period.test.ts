import { describe, expect, it } from 'vitest';
import { isValidTimeZone, resolvePeriodBoundary } from './period';

const SP = 'America/Sao_Paulo'; // UTC-3, sem horário de verão desde 2019
const NY = 'America/New_York'; // UTC-5 / UTC-4, com DST

describe('resolvePeriodBoundary — data pura vira o dia inteiro no fuso', () => {
  it('início do dia em São Paulo é 03:00Z', () => {
    expect(resolvePeriodBoundary('2026-08-12', SP, 'start')).toBe(
      '2026-08-12T03:00:00.000Z'
    );
  });

  it('fim do dia em São Paulo é 02:59:59.999Z do dia seguinte', () => {
    expect(resolvePeriodBoundary('2026-08-12', SP, 'end')).toBe(
      '2026-08-13T02:59:59.999Z'
    );
  });

  it('NÃO trata a data como meia-noite UTC', () => {
    // `new Date('2026-08-12')` daria 00:00Z — três horas do dia 11 no
    // fuso de São Paulo entrariam no intervalo sem ninguém pedir.
    expect(resolvePeriodBoundary('2026-08-12', SP, 'start')).not.toBe(
      '2026-08-12T00:00:00.000Z'
    );
  });

  it('respeita o horário de verão do fuso (Nova York, agosto = UTC-4)', () => {
    expect(resolvePeriodBoundary('2026-08-12', NY, 'start')).toBe(
      '2026-08-12T04:00:00.000Z'
    );
  });

  it('respeita o horário padrão do mesmo fuso (janeiro = UTC-5)', () => {
    expect(resolvePeriodBoundary('2026-01-12', NY, 'start')).toBe(
      '2026-01-12T05:00:00.000Z'
    );
  });

  it('UTC é identidade', () => {
    expect(resolvePeriodBoundary('2026-08-12', 'UTC', 'start')).toBe(
      '2026-08-12T00:00:00.000Z'
    );
    expect(resolvePeriodBoundary('2026-08-12', 'UTC', 'end')).toBe(
      '2026-08-12T23:59:59.999Z'
    );
  });

  it('fuso a leste (Tóquio, UTC+9) começa no dia anterior em UTC', () => {
    expect(resolvePeriodBoundary('2026-08-12', 'Asia/Tokyo', 'start')).toBe(
      '2026-08-11T15:00:00.000Z'
    );
  });
});

describe('resolvePeriodBoundary — ISO completo', () => {
  it('normaliza para ISO em UTC, preservando o instante', () => {
    expect(
      resolvePeriodBoundary('2026-08-12T14:32:00.000-03:00', SP, 'start')
    ).toBe('2026-08-12T17:32:00.000Z');
  });

  it('aceita ISO já em Z', () => {
    expect(resolvePeriodBoundary('2026-08-12T14:32:00.000Z', SP, 'end')).toBe(
      '2026-08-12T14:32:00.000Z'
    );
  });

  it('string sem sentido devolve null', () => {
    expect(resolvePeriodBoundary('ontem', SP, 'start')).toBeNull();
    expect(resolvePeriodBoundary('', SP, 'start')).toBeNull();
    expect(resolvePeriodBoundary('2026-13-45', SP, 'start')).toBeNull();
  });
});

describe('isValidTimeZone', () => {
  it('aceita fuso conhecido', () => {
    expect(isValidTimeZone(SP)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('recusa fuso inventado — vira 400 na rota, nunca 500', () => {
    expect(isValidTimeZone('Marte/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
