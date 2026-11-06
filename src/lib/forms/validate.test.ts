import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ID,
  CUSTOM_FIELD_ID,
  FORM_ID,
  leadFields,
  makeField,
  makeForm,
  OTHER_ACCOUNT_ID,
  RESPONSE_ID,
} from './test-fixtures';
import type { Band } from './types';
import {
  validateAnswer,
  validateAnswers,
  validateBands,
  validateFormForPublish,
  type FormIssueCode,
} from './validate';

const codes = (issues: { code: FormIssueCode }[]) => issues.map((i) => i.code);

describe('validateFormForPublish (SPEC 085 §12.1 critério 8)', () => {
  it('formulário de captação bem formado passa sem problemas', () => {
    expect(validateFormForPublish(makeForm(), leadFields())).toEqual([]);
  });

  it('link genérico exige bloco de identidade; só telefone pode ser identidade', () => {
    const noIdentity = leadFields().map((f) => ({ ...f, is_identity: false }));
    expect(codes(validateFormForPublish(makeForm(), noIdentity))).toContain(
      'identity_required'
    );
    // Sem link genérico (só por token) a identidade é dispensável.
    expect(
      validateFormForPublish(
        makeForm({ settings: { accept_generic_link: false } }),
        noIdentity
      )
    ).toEqual([]);

    const wrongType = leadFields().map((f) =>
      f.key === 'name' ? { ...f, is_identity: true } : f
    );
    expect(codes(validateFormForPublish(makeForm(), wrongType))).toEqual(
      expect.arrayContaining(['identity_duplicate', 'identity_not_phone'])
    );
  });

  it('identidade tem de ser o primeiro bloco com entrada', () => {
    const fields = leadFields().map((f) =>
      f.key === 'phone' ? { ...f, position: 10 } : f
    );
    expect(codes(validateFormForPublish(makeForm(), fields))).toContain(
      'identity_not_first_input'
    );
  });

  it('show_if só aponta para bloco anterior; jump_to só para frente e conhecido', () => {
    const fields = [
      ...leadFields(),
      makeField({
        key: 'later',
        type: 'short_text',
        position: 5,
        show_if: { field_key: 'after', op: 'answered' },
      }),
      makeField({
        key: 'after',
        type: 'single_select',
        position: 6,
        options: [
          { id: 'a', label: 'A', jump_to: 'later' },
          { id: 'b', label: 'B', jump_to: 'ghost' },
        ],
      }),
    ];
    const found = codes(validateFormForPublish(makeForm(), fields));
    expect(found).toContain('show_if_forward_ref');
    expect(found).toContain('jump_to_backward');
    expect(found).toContain('jump_to_unknown_field');
  });

  it('chave duplicada, nota fora de 3..10, consentimento opcional e mapeamento incompatível', () => {
    const fields = [
      ...leadFields(),
      makeField({ key: 'name', type: 'long_text', position: 7 }),
      makeField({
        key: 'nota',
        type: 'rating',
        position: 8,
        validation: { scale: 2 },
      }),
      makeField({ key: 'lgpd', type: 'consent', position: 9, required: false }),
      makeField({
        key: 'arquivo',
        type: 'file_upload',
        position: 10,
        mapping: { target: 'contact.name' },
      }),
      makeField({
        key: 'cf',
        type: 'short_text',
        position: 11,
        mapping: { target: 'custom:nao-e-uuid' },
      }),
    ];
    const found = codes(validateFormForPublish(makeForm(), fields));
    expect(found).toContain('key_duplicate');
    expect(found).toContain('rating_scale_invalid');
    expect(found).toContain('consent_must_be_required');
    expect(found.filter((c) => c === 'mapping_target_invalid')).toHaveLength(2);
  });

  it('mapeamento custom por UUID da conta e tag só para opções existentes', () => {
    const ok = [
      ...leadFields(),
      makeField({
        key: 'cf',
        type: 'short_text',
        position: 11,
        mapping: { target: `custom:${CUSTOM_FIELD_ID}` },
      }),
      makeField({
        key: 'tg',
        type: 'dropdown',
        position: 12,
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        mapping: { target: 'tag', tag_by_option: { a: 'tag-1', zz: 'tag-2' } },
      }),
    ];
    expect(codes(validateFormForPublish(makeForm(), ok))).toEqual([
      'mapping_tag_option_unknown',
    ]);
  });

  it('slug reservado/inválido, redirect sem https, origens de embed inválidas ou demais', () => {
    const form = makeForm({
      slug: 'admin',
      theme: { thank_you: { redirect_url: 'http://x.com' } },
      settings: {
        embed_origins: [
          'https://ok.com',
          'http://nao.com',
          'https://com-caminho.com/x',
          ...Array.from({ length: 9 }, (_, i) => `https://s${i}.com`),
        ],
      },
    });
    const found = codes(validateFormForPublish(form, leadFields()));
    expect(found).toContain('slug_reserved');
    expect(found).toContain('redirect_url_not_https');
    expect(found).toContain('embed_origins_too_many');
    expect(found.filter((c) => c === 'embed_origin_invalid')).toHaveLength(2);
    expect(
      codes(validateFormForPublish(makeForm({ slug: 'ab' }), leadFields()))
    ).toContain('slug_invalid');
  });

  it('sem blocos, ou só com texto fixo, não publica', () => {
    expect(codes(validateFormForPublish(makeForm(), []))).toContain(
      'no_fields'
    );
    expect(
      codes(
        validateFormForPublish(
          makeForm({ settings: { accept_generic_link: false } }),
          [makeField({ key: 'intro', type: 'statement' })]
        )
      )
    ).toEqual(['no_input_fields']);
  });
});

