'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  Download,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';

type Status = 'candidate' | 'approved' | 'rejected';
type Source = 'manual' | 'draft_edit' | 'handoff_reply';

interface ExampleRow {
  id: string;
  customerMessage: string;
  idealResponse: string;
  aiDraft: string | null;
  tags: string[];
  status: Status;
  source: Source;
  embedded: boolean;
  createdAt: string;
}

interface ListResponse {
  examples: ExampleRow[];
  has_more: boolean;
  counts: Record<Status, number>;
  embeddings_available: boolean;
  limits: { max_approved: number; max_candidates: number };
}

interface MatchRow {
  id: string;
  customerMessage: string;
  idealResponse: string;
  distance: number;
}

const STATUSES: Status[] = ['candidate', 'approved', 'rejected'];
const PAGE = 30;

const SOURCE_CLASS: Record<Source, string> = {
  manual: 'bg-secondary text-secondary-foreground',
  draft_edit: 'bg-primary/10 text-primary',
  handoff_reply: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

function errorCodeKey(code: unknown): string {
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * Dynamic examples and captured corrections (SPEC 089 F7). Candidates come
 * from the inbox (an edited AI draft, or the first human reply after a
 * hand-off) and NEVER reach a prompt until an admin approves them; the text
 * arrives already masked of personal data.
 */
export function AiTuningExamples() {
  const t = useTranslations('Agents.tuning.examples');
  const te = useTranslations('Agents.tuning.errors');
  const locale = useLocale();

  const [status, setStatus] = useState<Status>('candidate');
  const [rows, setRows] = useState<ExampleRow[]>([]);
  const [counts, setCounts] = useState<Record<Status, number>>({
    candidate: 0,
    approved: 0,
    rejected: 0,
  });
  const [embeddingsAvailable, setEmbeddingsAvailable] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [includeSystem, setIncludeSystem] = useState(false);
  const loadSeq = useRef(0);

  const apiError = useCallback(
    (data: { code?: unknown } | null) => {
      const key = errorCodeKey(data?.code);
      return te.has(key) ? te(key) : te('unknown');
    },
    [te]
  );

  const load = useCallback(
    async (offset: number, append: boolean) => {
      const seq = ++loadSeq.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setFailed(false);
      try {
        const qs = new URLSearchParams({
          status,
          limit: String(PAGE),
          offset: String(offset),
        });
        const res = await fetch(`/api/ai/examples?${qs}`, {
          cache: 'no-store',
        });
        const data = (await res.json().catch(() => null)) as
          (ListResponse & { code?: string }) | null;
        if (seq !== loadSeq.current) return;
        if (!res.ok || !data) {
          setFailed(true);
          return;
        }
        setRows((prev) =>
          append ? [...prev, ...data.examples] : data.examples
        );
        setHasMore(data.has_more);
        setCounts(data.counts);
        setEmbeddingsAvailable(data.embeddings_available);
      } catch {
        if (seq === loadSeq.current) setFailed(true);
      } finally {
        if (seq === loadSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [status]
  );

  useEffect(() => {
    setEditingId(null);
    void load(0, false);
  }, [load]);

  const formatWhen = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(d);
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/ai/examples/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(apiError(data));
        return false;
      }
      if (body.status === 'approved' && data?.embedded === false) {
        toast.warning(t('approvedNotEmbedded'));
      } else if (body.status === 'approved') {
        toast.success(t('approved'));
      } else if (body.status === 'rejected') {
        toast.success(t('rejected'));
      } else {
        toast.success(t('saved'));
      }
      await load(0, false);
      return true;
    } catch {
      toast.error(te('unknown'));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(t('deleteConfirm'))) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/ai/examples/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(apiError(await res.json().catch(() => null)));
        return;
      }
      toast.success(t('deleted'));
      await load(0, false);
    } catch {
      toast.error(te('unknown'));
    } finally {
      setBusyId(null);
    }
  };

  const create = async (draft: Draft) => {
    try {
      const res = await fetch('/api/ai/examples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_message: draft.customerMessage,
          ideal_response: draft.idealResponse,
          tags: splitTags(draft.tags),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(apiError(data));
        return false;
      }
      toast.success(
        data?.example?.embedded ? t('created') : t('approvedNotEmbedded')
      );
      setEditingId(null);
      if (status === 'approved') await load(0, false);
      else setStatus('approved');
      return true;
    } catch {
      toast.error(te('unknown'));
      return false;
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/examples/reindex', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(apiError(data));
        return;
      }
      toast.success(
        t('reindexDone', { embedded: data.embedded, failed: data.failed })
      );
      await load(0, false);
    } catch {
      toast.error(te('unknown'));
    } finally {
      setReindexing(false);
    }
  };

  const exportHref = `/api/ai/examples/export${includeSystem ? '?include_system=1' : ''}`;
  const hasUnembedded = status === 'approved' && rows.some((r) => !r.embedded);

  return (
    <div className="space-y-4">
      {!embeddingsAvailable && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t('noEmbeddings')}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {STATUSES.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={status === s ? 'default' : 'outline'}
                onClick={() => setStatus(s)}
              >
                {t(`filter.${s}`)} ({counts[s]})
              </Button>
            ))}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {hasUnembedded && embeddingsAvailable && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={reindex}
                  disabled={reindexing}
                >
                  {reindexing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {t('reindex')}
                </Button>
              )}
              <Button size="sm" onClick={() => setEditingId('new')}>
                <Plus className="h-3.5 w-3.5" /> {t('new')}
              </Button>
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            {t(`filterHint.${status}`)}
          </p>

          {editingId === 'new' && (
            <ExampleEditor
              initial={{ customerMessage: '', idealResponse: '', tags: '' }}
              submitLabel={t('createSubmit')}
              onCancel={() => setEditingId(null)}
              onSubmit={create}
            />
          )}

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : failed ? (
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t(`empty.${status}`)}
            </p>
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="border-border rounded-lg border p-3"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={cn(SOURCE_CLASS[row.source])}
                    >
                      {t(`source.${row.source}`)}
                    </Badge>
                    {row.status === 'approved' && !row.embedded && (
                      <Badge
                        variant="secondary"
                        className="bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      >
                        {t('notEmbedded')}
                      </Badge>
                    )}
                    {row.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                    <span className="text-muted-foreground ml-auto text-xs">
                      {formatWhen(row.createdAt)}
                    </span>
                  </div>

                  {editingId === row.id ? (
                    <ExampleEditor
                      initial={{
                        customerMessage: row.customerMessage,
                        idealResponse: row.idealResponse,
                        tags: row.tags.join(', '),
                      }}
                      submitLabel={t('saveSubmit')}
                      onCancel={() => setEditingId(null)}
                      onSubmit={async (d) => {
                        const ok = await patch(row.id, {
                          customer_message: d.customerMessage,
                          ideal_response: d.idealResponse,
                          tags: splitTags(d.tags),
                        });
                        if (ok) setEditingId(null);
                        return ok;
                      }}
                    />
                  ) : (
                    <div className="space-y-2 text-sm">
                      <div>
                        <p className="text-muted-foreground text-xs font-medium">
                          {t('customerSays')}
                        </p>
                        <p className="whitespace-pre-wrap">
                          {row.customerMessage}
                        </p>
                      </div>
                      {row.aiDraft && (
                        <div>
                          <p className="text-muted-foreground text-xs font-medium">
                            {t('aiSuggested')}
                          </p>
                          <p className="text-muted-foreground whitespace-pre-wrap line-through decoration-1">
                            {row.aiDraft}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-muted-foreground text-xs font-medium">
                          {row.source === 'draft_edit'
                            ? t('humanWrote')
                            : t('idealReply')}
                        </p>
                        <p className="whitespace-pre-wrap">
                          {row.idealResponse}
                        </p>
                      </div>
                    </div>
                  )}

                  {editingId !== row.id && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {row.status !== 'approved' && (
                        <Button
                          size="sm"
                          disabled={busyId === row.id}
                          onClick={() => patch(row.id, { status: 'approved' })}
                        >
                          <Check className="h-3.5 w-3.5" /> {t('approve')}
                        </Button>
                      )}
                      {row.status === 'candidate' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === row.id}
                          onClick={() => patch(row.id, { status: 'rejected' })}
                        >
                          <X className="h-3.5 w-3.5" /> {t('reject')}
                        </Button>
                      )}
                      {row.status !== 'candidate' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === row.id}
                          onClick={() => patch(row.id, { status: 'candidate' })}
                        >
                          <Undo2 className="h-3.5 w-3.5" /> {t('reopen')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => setEditingId(row.id)}
                      >
                        <Pencil className="h-3.5 w-3.5" /> {t('edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busyId === row.id}
                        onClick={() => remove(row.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> {t('delete')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {hasMore && !loading && (
            <Button
              variant="outline"
              size="sm"
              disabled={loadingMore}
              onClick={() => load(rows.length, true)}
            >
              {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('loadMore')}
            </Button>
          )}
        </CardContent>
      </Card>

      <ExampleSearchBox />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('export.title')}</CardTitle>
          <CardDescription>{t('export.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeSystem}
              onChange={(e) => setIncludeSystem(e.target.checked)}
            />
            {t('export.includeSystem')}
          </label>
          {counts.approved === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('export.nothing')}
            </p>
          ) : (
            <a
              href={exportHref}
              download
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Download className="h-3.5 w-3.5" /> {t('export.button')}
            </a>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------
// Editor
// ------------------------------------------------------------

interface Draft {
  customerMessage: string;
  idealResponse: string;
  tags: string;
}

function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function ExampleEditor({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useTranslations('Agents.tuning.examples');
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const valid =
    draft.customerMessage.trim().length > 0 &&
    draft.idealResponse.trim().length > 0;

  return (
    <div className="border-border bg-muted/30 space-y-3 rounded-lg border p-3">
      <div className="space-y-1.5">
        <Label>{t('customerSays')}</Label>
        <Textarea
          value={draft.customerMessage}
          maxLength={1000}
          onChange={(e) =>
            setDraft({ ...draft, customerMessage: e.target.value })
          }
          placeholder={t('customerPlaceholder')}
        />
      </div>
      <div className="space-y-1.5">
        <Label>{t('idealReply')}</Label>
        <Textarea
          value={draft.idealResponse}
          maxLength={2000}
          onChange={(e) =>
            setDraft({ ...draft, idealResponse: e.target.value })
          }
          placeholder={t('replyPlaceholder')}
        />
      </div>
      <div className="space-y-1.5">
        <Label>{t('tags')}</Label>
        <Input
          value={draft.tags}
          onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          placeholder={t('tagsPlaceholder')}
        />
      </div>
      <p className="text-muted-foreground text-xs">{t('maskNotice')}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!valid || saving}
          onClick={async () => {
            setSaving(true);
            const ok = await onSubmit(draft);
            setSaving(false);
            if (!ok) return;
          }}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// "Test examples"
// ------------------------------------------------------------

function ExampleSearchBox() {
  const t = useTranslations('Agents.tuning.examples.search');
  const te = useTranslations('Agents.tuning.errors');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    examples: MatchRow[];
    none: boolean;
    failed: boolean;
    maxDistance: number;
  } | null>(null);

  const run = async () => {
    if (!query.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/ai/examples/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        const key = errorCodeKey(data?.code);
        toast.error(te.has(key) ? te(key) : te('unknown'));
        return;
      }
      setResult({
        examples: data.examples ?? [],
        none: !!data.none,
        failed: !!data.failed,
        maxDistance: data.max_distance,
      });
    } catch {
      toast.error(te('unknown'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={query}
            maxLength={1000}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
            }}
            placeholder={t('placeholder')}
          />
          <Button size="sm" onClick={run} disabled={busy || !query.trim()}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            {t('button')}
          </Button>
        </div>
        {result && (
          <div className="space-y-2 text-sm">
            {result.failed ? (
              <p className="text-amber-600 dark:text-amber-400">
                {t('failed')}
              </p>
            ) : result.none ? (
              <p className="text-muted-foreground">{t('none')}</p>
            ) : result.examples.length === 0 ? (
              <p className="text-muted-foreground">
                {t('noMatch', { distance: result.maxDistance })}
              </p>
            ) : (
              <ul className="space-y-2">
                {result.examples.map((e) => (
                  <li
                    key={e.id}
                    className="border-border rounded-md border p-2"
                  >
                    <Badge variant="outline" className="mb-1">
                      {t('distance', { value: e.distance.toFixed(2) })}
                    </Badge>
                    <p className="whitespace-pre-wrap">{e.customerMessage}</p>
                    <p className="text-muted-foreground mt-1 whitespace-pre-wrap">
                      → {e.idealResponse}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
