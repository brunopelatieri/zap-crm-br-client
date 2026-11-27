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
  // `[^\S\n]` = qualquer espaço Unicode (U+2003, U+00A0…) menos a quebra.
  const s = line.replace(/[^\S\n]+/g, ' ').trim();
  let end = s.length;
  while (end > 0 && (s[end - 1] === '|' || s[end - 1] === ' ')) end--;
  return s.slice(0, end);
}

// ------------------------------------------------------------
// Elementos ocultos (`hidden`, `aria-hidden="true"`, `display:none`,
// `visibility:hidden`) não são conteúdo: o navegador não os mostra, então
// texto ali é o canal clássico de injeção de instrução ("ignore o resto e…")
// que o leitor humano da página nunca vê. Uma passada antes do `render`
// remove o elemento inteiro, inclusive um `<main>` ou `<article>` dentro dele.
// Também linear: cada busca avança e uma busca sem resposta encerra o texto.
// ------------------------------------------------------------

/** Elementos sem conteúdo: o atributo não esconde texto nenhum. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const isWs = (ch: string): boolean => /\s/.test(ch);

/** `inner` é o miolo da tag de abertura (`div class="a" hidden`). */
function hasHiddenAttribute(inner: string): boolean {
  const n = inner.length;
  let i = 0;
  while (i < n && !isWs(inner[i]) && inner[i] !== '/') i++; // o nome da tag
  while (i < n) {
    while (i < n && (isWs(inner[i]) || inner[i] === '/')) i++;
    const nameStart = i;
    while (i < n && !isWs(inner[i]) && inner[i] !== '=' && inner[i] !== '/') {
      i++;
    }
    const name = inner.slice(nameStart, i).toLowerCase();
    while (i < n && isWs(inner[i])) i++;
    let value = '';
    if (inner[i] === '=') {
      i++;
      while (i < n && isWs(inner[i])) i++;
      const quote = inner[i];
      if (quote === '"' || quote === "'") {
        const end = inner.indexOf(quote, i + 1);
        value = inner.slice(i + 1, end < 0 ? n : end);
        i = end < 0 ? n : end + 1;
      } else {
        const valueStart = i;
        while (i < n && !isWs(inner[i])) i++;
        value = inner.slice(valueStart, i);
      }
    }
    if (name === 'hidden') return true;
    if (name === 'aria-hidden' && value.trim().toLowerCase() === 'true') {
      return true;
    }
    if (
      name === 'style' &&
      // Entities decoded first (`display&#58;none` is `display:none`).
      /display\s*:\s*none|visibility\s*:\s*hidden/i.test(decodeEntities(value))
    ) {
      return true;
    }
    if (i === nameStart) i++; // garante progresso em entrada estranha
  }
  return false;
}

/**
 * Fim (`>`) da tag que abre em `lt`, ciente de aspas: `<div title=">" hidden>`
 * termina no último `>`, não no primeiro. Devolve -1 se a tag não fecha.
 */
function tagEnd(html: string, lt: number): number {
  let quote = '';
  for (let i = lt + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/** Posição logo depois do `</name>` que fecha o elemento aberto em `from`, ou -1. */
function findMatchingClose(html: string, name: string, from: number): number {
  let depth = 0;
  let p = from;
  for (;;) {
    const lt = html.indexOf('<', p);
    if (lt < 0) return -1;
    // A `</div>` inside a comment or inside a quoted attribute value is not
    // the close (adversarial pass of the F8: `<div hidden><!-- </div> -->x`
    // and `<span title="</div>">x` let the hidden text out).
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) return -1;
      p = end + 3;
      continue;
    }
    if (html[lt + 1] !== '/') {
      // A bare `<` in text (`a < b`) is not a tag.
      if (!/[a-zA-Z]/.test(html[lt + 1] ?? '')) {
        p = lt + 1;
        continue;
      }
      // An opening tag: skip it whole, quotes respected, so its attribute
      // values are never read as markup. An unclosed quote ends the search
      // (no close is found; the caller drops the rest, as a browser would).
      const gt = tagEnd(html, lt);
      if (gt < 0) return -1;
      const nameAt = lt + 1;
      if (
        html.substr(nameAt, name.length).toLowerCase() === name &&
        !isNameChar(html[nameAt + name.length])
      ) {
        depth++;
      }
      p = gt + 1;
      continue;
    }
    p = lt + 1;
    const closing = html[lt + 1] === '/';
    const nameAt = lt + (closing ? 2 : 1);
    if (
      html.substr(nameAt, name.length).toLowerCase() !== name ||
      isNameChar(html[nameAt + name.length])
    ) {
      continue;
    }
    if (!closing) {
      depth++;
      continue;
    }
    if (depth === 0) {
      const gt = html.indexOf('>', nameAt);
      return gt < 0 ? html.length : gt + 1;
    }
    depth--;
  }
}

