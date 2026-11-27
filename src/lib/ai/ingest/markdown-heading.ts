// ============================================================
// Cabeçalho Markdown (`#`…`######`) sem regex com retrocesso.
//
// A versão anterior, `/^#{1,6}\s+(.+?)\s*#*\s*$/`, tinha tempo CÚBICO: uma
// linha "# " + N espaços Unicode (U+2003) + N `#` + N espaços + "x" levava
// 25 s com 12 mil caracteres (`\s` casa U+2003, e `\s+`, `.+?`, `\s*` e `#*`
// disputam os mesmos caracteres). Aqui cada caractere é visitado um número
// constante de vezes, então o custo é linear na linha.
//
// Usada pelo fatiador (`chunk.ts`) e pelo título do `.md` (`extract-file.ts`).
// ============================================================

const isSpace = (ch: string): boolean => /\s/.test(ch);

export interface MarkdownHeading {
  level: number;
  text: string;
}

/**
 * `# Título ##` → `{ level: 1, text: 'Título' }`. Devolve `null` quando a
 * linha não é cabeçalho: sem espaço depois dos `#` (`#hashtag`), mais de seis
 * `#`, ou nada depois dos `#`.
 */
export function parseMarkdownHeading(line: string): MarkdownHeading | null {
  let level = 0;
  while (level < 7 && line[level] === '#') level++;
  if (level === 0 || level > 6) return null;
  if (level >= line.length || !isSpace(line[level])) return null;

  let start = level;
  while (start < line.length && isSpace(line[start])) start++;
  // Só espaços depois dos `#`: cabeçalho sem texto (some da lista, como antes).
  if (start === line.length) return { level, text: '' };

  let end = line.length;
  while (end > start && (line[end - 1] === '#' || isSpace(line[end - 1])))
    end--;
  // Só `#` depois do espaço (`# ###`): o texto é o que sobrou, sem aparar.
  const text = end > start ? line.slice(start, end) : line.slice(start).trim();
  return { level, text };
}
