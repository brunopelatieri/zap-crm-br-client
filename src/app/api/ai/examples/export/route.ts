import { loadAiConfig } from '@/lib/ai/config';
import { exportDataset } from '@/lib/ai/tuning/export';
import {
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';

/**
 * GET /api/ai/examples/export  (admin+)   ?include_system=1
 *
 * The approved examples as JSONL in chat format (one
 * `{"messages":[…]}` per line), for training a model OUTSIDE the product
 * (SPEC 089 D-19). Every line is masked again on the way out. With
 * `include_system=1` the account's system prompt is the first message of
 * each line.
 */
export async function GET(request: Request) {
  try {
    const g = await tuningGuard('ai-examples-export');
    if (!g.ok) return g.response;

    let systemPrompt: string | null = null;
    if (new URL(request.url).searchParams.get('include_system') === '1') {
      const config = await loadAiConfig(g.supabase, g.accountId, {
        requireActive: false,
      }).catch(() => null);
      systemPrompt = config?.systemPrompt ?? null;
    }

    const dataset = await exportDataset(g.supabase, g.accountId, {
      systemPrompt,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(dataset.jsonl, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="agent-examples-${stamp}.jsonl"`,
        'Cache-Control': 'no-store',
        'X-Example-Count': String(dataset.count),
        'X-Example-Remasked': String(dataset.remasked),
      },
    });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
