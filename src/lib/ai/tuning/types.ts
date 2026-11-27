// ============================================================
// Ajuste do agente (SPEC 089 F7): tipos, limites e o erro tipado da camada
// de serviço. A SPEC 090 expõe esta camada pela API pública e pelo MCP, por
// isso nada aqui depende de rota, de Next nem de React.
// ============================================================

export type ExampleStatus = 'candidate' | 'approved' | 'rejected';
export type ExampleSource = 'manual' | 'draft_edit' | 'handoff_reply';

export const EXAMPLE_STATUSES: readonly ExampleStatus[] = [
  'candidate',
  'approved',
  'rejected',
];
export const EXAMPLE_SOURCES: readonly ExampleSource[] = [
  'manual',
  'draft_edit',
  'handoff_reply',
];

/** One row of `ai_examples` as the panel and the API see it (no vector). */
export interface ExampleRow {
  id: string;
  customerMessage: string;
  idealResponse: string;
  /** What the AI had suggested (source `draft_edit`); never in the prompt. */
  aiDraft: string | null;
  tags: string[];
  status: ExampleStatus;
  source: ExampleSource;
  conversationId: string | null;
  /** True when the example carries an embedding of the CURRENT model: only
   *  then can an approved example reach the prompt. */
  embedded: boolean;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

/** An approved example picked for one turn. */
export interface ExampleHit {
  id: string;
  customerMessage: string;
  idealResponse: string;
  /** Cosine distance (0–2) between the query and the example's message. */
  distance: number;
}

export interface ExampleCounts {
  candidate: number;
  approved: number;
  rejected: number;
}

/** Limits (SPEC 089 F7). The database CHECKs are looser; these are what the
 *  code stores. */
export const EXAMPLES_PER_TURN = 3;
/** Cosine-distance ceiling for an example to enter the prompt. Not yet
 *  calibrated on a real account (same starting point as the knowledge
 *  base, `KNOWLEDGE_MAX_DISTANCE`); the "Test examples" box shows the
 *  distance of each match. */
export const EXAMPLES_MAX_DISTANCE = 0.55;
export const EXAMPLE_CUSTOMER_MAX_CHARS = 1000;
export const EXAMPLE_RESPONSE_MAX_CHARS = 2000;
export const EXAMPLE_TAG_MAX_CHARS = 40;
export const EXAMPLE_MAX_TAGS = 10;
/** Approved examples per account (the similarity search is exact). */
export const EXAMPLES_MAX_APPROVED = 500;
/** Unreviewed candidates per account: capture stops, it never blocks a send. */
export const EXAMPLES_MAX_CANDIDATES = 200;
/** A draft older than this is not compared with what was sent. */
export const DRAFT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const EVAL_MAX_CASES_PER_RUN = 10;
export const EVAL_MAX_CASES_PER_ACCOUNT = 50;
export const EVAL_MAX_TURNS = 20;
export const EVAL_TURN_MAX_CHARS = 1000;
/** Whole conversation of a case, in masked characters. The database CHECK
 *  caps the JSON at 12000 bytes (quotes, keys and multi-byte text count), so
 *  the code keeps well under it and drops the OLDEST turns past this size. */
export const EVAL_CONVERSATION_MAX_CHARS = 8000;
export const EVAL_TITLE_MAX_CHARS = 120;
export const EVAL_NOTES_MAX_CHARS = 1000;
/** A `running` run older than this is shown (and treated) as failed. */
export const EVAL_RUN_STALE_MS = 15 * 60 * 1000;
/** Cases evaluated at the same time inside one run. */
export const EVAL_CONCURRENCY = 2;

export type TuningErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'limit_reached'
  | 'run_in_progress'
  | 'ai_not_configured'
  | 'no_cases'
  | 'too_many_cases'
  | 'database_error';

/** Typed failure of the tuning service; routes map `status` to HTTP. */
export class TuningError extends Error {
  readonly code: TuningErrorCode;
  readonly status: number;
  constructor(code: TuningErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'TuningError';
    this.code = code;
    this.status =
      status ??
      (code === 'not_found'
        ? 404
        : code === 'run_in_progress' || code === 'limit_reached'
          ? 409
          : code === 'database_error'
            ? 500
            : 400);
  }
}