describe('validateBands', () => {
  const band = (key: string, min: number, max: number | null): Band => ({
    key,
    label: key,
    min,
    max,
  });

  it('faixas contíguas começando em 0 e terminando aberta passam', () => {
    expect(
      validateBands([band('a', 0, 20), band('b', 21, 60), band('c', 61, null)])
    ).toEqual([]);
    expect(validateBands([])).toEqual([]);
  });

  it('sobreposição, buraco, sem zero e última fechada são acusados', () => {
    expect(
      codes(validateBands([band('a', 0, 20), band('b', 20, null)]))
    ).toEqual(['band_overlap']);
    expect(
      codes(validateBands([band('a', 0, 20), band('b', 25, null)]))
    ).toEqual(['band_gap']);
    expect(codes(validateBands([band('a', 5, null)]))).toEqual([
      'band_no_zero',
    ]);
    expect(codes(validateBands([band('a', 0, 10)]))).toEqual([
      'band_open_end_missing',
    ]);
    expect(
      codes(validateBands([band('a', 0, 10), band('a', 11, null)]))
    ).toEqual(['band_key_duplicate']);
  });
});

describe('validateAnswer por tipo', () => {
  it('e-mail minúsculo, telefone canônico, número aceita vírgula', () => {
    const email = makeField({ key: 'e', type: 'email' });
    expect(validateAnswer(email, ' Fulano@Ex.com ')).toEqual({
      ok: true,
      value: 'fulano@ex.com',
    });
    expect(validateAnswer(email, 'sem-arroba')).toEqual({
      code: 'invalidEmail',
    });

    const phone = makeField({ key: 'p', type: 'phone' });
    expect(validateAnswer(phone, '(11) 99999-9999', { brMode: true })).toEqual({
      ok: true,
      value: '5511999999999',
    });
    expect(validateAnswer(phone, '123', { brMode: true })).toEqual({
      code: 'invalidPhone',
    });

    const num = makeField({
      key: 'n',
      type: 'number',
      validation: { min: 0, max: 10 },
    });
    expect(validateAnswer(num, '7,5')).toEqual({ ok: true, value: 7.5 });
    expect(validateAnswer(num, 11)).toEqual({ code: 'maxValue' });
    expect(validateAnswer(num, 'abc')).toEqual({ code: 'invalidNumber' });
  });

  it('escolhas: opção desconhecida, mínimo/máximo da múltipla, sim/não, nota na escala', () => {
    const multi = makeField({
      key: 'm',
      type: 'multi_select',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      validation: { min_choices: 2, max_choices: 2 },
    });
    expect(validateAnswer(multi, ['a'])).toEqual({ code: 'minChoices' });
    expect(validateAnswer(multi, ['a', 'b', 'c'])).toEqual({
      code: 'maxChoices',
    });
    expect(validateAnswer(multi, ['a', 'zz'])).toEqual({
      code: 'invalidOption',
    });
    expect(validateAnswer(multi, ['a', 'b', 'a'])).toEqual({
      ok: true,
      value: ['a', 'b'],
    });

    const yn = makeField({ key: 'y', type: 'yes_no' });
    expect(validateAnswer(yn, 'yes')).toEqual({ ok: true, value: true });
    expect(validateAnswer(yn, 'talvez')).toEqual({ code: 'invalidType' });

    const rating = makeField({
      key: 'r',
      type: 'rating',
      validation: { scale: 5 },
    });
    expect(validateAnswer(rating, 6)).toEqual({ code: 'invalidNumber' });
    expect(validateAnswer(rating, '3')).toEqual({ ok: true, value: 3 });
  });

  it('arquivos: referência válida, limite de quantidade; consentimento só true; data ISO real', () => {
    const file = makeField({
      key: 'f',
      type: 'file_upload',
      validation: { max_files: 1 },
    });
    const ref = {
      path: 'a/b.pdf',
      name: 'b.pdf',
      mime: 'application/pdf',
      size: 10,
    };
    expect(validateAnswer(file, [ref])).toEqual({ ok: true, value: [ref] });
    expect(validateAnswer(file, [ref, ref])).toEqual({ code: 'tooManyFiles' });
    expect(validateAnswer(file, ['nao-e-ref'])).toEqual({
      code: 'invalidFile',
    });

    const consent = makeField({ key: 'c', type: 'consent', required: true });
    expect(validateAnswer(consent, false)).toEqual({ code: 'consentRequired' });
    expect(validateAnswer(consent, undefined)).toEqual({
      code: 'consentRequired',
    });
    expect(validateAnswer(consent, true)).toEqual({ ok: true, value: true });

    const date = makeField({ key: 'd', type: 'date' });
    expect(validateAnswer(date, '2026-02-30')).toEqual({ code: 'invalidDate' });
    expect(validateAnswer(date, '2026-02-28')).toEqual({
      ok: true,
      value: '2026-02-28',
    });
  });

  it('obrigatório vazio → required; opcional vazio → ok sem valor', () => {
    const req = makeField({ key: 't', type: 'short_text', required: true });
    expect(validateAnswer(req, '   ')).toEqual({ code: 'required' });
    const opt = makeField({ key: 't', type: 'short_text' });
    expect(validateAnswer(opt, '')).toBeNull();
  });
});

