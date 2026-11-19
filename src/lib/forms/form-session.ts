// ============================================================
// Sessão de preenchimento do visitante (SPEC 085 §4.2 itens 4–9, F3).
//
// Roda no NAVEGADOR e fala com `/api/forms/public/[slug]/**`. É lógica
// pura (sem React, sem `node:`; `fetch`, relógio, `sleep` e `localStorage`
// entram por injeção) para ser testada sem DOM. O componente só liga isto
// às telas.
//
// O que a sessão garante:
//   - `start` só depois da identidade (D-7): em `phone`, ao responder o
//     bloco de identidade; em `token`, ao concluir o primeiro bloco. Antes
//     disso o progresso vive só no rascunho local;
//   - nunca chama `start` antes de 3 s desde que a página abriu (a rota
//     recusa): espera o que falta em vez de falhar na cara do visitante;
//   - autosave por bloco com FILA: uma falha de rede não trava a tela, o
//     que não foi salvo volta à fila e é reenviado (backoff e evento
//     `online`); valor mais novo da mesma chave vence o reenvio;
//   - upload direto ao Storage por URL assinada (o arquivo não passa pelo
//     Node do app);
//   - o envio manda SÓ as respostas: nada de pontos, faixa nem identidade;
//   - rascunho em `localStorage` dentro de `try/catch` (modo privado ou
//     bloqueio de dados não pode quebrar o formulário), sem arquivos.
// ============================================================

import type {
  AnswerValue,
  Answers,
  FileRef,
  PublicField,
  PublicFormPayload,
} from './types';

export const MIN_FILL_MS = 3000;
const DRAFT_PREFIX = 'zapcrm-form:';
// Curto de propósito: o rascunho fica em claro no navegador e, em computador
// compartilhado, o próximo visitante do mesmo formulário o abriria.
const DRAFT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const FLUSH_MAX_ATTEMPTS = 5;

