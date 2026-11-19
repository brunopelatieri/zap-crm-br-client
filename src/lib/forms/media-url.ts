// ============================================================
// URL de vídeo por etapa (SPEC 085 E-16): só EMBED de YouTube (sem cookie)
// e Vimeo. Vídeo não passa pelo Storage (custaria quota e banda). Puro,
// importável do cliente (a página pública confere de novo antes de
// renderizar o iframe).
// ============================================================

/**
 * Aceita links de YouTube (`watch?v=`, `youtu.be/`, `embed/`, `shorts/`) e
 * Vimeo (`vimeo.com/<id>`, `player.vimeo.com/video/<id>`) e devolve a URL
 * de EMBED sem cookie. Qualquer outra coisa → `null`. O vídeo não passa
 * pelo Storage (custaria quota e banda).
 */
export function normalizeVideoEmbedUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  const ytId = (id: string | null | undefined) =>
    id && /^[A-Za-z0-9_-]{11}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : null;

  if (host === 'youtu.be') return ytId(u.pathname.slice(1).split('/')[0]);
  if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    if (u.pathname === '/watch') return ytId(u.searchParams.get('v'));
    const m = /^\/(?:embed|shorts)\/([^/]+)/.exec(u.pathname);
    return m ? ytId(m[1]) : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/)?(\d{5,12})(?:\/|$)/.exec(u.pathname);
    return m ? `https://player.vimeo.com/video/${m[1]}` : null;
  }
  return null;
}

const TRUSTED_EMBED_HOSTS: ReadonlySet<string> = new Set([
  'www.youtube-nocookie.com',
  'player.vimeo.com',
]);

/** O iframe só renderiza URL de embed já normalizada (defesa em profundidade). */
export function isTrustedEmbedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && TRUSTED_EMBED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
