/**
 * Bytes das mídias da conversa (SPEC 067 §5).
 *
 * É a diferença essencial entre esta exportação e a de contatos: os
 * arquivos vêm de TRÊS origens, e cada uma exige um caminho próprio.
 *
 *   `storage`  → objeto no bucket privado (040). `download()` direto,
 *                com o cliente de SESSÃO: a policy da 040 é quem decide,
 *                e nenhuma URL assinada chega a ser criada para algo que
 *                só o servidor vai consumir.
 *   `proxy`    → handle na Meta, baixável só com o token DO NÚMERO dono
 *                (SPEC 064). O token do outro número devolve 404 da
 *                Graph API numa conta com dois oficiais.
 *   `external` → URL de terceiro colada pelo usuário (header de template,
 *                nó de flow). Passa pela guarda SSRF antes do `fetch` —
 *                sem ela, a exportação vira um leitor de
 *                `169.254.169.254` com as credenciais do servidor.
 *
 * Nada aqui aborta a exportação. Mídia que a Meta já apagou (ela apaga
 * bem antes do que a documentação promete — é o que motivou o download
 * ansioso do webhook) vira `missing`, e o pacote sai com o manifesto
 * dizendo o que faltou: uma foto perdida em 2024 não pode impedir a
 * exportação de 2026 (D-6).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import { decrypt } from '@/lib/whatsapp/encryption';
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api';
import { resolveCloudConfig } from '@/lib/whatsapp/cloud-channels';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { MediaPlanEntry } from './media-plan';

export interface MediaFetchLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  concurrency: number;
}

/** Tetos de D-5, dimensionados para caber no `maxDuration` de 300s. */
export const DEFAULT_MEDIA_FETCH_LIMITS: MediaFetchLimits = {
  maxFiles: 500,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  concurrency: 6,
};

const MEDIA_FETCH_TIMEOUT_MS = 30_000;

/**
 * - `missing`  — o objeto não está mais na origem, ou a RLS/policy o
 *   esconde. Deliberadamente não distingue "não existe" de "não é sua".
 * - `too_large` — passou de `maxFileBytes` sozinho.
 * - `skipped`  — o teto global (bytes ou nº de arquivos) já tinha sido
 *   atingido quando chegou a vez dele.
 * - `error`    — falha nossa ou recusa de segurança (SSRF).
 */
export type MediaFetchStatus =
  'ok' | 'missing' | 'too_large' | 'skipped' | 'error';

export interface FetchedMedia {
  index: number;
  status: MediaFetchStatus;
  bytes: Uint8Array | null;
  mimeType: string | null;
  byteLength: number;
}

interface Budget {
  usedBytes: number;
}

function emptyResult(index: number, status: MediaFetchStatus): FetchedMedia {
  return { index, status, bytes: null, mimeType: null, byteLength: 0 };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Token do canal, resolvido UMA vez por canal e memoizado como PROMESSA
 * — não como valor. Com 6 downloads em voo, memoizar o valor deixaria os
 * 6 primeiros de um mesmo canal resolverem a config em paralelo; a
 * promessa faz o segundo em diante aguardar o primeiro.
 *
 * A falha também é memoizada: um canal desconectado não pode custar uma
 * consulta (e uma exceção) por anexo.
 */
class ChannelTokenCache {
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accountId: string
  ) {}

  get(channelId: string | null): Promise<string | null> {
    const key = channelId ?? '';
    const cached = this.pending.get(key);
    if (cached) return cached;

    const promise = this.resolve(channelId);
    this.pending.set(key, promise);
    return promise;
  }

  private async resolve(channelId: string | null): Promise<string | null> {
    try {
      const { config } = await resolveCloudConfig(
        this.supabase,
        this.accountId,
        channelId ?? undefined
      );
      return decrypt(config.access_token);
    } catch (err) {
      if (err instanceof ChannelNotConfiguredError) {
        console.warn(
          '[conversation-export] channel not configured for media download:',
          { channelId, reason: err.reason }
        );
        return null;
      }
      // Segredo indecifrável tem o mesmo efeito prático de canal sem
      // credencial: nenhuma mídia daquele número é baixável.
      console.error('[conversation-export] token resolution failed:', err);
      return null;
    }
  }
}

