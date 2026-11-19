import { describe, expect, it } from 'vitest';

import {
  entryText,
  fileRefsOf,
  firstEntries,
  orderedEntries,
} from './response-display';
import {
  buildResponsesExportMatrix,
  filenameFromDisposition,
  neutralizeFormula,
  resolveBlockColumns,
  responsesExportFilename,
  type ResponseExportLabels,
  type ResponseExportRow,
} from './response-export';
import type { AnswersSnapshot } from './types';

const L = { yes: 'Sim', no: 'Não' };

const answers: AnswersSnapshot = {
  zz_nome: { label: 'Nome', type: 'short_text', value: 'Ana', points: 0 },
  interesse: {
    label: 'Interesse',
    type: 'single_select',
    value: 'o1',
    points: 5,
    option_labels: ['Compra'],
  },
  aceite: { label: 'Aceite', type: 'consent', value: true, points: 0 },
  cnh: {
    label: 'CNH',
    type: 'file_upload',
    value: [
      {
        path: 'account-x/f/r/1.pdf',
        name: 'cnh.pdf',
        mime: 'application/pdf',
        size: 10,
      },
    ],
    points: 0,
  },
  velho: { label: 'Bloco apagado', type: 'short_text', value: 'x', points: 0 },
};

describe('entryText', () => {
  it('escolha pelo rótulo do instantâneo', () => {
    expect(entryText(answers.interesse, L)).toBe('Compra');
  });
  it('consentimento e sim/não traduzidos', () => {
    expect(entryText(answers.aceite, L)).toBe('Sim');
    expect(
      entryText({ label: 'x', type: 'yes_no', value: false, points: 0 }, L)
    ).toBe('Não');
  });
  it('arquivo pelo nome', () => {
    expect(entryText(answers.cnh, L)).toBe('cnh.pdf');
  });
  it('opção sem rótulo guardado cai no id', () => {
    expect(
      entryText(
        { label: 'x', type: 'multi_select', value: ['a', 'b'], points: 0 },
        L
      )
    ).toBe('a, b');
  });
  it('número como texto', () => {
    expect(
      entryText({ label: 'x', type: 'rating', value: 4, points: 4 }, L)
    ).toBe('4');
  });
});

describe('fileRefsOf', () => {
  it('só entrada de arquivo, na ordem, ignorando lixo', () => {
    expect(fileRefsOf(answers.cnh)).toHaveLength(1);
    expect(fileRefsOf(answers.zz_nome)).toEqual([]);
    expect(
      fileRefsOf({
        label: 'x',
        type: 'file_upload',
        value: [null, 3] as never,
        points: 0,
      })
    ).toEqual([]);
  });
});

describe('orderedEntries / firstEntries', () => {
  it('segue a ordem dos blocos; chave desconhecida vai ao fim', () => {
    const keys = orderedEntries(answers, [
      'zz_nome',
      'interesse',
      'aceite',
    ]).map((e) => e.key);
    expect(keys).toEqual(['zz_nome', 'interesse', 'aceite', 'cnh', 'velho']);
  });

  it('ordem de blocos que não estão na resposta é ignorada', () => {
    expect(orderedEntries(answers, ['nada', 'interesse'])[0].key).toBe(
      'interesse'
    );
  });

  it('snapshot nulo não quebra', () => {
    expect(orderedEntries(null, ['a'])).toEqual([]);
  });

  it('3 primeiros blocos respondidos, pulando arquivo e vazios', () => {
    const out = firstEntries(
      {
        ...answers,
        vazio: { label: 'V', type: 'short_text', value: '  ', points: 0 },
      },
      ['cnh', 'vazio', 'zz_nome', 'interesse', 'aceite'],
      3,
      L
    );
    expect(out.map((e) => e.key)).toEqual(['zz_nome', 'interesse', 'aceite']);
    expect(out[1]).toEqual({
      key: 'interesse',
      label: 'Interesse',
      text: 'Compra',
    });
  });
});

describe('neutralizeFormula', () => {
  it.each(['=1+1', '+cmd|"/c calc"', '-2+3+cmd', '@SUM(A1)', '\tx', '\rx'])(
    'neutraliza %j',
    (cell) => {
      expect(neutralizeFormula(cell)).toBe(`'${cell}`);
    }
  );
  it('deixa texto comum, número e telefone', () => {
    expect(neutralizeFormula('Ana')).toBe('Ana');
    expect(neutralizeFormula('-5')).toBe('-5');
    expect(neutralizeFormula('+55 11 99999-0000')).toBe('+55 11 99999-0000');
    expect(neutralizeFormula('')).toBe('');
  });
});

describe('resolveBlockColumns', () => {
  const fields = [
    { key: 'zz_nome', label: 'Nome', type: 'short_text' },
    { key: 'intro', label: 'Intro', type: 'statement' },
    { key: 'interesse', label: 'Interesse', type: 'single_select' },
  ] as never[];

  it('blocos do formulário (sem statement) e depois os apagados, com o rótulo antigo', () => {
    expect(resolveBlockColumns(fields, [{ answers }])).toEqual([
      { key: 'zz_nome', label: 'Nome' },
      { key: 'interesse', label: 'Interesse' },
      { key: 'aceite', label: 'Aceite' },
      { key: 'cnh', label: 'CNH' },
      { key: 'velho', label: 'Bloco apagado' },
    ]);
  });

  it('onlyKeys restringe', () => {
    expect(
      resolveBlockColumns(fields, [{ answers }], ['interesse']).map(
        (c) => c.key
      )
    ).toEqual(['interesse']);
  });
});

