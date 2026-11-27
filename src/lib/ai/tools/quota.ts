import {
  FORM_RESPONSES_METRIC_PREFIX,
  monthMetricKey,
} from '@/lib/forms/quota';

// ============================================================
// Quota `ai_tool_calls_month` (SPEC 089 D-20, migration 106).
//
// The DATABASE decides (`claim_ai_tool_call` increments the counter and
// refuses over the plan limit; absent = unlimited). This module only holds
// the counter's name so the plan screen can show the usage. The literal is
// a CONTRACT with the migration: `ai_tool_calls:YYYY-MM`, month in
// America/Sao_Paulo (the same clock as `form_responses:YYYY-MM`).
// ============================================================

export const AI_TOOL_CALLS_METRIC_PREFIX = 'ai_tool_calls:';

/** `ai_tool_calls:YYYY-MM` for the instant `now`. */
export function aiToolCallsMetricKey(now: Date): string {
  return monthMetricKey(now).replace(
    FORM_RESPONSES_METRIC_PREFIX,
    AI_TOOL_CALLS_METRIC_PREFIX
  );
}
