// ============================================================
// HTML → texto puro (SPEC 089 D-7, D-8).
//
// Um conversor só para os dois caminhos que chegam em HTML: a página
// importada por URL e o DOCX (`mammoth.convertToHtml`). Cabeçalhos viram
// `#` Markdown (o fatiador usa como título da seção, D-12), itens viram
// `- `, células de tabela se separam por ` | `.
//
// É extração de TEXTO, nunca sanitização para renderizar: o resultado é
// texto puro e a tela o mostra como texto. Por isso um parser por regex
// basta (sem dependência nova) — o que não se entende vira texto ou some.
// ============================================================

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
  ordm: 'º',
  ordf: 'ª',
  copy: '©',
  reg: '®',
  euro: '€',
  pound: '£',
  sect: '§',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  agrave: 'à',
  Agrave: 'À',
  acirc: 'â',
  ecirc: 'ê',
  ocirc: 'ô',
  Acirc: 'Â',
  Ecirc: 'Ê',
  Ocirc: 'Ô',
  atilde: 'ã',
  otilde: 'õ',
  Atilde: 'Ã',
  Otilde: 'Õ',
  ccedil: 'ç',
  Ccedil: 'Ç',
  uuml: 'ü',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      // 0 e substitutos soltos nunca viram caractere.
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return ' ';
      if (code >= 0xd800 && code <= 0xdfff) return ' ';
      return String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? all;
  });
}

// ------------------------------------------------------------
// Extração em UMA passada, sem regex preguiçosa.
//
// Uma versão anterior usava `<tag[^>]*>[\s\S]*?</tag>` e `/<[^>]*>/g`.
// Em página hostil (`<script>` repetido, 300 mil `<` seguidos, `<!--`
// sem fechar) cada tentativa varre até o fim do texto: tempo QUADRÁTICO,
// 65 s travando o servidor para 300 KB de entrada, e o corpo aceito vai
// até 2 MB. Aqui toda busca avança com `indexOf` a partir da posição atual
// e nunca volta, então o custo é linear no tamanho da página.
// ------------------------------------------------------------

/** Blocos inteiros que nunca são conteúdo: script, estilo, navegação, rodapé, formulário… */
const DROP_BLOCKS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'embed',
  'canvas',
  'head',
  'nav',
  'footer',
  'aside',
  'form',
  'select',
  'button',
  'dialog',
]);

/** Fechamentos que viram quebra de parágrafo. */
const PARAGRAPH_CLOSE = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
]);

const isNameChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[a-zA-Z0-9]/.test(ch);

/** Posição do `</name` (sem diferenciar caixa) a partir de `from`, ou -1. */
function findClose(html: string, name: string, from: number): number {
  let p = from;
  for (;;) {
    const j = html.indexOf('</', p);
    if (j < 0) return -1;
    if (
      html.substr(j + 2, name.length).toLowerCase() === name &&
      !isNameChar(html[j + 2 + name.length])
    ) {
      return j;
    }
    p = j + 2;
  }
}

/** `>` mais próximo a partir de `from`, com memória: nunca varre o mesmo trecho duas vezes. */
function makeGtFinder(html: string): (from: number) => number {
  let cached = -2;
  return (from) => {
    if (cached === -1) return -1;
    if (cached >= from) return cached;
    cached = html.indexOf('>', from);
    return cached;
  };
}

/** Conteúdo interno dos elementos `<name>…</name>` (o primeiro, ou todos). */
function findElements(html: string, name: string, all: boolean): string[] {
  const found: string[] = [];
  const nextGt = makeGtFinder(html);
  let p = 0;
  for (;;) {
    const j = html.indexOf('<', p);
    if (j < 0) break;
    p = j + 1;
    if (
      html.substr(j + 1, name.length).toLowerCase() !== name ||
      isNameChar(html[j + 1 + name.length])
    ) {
      continue;
    }
    const gt = nextGt(j + 1);
    if (gt < 0) break;
    const close = findClose(html, name, gt + 1);
    if (close < 0) break;
    found.push(html.slice(gt + 1, close));
    if (!all) break;
    p = close + 2;
  }
  return found;
}

