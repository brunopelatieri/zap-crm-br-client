import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_INVALID_ITEMS,
  MAX_ITEMS_PER_POST,
  MAX_LOG_LINES,
  MAX_NOTICE_LINES,
  WebhookPostGuard,
  isJsonObject,
} from './webhook-post-guard';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const isString = (v: unknown): v is string => typeof v === 'string';

describe('isJsonObject', () => {
  it.each([
    [{}, true],
    [{ id: 'x' }, true],
    [null, false],
    [undefined, false],
    [[], false],
    ['x', false],
    [0, false],
  ])('%j → %s', (value, expected) => {
    expect(isJsonObject(value)).toBe(expected);
  });
});

describe('WebhookPostGuard', () => {
  it('POST sem nada de errado: nenhum log', async () => {
    const guard = new WebhookPostGuard();
    for (let i = 0; i < 500; i++) expect(await guard.next()).toBe(true);
    guard.finish();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('abandona no limite de inválidos; um a menos ainda segue', async () => {
    const guard = new WebhookPostGuard();
    for (let i = 0; i < MAX_INVALID_ITEMS - 1; i++) guard.malformed('x');
    expect(guard.stopped).toBe(false);
    expect(await guard.next()).toBe(true);

    guard.malformed('x');
    expect(guard.stopped).toBe(true);
    expect(await guard.next()).toBe(false);
  });

  it('falha de processamento não abandona, por mais que se repita', async () => {
    const guard = new WebhookPostGuard();
    for (let i = 0; i < MAX_INVALID_ITEMS * 10; i++) guard.failed('x');
    expect(guard.stopped).toBe(false);
    expect(await guard.next()).toBe(true);
  });

  it('teto de itens: o último cabe, o seguinte não', async () => {
    const guard = new WebhookPostGuard();
    for (let i = 0; i < MAX_ITEMS_PER_POST; i++) {
      expect(await guard.next()).toBe(true);
    }
    expect(guard.stopped).toBe(false);
    expect(await guard.next()).toBe(false);
    expect(guard.stopped).toBe(true);
  });

  it('teto de linhas somado entre os níveis, e um resumo do que foi calado', () => {
    const guard = new WebhookPostGuard();
    for (let i = 0; i < MAX_LOG_LINES; i++) {
      guard.info('i');
      guard.warn('w');
      guard.error('e');
    }
    const count = () =>
      [console.info, console.warn, console.error].reduce(
        (n, fn) => n + vi.mocked(fn).mock.calls.length,
        0
      );
    expect(count()).toBe(MAX_LOG_LINES);

    guard.finish();
    expect(count()).toBe(MAX_LOG_LINES + 1);
    expect(vi.mocked(console.warn).mock.lastCall!.join(' ')).toContain(
      `"log_lines_suppressed":${MAX_LOG_LINES * 2}`
    );
  });

  it('avisos não calam erro: 1.000 avisos e depois um erro', () => {
    const guard = new WebhookPostGuard();
    for (let i = 0; i < 1000; i++) guard.malformed('w');
    guard.info('i');
    expect(console.warn).toHaveBeenCalledTimes(MAX_NOTICE_LINES);
    expect(console.info).not.toHaveBeenCalled();

    guard.error('erro real');
    expect(console.error).toHaveBeenCalledWith('erro real');
  });

  it('só erros: vão até o teto total, e o resumo diz quantos foram calados', () => {
    const guard = new WebhookPostGuard();
    for (let i = 0; i < MAX_LOG_LINES + 5; i++) guard.failed('e');
    guard.warn('w');
    expect(console.error).toHaveBeenCalledTimes(MAX_LOG_LINES);
    expect(console.warn).not.toHaveBeenCalled();

    guard.finish();
    const summary = vi.mocked(console.warn).mock.lastCall!.join(' ');
    expect(summary).toContain('"log_lines_suppressed":6');
    expect(summary).toContain('"errors_suppressed":5');
  });

  it('wellFormed: devolve os bons com o índice original e para no abandono', async () => {
    const guard = new WebhookPostGuard();
    const bad: number[] = [];
    const list = ['a', null, 'b', ...Array(1000).fill(null), 'c'];
    const kept = await guard.wellFormed(list, isString, (i) => {
      bad.push(i);
      guard.malformed('x');
    });

    expect(kept).toEqual([
      { item: 'a', index: 0 },
      { item: 'b', index: 2 },
    ]);
    expect(bad).toHaveLength(MAX_INVALID_ITEMS);
  });
});
