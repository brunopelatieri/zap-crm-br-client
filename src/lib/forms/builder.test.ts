import { describe, expect, it } from 'vitest';

import {
  createDraftField,
  dependentsOf,
  ensureIdentity,
  identityOf,
  insertDraft,
  isKeyAvailable,
  keyFromLabel,
  maxPossibleScore,
  moveDraft,
  newCid,
  pinIdentity,
  removeDraft,
  renameKey,
  toDraft,
  toPayload,
  uniqueKey,
  type DraftField,
} from './builder';
import { buildFormTemplate } from './templates';
import { buildPreviewPayload } from './preview';
import { findForbiddenPublicKeys } from './project-public';
import { makeForm } from './test-fixtures';
import { validateFormForPublish } from './validate';

const draft = (
  key: string,
  type: DraftField['type'] = 'short_text',
  over: Partial<DraftField> = {}
): DraftField => ({
  ...createDraftField(type, { label: key }, []),
  key,
  ...over,
});

const keys = (fields: DraftField[]) => fields.map((f) => f.key);

describe('keyFromLabel / uniqueKey', () => {
  it('tira acento, vira snake_case e corta em 40', () => {
    expect(keyFromLabel('Qual é o seu nome?')).toBe('qual_e_o_seu_nome');
    expect(keyFromLabel('  ¿Orçamento (R$)?  ')).toBe('orcamento_r');
    expect(keyFromLabel('???', 'nome')).toBe('nome');
    expect(keyFromLabel('a'.repeat(80))).toHaveLength(40);
  });

  it('colisão ganha _2, _3… sem passar de 40 caracteres', () => {
    expect(uniqueKey('nome', ['nome'])).toBe('nome_2');
    expect(uniqueKey('nome', ['nome', 'nome_2'])).toBe('nome_3');
    const long = 'a'.repeat(40);
    const out = uniqueKey(long, [long]);
    expect(out).toHaveLength(40);
    expect(out.endsWith('_2')).toBe(true);
  });
});

describe('createDraftField', () => {
  it('escolha nasce com duas opções de ids únicos; yes_no com yes/no fixos', () => {
    const s = createDraftField('single_select', { label: 'Cor' }, []);
    expect(s.options?.map((o) => o.id)).toEqual(['opt_1', 'opt_2']);
    const yn = createDraftField(
      'yes_no',
      { label: 'Aceita?', options: ['Sim', 'Não'] },
      []
    );
    expect(yn.options?.map((o) => [o.id, o.label])).toEqual([
      ['yes', 'Sim'],
      ['no', 'Não'],
    ]);
  });

  it('padrões por tipo: nota 1–5, arquivo 1, consentimento obrigatório', () => {
    expect(
      createDraftField('rating', { label: 'x' }, []).validation.scale
    ).toBe(5);
    expect(
      createDraftField('file_upload', { label: 'x' }, []).validation.max_files
    ).toBe(1);
    expect(createDraftField('consent', { label: 'x' }, []).required).toBe(true);
    expect(
      createDraftField('short_text', { label: 'x' }, []).options
    ).toBeNull();
  });

  it('chave vem do rótulo e não repete', () => {
    expect(
      createDraftField('short_text', { label: 'Nome' }, ['nome']).key
    ).toBe('nome_2');
  });
});

describe('identidade fixada (PRD D-2)', () => {
  const phone = draft('phone', 'phone', { is_identity: true, required: true });

  it('mover um bloco acima do telefone devolve o telefone ao topo dos blocos com entrada', () => {
    const fields = [phone, draft('a'), draft('b')];
    expect(keys(moveDraft(fields, 2, 0))).toEqual(['phone', 'b', 'a']);
  });

  it('declaração pode vir antes da identidade', () => {
    const fields = [draft('intro', 'statement'), phone, draft('a')];
    expect(keys(pinIdentity(fields))).toEqual(['intro', 'phone', 'a']);
    // Bloco com entrada inserido no topo empurra o telefone para antes dele.
    expect(keys(insertDraft(fields, draft('x'), 0))).toEqual([
      'phone',
      'x',
      'intro',
      'a',
    ]);
  });

  it('inserir um bloco com entrada antes da identidade não a desloca', () => {
    const out = insertDraft([phone, draft('a')], draft('x'), 0);
    expect(identityOf(out)?.key).toBe('phone');
    expect(out.findIndex((f) => f.key === 'phone')).toBeLessThan(
      out.findIndex((f) => f.key === 'x')
    );
  });

  it('ensureIdentity cria o telefone antes do primeiro bloco com entrada; não duplica', () => {
    const out = ensureIdentity([draft('intro', 'statement'), draft('a')], {
      label: 'WhatsApp',
    });
    expect(keys(out)).toEqual(['intro', 'phone', 'a']);
    expect(out[1]).toMatchObject({
      type: 'phone',
      is_identity: true,
      required: true,
    });
    expect(keys(ensureIdentity(out, { label: 'x' }))).toEqual([
      'intro',
      'phone',
      'a',
    ]);
  });

  it('o resultado passa na regra de identidade da publicação', () => {
    const out = ensureIdentity([draft('a'), draft('b')], { label: 'WhatsApp' });
    const issues = validateFormForPublish(
      makeForm({ settings: {} }),
      out.map(toPayload)
    );
    expect(issues.map((i) => i.code)).not.toContain('identity_required');
    expect(issues.map((i) => i.code)).not.toContain('identity_not_first_input');
  });
});

