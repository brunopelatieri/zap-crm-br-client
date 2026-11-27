import { describe, it, expect } from 'vitest';
import { buildDataset, exportDataset } from './export';
import { tuningDb } from './test-db';

// Synthetic data only.
const PII = [
  '(11) 98765-4321',
  '11987654321',
  'maria.souza@exemplo.com',
  '529.982.247-25',
  '11.222.333/0001-81',
  '4111 1111 1111 1111',
  '01310-100',
];

describe('buildDataset', () => {
  it('writes one chat-format object per line', () => {
    const out = buildDataset({
      rows: [
        { customer_message: 'quanto custa?', ideal_response: 'R$ 129,00' },
        {
          customer_message: 'tem frete?\nmesmo no domingo?',
          ideal_response: 'Sim.\nTodos os dias.',
        },
      ],
    });
    expect(out.count).toBe(2);
    const lines = out.jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      messages: [
        { role: 'user', content: 'quanto custa?' },
        { role: 'assistant', content: 'R$ 129,00' },
      ],
    });
    // Newlines inside a text stay escaped, so the line count is the example count.
    expect(JSON.parse(lines[1]).messages[1].content).toBe(
      'Sim.\nTodos os dias.'
    );
    expect(out.jsonl.endsWith('\n')).toBe(true);
  });

  it('adds the system prompt as the first message only when asked', () => {
    const rows = [{ customer_message: 'oi', ideal_response: 'olá' }];
    const withSystem = buildDataset({ rows, systemPrompt: 'Loja de tênis.' });
    expect(JSON.parse(withSystem.jsonl).messages[0]).toEqual({
      role: 'system',
      content: 'Loja de tênis.',
    });
    expect(JSON.parse(buildDataset({ rows }).jsonl).messages).toHaveLength(2);
    expect(
      JSON.parse(buildDataset({ rows, systemPrompt: '  ' }).jsonl).messages
    ).toHaveLength(2);
  });

  it('a row that reached the table unmasked still leaves masked, and is counted', () => {
    const out = buildDataset({
      rows: [
        {
          customer_message: `meu contato ${PII.join(' | ')}`,
          ideal_response: 'anotado',
        },
        {
          customer_message: 'ok',
          ideal_response: 'escreva para maria.souza@exemplo.com',
        },
      ],
      systemPrompt: 'Fale com vendas@loja.com',
    });
    for (const value of PII) {
      expect(out.jsonl).not.toContain(value);
    }
    expect(out.jsonl).not.toContain('vendas@loja.com');
    expect(out.jsonl).not.toMatch(/\d{8}/);
    expect(out.remasked).toBe(2);
  });

  it('already-masked rows are exported unchanged (remasked 0)', () => {
    const out = buildDataset({
      rows: [
        {
          customer_message: 'meu zap [telefone]',
          ideal_response: 'te ligo, [nome]',
        },
      ],
    });
    expect(out.remasked).toBe(0);
    expect(JSON.parse(out.jsonl).messages[0].content).toBe(
      'meu zap [telefone]'
    );
  });

  it('skips rows that are empty after masking and returns an empty file for none', () => {
    expect(buildDataset({ rows: [] })).toEqual({
      jsonl: '',
      count: 0,
      remasked: 0,
    });
    expect(
      buildDataset({ rows: [{ customer_message: ' ', ideal_response: 'x' }] })
        .count
    ).toBe(0);
  });
});

describe('exportDataset', () => {
  it('exports only the approved examples of the account', async () => {
    const row = (id: string, account: string, status: string) => ({
      id,
      account_id: account,
      status,
      customer_message: `q ${id}`,
      ideal_response: `a ${id}`,
      created_at: `2026-11-0${id.length}T10:00:00Z`,
    });
    const { db } = tuningDb({
      ai_examples: [
        row('a', 'acct-a', 'approved'),
        row('bb', 'acct-a', 'candidate'),
        row('ccc', 'acct-a', 'rejected'),
        row('dddd', 'acct-b', 'approved'),
      ],
    });
    const out = await exportDataset(db, 'acct-a');
    expect(out.count).toBe(1);
    expect(out.jsonl).toContain('q a');
    expect(out.jsonl).not.toContain('q dddd');
    expect(out.jsonl).not.toContain('q bb');
  });

  it('a database error is a typed error, not a half file', async () => {
    const { db } = tuningDb({}, { failOn: ['ai_examples'] });
    await expect(exportDataset(db, 'acct-a')).rejects.toMatchObject({
      code: 'database_error',
    });
  });
});
