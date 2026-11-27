'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Eye,
  FlaskConical,
  Loader2,
  Pencil,
  ShieldAlert,
  Sparkles,
  Wrench,
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
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/dashboard/skeleton';
import { createClient } from '@/lib/supabase/client';
import { AiHttpTools } from './ai-http-tools';
import { AiToolCallsHistory } from './ai-tools-history';
import {
  CheckList,
  PipelineStageList,
  type ListOption,
  type PipelineOption,
  type StageOption,
} from './ai-tools-lists';

type ListKey =
  | 'visible_fields'
  | 'writable_fields'
  | 'pipeline_ids'
  | 'stage_ids'
  | 'tag_ids';

/** Which allow-lists each tool needs (fail-closed: empty = nothing allowed). */
const TOOL_LISTS: Record<string, ListKey[]> = {
  get_contact_profile: ['visible_fields'],
  list_contact_deals: ['pipeline_ids'],
  update_contact_fields: ['writable_fields'],
  add_contact_tags: ['tag_ids'],
  remove_contact_tags: ['tag_ids'],
  create_deal: ['pipeline_ids', 'stage_ids'],
  move_deal_stage: ['pipeline_ids', 'stage_ids'],
};

const VISIBLE_BUILTINS = ['email', 'company', 'phone', 'tags'];
const WRITABLE_BUILTINS = ['name', 'email', 'company'];

interface CatalogItem {
  key: string;
  risk: 'read' | 'write';
}

interface ToolEntry {
  enabled: boolean;
  visible_fields: string[];
  writable_fields: string[];
  pipeline_ids: string[];
  stage_ids: string[];
  tag_ids: string[];
}

type Draft = Record<string, ToolEntry>;

interface ToolsResponse {
  catalog: CatalogItem[];
  tools_config: Record<string, Partial<ToolEntry> | undefined>;
  configured: boolean;
  migration_pending: boolean;
  write_calls_per_conversation: number;
}

interface Options {
  tags: { id: string; name: string }[];
  fields: { id: string; field_name: string }[];
  pipelines: PipelineOption[];
  stages: StageOption[];
}

type TestStatus = 'supported' | 'no_call' | 'unsupported';

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : [];
}

function entryFromServer(raw: Partial<ToolEntry> | undefined): ToolEntry {
  return {
    enabled: raw?.enabled === true,
    visible_fields: strList(raw?.visible_fields),
    writable_fields: strList(raw?.writable_fields),
    pipeline_ids: strList(raw?.pipeline_ids),
    stage_ids: strList(raw?.stage_ids),
    tag_ids: strList(raw?.tag_ids),
  };
}

function draftFromServer(
  catalog: CatalogItem[],
  cfg: ToolsResponse['tools_config']
): Draft {
  const out: Draft = {};
  for (const c of catalog) out[c.key] = entryFromServer(cfg?.[c.key]);
  return out;
}

/**
 * What the PUT would send for one tool: only the lists the tool uses, only
 * ids this screen knows (a deleted item is dropped), stages only under a
 * checked funnel, sorted for a stable comparison. `options = null` skips the
 * "known ids" filter (nothing loaded yet).
 */
function normalizeEntry(
  key: string,
  entry: ToolEntry,
  options: Options | null
): Record<string, unknown> {
  const out: Record<string, unknown> = { enabled: entry.enabled };
  const lists = TOOL_LISTS[key] ?? [];
  const known: Record<ListKey, Set<string> | null> = options
    ? {
        tag_ids: new Set(options.tags.map((x) => x.id)),
        pipeline_ids: new Set(options.pipelines.map((x) => x.id)),
        stage_ids: new Set(options.stages.map((x) => x.id)),
        visible_fields: new Set([
          ...VISIBLE_BUILTINS,
          ...options.fields.map((f) => `custom:${f.id}`),
        ]),
        writable_fields: new Set([
          ...WRITABLE_BUILTINS,
          ...options.fields.map((f) => `custom:${f.id}`),
        ]),
      }
    : {
        tag_ids: null,
        pipeline_ids: null,
        stage_ids: null,
        visible_fields: null,
        writable_fields: null,
      };
  for (const list of lists) {
    let values = entry[list];
    const k = known[list];
    if (k) values = values.filter((v) => k.has(v));
    if (list === 'stage_ids' && options) {
      const stagePipeline = new Map(
        options.stages.map((s) => [s.id, s.pipeline_id])
      );
      const picked = new Set(entry.pipeline_ids);
      values = values.filter((v) => picked.has(stagePipeline.get(v) ?? ''));
    }
    out[list] = [...new Set(values)].sort();
  }
  return out;
}

