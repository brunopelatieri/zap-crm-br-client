import { describe, expect, it } from 'vitest';

import {
  isOwnedMediaPath,
  normalizeVideoEmbedUrl,
  parseCreateBody,
  parseDuplicateBody,
  parseFieldsBody,
  parseFormPatch,
  parseLinkBody,
  parseScoring,
  parseTheme,
} from './account-input';
import {
  ACCOUNT_ID,
  CONTACT_ID,
  FORM_ID,
  OTHER_ACCOUNT_ID,
} from './test-fixtures';

const scope = { accountId: ACCOUNT_ID };
const MEDIA_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWN_PATH = `account-${ACCOUNT_ID}/${FORM_ID}/${MEDIA_ID}.png`;

describe('normalizeVideoEmbedUrl (E-16)', () => {
  it.each([
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    [
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    ['https://vimeo.com/123456789', 'https://player.vimeo.com/video/123456789'],
    [
      'https://player.vimeo.com/video/123456789',
      'https://player.vimeo.com/video/123456789',
    ],
  ])('%s → embed', (input, out) => {
    expect(normalizeVideoEmbedUrl(input)).toBe(out);
  });

  it.each([
    'http://youtu.be/dQw4w9WgXcQ',
    'https://evil.example/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=curto',
    'https://vimeo.com/abc',
    'javascript:alert(1)',
    'não é url',
  ])('recusa %s', (input) => {
    expect(normalizeVideoEmbedUrl(input)).toBeNull();
  });
});

describe('isOwnedMediaPath', () => {
  it('só a pasta da própria conta', () => {
    expect(isOwnedMediaPath(OWN_PATH, ACCOUNT_ID)).toBe(true);
    expect(isOwnedMediaPath(OWN_PATH, OTHER_ACCOUNT_ID)).toBe(false);
    expect(
      isOwnedMediaPath(`account-${ACCOUNT_ID}/../x/${MEDIA_ID}.png`, ACCOUNT_ID)
    ).toBe(false);
    expect(isOwnedMediaPath('qualquer/coisa.png', ACCOUNT_ID)).toBe(false);
  });
});

describe('parseCreateBody', () => {
  it('padrões: modelo em branco, pt-BR, sem nome', () => {
    expect(parseCreateBody({})).toEqual({
      ok: true,
      value: { template: 'blank', locale: 'pt-BR', name: null },
    });
  });
  it('recusa modelo e idioma desconhecidos', () => {
    expect(parseCreateBody({ template: 'x' }).ok).toBe(false);
    expect(parseCreateBody({ locale: 'fr' }).ok).toBe(false);
    expect(parseCreateBody(null).ok).toBe(false);
  });
  it('apara e corta o nome', () => {
    const r = parseCreateBody({ name: `  ${'a'.repeat(300)}  ` });
    expect(r.ok && r.value.name).toHaveLength(120);
  });
});

describe('parseFormPatch', () => {
  it('só as chaves conhecidas entram; o resto some', () => {
    const r = parseFormPatch(
      { name: ' Novo ', account_id: 'x', version: 99, status: 'published' },
      scope
    );
    expect(r).toEqual({ ok: true, value: { name: 'Novo' } });
  });

  it('recusa nome vazio, visibilidade inválida e idioma inválido', () => {
    expect(parseFormPatch({ name: '  ' }, scope).ok).toBe(false);
    expect(parseFormPatch({ portal_visibility: 'all' }, scope).ok).toBe(false);
    expect(parseFormPatch({ locale: 'es' }, scope).ok).toBe(false);
  });

  it('slug vai minúsculo', () => {
    const r = parseFormPatch({ slug: ' Minha-Pagina ' }, scope);
    expect(r.ok && r.value.slug).toBe('minha-pagina');
  });

  it('descrição vazia vira null', () => {
    const r = parseFormPatch({ description: '' }, scope);
    expect(r.ok && r.value.description).toBeNull();
  });
});

describe('parseTheme', () => {
  it('imagem do tema só dentro da pasta da conta', () => {
    expect(parseTheme({ logo_path: OWN_PATH }, scope).ok).toBe(true);
    expect(
      parseTheme(
        { logo_path: `account-${OTHER_ACCOUNT_ID}/${FORM_ID}/${MEDIA_ID}.png` },
        scope
      ).ok
    ).toBe(false);
    expect(
      parseTheme(
        { welcome: { media: { kind: 'image', path: '/etc/passwd' } } },
        scope
      ).ok
    ).toBe(false);
  });

  it('vídeo do boas-vindas é normalizado; link estranho é recusado', () => {
    const ok = parseTheme(
      {
        welcome: {
          media: { kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' },
        },
      },
      scope
    );
    expect(ok.ok && ok.value.welcome?.media).toEqual({
      kind: 'video',
      url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
    expect(
      parseTheme(
        {
          welcome: { media: { kind: 'video', url: 'https://evil.example/v' } },
        },
        scope
      ).ok
    ).toBe(false);
  });

  it('fonte/raio fora da lista somem; cor não-hex passa (a publicação recusa)', () => {
    const r = parseTheme(
      { font: 'comic', radius: 'round', colors: { primary: 'red' } },
      scope
    );
    expect(r.ok && r.value).toEqual({ colors: { primary: 'red' } });
  });
});

describe('parseScoring', () => {
  it('lê faixas com ações e descarta lixo', () => {
    const r = parseScoring({
      bands: [
        {
          key: 'hot',
          label: 'Quente',
          min: 61,
          max: null,
          actions: {
            tag_ids: ['t1', 5, ''],
            deal: {
              pipeline_id: 'p',
              stage_id: 's',
              assign: { mode: 'round_robin' },
            },
            notify_user_ids: ['u1'],
            extra: 1,
          },
        },
      ],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        bands: [
          {
            key: 'hot',
            label: 'Quente',
            min: 61,
            max: null,
            actions: {
              tag_ids: ['t1'],
              notify_user_ids: ['u1'],
              deal: {
                pipeline_id: 'p',
                stage_id: 's',
                assign: { mode: 'round_robin', user_id: null },
              },
            },
          },
        ],
      },
    });
  });

  it('recusa faixa sem chave/min e mais de 20 faixas', () => {
    expect(parseScoring({ bands: [{ label: 'x' }] }).ok).toBe(false);
    expect(
      parseScoring({
        bands: Array.from({ length: 21 }, (_, i) => ({
          key: `b${i}`,
          label: 'x',
          min: i,
          max: null,
        })),
      }).ok
    ).toBe(false);
  });
});

describe('parseFieldsBody', () => {
  const field = (over: Record<string, unknown> = {}) => ({
    key: 'nome',
    type: 'short_text',
    label: 'Nome',
    ...over,
  });

  it('normaliza e numera as posições pela ordem do array', () => {
    const r = parseFieldsBody(
      { fields: [field({ key: 'a' }), field({ key: 'b', required: true })] },
      scope
    );
    expect(r.ok && r.value.map((f) => [f.key, f.position, f.required])).toEqual(
      [
        ['a', 0, false],
        ['b', 1, true],
      ]
    );
  });

  it('recusa tipo desconhecido, chave inválida, id que não é UUID, lista longa demais', () => {
    expect(parseFieldsBody({ fields: [field({ type: 'x' })] }, scope).ok).toBe(
      false
    );
    expect(
      parseFieldsBody({ fields: [field({ key: 'Nome!' })] }, scope).ok
    ).toBe(false);
    expect(parseFieldsBody({ fields: [field({ id: 'nope' })] }, scope).ok).toBe(
      false
    );
    expect(parseFieldsBody({ fields: 'x' }, scope).ok).toBe(false);
    expect(
      parseFieldsBody(
        {
          fields: Array.from({ length: 101 }, (_, i) =>
            field({ key: `k${i}` })
          ),
        },
        scope
      ).ok
    ).toBe(false);
  });

  it('is_identity só vale em phone; options só em bloco de escolha', () => {
    const r = parseFieldsBody(
      {
        fields: [
          field({
            key: 'a',
            is_identity: true,
            options: [{ id: 'x', label: 'X' }],
          }),
          field({
            key: 'p',
            type: 'phone',
            is_identity: true,
            required: true,
          }),
          field({
            key: 's',
            type: 'single_select',
            options: [
              { id: 'x', label: 'X', points: 3.9, jump_to: 'p' },
              { id: 'y', label: 'Y' },
            ],
          }),
        ],
      },
      scope
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0].is_identity).toBe(false);
    expect(r.value[0].options).toBeNull();
    expect(r.value[1].is_identity).toBe(true);
    expect(r.value[2].options?.[0]).toEqual({
      id: 'x',
      label: 'X',
      points: 3,
      jump_to: 'p',
    });
  });

  it('mídia de bloco: caminho de outra conta é recusado', () => {
    const bad = parseFieldsBody(
      {
        fields: [
          field({
            media: {
              kind: 'image',
              path: `account-${OTHER_ACCOUNT_ID}/${FORM_ID}/${MEDIA_ID}.png`,
            },
          }),
        ],
      },
      scope
    );
    expect(bad.ok).toBe(false);
    const good = parseFieldsBody(
      { fields: [field({ media: { kind: 'image', path: OWN_PATH } })] },
      scope
    );
    expect(good.ok).toBe(true);
  });

  it('show_if inválido (operador) é descartado; mapping é saneado', () => {
    const r = parseFieldsBody(
      {
        fields: [
          field({
            show_if: { field_key: 'a', op: 'matches', value: 'x' },
            mapping: { target: 'contact.name', overwrite: true, lixo: 1 },
          }),
        ],
      },
      scope
    );
    expect(r.ok && r.value[0].show_if).toBeNull();
    expect(r.ok && r.value[0].mapping).toEqual({
      target: 'contact.name',
      overwrite: true,
    });
  });
});

describe('parseLinkBody / parseDuplicateBody', () => {
  it('link: contato UUID e origem válida (padrão inbox)', () => {
    expect(parseLinkBody({ contact_id: CONTACT_ID })).toEqual({
      ok: true,
      value: { contactId: CONTACT_ID, source: 'inbox' },
    });
    expect(parseLinkBody({ contact_id: 'x' }).ok).toBe(false);
    expect(parseLinkBody({ contact_id: CONTACT_ID, source: 'sms' }).ok).toBe(
      false
    );
  });
  it('duplicar: corpo opcional', () => {
    expect(parseDuplicateBody(null)).toEqual({
      ok: true,
      value: { name: null },
    });
    expect(parseDuplicateBody({ name: ' Cópia ' })).toEqual({
      ok: true,
      value: { name: 'Cópia' },
    });
  });
});
