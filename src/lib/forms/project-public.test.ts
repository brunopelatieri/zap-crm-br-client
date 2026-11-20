import { describe, expect, it } from 'vitest';

import {
  findForbiddenPublicKeys,
  PUBLIC_PAYLOAD_FORBIDDEN_KEYS,
  SECONDS_PER_INPUT_FIELD,
  toPublicPayload,
} from './project-public';
import {
  CUSTOM_FIELD_ID,
  leadFields,
  makeField,
  makeForm,
  PIPELINE_ID,
  STAGE_ID,
  TAG_ID,
  USER_ID,
} from './test-fixtures';
import type { Form, FormField } from './types';

/** Formulário com TUDO que é sensível preenchido — o pior caso do E-9. */
function loadedForm(): { form: Form; fields: FormField[] } {
  const form = makeForm({
    theme: {
      logo_path: 'account-x/logo.png',
      colors: { primary: '#000' },
      welcome: {
        title: 'Oi',
        media: { kind: 'image', path: 'account-x/w.png' },
      },
      thank_you: { title: 'Valeu', redirect_url: 'https://ok.com/x' },
    },
    settings: { turnstile: true, confirm_phone_with_token: true },
    scoring: {
      bands: [
        {
          key: 'hot',
          label: 'Quente',
          min: 0,
          max: null,
          actions: {
            tag_ids: [TAG_ID],
            deal: {
              pipeline_id: PIPELINE_ID,
              stage_id: STAGE_ID,
              assign: { mode: 'specific', user_id: USER_ID },
            },
            notify_user_ids: [USER_ID],
          },
        },
      ],
    },
  });
  const fields = [
    ...leadFields(),
    makeField({
      key: 'nota',
      type: 'rating',
      position: 4,
      validation: {
        scale: 10,
        points_ranges: [{ min: 0, max: 10, points: 5 }],
      },
      mapping: { target: `custom:${CUSTOM_FIELD_ID}` },
      media: { kind: 'video', url: 'https://youtu.be/x' },
    }),
    makeField({
      key: 'tg',
      type: 'dropdown',
      position: 5,
      options: [
        { id: 'a', label: 'A', points: 3, jump_to: 'nota' },
        { id: 'b', label: 'B', points: 0 },
      ],
      mapping: { target: 'tag', tag_by_option: { a: TAG_ID } },
    }),
  ];
  return { form, fields };
}

