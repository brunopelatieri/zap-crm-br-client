// ============================================================
// Limites da ingestão da base de conhecimento (SPEC 089 D-7, D-8, P-6).
// Um lugar só: rotas, extratores e tela leem daqui.
// ============================================================

/** Arquivo enviado: 10 MB (P-6). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Texto de um documento, qualquer fonte: 500 mil caracteres (P-6). */
export const MAX_DOCUMENT_CHARS = 500_000;

/** Corpo de uma página importada por URL: 2 MB (D-8). */
export const MAX_URL_BODY_BYTES = 2 * 1024 * 1024;

/** Prazo da requisição de importação por URL: 10 s (D-8). */
export const URL_FETCH_TIMEOUT_MS = 10_000;

/** Redirecionamentos seguidos (cada salto passa de novo pela guarda). */
export const MAX_URL_REDIRECTS = 3;

/** Etiquetas por documento (o banco também limita, 103). */
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

/** Perguntas e respostas (D-12: um par nunca é partido, então precisa caber numa fatia). */
export const MAX_FAQ_PAIRS = 200;
export const MAX_FAQ_QUESTION_CHARS = 500;
export const MAX_FAQ_ANSWER_CHARS = 3_500;

/** Título do documento. */
export const MAX_TITLE_CHARS = 200;

/**
 * Tentativas de indexação antes de o documento virar `error` (D-9, número
 * definido na F2): a primeira roda no `after()` da rota, as outras duas na
 * varredura do cron. Reindexar manualmente zera a conta.
 */
export const MAX_INDEX_ATTEMPTS = 3;

/** `indexing` parado há mais que isto é considerado órfão (D-9). */
export const INDEXING_STALE_MINUTES = 10;

/** Documentos retomados por ciclo da varredura (ciclo de 5 min). */
export const SWEEP_DOCUMENTS_PER_CYCLE = 5;

/** Documentos que o `after()` de uma rota indexa de uma vez; o resto espera a varredura. */
export const AFTER_INDEX_BATCH = 25;

/** Extensões aceitas no envio de arquivo (D-7). */
export const ACCEPTED_FILE_EXTENSIONS = [
  'pdf',
  'docx',
  'txt',
  'md',
  'csv',
] as const;
export type AcceptedFileExtension = (typeof ACCEPTED_FILE_EXTENSIONS)[number];