/** Percorre o HTML uma vez e devolve texto com a estrutura mínima (títulos, itens, linhas). */
function render(html: string): string {
  const out: string[] = [];
  const unclosed = new Set<string>();
  const nextGt = makeGtFinder(html);
  const n = html.length;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break; // comentário sem fim: o resto não é conteúdo
      out.push(' ');
      i = end + 3;
      continue;
    }

    const gt = nextGt(lt + 1);
    if (gt < 0) {
      out.push(html.slice(lt));
      break;
    }
    const inner = html.slice(lt + 1, gt);
    // `<!doctype html>`, `<?xml ... ?>`, `<![CDATA[`: declaração, nunca texto.
    if (inner[0] === '!' || inner[0] === '?') {
      i = gt + 1;
      continue;
    }
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
    if (!m) {
      // `a < b`: um `<` solto é texto.
      out.push('<');
      i = lt + 1;
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    i = gt + 1;

    if (!closing && DROP_BLOCKS.has(name)) {
      out.push(' ');
      if (inner.endsWith('/') || unclosed.has(name)) continue;
      const close = findClose(html, name, i);
      if (close < 0) {
        unclosed.add(name);
        continue; // sem fechamento: some só a tag de abertura
      }
      const closeGt = nextGt(close);
      i = closeGt < 0 ? n : closeGt + 1;
      continue;
    }

    if (/^h[1-6]$/.test(name)) {
      out.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `);
    } else if (name === 'br') {
      out.push('\n');
    } else if (name === 'li' && !closing) {
      out.push('\n- ');
    } else if (closing && name === 'tr') {
      out.push('\n');
    } else if (closing && (name === 'td' || name === 'th')) {
      out.push(' | ');
    } else if (closing && PARAGRAPH_CLOSE.has(name)) {
      out.push('\n\n');
    }
  }
  return out.join('');
}

/** Tira espaços repetidos e as barras de célula que sobram no fim da linha. */
function cleanLine(line: string): string {
  const s = line.replace(/[ \t\f\v\xa0]+/g, ' ').trim();
  let end = s.length;
  while (end > 0 && (s[end - 1] === '|' || s[end - 1] === ' ')) end--;
  return s.slice(0, end);
}

export interface HtmlText {
  title: string | null;
  text: string;
}

export function htmlToText(html: string): HtmlText {
  const [titleInner] = findElements(html, 'title', false);
  const title = titleInner
    ? decodeEntities(render(titleInner)).replace(/\s+/g, ' ').trim() || null
    : null;

  // Corpo principal: `<main>`; senão os `<article>`; senão a página toda.
  const [main] = findElements(html, 'main', false);
  let region = html;
  let rendered: string | null = null;
  if (main !== undefined) {
    const r = render(main);
    if (r.trim().length > 200) {
      region = main;
      rendered = r;
    }
  }
  if (rendered === null) {
    const articles = findElements(html, 'article', true);
    if (articles.length > 0) {
      const r = render(articles.join('\n'));
      if (r.trim().length > 200) {
        region = articles.join('\n');
        rendered = r;
      }
    }
  }
  if (rendered === null) rendered = render(region);

  // Linhas de tabela do Word: `<td><p>Produto</p></td>` deixa a barra da
  // célula numa linha própria; junta com a linha de cima ("Produto | Preço").
  const lines: string[] = [];
  for (const raw of decodeEntities(rendered)
    .replace(/\r\n/g, '\n')
    .split('\n')) {
    const line = cleanLine(raw);
    if (line.startsWith('|') && lines.length > 0) {
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      if (lines.length > 0) {
        lines[lines.length - 1] += ` ${line}`;
        continue;
      }
    }
    lines.push(line);
  }

  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