export function AiTools({
  onGoToSetup,
  onGoToPlayground,
}: {
  onGoToSetup: () => void;
  onGoToPlayground: () => void;
}) {
  const t = useTranslations('Agents.tools');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ToolsResponse | null>(null);
  const [saved, setSaved] = useState<Draft>({});
  const [draft, setDraft] = useState<Draft>({});
  const [options, setOptions] = useState<Options | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestStatus | null>(null);
  const startedRef = useRef(false);

  const errorMessage = useCallback(
    (code: unknown, status: number) => {
      if (typeof code === 'string' && t.has(`errors.${code}`)) {
        return t(`errors.${code}`);
      }
      if (status === 429) return t('errors.rate_limited');
      return t('errors.generic');
    },
    [t]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/ai/tools', { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        setLoadError(errorMessage(json?.code, res.status));
        return;
      }
      const data = json as ToolsResponse;
      const d = draftFromServer(data.catalog ?? [], data.tools_config ?? {});
      setMeta(data);
      setSaved(d);
      setDraft(d);
    } catch {
      setLoadError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [errorMessage, t]);

  const loadOptions = useCallback(async () => {
    setOptionsError(false);
    try {
      const supabase = createClient();
      const [tags, fields, pipelines, stages] = await Promise.all([
        supabase.from('tags').select('id, name').order('name'),
        supabase
          .from('custom_fields')
          .select('id, field_name')
          .order('field_name'),
        supabase.from('pipelines').select('id, name').order('name'),
        supabase
          .from('pipeline_stages')
          .select('id, pipeline_id, name, position')
          .order('position'),
      ]);
      if (tags.error || fields.error || pipelines.error || stages.error) {
        setOptionsError(true);
        return;
      }
      setOptions({
        tags: (tags.data ?? []) as Options['tags'],
        fields: (fields.data ?? []) as Options['fields'],
        pipelines: (pipelines.data ?? []) as Options['pipelines'],
        stages: (stages.data ?? []) as Options['stages'],
      });
    } catch {
      setOptionsError(true);
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void load();
    void loadOptions();
  }, [load, loadOptions]);

  const catalog = useMemo(() => meta?.catalog ?? [], [meta]);

  const dirty = useMemo(
    () =>
      catalog.some(
        (c) =>
          JSON.stringify(normalizeEntry(c.key, draft[c.key], options)) !==
          JSON.stringify(normalizeEntry(c.key, saved[c.key], options))
      ),
    [catalog, draft, saved, options]
  );

  const migrationPending = meta?.migration_pending === true;
  const notConfigured = meta !== null && !meta.configured;
  const canSave =
    dirty &&
    !saving &&
    !migrationPending &&
    !notConfigured &&
    options !== null &&
    !optionsError;

  const patch = (key: string, change: Partial<ToolEntry>) =>
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...change } }));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: Record<string, Record<string, unknown>> = {};
      for (const c of catalog) {
        payload[c.key] = normalizeEntry(c.key, draft[c.key], options);
      }
      const res = await fetch('/api/ai/tools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools_config: payload }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(errorMessage(json?.code, res.status));
        return;
      }
      const d = draftFromServer(catalog, json?.tools_config ?? payload);
      setSaved(d);
      setDraft(d);
      toast.success(t('saved'));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => setDraft(saved);

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ai/tools/test', { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(errorMessage(json?.code, res.status));
        return;
      }
      const status = json?.status;
      if (
        status === 'supported' ||
        status === 'no_call' ||
        status === 'unsupported'
      ) {
        setTestResult(status);
      } else {
        toast.error(t('errors.generic'));
      }
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setTesting(false);
    }
  };

  // ------------------------------------------------------------------
  // Allow-list controls for one tool.
  // ------------------------------------------------------------------
  const fieldOptions = (builtins: string[]): ListOption[] => [
    ...builtins.map((b) => ({ value: b, label: t(`fields.${b}`) })),
    ...(options?.fields ?? []).map((f) => ({
      value: `custom:${f.id}`,
      label: t('fields.custom', { name: f.field_name }),
    })),
  ];

  const renderLists = (key: string, entry: ToolEntry) => {
    const lists = TOOL_LISTS[key];
    if (!lists) return null;
    if (!options) {
      return (
        <p className="text-muted-foreground text-xs">
          {optionsError ? t('optionsFailed') : t('optionsLoading')}
        </p>
      );
    }
    const emptyOptions = t('noOptions');
    const norm = normalizeEntry(key, entry, options);
    const isEmpty = lists.some(
      (l) => ((norm[l] as string[] | undefined) ?? []).length === 0
    );

    return (
      <div className="space-y-3">
        {lists.includes('visible_fields') && (
          <ListBlock
            title={t('lists.visibleFields')}
            hint={t('lists.visibleFieldsHint')}
          >
            <CheckList
              options={fieldOptions(VISIBLE_BUILTINS)}
              selected={entry.visible_fields}
              onChange={(v) => patch(key, { visible_fields: v })}
              emptyLabel={emptyOptions}
            />
          </ListBlock>
        )}
        {lists.includes('writable_fields') && (
          <ListBlock title={t('lists.writableFields')}>
            <CheckList
              options={fieldOptions(WRITABLE_BUILTINS)}
              selected={entry.writable_fields}
              onChange={(v) => patch(key, { writable_fields: v })}
              emptyLabel={emptyOptions}
            />
          </ListBlock>
        )}
        {lists.includes('tag_ids') && (
          <ListBlock title={t('lists.tags')}>
            <CheckList
              options={options.tags.map((x) => ({
                value: x.id,
                label: x.name,
              }))}
              selected={entry.tag_ids}
              onChange={(v) => patch(key, { tag_ids: v })}
              emptyLabel={t('noTags')}
            />
          </ListBlock>
        )}
        {lists.includes('pipeline_ids') && !lists.includes('stage_ids') && (
          <ListBlock title={t('lists.pipelines')}>
            <CheckList
              options={options.pipelines.map((x) => ({
                value: x.id,
                label: x.name,
              }))}
              selected={entry.pipeline_ids}
              onChange={(v) => patch(key, { pipeline_ids: v })}
              emptyLabel={t('noPipelines')}
            />
          </ListBlock>
        )}
        {lists.includes('stage_ids') && (
          <ListBlock
            title={t('lists.pipelinesAndStages')}
            hint={t('lists.pipelinesAndStagesHint')}
          >
            <PipelineStageList
              pipelines={options.pipelines}
              stages={options.stages}
              selectedPipelines={entry.pipeline_ids}
              selectedStages={entry.stage_ids}
              onChange={(p, s) => patch(key, { pipeline_ids: p, stage_ids: s })}
              emptyLabel={t('noPipelines')}
            />
          </ListBlock>
        )}
        {isEmpty && (
          <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {t('emptyListHint')}
          </p>
        )}
      </div>
    );
  };

  const renderTool = (item: CatalogItem) => {
    const entry = draft[item.key];
    if (!entry) return null;
    const name = t.has(`catalog.${item.key}.name`)
      ? t(`catalog.${item.key}.name`)
      : item.key;
    const description = t.has(`catalog.${item.key}.description`)
      ? t(`catalog.${item.key}.description`)
      : '';
    return (
      <div
        key={item.key}
        className="border-border bg-card space-y-3 rounded-lg border p-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-foreground flex flex-wrap items-center gap-2 text-sm font-medium">
              {name}
              {item.risk === 'write' && (
                <Badge variant="outline">{t('writeBadge')}</Badge>
              )}
            </p>
            {description && (
              <p className="text-muted-foreground mt-1 text-xs">
                {description}
              </p>
            )}
          </div>
          <Switch
            checked={entry.enabled}
            onCheckedChange={(v) => patch(item.key, { enabled: v === true })}
            aria-label={t('toggleLabel', { name })}
            disabled={migrationPending || notConfigured}
          />
        </div>
        {entry.enabled && renderLists(item.key, entry)}
      </div>
    );
  };

  // ------------------------------------------------------------------
  if (loading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (loadError || !meta) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-2 pt-6">
          <p className="text-destructive flex items-center gap-1.5 text-sm">
            <AlertTriangle className="h-4 w-4" />{' '}
            {loadError ?? t('errors.generic')}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const readTools = catalog.filter((c) => c.risk === 'read');
  const writeTools = catalog.filter((c) => c.risk === 'write');

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
        <p className="text-foreground flex items-center gap-2 font-medium">
          <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          {t('writeWarningTitle')}
        </p>
        <p className="text-foreground">{t('writeWarning')}</p>
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
          <li>{t('warnPlayground')}</li>
          <li>{t('warnDraft')}</li>
          <li>{t('warnOwnContact')}</li>
          <li>{t('warnBornOff')}</li>
          <li>
            {t('warnWriteLimit', { count: meta.write_calls_per_conversation })}
          </li>
        </ul>
        <p className="text-muted-foreground text-xs">{t('untrustedNote')}</p>
      </div>

      {migrationPending && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <p>{t('migrationPending')}</p>
        </div>
      )}

      {notConfigured && !migrationPending && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            {t('notConfigured')}
          </p>
          <Button variant="outline" size="sm" onClick={onGoToSetup}>
            {t('goToSetup')}
          </Button>
        </div>
      )}

      {optionsError && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            {t('optionsFailed')}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadOptions()}
          >
            {t('retry')}
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="text-primary h-4 w-4" /> {t('testTitle')}
          </CardTitle>
          <CardDescription>{t('testDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runTest()}
              disabled={testing || notConfigured}
            >
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wrench className="h-4 w-4" />
              )}
              {testing ? t('testing') : t('testButton')}
            </Button>
            <Button variant="outline" size="sm" onClick={onGoToPlayground}>
              <Sparkles className="h-4 w-4" /> {t('simulateButton')}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">{t('simulateHint')}</p>
          {testResult && (
            <p
              className={
                testResult === 'supported'
                  ? 'text-sm text-emerald-600 dark:text-emerald-400'
                  : 'text-sm text-amber-600 dark:text-amber-400'
              }
              role="status"
            >
              {testResult === 'supported'
                ? t('testSupported')
                : testResult === 'no_call'
                  ? t('testNoCall')
                  : t('testUnsupported')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="text-primary h-4 w-4" /> {t('sectionRead')}
          </CardTitle>
          <CardDescription>{t('sectionReadDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {readTools.map(renderTool)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Pencil className="text-primary h-4 w-4" /> {t('sectionWrite')}
          </CardTitle>
          <CardDescription>{t('sectionWriteDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {writeTools.map(renderTool)}
        </CardContent>
      </Card>

      <div className="border-border bg-background/95 sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 backdrop-blur">
        <p className="text-muted-foreground text-xs">
          {dirty ? t('unsaved') : t('allSaved')}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={discard}
            disabled={!dirty || saving}
          >
            {t('discard')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!canSave}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>

      <AiHttpTools />

      <AiToolCallsHistory />
    </div>
  );
}

function ListBlock({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-foreground text-xs font-medium">{title}</p>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      {children}
    </div>
  );
}