async function fetchFromStorage(
  supabase: SupabaseClient,
  entry: MediaPlanEntry & { ref: { kind: 'storage' } },
  limits: MediaFetchLimits
): Promise<FetchedMedia> {
  const { data, error } = await supabase.storage
    .from(entry.ref.bucket)
    .download(entry.ref.path);

  if (error || !data) return emptyResult(entry.index, 'missing');

  // `blob.size` antes do `arrayBuffer()`: um arquivo acima do teto é
  // descartado sem materializar uma segunda cópia dele em memória.
  if (data.size > limits.maxFileBytes) {
    return emptyResult(entry.index, 'too_large');
  }

  const bytes = new Uint8Array(await data.arrayBuffer());
  return {
    index: entry.index,
    status: 'ok',
    bytes,
    mimeType: data.type || null,
    byteLength: bytes.byteLength,
  };
}

async function fetchFromProxy(
  entry: MediaPlanEntry & { ref: { kind: 'proxy' } },
  limits: MediaFetchLimits,
  tokens: ChannelTokenCache
): Promise<FetchedMedia> {
  const accessToken = await tokens.get(entry.channelId);
  if (!accessToken) return emptyResult(entry.index, 'missing');

  try {
    const { url, mimeType } = await getMediaUrl({
      mediaId: entry.ref.mediaId,
      accessToken,
    });
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: url,
      accessToken,
    });

    if (buffer.length > limits.maxFileBytes) {
      return emptyResult(entry.index, 'too_large');
    }

    return {
      index: entry.index,
      status: 'ok',
      bytes: new Uint8Array(buffer),
      mimeType: contentType || mimeType || null,
      byteLength: buffer.length,
    };
  } catch (err) {
    // `missing`, não `error`: a Meta apaga mídia recebida bem antes do
    // prazo documentado, então uma falha aqui é, na prática, sempre
    // expiração — e o usuário precisa da exportação do que sobrou.
    console.warn('[conversation-export] media unavailable at Meta:', {
      index: entry.index,
      message: err instanceof Error ? err.message : String(err),
    });
    return emptyResult(entry.index, 'missing');
  }
}

