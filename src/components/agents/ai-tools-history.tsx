'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';

type CallStatus = 'started' | 'ok' | 'error' | 'timeout' | 'refused';

interface ToolCallRow {
  id: string;
  conversation_id: string | null;
  mode: string;
  tool: string;
  risk: 'read' | 'write';
  input: unknown;
  output_summary: unknown;
  status: CallStatus;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface ToolCallsResponse {
  calls: ToolCallRow[];
  has_more: boolean;
  migration_pending: boolean;
}

const PAGE_SIZE = 50;

const KNOWN_ERROR_CODES = new Set([
  'tag_not_allowed',
  'field_not_allowed',
  'pipeline_not_allowed',
  'stage_not_allowed',
  'deal_not_found',
  'deal_not_allowed',
  'deal_not_open',
  'deal_stage_not_allowed',
  'duplicate_deal',
  'contact_not_found',
  'update_failed',
  'write_limit_reached',
  'quota_exceeded',
  'audit_unavailable',
  'tool_timeout',
  'tool_failed',
  'not_available',
  'not_enough_time',
  'turn_ended',
  'duplicate_call',
  'conversation_not_found',
  'endpoint_not_allowed',
  'endpoint_redirect',
  'unsupported_response',
  'response_too_large',
  'endpoint_timeout',
  'endpoint_unreachable',
  'headers_unreadable',
  'http_error',
]);

const STATUS_CLASS: Record<CallStatus, string> = {
  ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  error: 'bg-destructive/10 text-destructive',
  timeout: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  refused: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  started: 'bg-secondary text-secondary-foreground',
};

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Audit history of the agent's tool calls (SPEC 089 F5). Newest first,
 * paged with `before=<created_at of the last row>`. `input` and
 * `output_summary` arrive with personal data already masked; they are shown
 * as they are.
 */
export function AiToolCallsHistory() {
  const t = useTranslations('Agents.tools');
  const locale = useLocale();

  const [rows, setRows] = useState<ToolCallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [migrationPending, setMigrationPending] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const startedRef = useRef(false);

  const formatWhen = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(d);
  };

  const fetchPage = useCallback(async (before: string | null) => {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) qs.set('before', before);
    const res = await fetch(`/api/ai/tool-calls?${qs.toString()}`, {
      cache: 'no-store',
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error('load_failed');
    return json as ToolCallsResponse;
  }, []);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const data = await fetchPage(null);
      setRows(data.calls ?? []);
      setHasMore(!!data.has_more);
      setMigrationPending(!!data.migration_pending);
      setExpanded(new Set());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void loadFirst();
  }, [loadFirst]);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    setFailed(false);
    try {
      const data = await fetchPage(last.created_at);
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...(data.calls ?? []).filter((r) => !seen.has(r.id))];
      });
      setHasMore(!!data.has_more);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toolName = (key: string) =>
    t.has(`catalog.${key}.name`) ? t(`catalog.${key}.name`) : key;
  const statusLabel = (s: string) =>
    t.has(`history.status.${s}`) ? t(`history.status.${s}`) : s;
  const errorLabel = (code: string) =>
    KNOWN_ERROR_CODES.has(code) ? t(`errorCodes.${code}`) : code;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="text-primary h-4 w-4" /> {t('history.title')}
        </CardTitle>
        <CardDescription>{t('history.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-xs">
          {t('history.privacyNote')}
        </p>

        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : failed && rows.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-destructive flex items-center gap-1.5 text-sm">
              <AlertTriangle className="h-4 w-4" /> {t('history.loadFailed')}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadFirst()}
            >
              {t('history.retry')}
            </Button>
          </div>
        ) : migrationPending ? (
          <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            {t('history.migrationPending')}
          </p>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-8 text-center text-sm">
            <History className="h-8 w-8 opacity-40" />
            <p>{t('history.emptyTitle')}</p>
            <p className="text-xs">{t('history.emptyDesc')}</p>
          </div>
        ) : (
          <>
            <ul className="divide-border border-border divide-y rounded-md border">
              {rows.map((row) => {
                const open = expanded.has(row.id);
                const inputText = asText(row.input);
                const outputText = asText(row.output_summary);
                const Chevron = open ? ChevronDown : ChevronRight;
                return (
                  <li key={row.id} className="px-3 py-2 text-sm">
                    <button
                      type="button"
                      onClick={() => toggle(row.id)}
                      aria-expanded={open}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
                    >
                      <Chevron className="text-muted-foreground h-4 w-4 flex-shrink-0" />
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {formatWhen(row.created_at)}
                      </span>
                      <span className="text-foreground min-w-0 font-medium">
                        {toolName(row.tool)}
                      </span>
                      <Badge
                        variant="ghost"
                        className={cn(
                          'hover:bg-inherit',
                          STATUS_CLASS[row.status] ?? STATUS_CLASS.started
                        )}
                      >
                        {statusLabel(row.status)}
                      </Badge>
                      {row.risk === 'write' && (
                        <Badge variant="outline">{t('writeBadge')}</Badge>
                      )}
                      {row.duration_ms !== null &&
                        row.duration_ms !== undefined && (
                          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                            {t('history.duration', { ms: row.duration_ms })}
                          </span>
                        )}
                    </button>
                    {open && (
                      <div className="mt-2 space-y-2 pl-7">
                        {row.error_code && (
                          <p className="text-xs">
                            <span className="text-muted-foreground">
                              {t('history.reason')}:{' '}
                            </span>
                            <span className="text-foreground">
                              {errorLabel(row.error_code)}
                            </span>
                          </p>
                        )}
                        <div>
                          <p className="text-muted-foreground mb-1 text-xs font-medium">
                            {t('history.input')}
                          </p>
                          <pre className="bg-muted/50 max-h-48 overflow-auto rounded-md p-2 text-xs break-words whitespace-pre-wrap">
                            {inputText || t('history.none')}
                          </pre>
                        </div>
                        <div>
                          <p className="text-muted-foreground mb-1 text-xs font-medium">
                            {t('history.output')}
                          </p>
                          <pre className="bg-muted/50 max-h-48 overflow-auto rounded-md p-2 text-xs break-words whitespace-pre-wrap">
                            {outputText || t('history.none')}
                          </pre>
                        </div>
                        {row.conversation_id && (
                          <Link
                            href={`/inbox?c=${encodeURIComponent(row.conversation_id)}`}
                            className="text-primary text-xs underline-offset-4 hover:underline"
                          >
                            {t('history.openConversation')}
                          </Link>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {failed && (
              <p className="text-destructive flex items-center gap-1.5 text-xs">
                <AlertTriangle className="h-3.5 w-3.5" />{' '}
                {t('history.loadFailed')}
              </p>
            )}
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                {failed ? t('history.retry') : t('history.loadMore')}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
