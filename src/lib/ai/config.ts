import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import type {
  AiConfig,
  AiProvider,
  EmbeddingsProvider,
  EmbeddingsTarget,
} from './types';
import { resolveEmbeddingsTarget } from './embeddings';
import { parseProviderOptions } from './provider-options';
import { parseToolsConfig } from './tools/config';

interface AiConfigRow {
  provider: AiProvider;
  embeddings_provider: EmbeddingsProvider | null;
  provider_options: unknown;
  model: string;
  api_key: string;
  system_prompt: string | null;
  is_active: boolean;
  auto_reply_enabled: boolean;
  auto_reply_max_per_conversation: number;
  handoff_agent_id: string | null;
  embeddings_api_key: string | null;
  tools_config?: unknown;
}

const BASE_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key, embeddings_provider, provider_options';
// `tools_config` is from migration 105 (SPEC 089 F4). On a database that
// has not received it yet the load falls back to the columns above (every
// tool off) instead of taking auto-reply, drafts and the playground down.
const CONFIG_COLUMNS = `${BASE_COLUMNS}, tools_config`;

/** Postgres `undefined_column` naming `tools_config` (migration 105 missing). */
function isMissingToolsConfig(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === '42703' &&
    typeof e.message === 'string' &&
    e.message.includes('tools_config')
  );
}

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * `db` DEVE ser o cliente de service role (`supabaseAdmin()`): desde a
 * migração 111 (P-14) `authenticated` não tem SELECT em `api_key` nem em
 * `embeddings_api_key`, então o cliente com RLS recebe `42501`. Filtre
 * sempre por `accountId` já validado pela sessão (ver `requireRole`).
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {}
): Promise<AiConfig | null> {
  const { requireActive = true } = opts;
  const select = (columns: string) =>
    db
      .from('ai_configs')
      .select(columns)
      .eq('account_id', accountId)
      .maybeSingle();
  let { data, error } = await select(CONFIG_COLUMNS);
  if (error && isMissingToolsConfig(error)) {
    console.error(
      '[ai config] ai_configs.tools_config is missing — apply migration 105. Tools stay off until then.'
    );
    ({ data, error } = await select(BASE_COLUMNS));
  }

  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as AiConfigRow;
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null;
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null;

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null;
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key);
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`
      );
      embeddingsApiKey = null;
    }
  }

  const apiKey = decrypt(row.api_key);
  return {
    provider: row.provider,
    model: row.model,
    apiKey,
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsTarget: resolveEmbeddingsTarget({
      provider: row.provider,
      apiKey,
      embeddingsProvider: row.embeddings_provider ?? 'openai',
      embeddingsApiKey,
    }),
    providerOptions: parseProviderOptions(row.provider_options),
    toolsConfig: parseToolsConfig(row.tools_config),
  };
}

/**
 * Load the embeddings target (provider + key) independent of
 * `is_active`. Used by the knowledge-base ingest routes so the KB gets
 * embedded (and semantic search works) whenever a key is available, even
 * if the assistant's master switch is currently off. On OpenRouter with
 * no own embeddings key, the chat key is reused (SPEC 089 D-3).
 *
 * `db` deve ser o cliente de service role (mesma regra de `loadAiConfig`).
 *
 * Returns `{ target, corrupt }`: `target` is null when there's no usable
 * key; `corrupt` distinguishes "a key is set but can't be decrypted" so
 * callers can warn rather than silently indexing lexical-only.
 */
export async function loadEmbeddingsTarget(
  db: SupabaseClient,
  accountId: string
): Promise<{ target: EmbeddingsTarget | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('provider, api_key, embeddings_api_key, embeddings_provider')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    // Não é silencioso: `42501` aqui quer dizer que o chamador passou o
    // cliente com RLS (`authenticated` não lê as chaves cifradas desde a
    // 111) e a busca semântica cairia em lexical sem aviso.
    console.error(
      `[ai config] embeddings target for account ${accountId} not loaded (code ${(error as { code?: string }).code ?? 'unknown'}) — pass the service-role client.`
    );
    return { target: null, corrupt: false };
  }
  if (!data) return { target: null, corrupt: false };

  const row = data as Pick<
    AiConfigRow,
    'provider' | 'api_key' | 'embeddings_api_key' | 'embeddings_provider'
  >;
  let embeddingsApiKey: string | null = null;
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key);
    } catch {
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`
      );
      return { target: null, corrupt: true };
    }
  }
  let apiKey = '';
  if (!embeddingsApiKey && row.provider === 'openrouter' && row.api_key) {
    try {
      apiKey = decrypt(row.api_key);
    } catch {
      console.error(
        `[ai config] chat key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`
      );
      return { target: null, corrupt: true };
    }
  }
  return {
    target: resolveEmbeddingsTarget({
      provider: row.provider,
      apiKey,
      embeddingsProvider: row.embeddings_provider ?? 'openai',
      embeddingsApiKey,
    }),
    corrupt: false,
  };
}
