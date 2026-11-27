'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock,
  FileText,
  Globe,
  HelpCircle,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

type SourceType = 'text' | 'file' | 'url' | 'faq';
type Status = 'pending' | 'indexing' | 'ready' | 'error';

interface DocSummary {
  id: string;
  title: string;
  source_type: SourceType;
  source_name: string | null;
  source_url: string | null;
  status: Status;
  index_error: string | null;
  chunk_count: number;
  char_count: number;
  is_enabled: boolean;
  tags: string[];
}

interface FaqPair {
  question: string;
  answer: string;
}

/** Editor target: a source type when creating, a doc id when editing, null when closed. */
type EditTarget =
  { mode: 'new'; source: SourceType } | { mode: 'edit'; id: string } | null;

const SOURCES: { key: SourceType; icon: typeof Type }[] = [
  { key: 'text', icon: Type },
  { key: 'file', icon: FileText },
  { key: 'url', icon: Globe },
  { key: 'faq', icon: HelpCircle },
];

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['pdf', 'docx', 'txt', 'md', 'csv'];
const POLL_MS = 3000;

const emptyPair = (): FaqPair => ({ question: '', answer: '' });

export function AiKnowledgeCard({
  accountId,
  canEdit,
  hasEmbeddingsKey,
}: {
  accountId: string | null;
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [pairs, setPairs] = useState<FaqPair[]>([emptyPair()]);
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState<string | 'all' | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations('Agents.knowledge');

  /** Mensagem traduzida de um erro da API (`code` estável, texto em inglês). */
  const apiError = useCallback(
    (data: {
      code?: string;
      error?: string;
      existing?: { title?: string };
      quota?: { limit?: number };
    }): string => {
      const code = data?.code;
      if (code === 'duplicate_content') {
        return t('errors.duplicate_content', {
          title: data.existing?.title ?? '',
        });
      }
      if (code === 'quota_exceeded') {
        return t('errors.quota_exceeded', { limit: data.quota?.limit ?? 0 });
      }
      if (code && t.has(`errors.${code}`)) return t(`errors.${code}`);
      return t('errors.generic');
    },
    [t]
  );

  const fetchDocs = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch('/api/ai/knowledge');
        const data = await res.json();
        if (res.ok) setDocs(data.documents ?? []);
        else if (!silent) toast.error(t('loadFailed'));
      } catch {
        if (!silent) toast.error(t('loadFailed'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchDocs();
  }, [accountId, fetchDocs]);

  // Enquanto houver documento na fila ou indexando (D-9), atualiza a lista:
  // a indexação roda fora da requisição e o estado muda sozinho.
  const hasInFlight = docs.some(
    (d) => d.status === 'pending' || d.status === 'indexing'
  );
  useEffect(() => {
    if (!hasInFlight) return;
    const timer = setInterval(() => void fetchDocs(true), POLL_MS);
    return () => clearInterval(timer);
  }, [hasInFlight, fetchDocs]);

  const resetForm = () => {
    setTitle('');
    setContent('');
    setUrl('');
    setFile(null);
    setPairs([emptyPair()]);
    setTags('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const openNew = (source: SourceType) => {
    resetForm();
    setEditing({ mode: 'new', source });
  };

  const openEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(t('openFailed'));
        return;
      }
      resetForm();
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
      setTags(Array.isArray(data.tags) ? data.tags.join(', ') : '');
      if (data.source_type === 'faq') {
        setPairs(data.pairs?.length ? data.pairs : [emptyPair()]);
      }
      setEditing({ mode: 'edit', id });
    } catch {
      toast.error(t('openFailed'));
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    resetForm();
  };

  const editedDoc =
    editing?.mode === 'edit' ? docs.find((d) => d.id === editing.id) : null;
  const formSource: SourceType | null = editing
    ? editing.mode === 'new'
      ? editing.source
      : (editedDoc?.source_type ?? 'text')
    : null;

  const pickFile = (picked: File | null) => {
    if (!picked) {
      setFile(null);
      return;
    }
    const ext = picked.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ACCEPTED.includes(ext)) {
      toast.error(t('toast.fileType'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (picked.size > MAX_FILE_BYTES) {
      toast.error(t('toast.fileTooLarge'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setFile(picked);
  };

  const canSave = (() => {
    if (!editing || !formSource) return false;
    if (editing.mode === 'new') {
      if (formSource === 'text') return !!title.trim() && !!content.trim();
      if (formSource === 'file') return !!file;
      if (formSource === 'url') return !!url.trim();
      return (
        !!title.trim() &&
        pairs.length > 0 &&
        pairs.every((p) => p.question.trim() && p.answer.trim())
      );
    }
    if (!title.trim()) return false;
    if (formSource === 'faq') {
      return pairs.every((p) => p.question.trim() && p.answer.trim());
    }
    return !!content.trim();
  })();

  const save = async () => {
    if (!editing || !formSource) return;
    setSaving(true);
    try {
      let res: Response;
      if (editing.mode === 'new') {
        if (formSource === 'file' && file) {
          const form = new FormData();
          form.set('file', file);
          if (title.trim()) form.set('title', title.trim());
          if (tags.trim()) form.set('tags', tags);
          res = await fetch('/api/ai/knowledge/upload', {
            method: 'POST',
            body: form,
          });
        } else {
          const base = { title: title.trim(), tags };
          const [endpoint, body] =
            formSource === 'url'
              ? ['/api/ai/knowledge/import-url', { url: url.trim(), ...base }]
              : formSource === 'faq'
                ? ['/api/ai/knowledge', { source: 'faq', pairs, ...base }]
                : ['/api/ai/knowledge', { content: content.trim(), ...base }];
          res = await fetch(endpoint as string, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        }
      } else {
        res = await fetch(`/api/ai/knowledge/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            tags,
            ...(formSource === 'faq' ? { pairs } : { content: content.trim() }),
          }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(
          editing.mode === 'new'
            ? t('toast.added')
            : data.reindexed
              ? t('toast.updatedReindex')
              : t('toast.updated')
        );
        cancelEdit();
        await fetchDocs(true);
      } else {
        toast.error(apiError(data));
      }
    } catch {
      toast.error(t('toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('toast.removed'));
        setDocs((d) => d.filter((x) => x.id !== id));
      } else {
        toast.error(t('toast.removeFailed'));
      }
    } catch {
      toast.error(t('toast.removeFailed'));
    }
  };

  const toggleEnabled = async (doc: DocSummary, next: boolean) => {
    // Otimista: o interruptor vale na hora (sem reindexar) e volta se falhar.
    setDocs((all) =>
      all.map((d) => (d.id === doc.id ? { ...d, is_enabled: next } : d))
    );
    try {
      const res = await fetch(`/api/ai/knowledge/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: next }),
      });
      if (!res.ok) throw new Error('toggle failed');
    } catch {
      setDocs((all) =>
        all.map((d) =>
          d.id === doc.id ? { ...d, is_enabled: doc.is_enabled } : d
        )
      );
      toast.error(t('toast.updateFailed'));
    }
  };

  const reindex = async (ids?: string[]) => {
    setReindexing(ids?.[0] ?? 'all');
    try {
      const res = await fetch('/api/ai/knowledge/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids ? { ids } : {}),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(t('toast.reindexQueued', { count: data.queued }));
        await fetchDocs(true);
      } else {
        toast.error(t('toast.reindexFailed'));
      }
    } catch {
      toast.error(t('toast.reindexFailed'));
    } finally {
      setReindexing(null);
    }
  };

  const statusBadge = (doc: DocSummary) => {
    switch (doc.status) {
      case 'ready':
        return (
          <Badge variant="secondary" className="gap-1">
            <CheckCircle2 className="h-3 w-3" /> {t('status.ready')}
          </Badge>
        );
      case 'indexing':
        return (
          <Badge variant="outline" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> {t('status.indexing')}
          </Badge>
        );
      case 'error':
        return (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="h-3 w-3" /> {t('status.error')}
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="gap-1">
            <Clock className="h-3 w-3" /> {t('status.pending')}
          </Badge>
        );
    }
  };

  /** `código` ou `código:detalhe` gravado em `index_error` pelo indexador. */
  const indexErrorText = (raw: string): string => {
    const [base, detail] = raw.split(':');
    const text = t.has(`indexError.${base}`)
      ? t(`indexError.${base}`)
      : t('indexError.unknown');
    return detail
      ? `${text} ${t('indexError.detail', { code: detail })}`
      : text;
  };

  const sourceLine = (doc: DocSummary): string | null => {
    if (doc.source_type === 'file' && doc.source_name) {
      return t('sourceLine.file', { name: doc.source_name });
    }
    if (doc.source_type === 'url') return doc.source_url;
    if (doc.source_type === 'faq') return t('sourceLine.faq');
    return null;
  };

  const sourceIcon = (type: SourceType) => {
    const Icon = SOURCES.find((s) => s.key === type)?.icon ?? Type;
    return <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>
          {t('description', {
            searchType: hasEmbeddingsKey
              ? t('semanticSearchOn')
              : t('keywordSearchOn'),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="text-muted-foreground flex items-center py-4 text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {docs.length === 0 && editing === null && (
              <p className="text-muted-foreground text-sm">{t('noDocs')}</p>
            )}

            {docs.length > 0 && (
              <ul className="divide-border border-border divide-y rounded-md border">
                {docs.map((doc) => {
                  const line = sourceLine(doc);
                  return (
                    <li
                      key={doc.id}
                      className="flex items-start justify-between gap-3 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        {sourceIcon(doc.source_type)}
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`min-w-0 truncate text-sm ${doc.is_enabled ? 'text-foreground' : 'text-muted-foreground'}`}
                            >
                              {doc.title}
                            </span>
                            {statusBadge(doc)}
                            {!doc.is_enabled && (
                              <Badge variant="outline">
                                {t('enabled.off')}
                              </Badge>
                            )}
                          </div>
                          {line && (
                            <p className="text-muted-foreground truncate text-xs">
                              {line}
                            </p>
                          )}
                          {doc.status === 'ready' && doc.chunk_count > 0 && (
                            <p className="text-muted-foreground text-xs">
                              {t('readyDetail', {
                                count: doc.chunk_count,
                                chars: doc.char_count,
                              })}
                            </p>
                          )}
                          {doc.index_error && (
                            <p
                              className={`text-xs ${doc.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                            >
                              {indexErrorText(doc.index_error)}
                              {doc.status === 'error' &&
                                ` ${t('indexError.retryHint')}`}
                            </p>
                          )}
                          {doc.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {doc.tags.map((tag) => (
                                <Badge key={tag} variant="secondary">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      {canEdit && (
                        <span className="flex shrink-0 items-center gap-1">
                          <Switch
                            checked={doc.is_enabled}
                            onCheckedChange={(v) => void toggleEnabled(doc, v)}
                            aria-label={t('enabled.label')}
                            title={t('enabled.label')}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => void reindex([doc.id])}
                            disabled={
                              reindexing !== null || doc.status === 'indexing'
                            }
                            title={t('actions.reindex')}
                            aria-label={t('actions.reindex')}
                          >
                            {reindexing === doc.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => void openEdit(doc.id)}
                            title={t('actions.edit')}
                            aria-label={t('actions.edit')}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive h-8 w-8 p-0"
                            onClick={() => void remove(doc.id)}
                            title={t('actions.delete')}
                            aria-label={t('actions.delete')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {editing !== null && formSource ? (
              <div className="border-border space-y-3 rounded-md border p-3">
                {formSource === 'file' && editing.mode === 'new' && (
                  <div className="space-y-2">
                    <Label htmlFor="kb-file">{t('form.file')}</Label>
                    <Input
                      id="kb-file"
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.txt,.md,.csv"
                      onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                      disabled={saving}
                    />
                    <p className="text-muted-foreground text-xs">
                      {t('form.fileHint')}
                    </p>
                  </div>
                )}

                {formSource === 'url' && editing.mode === 'new' && (
                  <div className="space-y-2">
                    <Label htmlFor="kb-url">{t('form.url')}</Label>
                    <Input
                      id="kb-url"
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder={t('form.urlPlaceholder')}
                      disabled={saving}
                    />
                    <p className="text-muted-foreground text-xs">
                      {t('form.urlHint')}
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="kb-title">
                    {editing.mode === 'new' &&
                    (formSource === 'file' || formSource === 'url')
                      ? t('form.titleOptional')
                      : t('form.title')}
                  </Label>
                  <Input
                    id="kb-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('form.titlePlaceholder')}
                    disabled={saving}
                  />
                  {editing.mode === 'new' &&
                    (formSource === 'file' || formSource === 'url') && (
                      <p className="text-muted-foreground text-xs">
                        {t('form.titleOptionalHint')}
                      </p>
                    )}
                </div>

                {formSource !== 'faq' &&
                  (formSource === 'text' || editing.mode === 'edit') && (
                    <div className="space-y-2">
                      <Label htmlFor="kb-content">{t('form.content')}</Label>
                      <Textarea
                        id="kb-content"
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={t('form.contentPlaceholder')}
                        rows={8}
                        disabled={saving}
                      />
                    </div>
                  )}

                {formSource === 'faq' && (
                  <div className="space-y-3">
                    {pairs.map((pair, i) => (
                      <div
                        key={i}
                        className="border-border space-y-2 rounded-md border p-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor={`kb-q-${i}`}>
                            {t('form.question')}
                          </Label>
                          {pairs.length > 1 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() =>
                                setPairs((all) =>
                                  all.filter((_, idx) => idx !== i)
                                )
                              }
                              title={t('form.removePair')}
                              aria-label={t('form.removePair')}
                              disabled={saving}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                        <Input
                          id={`kb-q-${i}`}
                          value={pair.question}
                          onChange={(e) =>
                            setPairs((all) =>
                              all.map((p, idx) =>
                                idx === i
                                  ? { ...p, question: e.target.value }
                                  : p
                              )
                            )
                          }
                          disabled={saving}
                        />
                        <Label htmlFor={`kb-a-${i}`}>{t('form.answer')}</Label>
                        <Textarea
                          id={`kb-a-${i}`}
                          value={pair.answer}
                          onChange={(e) =>
                            setPairs((all) =>
                              all.map((p, idx) =>
                                idx === i ? { ...p, answer: e.target.value } : p
                              )
                            )
                          }
                          rows={3}
                          disabled={saving}
                        />
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPairs((all) => [...all, emptyPair()])}
                      disabled={saving}
                    >
                      <Plus className="mr-2 h-4 w-4" /> {t('form.addPair')}
                    </Button>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="kb-tags">{t('form.tags')}</Label>
                  <Input
                    id="kb-tags"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder={t('form.tagsPlaceholder')}
                    disabled={saving}
                  />
                  <p className="text-muted-foreground text-xs">
                    {t('form.tagsHint')}
                  </p>
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={cancelEdit}
                    disabled={saving}
                  >
                    {t('actions.cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving || !canSave}>
                    {saving && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {editing.mode === 'new' && formSource === 'file'
                      ? t('actions.upload')
                      : editing.mode === 'new' && formSource === 'url'
                        ? t('actions.import')
                        : t('actions.save')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs font-medium">
                    {t('addSource')}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {SOURCES.map(({ key, icon: Icon }) => (
                      <Button
                        key={key}
                        variant="outline"
                        size="sm"
                        onClick={() => openNew(key)}
                      >
                        <Icon className="mr-2 h-4 w-4" /> {t(`sources.${key}`)}
                      </Button>
                    ))}
                    {docs.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => void reindex()}
                        disabled={reindexing !== null}
                        title={t('actions.reindexAllTooltip')}
                      >
                        {reindexing === 'all' ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-2 h-4 w-4" />
                        )}
                        {t('actions.reindexAll')}
                      </Button>
                    )}
                  </div>
                </div>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
