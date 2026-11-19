import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Cabeçalhos de segurança básicos aplicados a toda resposta.
 *
 * O CSP é enviado como `Content-Security-Policy-Report-Only` para que
 * o navegador reporte violações no console sem bloquear nada — quando
 * tivermos confiança de que nada legítimo o dispara (dois deploys, um
 * passe em toda rota), trocamos a chave para `Content-Security-Policy`
 * para aplicar de fato.
 *
 * O restante dos cabeçalhos são bloqueios diretos, seguros para
 * aplicar hoje:
 *   - HSTS: só faz sentido em HTTPS (é no-op em http://localhost).
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy:
 *     hardening OWASP básico, sem custo de comportamento.
 *   - Permissions-Policy: não usamos câmera / microfone / etc, então
 *     negamos. Um comprometimento na cadeia de suprimentos ou um
 *     plugin esquecido não consegue reativá-los silenciosamente.
 */
const SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    // O microfone é permitido para same-origin (`self`) para que o
    // compositor da caixa de entrada possa gravar notas de voz via
    // MediaRecorder. Todo o resto permanece negado — uma dependência
    // comprometida não consegue capturar silenciosamente a câmera /
    // geolocalização / etc.
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
  },
  {
    key: 'Content-Security-Policy-Report-Only',
    value: [
      "default-src 'self'",
      // O Next.js precisa de 'unsafe-inline' para seu script de
      // hidratação inline e de 'unsafe-eval' em dev + algumas
      // otimizações de produção. CSP baseado em nonce é um projeto
      // futuro.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind + atributos de estilo inline em muitos componentes.
      "style-src 'self' 'unsafe-inline'",
      // Avatares em bucket público do Supabase, avatares de contato
      // (URLs https arbitrárias que podem ser coladas pela UI),
      // imagens OG, data URLs para pequenos assets inline.
      "img-src 'self' data: blob: https:",
      // Prévias de mídia de saída (blob: do MediaRecorder + seletor
      // de arquivo) e áudio/vídeo em bucket público do Supabase que a
      // caixa de entrada renderiza.
      "media-src 'self' blob: https://*.supabase.co",
      "font-src 'self' data:",
      // REST + realtime (WSS) do Supabase. Todas as chamadas à API da
      // Meta acontecem server-side, então graph.facebook.com não
      // pertence aqui.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
] as const;

/**
 * CSP APLICADA (não Report-Only) das páginas da área do contato (SPEC 083
 * F5-06). `/area` recebe senha e código de acesso, e hoje não há HTML de
 * usuário renderizado, então não há XSS conhecido: isto é defesa em
 * profundidade contra exfiltração. O ganho está em `connect-src 'self'`
 * (um script injetado não manda senha a outro host) e `form-action 'self'`.
 *
 * `'unsafe-inline'` em `script-src` fica enquanto o Next exigir o script
 * inline de hidratação e o `theme-boot` do layout raiz (CSP por nonce é
 * trabalho futuro, como na política Report-Only do resto do app).
 * `'unsafe-eval'` só no `next dev` (o React/HMR de desenvolvimento usa
 * `eval`); o build de produção não o recebe.
 *
 * Calculada dentro de `headers()` para ler `NODE_ENV` na hora. A política
 * Report-Only do catch-all continua valendo também em `/area` (outra
 * chave de cabeçalho, sem conflito): o navegador aplica as duas.
 */
function contactPortalCsp(): string {
  const dev = process.env.NODE_ENV !== 'production';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
  ].join('; ');
}

/**
 * Cabeçalhos de `/f/**` — a página pública dos formulários (SPEC 085 E-12).
 *
 * Idênticos ao catch-all, MENOS `X-Frame-Options` e o `frame-ancestors` do
 * CSP: quem pode embutir um formulário é decidido por formulário (origens
 * de embed cadastradas), e só o middleware conhece o slug — ele manda
 * `Content-Security-Policy: frame-ancestors <origens>` ou, sem origens,
 * `X-Frame-Options: DENY`. Um cabeçalho fixo aqui venceria a decisão.
 *
 * O CSP Report-Only desta página lista o que ela de fato carrega: o
 * Turnstile (script, iframe e conexão), o embed de vídeo (YouTube sem
 * cookies e Vimeo), as imagens assinadas e o PUT direto ao Storage.
 */
function formPageSecurityHeaders() {
  return SECURITY_HEADERS.filter((h) => h.key !== 'X-Frame-Options').map(
    (h) =>
      h.key === 'Content-Security-Policy-Report-Only'
        ? {
            key: h.key,
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co",
              'frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com https://player.vimeo.com',
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          }
        : h
  );
}

