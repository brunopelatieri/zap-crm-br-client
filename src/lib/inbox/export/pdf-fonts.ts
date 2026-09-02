/**
 * Carrega e embute as fontes do PDF de exportação (SPEC 067 §6).
 *
 * As 14 fontes padrão do `pdf-lib` são WinAnsi e não têm como
 * representar acentuação fora do Latin-1, cirílico ou emoji. Logo:
 * fonte embutida via `fontkit`, obrigatoriamente.
 *
 * **O que o teste empírico mostrou, e que corrige a premissa da SPEC:**
 * com fonte EMBUTIDA, `drawText` de um caractere sem glifo **não lança**
 * — devolve `.notdef` e o documento sai com um retângulo vazio no lugar.
 * Ou seja, o risco real não é a rota estourar, é o documento jurídico
 * sair com "tofu" no meio da frase. É por isso que `sanitizeForPdf`
 * (§6) continua obrigatório: sem ele o caractere não some, ele *aparece
 * errado*.
 *
 * **Limite conhecido de cobertura:** `NotoSans-Regular` cobre latino,
 * cirílico e grego — NÃO cobre CJK nem árabe (medido: `漢` e `ع` não têm
 * glifo em nenhuma das duas fontes). Uma conversa nesses alfabetos perde
 * o texto na sanitização. Cobrir isso exigiria vendorizar NotoSansJP /
 * SC / Arabic, ~5 MB cada, o que extrapola o D-11.
 *
 * **Por que a fonte de emoji NÃO é subsetada (e as de texto são).**
 * Duas armadilhas medidas na inspeção visual do PDF, nenhuma delas
 * detectável por teste de "não lançou":
 *
 *   1. O `NotoEmoji` publicado pelo Google Fonts é uma fonte VARIÁVEL
 *      (`NotoEmoji[wght].ttf`). O subsetter do `pdf-lib` produz glifos
 *      vazios a partir dela. O arquivo vendorizado aqui é a instância
 *      ESTÁTICA em wght=400, gerada com
 *      `python -m fontTools.varLib.instancer "NotoEmoji[wght].ttf"
 *      wght=400` (886 KB contra 1,98 MB da variável).
 *   2. Mesmo estática, o subsetter do `pdf-lib` deixa de emitir parte
 *      dos glifos — 👍 e 👋 saem, 👨/👩/👧 saem em branco, e qualquer
 *      ligadura ZWJ (👨‍👩‍👧) some. Sem subset, todos renderizam, família
 *      inclusive. O preço é ~580 KB de fonte embutida, pago SÓ quando o
 *      documento realmente tem emoji (ver `documentNeedsEmojiFont`).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';

export interface GlyphCoverage {
  /**
   * Decide se o code point deve ser desenhado com a fonte de EMOJI —
   * alimenta `splitRuns`.
   *
   * ⚠️ Não é o mesmo que "a fonte de emoji tem esse glifo". A
   * `NotoEmoji` cobre espaço, dígitos e boa parte do ASCII, porque
   * `0️⃣`, `#️⃣` e `*️⃣` são sequências que começam nesses caracteres.
   * Perguntar só "tem glifo de emoji?" mandava **espaço e número** para
   * a fonte de emoji: o espaço saía com 15,23pt em vez de 3,12pt (texto
   * esparramado, quebra de linha prematura) e os dígitos saíam como
   * símbolos errados. A fonte de texto é a primária; a de emoji só
   * entra no que ela não cobre.
   */
  usesEmojiFont: (codePoint: number) => boolean;
  /** Cobertura de QUALQUER uma das duas — alimenta `sanitizeForPdf`. */
  isCovered: (codePoint: number) => boolean;
}

export interface LoadedFonts extends GlyphCoverage {
  /** Corpo do texto. */
  text: PDFFont;
  /** Nomes de remetente, cabeçalhos. */
  semibold: PDFFont;
  /**
   * Emoji monocromático (D-4). `null` quando o documento não tem emoji
   * nenhum — embutir 580 KB de fonte à toa num PDF de conversa só de
   * texto seria desperdício puro.
   */
  emoji: PDFFont | null;
}

const FONT_DIR = 'src/lib/inbox/export/fonts';

export const FONT_FILES = {
  regular: 'NotoSans-Regular.ttf',
  semibold: 'NotoSans-SemiBold.ttf',
  emoji: 'NotoEmoji-Regular.ttf',
} as const;

