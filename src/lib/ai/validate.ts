import { generateReply } from './generate';
import { aiRequestTimeoutMs } from './defaults';
import { validateOpenRouterKey } from './providers/openrouter';
import type { AiConfig } from './types';

/**
 * Cheap liveness + auth check with the caller's key. Throws `AiError`
 * (invalid_key / rate_limited / network / timeout) on failure, resolves
 * on success. Used by the settings "Test key" button and before
 * persisting a config — the same "verify before save" discipline the
 * WhatsApp config uses with Meta.
 *
 * OpenRouter: `GET /api/v1/key`, which spends no credit (SPEC 089 F0
 * §1.8). It checks the key only; a wrong model id fails on first use.
 * OpenAI / Anthropic: one tiny generation, as before.
 */
export async function validateAiCredentials(
  config: Pick<AiConfig, 'provider' | 'model' | 'apiKey'> & Partial<AiConfig>
): Promise<void> {
  if (config.provider === 'openrouter') {
    await validateOpenRouterKey(config.apiKey, aiRequestTimeoutMs());
    return;
  }
  await generateReply({
    config: {
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: false,
      autoReplyMaxPerConversation: 3,
      handoffAgentId: null,
      embeddingsTarget: null,
      providerOptions: { denyDataCollection: false },
      ...config,
    },
    systemPrompt:
      'You are a connectivity check. Reply with the single word: OK.',
    messages: [{ role: 'user', content: 'ping' }],
  });
}
