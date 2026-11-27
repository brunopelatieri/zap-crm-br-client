import { NextResponse } from 'next/server';
import { loadEmbeddingsTarget } from '@/lib/ai/config';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { embedPendingExamples } from '@/lib/ai/tuning/examples';
import {
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';

export const maxDuration = 300;

/**
 * POST /api/ai/examples/reindex  (admin+)
 *   → { embedded, failed }
 *
 * Embeds the approved examples that cannot be retrieved yet (approved
 * before an embeddings key existed, or embedded with another model). Spends
 * one embedding per example on the account's key.
 */
export async function POST() {
  try {
    const g = await tuningGuard('ai-examples-reindex');
    if (!g.ok) return g.response;
    const { target, corrupt } = await loadEmbeddingsTarget(
      supabaseAdmin(),
      g.accountId
    );
    if (corrupt) {
      return NextResponse.json(
        {
          error: 'Your embeddings key could not be decrypted.',
          code: 'key_decrypt_failed',
        },
        { status: 400 }
      );
    }
    const result = await embedPendingExamples(g.supabase, {
      accountId: g.accountId,
      userId: g.userId,
      embeddingsTarget: target,
    });
    return NextResponse.json(result);
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