interface FontkitFont {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

interface FontBundle {
  bytes: Buffer;
  coverage: FontkitFont;
}

/**
 * Cache de módulo: 3 MB de `.ttf` lidos do disco e parseados uma vez por
 * processo, não uma vez por exportação.
 */
let cachedBundles: Promise<Record<keyof typeof FONT_FILES, FontBundle>> | null =
  null;

/**
 * `process.cwd()` é o que o file tracing do Next preserva — os `.ttf`
 * são copiados para o pacote de deploy mantendo o caminho relativo à
 * raiz do projeto, desde que `next.config.ts` os declare em
 * `outputFileTracingIncludes`. Sem essa declaração o build PASSA e a
 * rota estoura `ENOENT` só em produção (a armadilha "build passa em
 * dev e falha no host" catalogada no AGENTS.md).
 */
function fontPath(file: string): string {
  return path.join(process.cwd(), FONT_DIR, file);
}

async function loadBundle(file: string): Promise<FontBundle> {
  const bytes = await fs.readFile(fontPath(file));
  // `fontkit.create` é usado SÓ para consultar cobertura de glifo. O
  // `pdf-lib` não expõe isso pela API pública, e alcançar o embedder
  // interno dele seria depender de detalhe privado.
  const coverage = (
    fontkit as unknown as { create(b: Buffer): FontkitFont }
  ).create(bytes);
  return { bytes, coverage };
}

async function getBundles(): Promise<
  Record<keyof typeof FONT_FILES, FontBundle>
> {
  if (!cachedBundles) {
    cachedBundles = (async () => {
      const [regular, semibold, emoji] = await Promise.all([
        loadBundle(FONT_FILES.regular),
        loadBundle(FONT_FILES.semibold),
        loadBundle(FONT_FILES.emoji),
      ]);
      return { regular, semibold, emoji };
    })().catch((err) => {
      // Não deixar uma falha transitória envenenar o cache do processo.
      cachedBundles = null;
      throw err;
    });
  }
  return cachedBundles;
}

function buildCoverage(bundles: {
  regular: FontBundle;
  emoji: FontBundle;
}): GlyphCoverage {
  const hasEmojiGlyph = (codePoint: number) =>
    bundles.emoji.coverage.hasGlyphForCodePoint(codePoint);
  const hasTextGlyph = (codePoint: number) =>
    bundles.regular.coverage.hasGlyphForCodePoint(codePoint);

  return {
    // A fonte de texto ganha sempre que cobre o caractere; a de emoji é
    // fallback, nunca preferência. Ver a nota em `GlyphCoverage`.
    usesEmojiFont: (codePoint) =>
      !hasTextGlyph(codePoint) && hasEmojiGlyph(codePoint),
    // Quebra de linha e espaço nunca têm glifo próprio, mas são
    // estruturais: removê-los colaria as palavras umas nas outras.
    isCovered: (codePoint) =>
      codePoint === 0x20 ||
      codePoint === 0x0a ||
      hasTextGlyph(codePoint) ||
      hasEmojiGlyph(codePoint),
  };
}

/**
 * Só a cobertura de glifo, sem embutir nada. É o que permite decidir se
 * vale a pena carregar a fonte de emoji ANTES de pagar os 580 KB dela.
 */
export async function loadGlyphCoverage(): Promise<GlyphCoverage> {
  return buildCoverage(await getBundles());
}

/** True se algum caractere do texto precisa da fonte de emoji. */
export function textNeedsEmojiFont(
  text: string,
  coverage: GlyphCoverage
): boolean {
  for (const ch of text) {
    if (coverage.usesEmojiFont(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

export interface LoadExportFontsOptions {
  /**
   * Embutir a fonte de emoji. `false` deixa `fonts.emoji` nulo e é
   * seguro quando nenhum caractere do documento a exige — use
   * `textNeedsEmojiFont` para decidir.
   */
  embedEmoji: boolean;
}

/**
 * Embute as fontes NESTE documento e devolve os predicados de cobertura.
 *
 * As de texto vão subsetadas (só os glifos usados) porque ali o
 * subsetter do `pdf-lib` se comporta. A de emoji vai INTEIRA, pelo
 * motivo documentado no topo do arquivo: subsetá-la produz glifos em
 * branco, e um documento probatório com emoji faltando é pior que um
 * documento maior.
 */
export async function loadExportFonts(
  doc: PDFDocument,
  options: LoadExportFontsOptions
): Promise<LoadedFonts> {
  const bundles = await getBundles();
  doc.registerFontkit(fontkit);

  const [text, semibold] = await Promise.all([
    doc.embedFont(bundles.regular.bytes, { subset: true }),
    doc.embedFont(bundles.semibold.bytes, { subset: true }),
  ]);

  const emoji = options.embedEmoji
    ? await doc.embedFont(bundles.emoji.bytes, { subset: false })
    : null;

  return { text, semibold, emoji, ...buildCoverage(bundles) };
}
