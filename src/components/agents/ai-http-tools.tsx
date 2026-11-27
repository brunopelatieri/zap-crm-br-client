'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  FlaskConical,
  Globe,
  Loader2,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
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
import { Checkbox } from '@/components/ui/checkbox';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

// ============================================================
// HTTP tools of the account (SPEC 089 F6): create, edit, simulate, delete.
// The rules live on the server (`/api/ai/custom-tools`); this screen only
// collects the fields. Header VALUES are write-only: a saved header shows
// its name and an empty value box ("leave blank to keep").
// ============================================================

type FieldType = 'string' | 'number' | 'integer' | 'boolean';

interface ToolView {
  id: string;
  name: string;
  description: string;
  input_schema: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  } | null;
  url: string;
  method: 'GET' | 'POST';
  risk: 'read' | 'write';
  header_names: string[];
  has_headers: boolean;
  timeout_ms: number;
  is_active: boolean;
}

interface FieldRow {
  key: number;
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
  /** Keywords the screen does not edit (enum, limits…): kept as they were. */
  extra: Record<string, unknown>;
}

interface HeaderRow {
  key: number;
  name: string;
  value: string;
  /** Already saved on the server: a blank value keeps it. */
  saved: boolean;
}

interface FormState {
  name: string;
  description: string;
  url: string;
  method: 'GET' | 'POST';
  risk: 'read' | 'write';
  timeoutSec: string;
  fields: FieldRow[];
  headers: HeaderRow[];
}

const MAX_FIELDS = 10;
const MAX_HEADERS = 10;
const FIELD_TYPES: FieldType[] = ['string', 'number', 'integer', 'boolean'];

let rowSeq = 0;
const nextKey = () => (rowSeq += 1);

function emptyForm(): FormState {
  return {
    name: '',
    description: '',
    url: 'https://',
    method: 'POST',
    risk: 'write',
    timeoutSec: '8',
    fields: [],
    headers: [],
  };
}

function formFromTool(tool: ToolView): FormState {
  const props = tool.input_schema?.properties ?? {};
  const required = new Set(tool.input_schema?.required ?? []);
  return {
    name: tool.name,
    description: tool.description,
    url: tool.url,
    method: tool.method,
    risk: tool.risk,
    timeoutSec: String(Math.round(tool.timeout_ms / 1000)),
    fields: Object.entries(props).map(([name, spec]) => {
      const { type, description, ...extra } = spec as {
        type?: FieldType;
        description?: string;
        [k: string]: unknown;
      };
      return {
        key: nextKey(),
        name,
        type: FIELD_TYPES.includes(type as FieldType)
          ? (type as FieldType)
          : 'string',
        required: required.has(name),
        description: typeof description === 'string' ? description : '',
        extra,
      };
    }),
    headers: tool.header_names.map((name) => ({
      key: nextKey(),
      name,
      value: '',
      saved: true,
    })),
  };
}

/** The body of a create / update request from the form. */
function payloadFromForm(form: FormState) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of form.fields) {
    const name = f.name.trim();
    if (!name) continue;
    // Keywords that only make sense for another type are dropped.
    const extra = { ...f.extra };
    if (f.type !== 'string') {
      delete extra.minLength;
      delete extra.maxLength;
    }
    if (f.type !== 'number' && f.type !== 'integer') {
      delete extra.minimum;
      delete extra.maximum;
    }
    if (f.type === 'boolean') delete extra.enum;
    properties[name] = {
      ...extra,
      type: f.type,
      ...(f.description.trim() ? { description: f.description.trim() } : {}),
    };
    if (f.required) required.push(name);
  }
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    url: form.url.trim(),
    method: form.method,
    risk: form.risk,
    timeout_ms: Math.round(Number(form.timeoutSec) * 1000),
    input_schema: { type: 'object', properties, required },
    headers: form.headers
      .filter((h) => h.name.trim())
      .map((h) => ({
        name: h.name.trim(),
        ...(h.value ? { value: h.value } : {}),
      })),
  };
}