export interface ApiFailure {
  ok: false;
  status: number;
  code: string;
  errors?: { key: string; code: string }[];
  /** Teto em bytes que a rota informa ao recusar um arquivo grande demais. */
  maxBytes?: number;
  /** Vale tentar de novo (rede, 429, 5xx); o resto é definitivo. */
  retryable: boolean;
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export interface ThankYouData {
  whatsapp_url: string | null;
  redirect_url: string | null;
}

export type BlockOutcome =
  { ok: true; alreadyAnswered?: boolean } | { ok: false; code: string };

export type SubmitOutcome =
  | { ok: true; thankYou: ThankYouData }
  | { ok: false; code: string; errors?: { key: string; code: string }[] };

export type UploadOutcome =
  { ok: true; ref: FileRef } | { ok: false; code: string; maxBytes?: number };

/** O que o componente usa da sessão. */
export interface LiveHandlers {
  blockDone(field: PublicField, answers: Answers): Promise<BlockOutcome>;
  upload(field: PublicField, file: UploadableFile): Promise<UploadOutcome>;
  submit(answers: Answers, turnstile: string | null): Promise<SubmitOutcome>;
  setHoneypot(value: string): void;
  loadDraft(): Answers;
  saveDraft(answers: Answers): void;
  /** Reenvia o que ficou na fila (ex.: quando o navegador volta `online`). */
  retryPending(): void;
}

/** O pedaço de `File` que a sessão usa (facilita o teste). */
export interface UploadableFile {
  name: string;
  type: string;
  size: number;
}

export interface FormSessionOptions {
  slug: string;
  identityMode: 'phone' | 'token';
  fields: readonly Pick<PublicField, 'key' | 'type' | 'is_identity'>[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** `?t=` do endereço atual. */
  getLinkToken?: () => string | null;
  /** `utm_*` do endereço atual. */
  getUtm?: () => Record<string, string>;
  isEmbedded?: () => boolean;
}

/**
 * Chrome no Windows reporta `.csv` como `application/vnd.ms-excel` (ou vazio):
 * a rota só aceita `.csv` com `text/csv`.
 */
function normalizeMime(file: UploadableFile): string {
  const isCsv = /.csv$/i.test(file.name.trim());
  if (
    isCsv &&
    ['', 'application/vnd.ms-excel', 'application/csv'].includes(file.type)
  ) {
    return 'text/csv';
  }
  return file.type;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function browserStorage(): FormSessionOptions['storage'] {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class FormSession implements LiveHandlers {
  private readonly slug: string;
  private readonly identityMode: 'phone' | 'token';
  private readonly fields: FormSessionOptions['fields'];
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly storage: FormSessionOptions['storage'];
  private readonly getLinkToken: () => string | null;
  private readonly getUtm: () => Record<string, string>;
  private readonly isEmbedded: () => boolean;
  private readonly loadedAt: number;

  private responseId: string | null = null;
  private resumeToken: string | null = null;
  private starting: Promise<BlockOutcome> | null = null;
  private honeypot = '';
  /** Um envio falhou por rede/5xx: pode ter concluído sem a resposta chegar. */
  private submitUncertain = false;

  private pending = new Map<string, AnswerValue | null>();
  private flushing = false;
  private dead = false;

  constructor(opts: FormSessionOptions) {
    this.slug = opts.slug;
    this.identityMode = opts.identityMode;
    this.fields = opts.fields;
    this.doFetch = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.storage = opts.storage === undefined ? browserStorage() : opts.storage;
    this.getLinkToken =
      opts.getLinkToken ??
      (() => {
        try {
          return new URLSearchParams(window.location.search).get('t');
        } catch {
          return null;
        }
      });
    this.getUtm =
      opts.getUtm ??
      (() => {
        const out: Record<string, string> = {};
        try {
          const sp = new URLSearchParams(window.location.search);
          for (const [k, v] of sp) if (k.startsWith('utm_')) out[k] = v;
        } catch {
          /* sem utm */
        }
        return out;
      });
    this.isEmbedded =
      opts.isEmbedded ??
      (() => {
        try {
          return window.parent !== window;
        } catch {
          return true;
        }
      });
    this.loadedAt = this.now();
  }

  // ---------- HTTP ----------

  private async call<T>(
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown
  ): Promise<ApiResult<T>> {
    let res: Response;
    try {
      res = await this.doFetch(
        `/api/forms/public/${encodeURIComponent(this.slug)}${path}`,
        {
          method,
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
    } catch {
      return { ok: false, status: 0, code: 'network', retryable: true };
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* corpo ilegível: segue pelo status */
    }
    if (res.ok) return { ok: true, data: json as T };
    return {
      ok: false,
      status: res.status,
      code: typeof json.code === 'string' ? json.code : 'unexpected',
      errors: Array.isArray(json.errors)
        ? (json.errors as { key: string; code: string }[])
        : undefined,
      maxBytes: typeof json.max_bytes === 'number' ? json.max_bytes : undefined,
      retryable: res.status === 429 || res.status >= 500,
    };
  }

  // ---------- Início ----------

  private identityKey(): string | null {
    return this.fields.find((f) => f.is_identity)?.key ?? null;
  }

  private async start(answers: Answers): Promise<BlockOutcome> {
    // A rota recusa resposta com menos de 3 s de página aberta: espera o
    // que falta em vez de devolver erro a quem foi rápido (autopreenchimento).
    const wait = MIN_FILL_MS - (this.now() - this.loadedAt);
    if (wait > 0) await this.sleep(wait + 100);

    const key = this.identityKey();
    const phoneAnswer = key ? answers[key] : undefined;
    const r = await this.call<{
      already_answered?: boolean;
      response_id?: string;
      resume_token?: string;
    }>('/start', 'POST', {
      phone:
        this.identityMode === 'phone' && typeof phoneAnswer === 'string'
          ? phoneAnswer
          : undefined,
      link_token: this.getLinkToken() ?? undefined,
      utm: this.getUtm(),
      embedded: this.isEmbedded(),
      honeypot: this.honeypot,
      elapsed_ms: this.now() - this.loadedAt,
    });
    if (!r.ok) return { ok: false, code: r.code };
    if (r.data.already_answered) return { ok: true, alreadyAnswered: true };
    if (!r.data.response_id || !r.data.resume_token) {
      return { ok: false, code: 'unexpected' };
    }
    this.responseId = r.data.response_id;
    this.resumeToken = r.data.resume_token;
    // O que já foi respondido antes da identidade vai junto, de uma vez.
    this.enqueue(answers);
    return { ok: true };
  }

  private ensureStarted(answers: Answers): Promise<BlockOutcome> {
    if (this.responseId) return Promise.resolve({ ok: true });
    // Duas chamadas seguidas compartilham o mesmo `start` (clique repetido).
    this.starting ??= this.start(answers).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async blockDone(field: PublicField, answers: Answers): Promise<BlockOutcome> {
    if (this.dead) return { ok: true };
    if (!this.responseId) {
      const shouldStart = this.identityMode === 'token' || field.is_identity;
      if (!shouldStart) return { ok: true };
      return this.ensureStarted(answers);
    }
    this.enqueue({ [field.key]: answers[field.key] ?? null });
    return { ok: true };
  }

  // ---------- Autosave (fila de reenvio) ----------

  private enqueue(delta: Record<string, AnswerValue | null | undefined>) {
    const ids = new Set(
      this.fields.filter((f) => f.type !== 'statement').map((f) => f.key)
    );
    for (const [key, value] of Object.entries(delta)) {
      if (!ids.has(key)) continue;
      this.pending.set(key, value ?? null);
    }
    void this.flush();
  }

  retryPending() {
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.dead || !this.responseId || !this.resumeToken) {
      return;
    }
    this.flushing = true;
    let attempts = 0;
    try {
      while (this.pending.size > 0 && !this.dead) {
        const batch = Object.fromEntries(this.pending);
        this.pending.clear();
        const r = await this.call('/responses/' + this.responseId, 'PATCH', {
          resume_token: this.resumeToken,
          answers_delta: batch,
        });
        if (r.ok) {
          attempts = 0;
          continue;
        }
        if (!r.retryable) {
          // 404 = a resposta acabou (concluída em outra aba, formulário fora
          // do ar): não adianta insistir. Outro 4xx descarta só este lote.
          if (r.status === 404) this.dead = true;
          continue;
        }
        // Volta à fila SEM sobrescrever o que o visitante digitou depois.
        for (const [key, value] of Object.entries(batch)) {
          if (!this.pending.has(key)) this.pending.set(key, value);
        }
        attempts += 1;
        if (attempts >= FLUSH_MAX_ATTEMPTS) break;
        await this.sleep(Math.min(1000 * 2 ** (attempts - 1), 8000));
      }
    } finally {
      this.flushing = false;
    }
  }

  // ---------- Upload ----------

  async upload(
    field: PublicField,
    file: UploadableFile & Partial<Blob>
  ): Promise<UploadOutcome> {
    if (!this.responseId || !this.resumeToken) {
      return { ok: false, code: 'unexpected' };
    }
    const r = await this.call<{
      path: string;
      signed_url: string;
      mime: string;
    }>('/upload-url', 'POST', {
      response_id: this.responseId,
      resume_token: this.resumeToken,
      field_key: field.key,
      name: file.name,
      mime: normalizeMime(file),
      size: file.size,
    });
    if (!r.ok) return { ok: false, code: r.code, maxBytes: r.maxBytes };
    try {
      const put = await this.doFetch(r.data.signed_url, {
        method: 'PUT',
        headers: { 'content-type': r.data.mime, 'x-upsert': 'false' },
        body: file as unknown as BodyInit,
      });
      if (!put.ok) return { ok: false, code: 'upload_failed' };
    } catch {
      return { ok: false, code: 'network' };
    }
    return {
      ok: true,
      ref: {
        path: r.data.path,
        name: file.name,
        mime: r.data.mime,
        size: file.size,
      },
    };
  }

  // ---------- Envio ----------

  setHoneypot(value: string) {
    this.honeypot = value;
  }

  async submit(
    answers: Answers,
    turnstile: string | null
  ): Promise<SubmitOutcome> {
    const started = await this.ensureStarted(answers);
    if (!started.ok) return { ok: false, code: started.code };
    if (started.alreadyAnswered) return { ok: false, code: 'already_answered' };

    const send = () =>
      this.call<{ thank_you?: ThankYouData }>('/submit', 'POST', {
        response_id: this.responseId,
        resume_token: this.resumeToken,
        answers,
        turnstile: turnstile ?? undefined,
        honeypot: this.honeypot,
      });

    let r = await send();
    if (!r.ok && r.code === 'too_fast') {
      await this.sleep(MIN_FILL_MS + 100);
      r = await send();
    }
    if (!r.ok) {
      // Resposta perdida (rede móvel): o envio pode ter concluído no servidor.
      if (r.retryable) this.submitUncertain = true;
      // Reenvio depois de uma tentativa incerta que volta 404: a resposta já
      // foi concluída (o token é descartado ao concluir) — é sucesso, só sem
      // os dados de agradecimento (que o servidor não repete).
      if (r.status === 404 && r.code === 'not_found' && this.submitUncertain) {
        this.clearDraft();
        this.dead = true;
        return {
          ok: true,
          thankYou: { whatsapp_url: null, redirect_url: null },
        };
      }
      return { ok: false, code: r.code, errors: r.errors };
    }

    this.clearDraft();
    this.dead = true; // a resposta acabou; o que sobrou na fila não vale mais
    return {
      ok: true,
      thankYou: {
        whatsapp_url: r.data.thank_you?.whatsapp_url ?? null,
        redirect_url: r.data.thank_you?.redirect_url ?? null,
      },
    };
  }

  // ---------- Rascunho local ----------

  private draftKey() {
    return `${DRAFT_PREFIX}${this.slug}`;
  }

  loadDraft(): Answers {
    try {
      const raw = this.storage?.getItem(this.draftKey());
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { savedAt?: number; answers?: unknown };
      if (
        !parsed ||
        typeof parsed.savedAt !== 'number' ||
        this.now() - parsed.savedAt > DRAFT_MAX_AGE_MS ||
        !parsed.answers ||
        typeof parsed.answers !== 'object' ||
        Array.isArray(parsed.answers)
      ) {
        return {};
      }
      const out: Answers = {};
      const allowed = new Map(this.fields.map((f) => [f.key, f] as const));
      for (const [key, value] of Object.entries(parsed.answers)) {
        const field = allowed.get(key);
        if (!field || field.is_identity) continue;
        if (field.type === 'file_upload' || field.type === 'statement')
          continue;
        out[key] = value as AnswerValue;
      }
      return out;
    } catch {
      return {};
    }
  }

  saveDraft(answers: Answers) {
    try {
      // Arquivos ficam de fora: o caminho vale só para ESTA resposta.
      // O telefone (identidade) também fica de fora: dado pessoal que o
      // próximo usuário do mesmo aparelho não deve ver.
      const byKey = new Map(this.fields.map((f) => [f.key, f] as const));
      const clean: Answers = {};
      for (const [key, value] of Object.entries(answers)) {
        const field = byKey.get(key);
        if (field?.type === 'file_upload' || field?.is_identity) continue;
        clean[key] = value;
      }
      if (Object.keys(clean).length === 0) {
        this.storage?.removeItem(this.draftKey());
        return;
      }
      this.storage?.setItem(
        this.draftKey(),
        JSON.stringify({ savedAt: this.now(), answers: clean })
      );
    } catch {
      /* armazenamento indisponível: o rascunho é conveniência, não requisito */
    }
  }

  private clearDraft() {
    try {
      this.storage?.removeItem(this.draftKey());
    } catch {
      /* idem */
    }
  }
}

/** Sessão para o payload da página (o componente chama uma vez, no cliente). */
export function createFormSession(payload: PublicFormPayload): FormSession {
  return new FormSession({
    slug: payload.slug,
    identityMode: payload.identity.mode === 'token' ? 'token' : 'phone',
    fields: payload.fields,
  });
}
