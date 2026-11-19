// ============================================================
// Página pública `/f/[slug]` (SPEC 085 §4.2 item 1, E-8, E-10; PRD 084
// D-11, R-5). Banco e Storage são dublês (`test-public-world.ts`).
//
// O que se prova: a página neutra é IDÊNTICA (HTML e metadados) para todo
// motivo de indisponibilidade; o payload entregue ao navegador não leva
// `account_id`, pontos, faixas, ids nem `contact_id`; o token do link
// vira `identity.mode = 'token'` só quando válido (adulterado degrada para
// o telefone); o idioma é o do formulário, não o do visitante.
// ============================================================

import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findForbiddenPublicKeys } from '@/lib/forms/project-public';
import { signFormLink } from '@/lib/forms/link-token';
import { ACCOUNT_ID, FORM_ID, TAG_ID } from '@/lib/forms/test-fixtures';
import {
  createWorld,
  defaultFields,
  defaultForm,
  EXISTING_CONTACT_ID,
  SLUG,
  type World,
} from '@/lib/forms/test-public-world';
import type { AvailabilityReason } from '@/lib/forms/availability';

const h = vi.hoisted(() => ({ world: null as unknown as World }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => h.world.db }));

import PublicFormPage, { generateMetadata } from './page';

const SECRET = 'a'.repeat(48);

function props(slug = SLUG, t?: string) {
  return {
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve(t === undefined ? {} : { t }),
  };
}

async function render(slug = SLUG, t?: string) {
  return renderToString(await PublicFormPage(props(slug, t)));
}

/** O payload que a página entrega ao componente cliente. */
async function payloadOf(slug = SLUG, t?: string) {
  const el = (await PublicFormPage(props(slug, t))) as {
    props: { children: Array<{ props?: { payload?: unknown } } | null> };
  };
  const live = el.props.children.find((c) => c?.props && 'payload' in c.props);
  return live?.props?.payload as
    { identity: { mode: string }; locale: string } | undefined;
}

beforeEach(() => {
  h.world = createWorld();
  vi.stubEnv('FORM_LINK_SECRET', SECRET);
  vi.stubEnv('TURNSTILE_SITE_KEY', '');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const REASONS: AvailabilityReason[] = [
  'not_found',
  'not_published',
  'account_blocked',
  'feature_not_in_plan',
  'responses_quota',
  'contacts_quota',
];

describe('página neutra', () => {
  it('é a MESMA (HTML e metadados) para qualquer motivo e para slug inexistente', async () => {
    const pages = new Set<string>();
    const metas = new Set<string>();
    for (const reason of REASONS) {
      h.world.state.availability = reason;
      pages.add(await render());
      metas.add(JSON.stringify(await generateMetadata(props())));
    }
    // Slug com forma inválida nem chega ao banco e dá o mesmo resultado.
    pages.add(await render('A_B'));
    metas.add(JSON.stringify(await generateMetadata(props('A_B'))));
    // Formulário só com link pessoal aberto sem token.
    h.world.state.availability = 'ok';
    h.world.state.form = defaultForm({
      settings: { accept_generic_link: false },
    });
    pages.add(await render());
    metas.add(JSON.stringify(await generateMetadata(props())));

    expect(pages.size).toBe(1);
    expect(metas.size).toBe(1);
    const html = [...pages][0];
    expect(html).toContain('Este formulário não está disponível');
    expect(html).not.toContain(SLUG);
    expect(JSON.parse([...metas][0]).robots).toEqual({
      index: false,
      follow: false,
    });
  });

  it('exceção ao carregar também é a página neutra (fail-closed)', async () => {
    h.world.db.rpc = async () => {
      throw new Error('banco fora');
    };
    h.world.state.availability = 'ok';
    const html = await render();
    expect(html).toContain('Este formulário não está disponível');
  });
});

describe('página disponível', () => {
  it('o payload não tem nenhuma chave proibida nem id da conta, de etiqueta ou de contato', async () => {
    h.world.state.form = defaultForm({
      scoring: {
        bands: [
          {
            key: 'hot',
            label: 'Quente',
            min: 0,
            max: null,
            actions: { tag_ids: [TAG_ID], notify_user_ids: [TAG_ID] },
          },
        ],
      },
    });
    const payload = await payloadOf();
    expect(payload).toBeDefined();
    expect(findForbiddenPublicKeys(payload)).toEqual([]);
    const json = JSON.stringify(payload);
    for (const secret of [ACCOUNT_ID, TAG_ID, FORM_ID, EXISTING_CONTACT_ID]) {
      expect(json).not.toContain(secret);
    }
    // Opções saem sem pontos.
    expect(json).not.toContain('"points"');
  });

  it('o idioma do texto de sistema é o do formulário', async () => {
    h.world.state.form = defaultForm({ locale: 'en' });
    const html = await render();
    expect(html).toContain('lang="en"');
    expect(html).toContain('Made with');
    expect(html).not.toContain('Feito com');
    expect((await payloadOf())?.locale).toBe('en');
  });

  it('token válido → modo token e página fora dos buscadores; adulterado → telefone', async () => {
    h.world.state.contacts.push({
      id: EXISTING_CONTACT_ID,
      account_id: ACCOUNT_ID,
      name: null,
      phone_normalized: '5511000000000',
    });
    const good = signFormLink({
      formId: FORM_ID,
      contactId: EXISTING_CONTACT_ID,
      source: 'inbox',
    })!;
    expect((await payloadOf(SLUG, good))?.identity.mode).toBe('token');
    expect((await generateMetadata(props(SLUG, good))).robots).toEqual({
      index: false,
      follow: false,
    });

    const tampered = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect((await payloadOf(SLUG, tampered))?.identity.mode).toBe('phone');
    expect((await generateMetadata(props(SLUG, tampered))).robots).toEqual({
      index: true,
      follow: true,
    });
    // Sem o contato na conta, o token válido também volta a pedir o telefone.
    h.world.state.contacts = [];
    expect((await payloadOf(SLUG, good))?.identity.mode).toBe('phone');
  });

  it('robots_noindex do formulário vale mesmo sem token', async () => {
    h.world.state.form = defaultForm({ settings: { robots_noindex: true } });
    expect((await generateMetadata(props())).robots).toEqual({
      index: false,
      follow: false,
    });
  });

  it('quota de upload cheia: o payload avisa que não há upload; com folga, avisa que há', async () => {
    h.world.state.fields = defaultFields();
    h.world.state.uploadQuota = { used_bytes: 10, limit_bytes: 10 };
    const full = (await payloadOf()) as unknown as {
      settings: { uploads_available: boolean };
    };
    expect(full.settings.uploads_available).toBe(false);
    h.world.state.uploadQuota = { used_bytes: 0, limit_bytes: null };
    const room = (await payloadOf()) as unknown as {
      settings: { uploads_available: boolean };
    };
    expect(room.settings.uploads_available).toBe(true);
  });

  it('cor do fundo só entra no <style> quando é hex válido', async () => {
    h.world.state.form = defaultForm({
      theme: { colors: { background: '#112233' } },
    });
    expect(await render()).toContain(
      'html,body{background:#112233 !important}'
    );
    h.world.state.form = defaultForm({
      theme: { colors: { background: 'red;}</style><script>x</script>' } },
    });
    const html = await render();
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain('background:red');
  });
});