async function fetchFromExternal(
  entry: MediaPlanEntry & { ref: { kind: 'external' } },
  limits: MediaFetchLimits
): Promise<FetchedMedia> {
  // A URL vem de campo controlável pelo usuário e o `fetch` sai do NOSSO
  // servidor, de dentro da rede do host. Sem esta guarda a exportação
  // vira uma primitiva de SSRF (§15).
  if (!(await isDeliverableUrl(entry.ref.url))) {
    console.warn(
      '[conversation-export] refusing non-public media URL for entry',
      entry.index
    );
    return emptyResult(entry.index, 'error');
  }

  try {
    const response = await fetch(entry.ref.url, {
      // Uma URL pública pode 3xx-saltar para um endereço interno,
      // contornando a checagem acima — mesmo cuidado do `deliver.ts`.
      redirect: 'manual',
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return emptyResult(entry.index, 'missing');

    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > limits.maxFileBytes
    ) {
      return emptyResult(entry.index, 'too_large');
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limits.maxFileBytes) {
      return emptyResult(entry.index, 'too_large');
    }

    return {
      index: entry.index,
      status: 'ok',
      bytes,
      mimeType: response.headers.get('content-type'),
      byteLength: bytes.byteLength,
    };
  } catch (err) {
    console.warn('[conversation-export] external media fetch failed:', {
      index: entry.index,
      message: err instanceof Error ? err.message : String(err),
    });
    return emptyResult(entry.index, 'error');
  }
}

async function fetchOne(
  supabase: SupabaseClient,
  entry: MediaPlanEntry,
  limits: MediaFetchLimits,
  budget: Budget,
  tokens: ChannelTokenCache
): Promise<FetchedMedia> {
  if (budget.usedBytes >= limits.maxTotalBytes) {
    return emptyResult(entry.index, 'skipped');
  }

  let result: FetchedMedia;
  switch (entry.ref.kind) {
    case 'storage':
      result = await fetchFromStorage(
        supabase,
        entry as MediaPlanEntry & { ref: { kind: 'storage' } },
        limits
      );
      break;
    case 'proxy':
      result = await fetchFromProxy(
        entry as MediaPlanEntry & { ref: { kind: 'proxy' } },
        limits,
        tokens
      );
      break;
    case 'external':
      result = await fetchFromExternal(
        entry as MediaPlanEntry & { ref: { kind: 'external' } },
        limits
      );
      break;
    case 'none':
      result = emptyResult(entry.index, 'missing');
      break;
  }

  if (result.status === 'ok') {
    budget.usedBytes += result.byteLength;
  }
  return result;
}

/**
 * Baixa os bytes de cada entrada do plano, respeitando os tetos de D-5.
 *
 * Entradas marcadas como duplicata (mesmo objeto reenviado/encaminhado)
 * NÃO baixam de novo: herdam o resultado da entrada original, com os
 * mesmos bytes por referência. Sem isso, um catálogo reenviado 30 vezes
 * multiplicaria o download por 30.
 *
 * A promessa sempre resolve — nunca rejeita. Estourar o teto global não
 * aborta: o que falta vira `skipped`, e o usuário recebe a exportação
 * parcial com o manifesto dizendo o que ficou de fora. O acumulador é
 * checado no início de cada item, então com `concurrency` downloads em
 * voo o total pode ultrapassar `maxTotalBytes` por até um lote — é
 * deliberado: reservar cota exigiria saber o tamanho antes de baixar.
 */
export async function fetchMediaBytes(
  supabase: SupabaseClient,
  accountId: string,
  plan: MediaPlanEntry[],
  limits: MediaFetchLimits = DEFAULT_MEDIA_FETCH_LIMITS
): Promise<Map<number, FetchedMedia>> {
  const results = new Map<number, FetchedMedia>();
  const tokens = new ChannelTokenCache(supabase, accountId);
  const budget: Budget = { usedBytes: 0 };

  const canonical = plan.filter((entry) => entry.duplicateOfIndex === null);
  const duplicates = plan.filter((entry) => entry.duplicateOfIndex !== null);

  // O teto de arquivos conta OBJETOS, não ocorrências: é sobre o que
  // entra na pasta `midias/`.
  const allowed = canonical.slice(0, limits.maxFiles);
  for (const entry of canonical.slice(limits.maxFiles)) {
    results.set(entry.index, emptyResult(entry.index, 'skipped'));
  }

  const batchSize = Math.max(1, limits.concurrency);
  for (const batch of chunkArray(allowed, batchSize)) {
    // `allSettled`, não `all`: uma rejeição inesperada perderia o lote
    // inteiro, e cada anexo perdido é prova que não chega ao documento.
    const settled = await Promise.allSettled(
      batch.map((entry) => fetchOne(supabase, entry, limits, budget, tokens))
    );

    settled.forEach((outcome, i) => {
      const entry = batch[i];
      if (outcome.status === 'fulfilled') {
        results.set(entry.index, outcome.value);
        return;
      }
      console.error('[conversation-export] media fetch rejected:', {
        index: entry.index,
        reason: outcome.reason,
      });
      results.set(entry.index, emptyResult(entry.index, 'error'));
    });
  }

  for (const entry of duplicates) {
    const origin =
      entry.duplicateOfIndex !== null
        ? results.get(entry.duplicateOfIndex)
        : undefined;
    results.set(
      entry.index,
      origin
        ? { ...origin, index: entry.index }
        : emptyResult(entry.index, 'skipped')
    );
  }

  return results;
}