export function AiHttpTools() {
  const t = useTranslations('Agents.tools.http');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolView[]>([]);
  const [max, setMax] = useState(20);
  const [migrationPending, setMigrationPending] = useState(false);

  const [form, setForm] = useState<FormState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [simTool, setSimTool] = useState<ToolView | null>(null);
  const [simArgs, setSimArgs] = useState('{}');
  const [simRunning, setSimRunning] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<{
    method: string;
    url: string;
    arguments: unknown;
  } | null>(null);

  const startedRef = useRef(false);

  const errorMessage = useCallback(
    (code: unknown, status: number, detail?: unknown) => {
      let base: string;
      if (typeof code === 'string' && t.has(`errors.${code}`)) {
        base = t(`errors.${code}`);
      } else if (status === 429) {
        base = t('errors.rate_limited');
      } else {
        base = t('errors.generic');
      }
      // The server's English reason (`identity_field:contact_id`…) helps a
      // field-level error; it is an identifier, not a sentence.
      return code === 'invalid_schema' && typeof detail === 'string'
        ? `${base} (${detail})`
        : base;
    },
    [t]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/ai/custom-tools', { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        setLoadError(errorMessage(json?.code, res.status));
        return;
      }
      setTools((json.tools ?? []) as ToolView[]);
      setMax(typeof json.max_tools === 'number' ? json.max_tools : 20);
      setMigrationPending(json.migration_pending === true);
    } catch {
      setLoadError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [errorMessage, t]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setFormError(null);
    setForm(emptyForm());
  };

  const openEdit = (tool: ToolView) => {
    setEditingId(tool.id);
    setFormError(null);
    setForm(formFromTool(tool));
  };

  const save = async () => {
    if (!form || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch(
        editingId
          ? `/api/ai/custom-tools/${editingId}`
          : '/api/ai/custom-tools',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadFromForm(form)),
        }
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError(errorMessage(json?.code, res.status, json?.error));
        return;
      }
      setForm(null);
      toast.success(editingId ? t('updated') : t('created'));
      await load();
    } catch {
      setFormError(t('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (tool: ToolView, active: boolean) => {
    setTogglingId(tool.id);
    try {
      const res = await fetch(`/api/ai/custom-tools/${tool.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: active }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(errorMessage(json?.code, res.status));
        return;
      }
      setTools((prev) =>
        prev.map((x) => (x.id === tool.id ? { ...x, is_active: active } : x))
      );
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setTogglingId(null);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/custom-tools/${id}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(errorMessage(json?.code, res.status));
        return;
      }
      setDeleteId(null);
      toast.success(t('deleted'));
      await load();
    } catch {
      toast.error(t('errors.generic'));
    }
  };

  const openSimulate = (tool: ToolView) => {
    setSimTool(tool);
    setSimArgs('{}');
    setSimError(null);
    setSimResult(null);
  };

  const runSimulation = async () => {
    if (!simTool || simRunning) return;
    let args: unknown;
    try {
      args = JSON.parse(simArgs || '{}');
    } catch {
      setSimError(t('test.invalidJson'));
      return;
    }
    setSimRunning(true);
    setSimError(null);
    setSimResult(null);
    try {
      const res = await fetch(`/api/ai/custom-tools/${simTool.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: args }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setSimError(errorMessage(json?.code, res.status, json?.error));
        return;
      }
      setSimResult(json.simulation.would_call);
    } catch {
      setSimError(t('errors.generic'));
    } finally {
      setSimRunning(false);
    }
  };

  const patchForm = (change: Partial<FormState>) =>
    setForm((prev) => (prev ? { ...prev, ...change } : prev));

  const patchField = (key: number, change: Partial<FieldRow>) =>
    setForm((prev) =>
      prev
        ? {
            ...prev,
            fields: prev.fields.map((f) =>
              f.key === key ? { ...f, ...change } : f
            ),
          }
        : prev
    );

  const patchHeader = (key: number, change: Partial<HeaderRow>) =>
    setForm((prev) =>
      prev
        ? {
            ...prev,
            headers: prev.headers.map((h) =>
              h.key === key ? { ...h, ...change } : h
            ),
          }
        : prev
    );

  const atLimit = tools.length >= max;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="text-foreground flex items-center gap-2 font-medium">
            <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            {t('warnTitle')}
          </p>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
            <li>{t('warnData')}</li>
            <li>{t('warnAnswer')}</li>
            <li>{t('warnSecret')}</li>
            <li>{t('warnLimits')}</li>
            <li>{t('warnModes')}</li>
          </ul>
        </div>

        {migrationPending && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <p>{t('migrationPending')}</p>
          </div>
        )}

        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
          </p>
        ) : loadError ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-destructive flex items-center gap-1.5 text-sm">
              <AlertTriangle className="h-4 w-4" /> {loadError}
            </p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                {t('count', { count: tools.length, max })}
                {atLimit ? ` · ${t('limitReached')}` : ''}
              </p>
              <Button
                size="sm"
                onClick={openCreate}
                disabled={migrationPending || atLimit}
              >
                <Plus className="h-4 w-4" /> {t('add')}
              </Button>
            </div>

            {tools.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('empty')}</p>
            ) : (
              <div className="space-y-3">
                {tools.map((tool) => (
                  <div
                    key={tool.id}
                    className="border-border bg-card space-y-3 rounded-lg border p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <p className="text-foreground flex flex-wrap items-center gap-2 text-sm font-medium">
                          <span className="font-mono">{tool.name}</span>
                          <Badge variant="outline">
                            {tool.risk === 'write'
                              ? t('riskWrite')
                              : t('riskRead')}
                          </Badge>
                          <Badge variant="outline">{tool.method}</Badge>
                          <Badge
                            variant={tool.is_active ? 'default' : 'secondary'}
                          >
                            {tool.is_active
                              ? t('badgeActive')
                              : t('badgeInactive')}
                          </Badge>
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {tool.description}
                        </p>
                        <p className="text-muted-foreground font-mono text-xs break-all">
                          {tool.url}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {tool.has_headers
                            ? t('headersConfigured', {
                                names: tool.header_names.join(', '),
                              })
                            : t('noHeaders')}
                        </p>
                      </div>
                      <Switch
                        checked={tool.is_active}
                        onCheckedChange={(v) => void toggle(tool, v === true)}
                        aria-label={t('toggleLabel', { name: tool.name })}
                        disabled={togglingId === tool.id}
                      />
                    </div>

                    {deleteId === tool.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm">
                          {t('deleteConfirm', { name: tool.name })}
                        </p>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => void remove(tool.id)}
                        >
                          {t('deleteYes')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteId(null)}
                        >
                          {t('cancel')}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openSimulate(tool)}
                        >
                          <FlaskConical className="h-4 w-4" />{' '}
                          {t('test.button')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEdit(tool)}
                        >
                          <Pencil className="h-4 w-4" /> {t('edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteId(tool.id)}
                        >
                          <Trash2 className="h-4 w-4" /> {t('delete')}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* Create / edit */}
      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setForm(null);
        }}
      >
        <DialogContent className="border-border bg-popover max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editingId
                ? t('editTitle', { name: form?.name ?? '' })
                : t('createTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('warnSecret')}
            </DialogDescription>
          </DialogHeader>

          {form && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="http-tool-name">{t('form.name')}</Label>
                <Input
                  id="http-tool-name"
                  value={form.name}
                  onChange={(e) => patchForm({ name: e.target.value })}
                  placeholder="check_stock"
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">
                  {t('form.nameHint')}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="http-tool-desc">{t('form.description')}</Label>
                <Textarea
                  id="http-tool-desc"
                  value={form.description}
                  onChange={(e) => patchForm({ description: e.target.value })}
                  maxLength={500}
                />
                <p className="text-muted-foreground text-xs">
                  {t('form.descriptionHint')}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="http-tool-url">{t('form.url')}</Label>
                <Input
                  id="http-tool-url"
                  value={form.url}
                  onChange={(e) => patchForm({ url: e.target.value })}
                  placeholder="https://api.example.com/v1/stock"
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">
                  {t('form.urlHint')}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="http-tool-method">{t('form.method')}</Label>
                  <select
                    id="http-tool-method"
                    className="border-input bg-background h-8 w-full rounded-lg border px-2 text-sm"
                    value={form.method}
                    onChange={(e) =>
                      patchForm({ method: e.target.value as 'GET' | 'POST' })
                    }
                  >
                    <option value="GET">{t('form.methodGet')}</option>
                    <option value="POST">{t('form.methodPost')}</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="http-tool-risk">{t('form.risk')}</Label>
                  <select
                    id="http-tool-risk"
                    className="border-input bg-background h-8 w-full rounded-lg border px-2 text-sm"
                    value={form.risk}
                    onChange={(e) =>
                      patchForm({ risk: e.target.value as 'read' | 'write' })
                    }
                  >
                    <option value="read">{t('riskReadFull')}</option>
                    <option value="write">{t('riskWriteFull')}</option>
                  </select>
                  <p className="text-muted-foreground text-xs">
                    {form.risk === 'read'
                      ? t('riskReadHint')
                      : t('riskWriteHint')}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="http-tool-timeout">{t('form.timeout')}</Label>
                  <Input
                    id="http-tool-timeout"
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    value={form.timeoutSec}
                    onChange={(e) => patchForm({ timeoutSec: e.target.value })}
                  />
                  <p className="text-muted-foreground text-xs">
                    {t('form.timeoutHint')}
                  </p>
                </div>
              </div>

              {/* Fields the model fills in */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {t('form.fieldsTitle')}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('form.fieldsHint')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={form.fields.length >= MAX_FIELDS}
                    onClick={() =>
                      patchForm({
                        fields: [
                          ...form.fields,
                          {
                            key: nextKey(),
                            name: '',
                            type: 'string',
                            required: false,
                            description: '',
                            extra: {},
                          },
                        ],
                      })
                    }
                  >
                    <Plus className="h-4 w-4" /> {t('form.addField')}
                  </Button>
                </div>
                {form.fields.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    {t('form.noFields')}
                  </p>
                )}
                {form.fields.map((f) => (
                  <div
                    key={f.key}
                    className="border-border grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_9rem_auto]"
                  >
                    <Input
                      aria-label={t('form.fieldName')}
                      placeholder={t('form.fieldName')}
                      value={f.name}
                      onChange={(e) =>
                        patchField(f.key, { name: e.target.value })
                      }
                      autoComplete="off"
                    />
                    <select
                      aria-label={t('form.fieldType')}
                      className="border-input bg-background h-8 rounded-lg border px-2 text-sm"
                      value={f.type}
                      onChange={(e) =>
                        patchField(f.key, { type: e.target.value as FieldType })
                      }
                    >
                      <option value="string">
                        {t('form.fieldTypeString')}
                      </option>
                      <option value="number">
                        {t('form.fieldTypeNumber')}
                      </option>
                      <option value="integer">
                        {t('form.fieldTypeInteger')}
                      </option>
                      <option value="boolean">
                        {t('form.fieldTypeBoolean')}
                      </option>
                    </select>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={f.required}
                          onCheckedChange={(v) =>
                            patchField(f.key, { required: v === true })
                          }
                        />
                        {t('form.fieldRequired')}
                      </label>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('form.removeField')}
                        onClick={() =>
                          patchForm({
                            fields: form.fields.filter((x) => x.key !== f.key),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <Input
                      className="sm:col-span-3"
                      aria-label={t('form.fieldDescription')}
                      placeholder={t('form.fieldDescription')}
                      value={f.description}
                      onChange={(e) =>
                        patchField(f.key, { description: e.target.value })
                      }
                      maxLength={200}
                    />
                  </div>
                ))}
              </div>

              {/* Headers (write-only values) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {t('form.headersTitle')}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('form.headersHint')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={form.headers.length >= MAX_HEADERS}
                    onClick={() =>
                      patchForm({
                        headers: [
                          ...form.headers,
                          { key: nextKey(), name: '', value: '', saved: false },
                        ],
                      })
                    }
                  >
                    <Plus className="h-4 w-4" /> {t('form.addHeader')}
                  </Button>
                </div>
                {form.headers.map((h) => (
                  <div
                    key={h.key}
                    className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                  >
                    <Input
                      aria-label={t('form.headerName')}
                      placeholder="Authorization"
                      value={h.name}
                      onChange={(e) =>
                        patchHeader(h.key, { name: e.target.value })
                      }
                      autoComplete="off"
                    />
                    <Input
                      aria-label={t('form.headerValue')}
                      type="password"
                      placeholder={
                        h.saved ? t('form.headerSaved') : t('form.headerValue')
                      }
                      value={h.value}
                      onChange={(e) =>
                        patchHeader(h.key, { value: e.target.value })
                      }
                      autoComplete="new-password"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('form.removeHeader')}
                      onClick={() =>
                        patchForm({
                          headers: form.headers.filter((x) => x.key !== h.key),
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>

              {formError && (
                <p
                  className="text-destructive flex items-start gap-1.5 text-sm"
                  role="alert"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  {formError}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setForm(null)}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Simulation */}
      <Dialog
        open={simTool !== null}
        onOpenChange={(open) => {
          if (!open) setSimTool(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('test.title', { name: simTool?.name ?? '' })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('test.hint')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="http-tool-sim-args">{t('test.arguments')}</Label>
              <Textarea
                id="http-tool-sim-args"
                className="font-mono text-xs"
                value={simArgs}
                onChange={(e) => setSimArgs(e.target.value)}
              />
            </div>
            {simError && (
              <p className="text-destructive text-sm" role="alert">
                {simError}
              </p>
            )}
            {simResult && (
              <div className="space-y-1 text-sm" role="status">
                <p>{t('test.result')}</p>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  {`${simResult.method} ${simResult.url}\n${JSON.stringify(simResult.arguments, null, 2)}`}
                </pre>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSimTool(null)}>
              {t('test.close')}
            </Button>
            <Button onClick={() => void runSimulation()} disabled={simRunning}>
              {simRunning && <Loader2 className="h-4 w-4 animate-spin" />}
              {simRunning ? t('test.running') : t('test.run')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
