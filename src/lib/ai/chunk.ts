import { parseFaqText, type FaqPair } from './ingest/faq';
import { parseMarkdownHeading } from './ingest/markdown-heading';

// ============================================================
// Fatiamento da base de conhecimento (SPEC 089 D-12).
//
// Parte o texto em seções (cabeçalho Markdown `#`…`######`), empacota
// parágrafos de cada seção até `maxChars` e devolve fatias que carregam:
//
//   - o TÍTULO DA SEÇÃO prefixado ("Política de Trocas › Frete"), para a
//     fatia não perder o assunto ("o prazo é de 7 dias": prazo de quê?);
//   - uma SOBREPOSIÇÃO de 150 caracteres do fim da fatia anterior da
//     mesma seção, para a frase cortada na fronteira existir inteira em
//     alguma das duas.
//
// Parágrafo maior que o orçamento desce em degraus: linhas → frases →
// janelas (na última palavra que cabe). Par de pergunta e resposta
// (`chunkFaq`) NUNCA é partido: um par por fatia.
//
// Pura e determinística: mesma entrada, mesmas fatias (reindexar não
// muda fronteira), e sem I/O, então testa sem navegador nem banco.
// ============================================================

export interface KnowledgeChunk {
  /** Título prefixado à fatia (nulo quando o documento não tem título nem cabeçalho). */
  heading: string | null;
  /** Texto da fatia, JÁ com o prefixo e a sobreposição: é o que se embute, se busca e se manda ao modelo. */
  content: string;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;
const MAX_PREFIX_CHARS = 150;
/** Piso do orçamento do corpo: opções absurdas (maxChars minúsculo) não travam o laço. */
const MIN_BODY_CHARS = 200;

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
  /** Título do documento: prefixo das fatias sem cabeçalho próprio e raiz do caminho das demais. */
  title?: string;
}

interface Atom {
  text: string;
  /** Separador que o une ao átomo anterior quando cabem na mesma fatia. */
  sep: string;
}

/** Janelas de `budget` caracteres, cortando na última palavra que cabe. */
function windows(text: string, budget: number): Atom[] {
  const out: Atom[] = [];
  let rest = text.trim();
  let sep = '';
  while (rest.length > budget) {
    let cut = rest.lastIndexOf(' ', budget);
    let nextSep = ' ';
    // Sem espaço na segunda metade da janela: corte seco (URL, sequência longa).
    if (cut < budget / 2) {
      cut = budget;
      nextSep = '';
    }
    out.push({ text: rest.slice(0, cut).trim(), sep });
    rest = rest.slice(cut).trim();
    sep = nextSep;
  }
  if (rest) out.push({ text: rest, sep });
  return out;
}

function toAtoms(body: string, budget: number): Atom[] {
  const atoms: Atom[] = [];
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const para of paragraphs) {
    if (para.length <= budget) {
      atoms.push({ text: para, sep: '\n\n' });
      continue;
    }
    // Parágrafo maior que o orçamento: desce para linhas.
    let lineSep = '\n\n';
    for (const rawLine of para.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.length <= budget) {
        atoms.push({ text: line, sep: lineSep });
      } else {
        let sentenceSep = lineSep;
        for (const rawSentence of line.split(/(?<=[.!?])\s+/)) {
          const sentence = rawSentence.trim();
          if (!sentence) continue;
          if (sentence.length <= budget) {
            atoms.push({ text: sentence, sep: sentenceSep });
          } else {
            const parts = windows(sentence, budget);
            if (parts.length > 0) parts[0].sep = sentenceSep;
            atoms.push(...parts);
          }
          sentenceSep = ' ';
        }
      }
      lineSep = '\n';
    }
  }
  return atoms;
}

function pack(atoms: Atom[], budget: number): string[] {
  const bodies: string[] = [];
  let current = '';
  for (const atom of atoms) {
    if (!current) {
      current = atom.text;
    } else if (current.length + atom.sep.length + atom.text.length <= budget) {
      current += atom.sep + atom.text;
    } else {
      bodies.push(current);
      current = atom.text;
    }
  }
  if (current) bodies.push(current);
  return bodies;
}

/** Últimos `n` caracteres de `text`, sem começar no meio de uma palavra. */
function tailOf(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? '' : text.trim();
  let s = text.slice(text.length - n);
  const firstSpace = s.search(/\s/);
  if (firstSpace > 0 && firstSpace < s.length - 1) s = s.slice(firstSpace + 1);
  return s.trim();
}

function buildPrefix(
  title: string | undefined,
  heading: string | null
): string {
  const parts: string[] = [];
  for (const p of [title?.trim(), heading?.trim()]) {
    if (p && !parts.includes(p)) parts.push(p);
  }
  const prefix = parts.join(' › ');
  return prefix.length > MAX_PREFIX_CHARS
    ? `${prefix.slice(0, MAX_PREFIX_CHARS - 1).trimEnd()}…`
    : prefix;
}

interface Section {
  heading: string | null;
  body: string;
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  let inFence = false;

  const close = () => {
    const body = lines.join('\n').trim();
    if (body) sections.push({ heading, body });
    lines = [];
  };

  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    // Sem regex com retrocesso: ver `markdown-heading.ts` (ReDoS cúbico).
    const parsed = inFence ? null : parseMarkdownHeading(line);
    if (parsed) {
      close();
      heading = parsed.text;
    } else {
      lines.push(line);
    }
  }
  close();
  return sections;
}

export function chunkText(
  content: string,
  opts: ChunkOptions = {}
): KnowledgeChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = Math.max(0, opts.overlapChars ?? DEFAULT_OVERLAP_CHARS);
  const text = content.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const chunks: KnowledgeChunk[] = [];

  for (const section of splitSections(text)) {
    const prefix = buildPrefix(opts.title, section.heading);
    const budget = Math.max(
      MIN_BODY_CHARS,
      maxChars - (prefix ? prefix.length + 2 : 0) - (overlap ? overlap + 1 : 0)
    );
    const bodies = pack(toAtoms(section.body, budget), budget);

    bodies.forEach((body, i) => {
      const parts: string[] = [];
      if (prefix) parts.push(prefix);
      const lead = i > 0 ? tailOf(bodies[i - 1], overlap) : '';
      parts.push(lead ? `${lead}\n${body}` : body);
      chunks.push({ heading: prefix || null, content: parts.join('\n\n') });
    });
  }
  return chunks;
}

/**
 * Um par por fatia, nunca partido (D-12). O limite de tamanho do par é
 * validado na entrada (`normalizeFaqPairs`), então ele sempre cabe.
 */
export function chunkFaq(pairs: FaqPair[], title?: string): KnowledgeChunk[] {
  const prefix = buildPrefix(title, null);
  return pairs.map((p) => ({
    heading: prefix || null,
    content: `${prefix ? `${prefix}\n\n` : ''}Q: ${p.question}\nA: ${p.answer}`,
  }));
}

/** Ponto de entrada do indexador: escolhe o fatiador pela fonte. */
export function chunkDocument(doc: {
  title: string;
  sourceType: string;
  content: string;
}): KnowledgeChunk[] {
  if (doc.sourceType === 'faq') {
    const pairs = parseFaqText(doc.content);
    if (pairs.length > 0) return chunkFaq(pairs, doc.title);
  }
  return chunkText(doc.content, { title: doc.title });
}