describe('validateAnswers (servidor, SPEC 085 §4.2 item 7)', () => {
  it('limpa, normaliza e descarta bloco escondido e chave desconhecida', () => {
    const fields = [
      ...leadFields(),
      makeField({
        key: 'why',
        type: 'short_text',
        position: 4,
        show_if: { field_key: 'interest', op: 'eq', value: 'later' },
      }),
    ];
    const r = validateAnswers(
      fields,
      {
        phone: '11 99999-9999',
        name: '  Ana  ',
        interest: 'now',
        consent: true,
        why: 'não devia entrar',
        hack: 'nem isso',
      },
      { identityMode: 'phone', brMode: true, uploadScope: null }
    );
    expect(r).toEqual({
      ok: true,
      answers: {
        phone: '5511999999999',
        name: 'Ana',
        interest: 'now',
        consent: true,
      },
    });
  });

  it('acumula um erro por bloco', () => {
    const r = validateAnswers(
      leadFields(),
      { phone: 'x', interest: 'zzz' },
      { identityMode: 'phone', brMode: true, uploadScope: null }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(
        expect.arrayContaining([
          { key: 'phone', code: 'invalidPhone' },
          { key: 'name', code: 'required' },
          { key: 'interest', code: 'invalidOption' },
          { key: 'consent', code: 'consentRequired' },
        ])
      );
    }
  });

  it('por token, o bloco de identidade é pulado (PRD D-2) — salvo confirm_phone_with_token', () => {
    const answers = { name: 'Ana', interest: 'now', consent: true };
    expect(
      validateAnswers(leadFields(), answers, {
        identityMode: 'token',
        uploadScope: null,
      })
    ).toEqual({ ok: true, answers });
    const strict = validateAnswers(leadFields(), answers, {
      identityMode: 'token',
      confirmPhoneWithToken: true,
      uploadScope: null,
    });
    expect(strict.ok).toBe(false);
    if (!strict.ok) {
      expect(strict.errors).toEqual([{ key: 'phone', code: 'required' }]);
    }
  });
});

