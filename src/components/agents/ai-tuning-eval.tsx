'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Loader2, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface EvalCase {
  id: string;
  title: string;
  conversation: Turn[];
  expectHandoff: boolean;
  expectedNotes: string | null;
}

interface EvalRun {
  id: string;
  status: 'running' | 'done' | 'error';
  provider: string;
  model: string;
  promptHash: string;
  caseCount: number;
  completedCount: number;
  totalTokens: number;
  costUsd: number | null;
  errorCode: string | null;
  createdAt: string;
}

interface EvalResult {
  id: string;
  caseId: string | null;
  caseTitle: string;
  conversation: Turn[];
  expectHandoff: boolean;
  expectedNotes: string | null;
  response: string | null;
  handoff: boolean;
  autoPass: boolean | null;
  errorCode: string | null;
  toolCalls: number;
  verdict: 'pass' | 'fail' | null;
}

interface RunDetail {
  run: EvalRun;
  results: EvalResult[];
}

const POLL_MS = 3000;

function errKey(code: unknown): string {
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * Evaluation set (SPEC 089 F7): reference conversations, runs against the
 * account's current configuration, and a side-by-side comparison of two runs.
 * Running spends tokens on the account's own key, so it asks first. Judgment
 * is human (pass / fail per result); the only automatic check is the
 * hand-off one.
 */
export function AiTuningEval() {
  const t = useTranslations('Agents.tuning.eval');
  const te = useTranslations('Agents.tuning.errors');
  const locale = useLocale();

  const [cases, setCases] = useState<EvalCase[]>([]);
  const [maxPerRun, setMaxPerRun] = useState(10);
  const [maxCases, setMaxCases] = useState(50);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runAId, setRunAId] = useState<string | null>(null);
  const [runBId, setRunBId] = useState<string | null>(null);
  const [detailA, setDetailA] = useState<RunDetail | null>(null);
  const [detailB, setDetailB] = useState<RunDetail | null>(null);
  const loadedRef = useRef(false);

  const apiError = useCallback(
    (data: { code?: unknown } | null) => {
      const k = errKey(data?.code);
      return te.has(k) ? te(k) : te('unknown');
    },
    [te]
  );

  const loadAll = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([
        fetch('/api/ai/eval/cases', { cache: 'no-store' }),
        fetch('/api/ai/eval/runs', { cache: 'no-store' }),
      ]);
      const cj = await c.json().catch(() => null);
      const rj = await r.json().catch(() => null);
      if (!c.ok || !r.ok || !cj || !rj) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setCases(cj.cases ?? []);
      setMaxPerRun(cj.limits?.max_cases_per_run ?? 10);
      setMaxCases(cj.limits?.max_cases ?? 50);
      setRuns(rj.runs ?? []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void loadAll();
  }, [loadAll]);

  // Keep the selection inside the cases that exist; start with the first N.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(cases.map((c) => c.id));
      const kept = new Set([...prev].filter((id) => ids.has(id)));
      if (kept.size === 0 && prev.size === 0) {
        return new Set(cases.slice(0, maxPerRun).map((c) => c.id));
      }
      return kept;
    });
  }, [cases, maxPerRun]);

  const fetchDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/ai/eval/runs/${id}`, { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return null;
    return data as RunDetail;
  }, []);

  // Default to the two newest runs (B = newest, A = the one before), ONCE:
  // picking "None" later must stick instead of being refilled.
  const defaultsAppliedRef = useRef(false);
  useEffect(() => {
    if (defaultsAppliedRef.current || runs.length === 0) return;
    defaultsAppliedRef.current = true;
    setRunBId(runs[0].id);
    if (runs.length > 1) setRunAId(runs[1].id);
  }, [runs]);

  const detailRunning =
    detailA?.run.status === 'running' ||
    detailB?.run.status === 'running' ||
    runs.some((r) => r.status === 'running');

  // Load (and, while a run is in progress, poll) the two chosen runs.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const [a, b] = await Promise.all([
        runAId ? fetchDetail(runAId) : Promise.resolve(null),
        runBId ? fetchDetail(runBId) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setDetailA(a);
      setDetailB(b);
    };
    void tick();
    if (!detailRunning) return () => void (cancelled = true);
    const timer = setInterval(() => {
      void tick();
      void loadAll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runAId, runBId, detailRunning, fetchDetail, loadAll]);

  const formatWhen = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : new Intl.DateTimeFormat(locale, {
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(d);
  };

  const money = (v: number | null) =>
    v === null ? t('costUnknown') : `US$ ${v.toFixed(4)}`;

  const lastDone = runs.find((r) => r.status === 'done' && r.costUsd !== null);
  const estimate =
    lastDone && lastDone.caseCount > 0
      ? (lastDone.costUsd as number) / lastDone.caseCount
      : null;

  const saveCase = async (id: string | 'new', draft: CaseDraft) => {
    const res = await fetch(
      id === 'new' ? '/api/ai/eval/cases' : `/api/ai/eval/cases/${id}`,
      {
        method: id === 'new' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          conversation: draft.turns,
          expect_handoff: draft.expectHandoff,
          expected_notes: draft.notes,
        }),
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(apiError(data));
      return false;
    }
    toast.success(t('caseSaved'));
    setEditing(null);
    await loadAll();
    return true;
  };

  const deleteCase = async (id: string) => {
    if (!window.confirm(t('deleteCaseConfirm'))) return;
    const res = await fetch(`/api/ai/eval/cases/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(apiError(await res.json().catch(() => null)));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await loadAll();
  };

  const startRun = async () => {
    setStarting(true);
    try {
      const res = await fetch('/api/ai/eval/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, case_ids: [...selected] }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.run) {
        toast.error(apiError(data));
        return;
      }
      setConfirmOpen(false);
      toast.success(t('runStarted'));
      // The new run is B; the previous newest becomes A.
      setRunAId(runs[0]?.id ?? null);
      setRunBId(data.run.id);
      await loadAll();
    } catch {
      toast.error(te('unknown'));
    } finally {
      setStarting(false);
    }
  };

  const judge = async (resultId: string, verdict: 'pass' | 'fail' | null) => {
    const res = await fetch(`/api/ai/eval/results/${resultId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict }),
    });
    if (!res.ok) {
      toast.error(apiError(await res.json().catch(() => null)));
      return;
    }
    const patchDetail = (d: RunDetail | null): RunDetail | null =>
      d && {
        ...d,
        results: d.results.map((r) =>
          r.id === resultId ? { ...r, verdict } : r
        ),
      };
    setDetailA(patchDetail);
    setDetailB(patchDetail);
  };

  const rows = useMemo(() => {
    const byKey = new Map<
      string,
      { key: string; title: string; a: EvalResult | null; b: EvalResult | null }
    >();
    const keyOf = (r: EvalResult) => r.caseId ?? `title:${r.caseTitle}`;
    for (const r of detailA?.results ?? []) {
      byKey.set(keyOf(r), { key: keyOf(r), title: r.caseTitle, a: r, b: null });
    }
    for (const r of detailB?.results ?? []) {
      const existing = byKey.get(keyOf(r));
      if (existing) existing.b = r;
      else
        byKey.set(keyOf(r), {
          key: keyOf(r),
          title: r.caseTitle,
          a: null,
          b: r,
        });
    }
    return Array.from(byKey.values());
  }, [detailA, detailB]);

  const runLabel = (r: EvalRun) =>
    `${formatWhen(r.createdAt)} · ${r.model} · ${t(`status.${r.status}`)}`;

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (failed) {
    return <p className="text-destructive text-sm">{t('loadFailed')}</p>;
  }

  const tooMany = selected.size > maxPerRun;
  const canRun = selected.size > 0 && !tooMany && !detailRunning;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('casesTitle')}</CardTitle>
          <CardDescription>{t('casesDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => setEditing('new')}
              disabled={cases.length >= maxCases}
            >
              <Plus className="h-3.5 w-3.5" /> {t('newCase')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canRun}
              onClick={() => setConfirmOpen(true)}
            >
              {detailRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {t('runButton', { count: selected.size })}
            </Button>
            <span className="text-muted-foreground text-xs">
              {t('casesCount', { count: cases.length, max: maxCases })}
            </span>
          </div>
          {tooMany && (
            <p className="text-destructive text-xs">
              {t('tooMany', { max: maxPerRun })}
            </p>
          )}

          {editing === 'new' && (
            <CaseEditor
              initial={emptyDraft()}
              onCancel={() => setEditing(null)}
              onSubmit={(d) => saveCase('new', d)}
            />
          )}

          {cases.length === 0 && editing !== 'new' ? (
            <p className="text-muted-foreground text-sm">{t('noCases')}</p>
          ) : (
            <ul className="space-y-2">
              {cases.map((c) => (
                <li key={c.id} className="border-border rounded-lg border p-3">
                  {editing === c.id ? (
                    <CaseEditor
                      initial={{
                        title: c.title,
                        turns: c.conversation,
                        expectHandoff: c.expectHandoff,
                        notes: c.expectedNotes ?? '',
                      }}
                      onCancel={() => setEditing(null)}
                      onSubmit={(d) => saveCase(c.id, d)}
                    />
                  ) : (
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selected.has(c.id)}
                        aria-label={t('selectCase', { title: c.title })}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(c.id);
                            else next.delete(c.id);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1 space-y-1 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{c.title}</span>
                          <Badge variant="secondary">
                            {c.expectHandoff
                              ? t('expectHandoff')
                              : t('expectAnswer')}
                          </Badge>
                        </div>
                        <ConversationView turns={c.conversation} />
                        {c.expectedNotes && (
                          <p className="text-muted-foreground text-xs">
                            {t('expected')}: {c.expectedNotes}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t('editCase')}
                          onClick={() => setEditing(c.id)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t('deleteCase')}
                          onClick={() => deleteCase(c.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('runsTitle')}</CardTitle>
          <CardDescription>{t('runsDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noRuns')}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <RunPicker
                  label={t('runA')}
                  value={runAId}
                  runs={runs}
                  runLabel={runLabel}
                  onChange={setRunAId}
                  allowNone
                  noneLabel={t('none')}
                />
                <RunPicker
                  label={t('runB')}
                  value={runBId}
                  runs={runs}
                  runLabel={runLabel}
                  onChange={setRunBId}
                  allowNone
                  noneLabel={t('none')}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <RunSummary
                  detail={detailA}
                  money={money}
                  formatWhen={formatWhen}
                />
                <RunSummary
                  detail={detailB}
                  money={money}
                  formatWhen={formatWhen}
                />
              </div>
              {detailA &&
                detailB &&
                detailA.run.promptHash !== detailB.run.promptHash && (
                  <p className="text-muted-foreground text-xs">
                    {t('promptChanged')}
                  </p>
                )}
              {detailA &&
                detailB &&
                detailA.run.model !== detailB.run.model && (
                  <p className="text-muted-foreground text-xs">
                    {t('modelChanged', {
                      a: detailA.run.model,
                      b: detailB.run.model,
                    })}
                  </p>
                )}

              <ul className="space-y-3">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className="border-border rounded-lg border p-3"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{row.title}</span>
                      <Badge variant="secondary">
                        {(row.a ?? row.b)?.expectHandoff
                          ? t('expectHandoff')
                          : t('expectAnswer')}
                      </Badge>
                    </div>
                    {(row.a ?? row.b)?.expectedNotes && (
                      <p className="text-muted-foreground mb-2 text-xs">
                        {t('expected')}: {(row.a ?? row.b)?.expectedNotes}
                      </p>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <ResultBox result={row.a} judge={judge} />
                      <ResultBox result={row.b} judge={judge} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('confirmBody', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
            <li>{t('confirmKey')}</li>
            <li>{t('confirmDry')}</li>
            <li>
              {estimate !== null
                ? t('confirmEstimate', {
                    cost: (estimate * selected.size).toFixed(4),
                  })
                : t('confirmNoEstimate')}
            </li>
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={startRun} disabled={starting}>
              {starting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('confirmRun')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------
// Pieces
// ------------------------------------------------------------

function ConversationView({ turns }: { turns: Turn[] }) {
  const t = useTranslations('Agents.tuning.eval');
  return (
    <ul className="space-y-0.5 text-xs">
      {turns.map((turn, i) => (
        <li key={i} className="whitespace-pre-wrap">
          <span className="text-muted-foreground font-medium">
            {turn.role === 'user' ? t('roleUser') : t('roleAssistant')}:
          </span>{' '}
          {turn.content}
        </li>
      ))}
    </ul>
  );
}

function RunPicker({
  label,
  value,
  runs,
  runLabel,
  onChange,
  allowNone,
  noneLabel,
}: {
  label: string;
  value: string | null;
  runs: EvalRun[];
  runLabel: (r: EvalRun) => string;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
  noneLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <select
        className="border-input bg-background h-8 w-full rounded-lg border px-2 text-sm"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {allowNone && <option value="">{noneLabel}</option>}
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {runLabel(r)}
          </option>
        ))}
      </select>
    </div>
  );
}

function RunSummary({
  detail,
  money,
  formatWhen,
}: {
  detail: RunDetail | null;
  money: (v: number | null) => string;
  formatWhen: (iso: string) => string;
}) {
  const t = useTranslations('Agents.tuning.eval');
  if (!detail) return <div />;
  const { run, results } = detail;
  const autoPass = results.filter((r) => r.autoPass === true).length;
  const autoFail = results.filter((r) => r.autoPass === false).length;
  const errors = results.filter((r) => r.autoPass === null).length;
  const pass = results.filter((r) => r.verdict === 'pass').length;
  const fail = results.filter((r) => r.verdict === 'fail').length;
  return (
    <div className="bg-muted/30 space-y-1 rounded-lg p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge
          variant="secondary"
          className={cn(
            run.status === 'error' && 'bg-destructive/10 text-destructive'
          )}
        >
          {run.status === 'running' && (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          {t(`status.${run.status}`)}
        </Badge>
        <span className="text-muted-foreground">
          {formatWhen(run.createdAt)}
        </span>
      </div>
      <p>
        {run.provider} · {run.model}
      </p>
      <p>
        {t('progress', {
          done: run.completedCount,
          total: run.caseCount,
        })}{' '}
        · {t('tokens', { count: run.totalTokens })} · {money(run.costUsd)}
      </p>
      <p>
        {t('autoSummary', { pass: autoPass, fail: autoFail, errors })} ·{' '}
        {t('humanSummary', { pass, fail })}
      </p>
      {run.errorCode && (
        <p className="text-destructive">
          {t('runError', { code: run.errorCode })}
        </p>
      )}
    </div>
  );
}

function ResultBox({
  result,
  judge,
}: {
  result: EvalResult | null;
  judge: (id: string, verdict: 'pass' | 'fail' | null) => void;
}) {
  const t = useTranslations('Agents.tuning.eval');
  const te = useTranslations('Agents.tuning.errors');
  if (!result) {
    return (
      <div className="text-muted-foreground bg-muted/20 rounded-md p-3 text-xs">
        {t('noResult')}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {result.autoPass === null ? (
          <Badge variant="destructive">
            {te.has(errKey(result.errorCode))
              ? te(errKey(result.errorCode))
              : t('errored')}
          </Badge>
        ) : (
          <Badge
            variant="secondary"
            className={
              result.autoPass
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-destructive/10 text-destructive'
            }
          >
            {result.autoPass ? t('autoPass') : t('autoFail')}
          </Badge>
        )}
        {result.handoff && <Badge variant="outline">{t('handedOff')}</Badge>}
        {result.toolCalls > 0 && (
          <Badge variant="outline">
            {t('toolCalls', { count: result.toolCalls })}
          </Badge>
        )}
      </div>
      <p className="whitespace-pre-wrap">
        {result.response ?? (result.handoff ? t('handoffNoText') : '—')}
      </p>
      <div className="flex gap-1.5">
        <Button
          size="xs"
          variant={result.verdict === 'pass' ? 'default' : 'outline'}
          onClick={() =>
            judge(result.id, result.verdict === 'pass' ? null : 'pass')
          }
        >
          <Check className="h-3 w-3" /> {t('verdictPass')}
        </Button>
        <Button
          size="xs"
          variant={result.verdict === 'fail' ? 'destructive' : 'outline'}
          onClick={() =>
            judge(result.id, result.verdict === 'fail' ? null : 'fail')
          }
        >
          <X className="h-3 w-3" /> {t('verdictFail')}
        </Button>
      </div>
    </div>
  );
}

interface CaseDraft {
  title: string;
  turns: Turn[];
  expectHandoff: boolean;
  notes: string;
}

function emptyDraft(): CaseDraft {
  return {
    title: '',
    turns: [{ role: 'user', content: '' }],
    expectHandoff: false,
    notes: '',
  };
}

function CaseEditor({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: CaseDraft;
  onSubmit: (draft: CaseDraft) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useTranslations('Agents.tuning.eval');
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const filled = draft.turns.filter((x) => x.content.trim());
  const valid =
    draft.title.trim().length > 0 &&
    filled.length > 0 &&
    filled[filled.length - 1].role === 'user';

  const setTurn = (i: number, patch: Partial<Turn>) =>
    setDraft({
      ...draft,
      turns: draft.turns.map((x, idx) => (idx === i ? { ...x, ...patch } : x)),
    });

  return (
    <div className="border-border bg-muted/30 space-y-3 rounded-lg border p-3">
      <div className="space-y-1.5">
        <Label>{t('caseTitle')}</Label>
        <Input
          value={draft.title}
          maxLength={120}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder={t('caseTitlePlaceholder')}
        />
      </div>
      <div className="space-y-2">
        <Label>{t('conversation')}</Label>
        {draft.turns.map((turn, i) => (
          <div key={i} className="flex items-start gap-2">
            <select
              className="border-input bg-background h-8 rounded-lg border px-2 text-sm"
              value={turn.role}
              onChange={(e) =>
                setTurn(i, { role: e.target.value as Turn['role'] })
              }
            >
              <option value="user">{t('roleUser')}</option>
              <option value="assistant">{t('roleAssistant')}</option>
            </select>
            <Textarea
              value={turn.content}
              maxLength={1000}
              className="min-h-8"
              onChange={(e) => setTurn(i, { content: e.target.value })}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('removeTurn')}
              disabled={draft.turns.length <= 1}
              onClick={() =>
                setDraft({
                  ...draft,
                  turns: draft.turns.filter((_, idx) => idx !== i),
                })
              }
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={draft.turns.length >= 20}
          onClick={() =>
            setDraft({
              ...draft,
              turns: [
                ...draft.turns,
                {
                  role:
                    draft.turns[draft.turns.length - 1]?.role === 'user'
                      ? 'assistant'
                      : 'user',
                  content: '',
                },
              ],
            })
          }
        >
          <Plus className="h-3.5 w-3.5" /> {t('addTurn')}
        </Button>
        <p className="text-muted-foreground text-xs">{t('conversationHint')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.expectHandoff}
          onChange={(e) =>
            setDraft({ ...draft, expectHandoff: e.target.checked })
          }
        />
        {t('expectHandoffLabel')}
      </label>
      <div className="space-y-1.5">
        <Label>{t('notes')}</Label>
        <Textarea
          value={draft.notes}
          maxLength={1000}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          placeholder={t('notesPlaceholder')}
        />
      </div>
      <p className="text-muted-foreground text-xs">{t('maskNotice')}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!valid || saving}
          onClick={async () => {
            setSaving(true);
            await onSubmit({
              ...draft,
              turns: draft.turns.filter((x) => x.content.trim()),
            });
            setSaving(false);
          }}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('saveCase')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