describe('lista: mover, apagar, renomear', () => {
  it('moveDraft renumera as posições', () => {
    const out = moveDraft([draft('a'), draft('b'), draft('c')], 0, 2);
    expect(out.map((f) => [f.key, f.position])).toEqual([
      ['b', 0],
      ['c', 1],
      ['a', 2],
    ]);
  });

  it('índice fora da lista não muda nada', () => {
    expect(keys(moveDraft([draft('a'), draft('b')], 0, 5))).toEqual(['a', 'b']);
  });

  it('apagar limpa show_if e jump_to que apontavam para o bloco', () => {
    const a = draft('a');
    const b = draft('b', 'short_text', {
      show_if: { field_key: 'a', op: 'answered' },
    });
    const c = draft('c', 'single_select', {
      options: [
        { id: 'x', label: 'X', jump_to: 'a' },
        { id: 'y', label: 'Y' },
      ],
    });
    expect(dependentsOf([a, b, c], 'a').map((f) => f.key)).toEqual(['b', 'c']);
    const out = removeDraft([a, b, c], a.cid);
    expect(keys(out)).toEqual(['b', 'c']);
    expect(out[0].show_if).toBeNull();
    expect(out[1].options?.[0].jump_to).toBeNull();
  });

  it('renomear a chave atualiza as referências', () => {
    const a = draft('a');
    const b = draft('b', 'short_text', {
      show_if: { field_key: 'a', op: 'eq', value: 'x' },
    });
    const c = draft('c', 'single_select', {
      options: [{ id: 'x', label: 'X', jump_to: 'a' }],
    });
    const out = renameKey([a, b, c], a.cid, 'novo');
    expect(out[0].key).toBe('novo');
    expect(out[1].show_if?.field_key).toBe('novo');
    expect(out[2].options?.[0].jump_to).toBe('novo');
  });

  it('isKeyAvailable: formato do CHECK e unicidade (ignorando o próprio bloco)', () => {
    const a = draft('a');
    const b = draft('b');
    expect(isKeyAvailable([a, b], a.cid, 'a')).toBe(true);
    expect(isKeyAvailable([a, b], a.cid, 'b')).toBe(false);
    expect(isKeyAvailable([a, b], a.cid, 'Nome')).toBe(false);
    expect(isKeyAvailable([a, b], a.cid, '')).toBe(false);
  });
});

describe('toDraft / toPayload', () => {
  it('bloco gravado usa o id como cid e o devolve; novo não manda id', () => {
    const saved = toDraft({ ...draft('a'), id: 'abc' } as never);
    expect(saved.cid).toBe('abc');
    expect(toPayload(saved)).toHaveProperty('id', 'abc');
    expect(toPayload(saved)).not.toHaveProperty('cid');

    const fresh = toDraft(draft('b'));
    expect(fresh.cid).toBeTruthy();
    const payload = toPayload({ ...fresh, id: undefined });
    expect(payload).not.toHaveProperty('cid');
    expect(newCid()).not.toBe(newCid());
  });
});

describe('prévia usa a projeção pública oficial (E-9)', () => {
  it('o payload da prévia não carrega pontos, mapeamentos nem ids internos', () => {
    const t = buildFormTemplate('lead_capture', 'pt-BR');
    const form = makeForm({
      theme: t.theme,
      settings: t.settings,
      scoring: { bands: t.bands },
    });
    const payload = buildPreviewPayload(form, t.fields);
    expect(payload.identity.mode).toBe('preview');
    expect(payload.fields).toHaveLength(t.fields.length);
    expect(findForbiddenPublicKeys(payload)).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('"points"');
  });
});

describe('maxPossibleScore', () => {
  it('melhor opção por escolha única, soma positiva na múltipla, melhor faixa em número', () => {
    const fields = [
      draft('a', 'single_select', {
        options: [
          { id: 'x', label: 'X', points: 10 },
          { id: 'y', label: 'Y', points: 40 },
        ],
      }),
      draft('b', 'multi_select', {
        options: [
          { id: 'x', label: 'X', points: 5 },
          { id: 'y', label: 'Y', points: 7 },
          { id: 'z', label: 'Z', points: -3 },
        ],
      }),
      draft('c', 'number', {
        validation: {
          points_ranges: [
            { min: 0, max: 9, points: 2 },
            { min: 10, max: null, points: 8 },
          ],
        },
      }),
      draft('d', 'short_text'),
    ];
    expect(maxPossibleScore(fields)).toBe(40 + 12 + 8);
  });

  it('sem pontos é 0 (nunca negativo)', () => {
    expect(maxPossibleScore([])).toBe(0);
    expect(
      maxPossibleScore([
        draft('a', 'yes_no', {
          options: [
            { id: 'yes', label: 'Sim', points: -5 },
            { id: 'no', label: 'Não', points: -1 },
          ],
        }),
      ])
    ).toBe(0);
  });
});