const nextConfig: NextConfig = {
  /**
   * Saída `standalone` (só o necessário para rodar: `.next/standalone/server.js`
   * + as dependências que o file tracing encontrou) — usada pela imagem Docker
   * (Dockerfile liga `NEXT_OUTPUT=standalone`), que cai de ~2 GB para algumas
   * centenas de MB. Condicional de propósito: `next dev`, `npm run build` e
   * hospedagens que rodam `next start` (Hostinger) seguem exatamente como
   * antes — `next start` não é o modo de servir um build standalone.
   */
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,

  images: {
    /**
     * A imagem Docker não carrega o `sharp` (~18 MB). Ele atenderia só ao
     * logo da sidebar, um WebP de 4 KB: toda a mídia da aplicação já usa
     * `unoptimized`, porque vem de URL assinada ou de host externo.
     */
    unoptimized: process.env.NEXT_OUTPUT === 'standalone',
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
    ],
  },

  /**
   * Fontes da exportação de conversa (SPEC 067 §6).
   *
   * A rota lê os `.ttf` do disco com `fs` em tempo de execução. O file
   * tracing do Next só copia para o pacote de deploy o que ele consegue
   * enxergar estaticamente — e um `path.join(process.cwd(), ...)` é
   * opaco para ele. Sem esta declaração o `build` PASSA e a rota estoura
   * `ENOENT` **só em produção**, que é exatamente a armadilha "build
   * passa em dev e falha no host" catalogada no AGENTS.md.
   */
  outputFileTracingIncludes: {
    '/api/inbox/conversations/[id]/export': ['./src/lib/inbox/export/fonts/**'],
  },

  /**
   * Política de Cache-Control.
   *
   * Por que isso existe:
   *   O CDN da Hostinger aplicava `s-maxage=31536000` (1 ano) a
   *   páginas HTML pré-renderizadas por padrão. Quando um novo deploy
   *   enviava novos hashes de chunk do Turbopack, a edge continuava
   *   servindo HTML de um ano atrás referenciando nomes de arquivo de
   *   chunk que já não existiam mais em disco — resultado: HTML 200,
   *   mas cada /_next/static/*.js e .css voltava 404, e a página
   *   renderizava sem estilo. Modo privado/anônimo não ajudava porque
   *   o cache é server-side.
   *
   * Estratégia (SPEC 083 §9 — o padrão é privado; público só o que é
   * estático de verdade):
   *   - /_next/static/* e /_next/image — deixamos para o Next. Chunks
   *     de dev do Turbopack podem ficar obsoletos se forçarmos cache
   *     imutável aqui; o Next já emite os cabeçalhos corretos de
   *     produção para assets com hash.
   *   - /api/*          — no-store. Respostas da API são por usuário
   *     e nunca devem ser compartilhadas entre requisições na edge.
   *   - Toda página (CRM, auth, convite, `/area`, console) — `private,
   *     no-store`. Até a SPEC 083 §9 o catch-all era `public, s-maxage=300`,
   *     e ele VENCE o `private, no-cache, no-store` que o Next põe nas
   *     páginas dinâmicas (medido no dev e no `next start` em
   *     2026-10-31: `/dashboard` → 307 com `public`). Com um cache
   *     compartilhado na frente, a página de um usuário (e o Set-Cookie
   *     do refresh de sessão que o middleware anexa) iria para outro.
   *     O motivo original continua atendido, e melhor: com `no-store` a
   *     edge não guarda HTML nenhum, então não há HTML velho apontando
   *     para chunk que já sumiu. Rota nova nasce privada sem lembrar de
   *     nada.
   *   - Arquivos soltos de `public/` (`/og-image.webp`, `/openapi.json`,
   *     `/favicon.ico`…) — público, s-maxage breve + stale-while-
   *     revalidate generoso, como o catch-all antigo: não têm hash no
   *     nome, então um deploy que os troque se autocorrige em ~5 min.
   *   - /emojibase/* e /opus/* — imutáveis (regras próprias abaixo).
   *
   * Os cabeçalhos de segurança são adicionados por uma regra catch-all
   * separada abaixo — o Next.js mescla os cabeçalhos de cada regra
   * correspondente, então eles se aplicam a toda resposta,
   * independente de qual regra de cache foi aplicada.
   */
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        // Padrão de toda página (inclui `/area/**`, SPEC 083 achado
        // A-1, e o 307 que o middleware devolve sem sessão).
        source: '/:path((?!_next/static|_next/image|api|emojibase|opus).*)',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
      {
        // Arquivo solto na raiz de `public/` (ou `src/app/favicon.ico`):
        // um segmento só, com extensão de estático. Nenhuma página tem
        // ponto no nome. Vem DEPOIS do padrão: mesma chave, vale a última.
        source:
          '/:path([^/]+\\.(?:svg|png|jpe?g|gif|webp|avif|ico|json|txt|xml|webmanifest))',
        headers: [
          {
            key: 'Cache-Control',
            value:
              'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
          },
        ],
      },
      {
        // Dados da Emojibase (SPEC 066): o conteúdo é fixo por versão da
        // dependência `emojibase-data` (npm run emoji:sync). Um upgrade
        // troca os bytes E o deploy junto, então cache imutável é seguro
        // e evita revalidar ~780KB por locale a cada 5 min (o que o antigo
        // catch-all público fazia antes da SPEC 083 §9).
        source: '/emojibase/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Worker do encoder Opus (opus-recorder, gravação de voz —
        // achado de code review na SPEC 066: a regra acima cobriu
        // /emojibase mas deixou de fora este outro diretório vendorizado
        // idêntico em espírito). Conteúdo fixo desde que foi vendorizado
        // em `public/opus`; mesmo raciocínio de cache imutável.
        source: '/opus/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // CSP aplicada só nas páginas da área do contato (F5-06). As
        // rotas `/area/api/*` também passam por aqui: inofensivo em JSON.
        source: '/area/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contactPortalCsp() },
        ],
      },
      {
        // Cabeçalhos de segurança em toda resposta, incluindo assets
        // de /_next/static (o nosniff importa lá) e /api/* (HSTS +
        // referrer-policy não fazem mal) — EXCETO `/f/**`, que tem regra
        // própria logo abaixo (sem `X-Frame-Options`, SPEC 085 E-12).
        source: '/:path((?!f/|f$).*)',
        headers: [...SECURITY_HEADERS],
      },
      {
        source: '/f/:path*',
        headers: formPageSecurityHeaders(),
      },
    ];
  },
};

export default withNextIntl(nextConfig);
