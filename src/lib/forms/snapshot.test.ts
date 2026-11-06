import { describe, expect, it } from 'vitest';

import {
  answerToText,
  fileRefsFromSnapshot,
  snapshotAnswers,
  uploadBytesFromSnapshot,
} from './snapshot';
import { leadFields, makeField } from './test-fixtures';

describe('snapshotAnswers (PRD 084 D-4)', () => {
  it('congela rótulo, tipo, valor, pontos e rótulos das opções; texto fixo não entra', () => {
    const fields = [
      ...leadFields(),
      makeField({ key: 'intro', type: 'statement', label: 'Oi' }),
    ];
    const snap = snapshotAnswers(
      fields,
      { phone: '5511999999999', interest: 'now', intro: 'x' },
      { interest: 40 }
    );
    expect(Object.keys(snap)).toEqual(['phone', 'interest']);
    expect(snap.interest).toEqual({
      label: 'interest',
      type: 'single_select',
      value: 'now',
      points: 40,
      option_labels: ['Agora'],
    });
    expect(snap.phone.points).toBe(0);
    expect(snap.phone.option_labels).toBeUndefined();
  });

  it('opção que já não existe fica pelo id (nunca perde a resposta)', () => {
    const field = makeField({
      key: 'm',
      type: 'multi_select',
      options: [{ id: 'a', label: 'A' }],
    });
    const snap = snapshotAnswers([field], { m: ['a', 'sumiu'] });
    expect(snap.m.option_labels).toEqual(['A', 'sumiu']);
  });

  it('answerToText: escolhas pelos rótulos, sim/não como yes/no, arquivos pelo nome', () => {
    const yn = makeField({
      key: 'y',
      type: 'yes_no',
      options: [
        { id: 'yes', label: 'Sim' },
        { id: 'no', label: 'Não' },
      ],
    });
    expect(answerToText(yn, true)).toBe('yes');
    const multi = makeField({
      key: 'm',
      type: 'multi_select',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
    expect(answerToText(multi, ['a', 'b'])).toBe('A, B');
    const file = makeField({ key: 'f', type: 'file_upload' });
    expect(
      answerToText(file, [
        { path: 'p/1.pdf', name: 'um.pdf', mime: 'application/pdf', size: 1 },
      ])
    ).toBe('um.pdf');
    expect(answerToText(makeField({ key: 'n', type: 'number' }), 7.5)).toBe(
      '7.5'
    );
  });

  it('fileRefs e upload_bytes saem do instantâneo', () => {
    const file = makeField({ key: 'f', type: 'file_upload' });
    const refs = [
      { path: 'a/1.pdf', name: '1.pdf', mime: 'application/pdf', size: 100 },
      { path: 'a/2.png', name: '2.png', mime: 'image/png', size: 250 },
    ];
    const snap = snapshotAnswers([file], { f: refs });
    expect(fileRefsFromSnapshot(snap)).toEqual(refs);
    expect(uploadBytesFromSnapshot(snap)).toBe(350);
  });
});
