import type { Metadata } from 'next';
import { cache } from 'react';

import { HtmlLang } from '@/components/forms/public/html-lang';
import { PublicFormLive } from '@/components/forms/public/public-form-live';
import { Unavailable } from '@/components/forms/public/unavailable';
import { isSlugShape } from '@/lib/forms/public-api';
import { loadPublicFormMessages } from '@/lib/forms/public-messages';
import {
  loadPublicFormPage,
  type PublicPageState,
} from '@/lib/forms/public-service';
import { isCssHexColor } from '@/lib/forms/types';
import { getDeploymentLocale } from '@/lib/i18n/deployment-locale';

// Página pública do formulário (SPEC 085 §4.2 item 1, E-8, E-10, E-11).
//
// Sem sessão (o middleware sai cedo em `/f/**`). Qualquer motivo de
// indisponibilidade renderiza a MESMA página neutra, com HTTP 200 e sem
// revelar se o slug existe. Os textos de sistema vêm do idioma do
// FORMULÁRIO, nunca do cookie do visitante.

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const tokenOf = (sp: Awaited<Props['searchParams']>): string | null =>
  typeof sp.t === 'string' ? sp.t : null;

// `generateMetadata` e a página pedem a mesma coisa: um carregamento só.
const load = cache(
  async (slug: string, token: string | null): Promise<PublicPageState> =>
    isSlugShape(slug)
      ? loadPublicFormPage(slug, token)
      : { kind: 'unavailable' }
);

const NOINDEX = { index: false, follow: false } as const;

export async function generateMetadata({
  params,
  searchParams,
}: Props): Promise<Metadata> {
  const { slug } = await params;
  const state = await load(slug, tokenOf(await searchParams));

  if (state.kind === 'unavailable') {
    const messages = await loadPublicFormMessages(getDeploymentLocale());
    return {
      title: messages['unavailable.title'],
      description: messages['unavailable.body'],
      robots: NOINDEX,
      alternates: {},
      openGraph: { title: messages['unavailable.title'] },
      twitter: { card: 'summary', title: messages['unavailable.title'] },
    };
  }

  const { payload } = state;
  const description = payload.description ?? undefined;
  return {
    title: payload.name,
    description,
    robots: state.noindex ? NOINDEX : { index: true, follow: true },
    // Herda do layout raiz o canonical do site: cada formulário tem o seu.
    alternates: {},
    openGraph: { type: 'website', title: payload.name, description },
    twitter: { card: 'summary', title: payload.name, description },
  };
}

export default async function PublicFormPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const state = await load(slug, tokenOf(await searchParams));

  if (state.kind === 'unavailable') {
    const locale = getDeploymentLocale();
    const messages = await loadPublicFormMessages(locale);
    return (
      <Unavailable
        lang={locale}
        title={messages['unavailable.title']}
        body={messages['unavailable.body']}
      />
    );
  }

  const { payload, messages } = state;
  const bg = payload.theme.colors.background;
  return (
    <>
      {/* A cor do fundo do formulário também pinta o `body` (rolagem elástica,
          áreas fora do cartão). Só hex validado chega aqui (`projectColors`). */}
      {isCssHexColor(bg) ? (
        <style>{`html,body{background:${bg} !important}`}</style>
      ) : null}
      <HtmlLang locale={payload.locale} />
      <PublicFormLive payload={payload} messages={messages} />
    </>
  );
}