describe('arquivos só dentro da pasta da resposta (E-16)', () => {
  const OBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const scope = {
    accountId: ACCOUNT_ID,
    formId: FORM_ID,
    responseId: RESPONSE_ID,
  };
  const own = {
    path: `account-${ACCOUNT_ID}/${FORM_ID}/${RESPONSE_ID}/${OBJECT}.pdf`,
    name: 'a.pdf',
    mime: 'application/pdf',
    size: 10,
  };
  const foreign = {
    ...own,
    path: `account-${OTHER_ACCOUNT_ID}/${FORM_ID}/${RESPONSE_ID}/${OBJECT}.pdf`,
  };
  const fields = [
    makeField({ key: 'doc', type: 'file_upload', position: 0, required: true }),
  ];
  const base = { identityMode: 'token' as const };

  it('caminho da própria resposta passa; de outra conta é invalidFile', () => {
    expect(
      validateAnswers(fields, { doc: [own] }, { ...base, uploadScope: scope })
    ).toEqual({
      ok: true,
      answers: { doc: [own] },
    });
    expect(
      validateAnswers(
        fields,
        { doc: [foreign] },
        { ...base, uploadScope: scope }
      )
    ).toEqual({ ok: false, errors: [{ key: 'doc', code: 'invalidFile' }] });
  });

  it('sem pasta (prévia) nenhum arquivo é aceito; no cliente, sem escopo, só a forma é checada', () => {
    expect(
      validateAnswers(fields, { doc: [own] }, { ...base, uploadScope: null })
    ).toEqual({ ok: false, errors: [{ key: 'doc', code: 'invalidFile' }] });
    expect(validateAnswer(fields[0], [foreign])).toEqual({
      ok: true,
      value: [foreign],
    });
  });
});

describe('tema e pulos — achados da revisão', () => {
  it('cor de tema fora de hex não publica; hex curto e com alfa passam', () => {
    const bad = makeForm({
      theme: { colors: { primary: 'red;background:url(https://evil)' } },
    });
    expect(codes(validateFormForPublish(bad, leadFields()))).toEqual([
      'theme_color_invalid',
    ]);
    const ok = makeForm({
      theme: {
        colors: { primary: '#abc', background: '#AABBCCDD', text: '#112233' },
      },
    });
    expect(validateFormForPublish(ok, leadFields())).toEqual([]);
  });

  it('jump_to em múltipla escolha tem código próprio; sim/não com opções erradas acusa uma vez', () => {
    const fields = [
      ...leadFields(),
      makeField({
        key: 'multi',
        type: 'multi_select',
        position: 5,
        options: [
          { id: 'a', label: 'A', jump_to: 'end' },
          { id: 'b', label: 'B' },
        ],
      }),
      makeField({
        key: 'yn',
        type: 'yes_no',
        position: 6,
        options: [{ id: 'sim', label: 'Sim' }],
      }),
      makeField({ key: 'end', type: 'short_text', position: 7 }),
    ];
    const found = codes(validateFormForPublish(makeForm(), fields));
    expect(found).toContain('jump_to_not_allowed');
    expect(found).not.toContain('jump_to_unknown_field');
    expect(found.filter((c) => c === 'yes_no_options_invalid')).toHaveLength(1);
  });
});
