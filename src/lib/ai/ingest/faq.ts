import { IngestError } from './errors';
import {
  MAX_FAQ_ANSWER_CHARS,
  MAX_FAQ_PAIRS,
  MAX_FAQ_QUESTION_CHARS,
} from './limits';

// ============================================================
// Pares de pergunta e resposta (SPEC 089 D-7, D-12).
//
// A fonte `faq` também devolve texto puro para o mesmo `ingestDocument`:
// cada par vira o bloco
//
//   Q: <pergunta em uma linha>
//   A: <resposta, quebras simples preservadas>
//
// e os blocos se separam por linha em branco. O formato é determinístico
// nos dois sentidos (`buildFaqText` e `parseFaqText`), então reindexar
// ou editar um documento `faq` reconstrói exatamente os mesmos pares, e
// o fatiador (`chunkFaq`) guarda um par por fatia, sem nunca parti-lo.
// ============================================================

export interface FaqPair {
  question: string;
  answer: string;
}

function normalizePair(pair: FaqPair): FaqPair {
  return {
    // Pergunta numa linha só: o separador do formato é a linha em branco.
    question: pair.question.replace(/\s+/g, ' ').trim(),
    // Resposta: quebras simples ficam, linha em branco vira quebra simples
    // (senão a resposta viraria dois "blocos" na releitura).
    answer: pair.answer
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * Valida e normaliza os pares recebidos. Lança `IngestError('faq_invalid')`
 * com o motivo (em inglês, vai para `/api/**`).
 */
export function normalizeFaqPairs(input: unknown): FaqPair[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new IngestError(
      'faq_invalid',
      'At least one question/answer pair is required.'
    );
  }
  if (input.length > MAX_FAQ_PAIRS) {
    throw new IngestError(
      'faq_invalid',
      `At most ${MAX_FAQ_PAIRS} pairs per document.`
    );
  }
  const pairs: FaqPair[] = [];
  for (const raw of input) {
    const q = (raw as { question?: unknown })?.question;
    const a = (raw as { answer?: unknown })?.answer;
    if (typeof q !== 'string' || typeof a !== 'string') {
      throw new IngestError(
        'faq_invalid',
        'Each pair needs a question and an answer.'
      );
    }
    const pair = normalizePair({ question: q, answer: a });
    if (!pair.question || !pair.answer) {
      throw new IngestError(
        'faq_invalid',
        'Questions and answers cannot be empty.'
      );
    }
    if (pair.question.length > MAX_FAQ_QUESTION_CHARS) {
      throw new IngestError(
        'faq_invalid',
        `A question is limited to ${MAX_FAQ_QUESTION_CHARS} characters.`
      );
    }
    if (pair.answer.length > MAX_FAQ_ANSWER_CHARS) {
      throw new IngestError(
        'faq_invalid',
        `An answer is limited to ${MAX_FAQ_ANSWER_CHARS} characters.`
      );
    }
    pairs.push(pair);
  }
  return pairs;
}

export function buildFaqText(pairs: FaqPair[]): string {
  return pairs
    .map((p) => normalizePair(p))
    .map((p) => `Q: ${p.question}\nA: ${p.answer}`)
    .join('\n\n');
}

/**
 * Inverso de `buildFaqText`. Bloco que não segue o formato é ignorado
 * (o texto de um documento `faq` só nasce de `buildFaqText`).
 */
export function parseFaqText(text: string): FaqPair[] {
  const pairs: FaqPair[] = [];
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const m = /^Q: (.+)\nA: ([\s\S]+)$/.exec(block.trim());
    if (m) pairs.push({ question: m[1].trim(), answer: m[2].trim() });
  }
  return pairs;
}
