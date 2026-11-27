import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { loadAiConfig } from '@/lib/ai/config';
import { executeEvalRun, listRuns, startEvalRun } from '@/lib/ai/tuning/eval';
import {
  UUID_RE,
  badRequest,
  readJson,
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';
import { EVAL_MAX_CASES_PER_RUN, TuningError } from '@/lib/ai/tuning/types';
import { AiError } from '@/lib/ai/types';
import { RATE_LIMITS } from '@/lib/rate-limit';

export const maxDuration = 300;

/** GET /api/ai/eval/runs  (admin+) → { runs } (newest first, up to 20). */
export async function GET() {
  try {
    const g = await tuningGuard('ai-eval-runs');
    if (!g.ok) return g.response;
    const runs = await listRuns(g.supabase, g.accountId);
    return NextResponse.json({
      runs,
      max_cases_per_run: EVAL_MAX_CASES_PER_RUN,
    });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}

/**
 * POST /api/ai/eval/runs  (admin+)   { confirm: true, case_ids?: string[] }
 *
 * Runs the evaluation cases against the account's CURRENT configuration
 * (provider, model, prompt, knowledge, examples, tools). It SPENDS the
 * account's own provider key, so `confirm: true` is required (the screen
 * asks before sending it), at most 10 cases run at once, and only one run
 * can be in progress. Tools run as a dry run and nothing is sent to anyone.
 *
 * Answers 202 with the run (`status: 'running'`); the cases run after the
 * response and the screen polls `GET /api/ai/eval/runs/[id]`.
 */
export async function POST(request: Request) {
  try {
    const g = await tuningGuard('ai-eval-run', RATE_LIMITS.aiDraft);
    if (!g.ok) return g.response;
    const body = await readJson(request);
    if (!body || body.confirm !== true) {
      return badRequest(
        'Running an evaluation spends tokens on your AI key; send confirm: true.',
        'confirmation_required'
      );
    }
    let caseIds: string[] | undefined;
    if (body.case_ids !== undefined) {
      if (
        !Array.isArray(body.case_ids) ||
        body.case_ids.length === 0 ||
        body.case_ids.length > 50 ||
        !body.case_ids.every((x) => typeof x === 'string' && UUID_RE.test(x))
      ) {
        return badRequest('case_ids must be a non-empty list of case ids.');
      }
      caseIds = body.case_ids as string[];
    }

    const config = await loadAiConfig(supabaseAdmin(), g.accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/eval] loadAiConfig error:', err);
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      });
    });
    if (!config) {
      throw new TuningError(
        'ai_not_configured',
        'No agent configured yet. Add your provider key in Setup.'
      );
    }

    // Run writes are service-role only (no INSERT grant for the member).
    const admin = supabaseAdmin();
    const started = await startEvalRun(
      admin,
      { accountId: g.accountId, userId: g.userId },
      config,
      caseIds
    );
    after(async () => {
      await executeEvalRun(admin, {
        accountId: g.accountId,
        runId: started.run.id,
        config,
        cases: started.cases,
      });
    });
    return NextResponse.json({ run: started.run }, { status: 202 });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