describe('buildResponsesExportMatrix', () => {
  const labels: ResponseExportLabels = {
    ...L,
    columns: {
      contact_name: 'Contato',
      contact_phone: 'Telefone',
      status: 'Status',
      source: 'Origem',
      started_at: 'Início',
      completed_at: 'Conclusão',
      score: 'Pontos',
      band: 'Faixa',
    },
    statuses: {
      partial: 'Parcial',
      completed: 'Concluída',
      abandoned: 'Abandonada',
    },
    sources: {
      link: 'Link',
      inbox: 'Inbox',
      broadcast: 'Disparo',
      automation: 'Automação',
      flow: 'Flow',
      portal: 'Área do contato',
      ai: 'IA',
      api: 'API',
      embed: 'Embed',
    },
    bands: { hot: 'Quente' },
    datePattern: 'yyyy-MM-dd',
  };

  const row = (patch: Partial<ResponseExportRow> = {}): ResponseExportRow => ({
    status: 'completed',
    source: 'link',
    started_at: '2026-11-10T12:00:00Z',
    completed_at: '2026-11-10T12:05:00Z',
    score: 12,
    band_key: 'hot',
    answers,
    contacts: { name: 'Ana', phone: '5511999990000' },
    ...patch,
  });

  const blocks = [
    { key: 'zz_nome', label: 'Nome' },
    { key: 'interesse', label: 'Interesse' },
    { key: 'cnh', label: 'CNH' },
  ];

  it('cabeçalho: fixas + blocos; linha traduzida', () => {
    const m = buildResponsesExportMatrix([row()], blocks, labels);
    expect(m[0]).toEqual([
      'Contato',
      'Telefone',
      'Status',
      'Origem',
      'Início',
      'Conclusão',
      'Pontos',
      'Faixa',
      'Nome',
      'Interesse',
      'CNH',
    ]);
    expect(m[1]).toEqual([
      'Ana',
      '5511999990000',
      'Concluída',
      'Link',
      '2026-11-10',
      '2026-11-10',
      '12',
      'Quente',
      'Ana',
      'Compra',
      'cnh.pdf',
    ]);
  });

  it('resposta parcial: sem conclusão/pontos e bloco ausente vazio; faixa removida mostra a chave', () => {
    const m = buildResponsesExportMatrix(
      [
        row({
          status: 'partial',
          completed_at: null,
          score: null,
          band_key: 'sumiu',
          answers: {},
          contacts: null,
        }),
      ],
      blocks,
      labels
    );
    expect(m[1]).toEqual([
      '',
      '',
      'Parcial',
      'Link',
      '2026-11-10',
      '',
      '',
      'sumiu',
      '',
      '',
      '',
    ]);
  });

  it('resposta de visitante com fórmula não vira fórmula no arquivo', () => {
    const m = buildResponsesExportMatrix(
      [
        row({
          answers: {
            zz_nome: {
              label: 'Nome',
              type: 'short_text',
              value: '=HYPERLINK("http://x")',
              points: 0,
            },
          },
        }),
      ],
      blocks,
      labels
    );
    expect(m[1][8]).toBe(`'=HYPERLINK("http://x")`);
  });

  it('rótulo malicioso do cabeçalho também é neutralizado', () => {
    const m = buildResponsesExportMatrix(
      [],
      [{ key: 'k', label: '=cmd()' }],
      labels
    );
    expect(m[0].at(-1)).toBe(`'=cmd()`);
  });
});

describe('responsesExportFilename', () => {
  it('prefixo, slug e data ISO', () => {
    expect(
      responsesExportFilename(
        'respostas',
        'captacao',
        'xlsx',
        new Date('2026-11-19T10:00:00Z')
      )
    ).toBe('respostas-captacao-2026-11-19.xlsx');
  });
});

describe('filenameFromDisposition', () => {
  it('prefere filename* (RFC 5987) e decodifica', () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="respostas.xlsx"; filename*=UTF-8\'\'respostas-captacao%C3%A7%C3%A3o.xlsx',
        'x'
      )
    ).toBe('respostas-captacaoção.xlsx');
  });
  it('cai em filename= e depois no fallback', () => {
    expect(filenameFromDisposition('attachment; filename="a.csv"', 'x')).toBe(
      'a.csv'
    );
    expect(filenameFromDisposition(null, 'fallback.csv')).toBe('fallback.csv');
    expect(filenameFromDisposition('attachment', 'fb')).toBe('fb');
  });
  it('filename* malformado cai no filename= em vez de lançar', () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="ok.csv"; filename*=UTF-8\'\'%E0%A4%A',
        'x'
      )
    ).toBe('ok.csv');
  });
});