describe('toPublicPayload — contrato E-9 (PRD 084 R-5)', () => {
  it('o JSON público não contém nenhuma chave proibida', () => {
    const { form, fields } = loadedForm();
    const payload = toPublicPayload(form, fields, {
      identity: 'phone',
      signedMedia: { 'account-x/logo.png': 'https://signed/logo' },
      turnstileSiteKey: 'site-key',
    });
    const json = JSON.stringify(payload);
    for (const key of PUBLIC_PAYLOAD_FORBIDDEN_KEYS) {
      expect(json).not.toContain(`"${key}"`);
    }
    expect(findForbiddenPublicKeys(payload)).toEqual([]);
    // Valores sensíveis também não vazam pelo valor.
    expect(json).not.toContain(TAG_ID);
    expect(json).not.toContain(USER_ID);
    expect(json).not.toContain(CUSTOM_FIELD_ID);
    expect(json).not.toContain(form.account_id);
  });

  it('findForbiddenPublicKeys acusa uma chave proibida aninhada', () => {
    expect(
      findForbiddenPublicKeys({ a: [{ b: { account_id: 'x' } }] })
    ).toEqual(['account_id']);
    expect(findForbiddenPublicKeys({ fields: [{ tag_ids: [] }] })).toEqual([
      'tag_ids',
    ]);
  });

  it('opções saem só com id, rótulo e pulo; validação sem points_ranges', () => {
    const { form, fields } = loadedForm();
    const payload = toPublicPayload(form, fields, { identity: 'phone' });
    const tg = payload.fields.find((f) => f.key === 'tg')!;
    expect(tg.options).toEqual([
      { id: 'a', label: 'A', jump_to: 'nota' },
      { id: 'b', label: 'B' },
    ]);
    const nota = payload.fields.find((f) => f.key === 'nota')!;
    expect(nota.validation).toEqual({ scale: 10 });
    expect(nota.media).toEqual({ kind: 'video', url: 'https://youtu.be/x' });
  });

  it('mídia sem URL assinada sai null, nunca o caminho do bucket', () => {
    const { form, fields } = loadedForm();
    const payload = toPublicPayload(form, fields, { identity: 'phone' });
    expect(payload.theme.logo_url).toBeNull();
    expect(payload.theme.welcome.media).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('account-x/');
    const signed = toPublicPayload(form, fields, {
      identity: 'phone',
      signedMedia: { 'account-x/w.png': 'https://signed/w' },
    });
    expect(signed.theme.welcome.media).toEqual({
      kind: 'image',
      url: 'https://signed/w',
    });
  });

  it('tempo estimado = blocos com entrada × 10 s; turnstile só com chave e ligado', () => {
    const { form, fields } = loadedForm();
    const withStatement = [
      ...fields,
      makeField({ key: 'intro', type: 'statement', position: 99 }),
    ];
    const payload = toPublicPayload(form, withStatement, {
      identity: 'token',
      turnstileSiteKey: 'site-key',
    });
    expect(payload.estimated_seconds).toBe(6 * SECONDS_PER_INPUT_FIELD);
    expect(payload.identity).toEqual({ mode: 'token' });
    expect(payload.settings.turnstile_site_key).toBe('site-key');
    expect(payload.settings.confirm_phone_with_token).toBe(true);

    const off = toPublicPayload(
      makeForm({ settings: { turnstile: false } }),
      fields,
      { identity: 'phone', turnstileSiteKey: 'site-key' }
    );
    expect(off.settings.turnstile_site_key).toBeNull();
  });

  it('uploads_available: verdadeiro por padrão, falso quando a quota de upload acabou', () => {
    const { form, fields } = loadedForm();
    expect(
      toPublicPayload(form, fields, { identity: 'phone' }).settings
        .uploads_available
    ).toBe(true);
    expect(
      toPublicPayload(form, fields, {
        identity: 'phone',
        uploadsAvailable: false,
      }).settings.uploads_available
    ).toBe(false);
  });

  it('redirect sem https é descartado na projeção', () => {
    const form = makeForm({
      theme: { thank_you: { redirect_url: 'http://inseguro.com' } },
    });
    expect(
      toPublicPayload(form, leadFields(), { identity: 'phone' }).theme.thank_you
        .redirect_url
    ).toBeNull();
  });
});

describe('cores do tema (achado da revisão)', () => {
  it('só hex chega ao payload; o resto é descartado', () => {
    const form = makeForm({
      theme: {
        colors: {
          primary: '#16a34a',
          background: 'url(https://evil)',
          text: '#fff;--x:1',
          button: '#ABCDEF80',
        },
      },
    });
    expect(
      toPublicPayload(form, leadFields(), { identity: 'phone' }).theme.colors
    ).toEqual({ primary: '#16a34a', button: '#ABCDEF80' });
  });
});

describe('phone_proof (F7)', () => {
  const { fields } = loadedForm();
  const on = makeForm({ settings: { require_phone_proof: true } });

  it('só no modo telefone: com token o link já prova o contato', () => {
    const phone = toPublicPayload(on, fields, { identity: 'phone' });
    expect(phone.settings.phone_proof).toBe(true);
    const token = toPublicPayload(on, fields, { identity: 'token' });
    expect(token.settings.phone_proof).toBe(false);
  });

  it('desligado (padrão) não liga, e a chave interna não vaza no JSON', () => {
    const off = toPublicPayload(makeForm({ settings: {} }), fields, {
      identity: 'phone',
    });
    expect(off.settings.phone_proof).toBe(false);
    const json = JSON.stringify(
      toPublicPayload(on, fields, { identity: 'phone' })
    );
    expect(json).not.toContain('require_phone_proof');
  });
});
