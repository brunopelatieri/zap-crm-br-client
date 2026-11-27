// ============================================================
// Erro tipado da ingestão (SPEC 089 F2). `code` é estável: a rota o
// devolve em inglês e a tela o traduz (`Agents.knowledge.errors.*`).
// A mensagem NUNCA carrega URL com credencial, corpo de resposta nem
// caminho de arquivo.
// ============================================================

export type IngestErrorCode =
  | 'unsupported_type'
  | 'file_too_large'
  | 'file_corrupt'
  | 'pdf_encrypted'
  | 'file_too_complex'
  | 'empty_text'
  | 'text_too_long'
  | 'invalid_url'
  | 'url_blocked'
  | 'url_unreachable'
  | 'url_timeout'
  | 'url_bad_status'
  | 'url_unsupported_content_type'
  | 'url_too_large'
  | 'url_too_many_redirects'
  | 'faq_invalid'
  | 'invalid_input';

const STATUS_BY_CODE: Record<IngestErrorCode, number> = {
  unsupported_type: 415,
  file_too_large: 413,
  file_corrupt: 422,
  pdf_encrypted: 422,
  file_too_complex: 422,
  empty_text: 422,
  text_too_long: 413,
  invalid_url: 400,
  url_blocked: 400,
  url_unreachable: 422,
  url_timeout: 422,
  url_bad_status: 422,
  url_unsupported_content_type: 415,
  url_too_large: 413,
  url_too_many_redirects: 422,
  faq_invalid: 400,
  invalid_input: 400,
};

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  readonly status: number;
  constructor(code: IngestErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'IngestError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