function stripHidden(html: string): string {
  const lower = html.toLowerCase();
  if (!lower.includes('hidden') && !lower.includes('none')) return html;

  const out: string[] = [];
  const n = html.length;
  let quoteAware = true;
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
      const stop = end < 0 ? n : end + 3;
      out.push(html.slice(lt, stop));
      i = stop;
      continue;
    }

    let gt = quoteAware ? tagEnd(html, lt) : -1;
    if (gt < 0) {
      // Aspa que nunca fecha: desiste da leitura por aspas no resto do texto
      // (uma varredura até o fim por tag seria quadrática).
      quoteAware = false;
      gt = html.indexOf('>', lt + 1);
    }
    if (gt < 0) {
      out.push(html.slice(lt));
      break;
    }
    const tag = html.slice(lt, gt + 1);
    const inner = tag.slice(1, -1);
    const m = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
    i = gt + 1;
    const name = m ? m[1].toLowerCase() : '';

    // Script, estilo e afins são texto cru: um `<` lá dentro (`i<n`) não é
    // tag, e ler atributos ali apagava a página (SPEC 089 F8, /code-review).
    // O miolo passa intacto; quem o descarta é o conversor, mais adiante.
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      const stop = close < 0 ? n : close;
      out.push(tag, html.slice(i, stop));
      i = stop;
      continue;
    }

    if (
      !m ||
      VOID_ELEMENTS.has(name) ||
      NEVER_HIDDEN.has(name) ||
      !hasHiddenAttribute(inner)
    ) {
      out.push(tag);
      continue;
    }

    // Elemento oculto: some inteiro.
    out.push(' ');
    if (OPTIONAL_END_ELEMENTS.has(name)) {
      // `<p hidden>` sem `</p>` é HTML válido: ele termina no próximo irmão
      // de mesmo nome ou no fechamento do pai, não no fim do documento.
      i = optionalEnd(html, lower, name, i);
      continue;
    }
    // Sem fechamento, some até o fim: o navegador também esconde o resto
    // (o elemento fica aberto até o pai fechar). Os casos em que isso
    // apagava texto visível eram os de fechamento opcional (acima) e o `<`
    // dentro de script (texto cru, acima).
    const close = findMatchingClose(html, name, i);
    i = close < 0 ? n : close;
  }
  return out.join('');
}

/** Texto cru: o conteúdo não é HTML (um `<` lá dentro não abre tag). */
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'textarea',
  'template',
  'noscript',
  'xmp',
]);

/**
 * Nunca tratados como ocultos: páginas escondem o `<html>`/`<body>` até o
 * JavaScript carregar (anti-flicker), e o texto é da página toda.
 */
const NEVER_HIDDEN = new Set(['html', 'head', 'body']);

/** Elementos cujo fechamento é opcional em HTML. */
const OPTIONAL_END_ELEMENTS = new Set([
  'p',
  'li',
  'dt',
  'dd',
  'option',
  'optgroup',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'rt',
  'rp',
  'caption',
  'colgroup',
]);

/**
 * Onde termina um elemento de fechamento opcional aberto antes de `from`: no
 * seu `</nome>` (consumido), ou antes do próximo `<nome` irmão ou do próximo
 * fechamento de outro elemento (o pai). Sem nada disso, no fim do texto.
 */
function optionalEnd(
  html: string,
  lower: string,
  name: string,
  from: number
): number {
  let p = from;
  for (;;) {
    const lt = html.indexOf('<', p);
    if (lt < 0) return html.length;
    const closing = html[lt + 1] === '/';
    const nameAt = lt + (closing ? 2 : 1);
    const same =
      lower.startsWith(name, nameAt) && !isNameChar(html[nameAt + name.length]);
    if (closing) {
      if (same) {
        const gt = html.indexOf('>', nameAt);
        return gt < 0 ? html.length : gt + 1;
      }
      return lt; // fechamento do pai: o elemento acabou antes dele
    }
    if (same) return lt; // irmão de mesmo nome
    p = lt + 1;
  }
}

export interface HtmlText {
  title: string | null;
  text: string;
}

export function htmlToText(rawHtml: string): HtmlText {
  const html = stripHidden(rawHtml);
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
