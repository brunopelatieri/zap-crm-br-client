// ============================================================
// Slug do formulário (SPEC 085 E-3).
//
// A URL pública é `/f/<slug>` sem id de conta — então o slug é único no
// DEPLOYMENT (UNIQUE em `forms.slug`, 097), e na SPEC 087 vira `/<slug>`
// no domínio do owner. Por isso a lista de reservados cobre também as
// rotas do app: um formulário chamado `admin` ou `area` tomaria o lugar
// de uma tela quando o domínio próprio chegar.
//
// Mesmo regex do CHECK do banco: `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`
// (3–60 caracteres). Mudou de um lado, muda dos dois.
// ============================================================

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 60;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

/**
 * Reservados: os da SPEC (E-3) + os segmentos de primeiro nível das rotas
 * do app (porque na SPEC 087 o slug passa a ser `/<slug>` no domínio
 * próprio) + arquivos que todo navegador pede.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // SPEC 085 E-3
  'api',
  '_next',
  'area',
  'admin',
  'f',
  'static',
  'assets',
  'favicon.ico',
  'robots.txt',
  // Rotas do app (src/app/**)
  'login',
  'signup',
  'forgot-password',
  'reset-password',
  'auth',
  'join',
  'blocked',
  'dashboard',
  'inbox',
  'contacts',
  'pipelines',
  'broadcasts',
  'automations',
  'flows',
  'agents',
  'notifications',
  'activity',
  'plan',
  'settings',
  'forms',
  // Arquivos pedidos por navegadores e rastreadores
  'sitemap.xml',
  'manifest.json',
  'opus',
  'public',
  'new',
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

/** Formato válido (3–60, `[a-z0-9-]`, sem hífen nas pontas) e não reservado. */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !isReservedSlug(slug);
}

/**
 * Nome → slug: tira acento (NFD), minúsculas, tudo que não é `[a-z0-9]`
 * vira `-`, colapsa, apara as pontas e corta em 60 sem terminar em `-`.
 * Devolve `''` quando não sobra nada (o chamador decide o fallback).
 */
export function slugify(input: string): string {
  const base = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return '';
  return base.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, '');
}

/**
 * Sugere um slug livre a partir do nome: `slugify(name)`; curto demais ou
 * reservado ganha o prefixo `form-`; colisão com `taken` ganha `-2`,
 * `-3`, … sempre respeitando o teto de 60. Determinístico — o construtor
 * mostra a sugestão e o `admin` edita.
 */
export function suggestSlug(
  name: string,
  taken: Iterable<string> = []
): string {
  const used = new Set(Array.from(taken, (s) => s.toLowerCase()));
  let base = slugify(name) || 'form';
  if (base.length < SLUG_MIN_LENGTH || isReservedSlug(base)) {
    base = slugify(`form-${base}`);
  }

  const fits = (candidate: string) =>
    isValidSlug(candidate) && !used.has(candidate);

  if (fits(base)) return base;

  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const trimmed = base
      .slice(0, SLUG_MAX_LENGTH - suffix.length)
      .replace(/-+$/g, '');
    const candidate = `${trimmed}${suffix}`;
    if (fits(candidate)) return candidate;
  }
  // 10.000 colisões do mesmo nome não acontecem na prática; o UNIQUE do
  // banco é a última linha de defesa.
  return `${base.slice(0, SLUG_MAX_LENGTH - 9)}-${Date.now().toString(36)}`;
}
