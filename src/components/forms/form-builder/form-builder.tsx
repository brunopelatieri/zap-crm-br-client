'use client';

// ============================================================
// Construtor `/forms/[id]` (SPEC 085 §4.3).
//
// Três colunas no desktop (blocos · prévia · painel) e três abas no
// celular. O estado (formulário + blocos em edição) vive AQUI; as regras de
// mexer na lista são de `src/lib/forms/builder.ts` (testadas sem navegador).
//
// Salvar = `PUT …/fields` + `PUT …/[id]`. Em formulário PUBLICADO o servidor
// valida cada passo contra o que já está gravado do outro; se uma mudança só
// é válida com a OUTRA gravada antes (ex.: desligar o link genérico e tirar
// o bloco de telefone), a primeira ordem responde 422 e esta tela tenta a
// ordem inversa uma vez.
// ============================================================

import { Loader2, Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { PublicForm } from '@/components/forms/public/public-form';
import type { PublicFormMessages } from '@/components/forms/public/use-public-translator';
import { ShareDialog } from '@/components/forms/share-dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import {
  blockDefaultTexts,
  copyName,
  identityTexts,
} from '@/lib/forms/block-defaults';
import {
  createDraftField,
  ensureIdentity,
  dependentsOf,
  insertDraft,
  isKeyAvailable,
  moveDraft,
  newCid,
  pinIdentity,
  removeDraft,
  renameKey,
  toDraft,
  toPayload,
  uniqueKey,
  type DraftField,
} from '@/lib/forms/builder';
import { isFormsApiErrorCode } from '@/lib/forms/error-codes';
import { buildPreviewPayload } from '@/lib/forms/preview';
import type {
  FieldType,
  Form,
  FormField,
  FormLocale,
  FormSettings,
  FormTheme,
} from '@/lib/forms/types';
import { validateFormForPublish, type FormIssue } from '@/lib/forms/validate';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

import { BlockEditor } from './block-editor';
import { BlockList } from './block-list';
import { BlockPalette } from './block-palette';
import { LogicEditor } from './logic-editor';
import { PhoneFrame } from './phone-frame';
import { IssuesDialog, PublishBar } from './publish-bar';
import { ScoringEditor } from './scoring-editor';
import { SettingsEditor, type BuilderCapabilities } from './settings-editor';
import { ThemeEditor } from './theme-editor';
import { useBuilderRefs } from './use-builder-refs';

type PanelTab = 'block' | 'theme' | 'logic' | 'scoring' | 'settings';
type MobilePane = 'blocks' | 'preview' | 'panel';

/** O que o PUT do formulário leva (e o que conta para "alterado"). */
function editableOf(form: Form) {
  return {
    name: form.name,
    slug: form.slug,
    locale: form.locale,
    description: form.description,
    theme: form.theme,
    settings: form.settings,
    scoring: form.scoring,
    portal_visibility: form.portal_visibility,
    ai_offerable: form.ai_offerable,
    ai_offer_hint: form.ai_offer_hint,
  };
}

interface ApiProblem {
  status: number;
  error: string;
  issues?: FormIssue[];
  body: Record<string, unknown>;
}

async function problemOf(res: Response): Promise<ApiProblem> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: res.status,
    error: typeof body.error === 'string' ? body.error : 'UNKNOWN',
    issues: Array.isArray(body.issues)
      ? (body.issues as FormIssue[])
      : undefined,
    body,
  };
}

export function FormBuilder({
  formId,
  publicMessages,
}: {
  formId: string;
  publicMessages: Record<FormLocale, PublicFormMessages>;
}) {
  const t = useTranslations('Forms.builder');
  const te = useTranslations('Forms.errors');
  const router = useRouter();
  const canEdit = useCan('edit-settings');
  const { profileLoading } = useAuth();
  const refs = useBuilderRefs();

  const [loadState, setLoadState] = useState<
    'loading' | 'ready' | 'notFound' | 'forbidden' | 'error'
  >('loading');
  const [form, setForm] = useState<Form | null>(null);
  const [fields, setFields] = useState<DraftField[]>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [capabilities, setCapabilities] = useState<BuilderCapabilities>({
    link_token: false,
    turnstile: false,
  });
  const [hasResponses, setHasResponses] = useState(false);
  const [snapshot, setSnapshot] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedCid, setSelectedCid] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>('block');
  const [mobilePane, setMobilePane] = useState<MobilePane>('blocks');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [issues, setIssues] = useState<FormIssue[] | null>(null);
  const [previewKey, setPreviewKey] = useState(0);

  // ---------------- carga ----------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/forms/${formId}`);
        if (cancelled) return;
        if (res.status === 404) return setLoadState('notFound');
        if (res.status === 403) return setLoadState('forbidden');
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          form: Form;
          fields: FormField[];
          media_urls: Record<string, string>;
          capabilities: BuilderCapabilities;
        };
        const drafts = data.fields.map(toDraft);
        setForm(data.form);
        setFields(drafts);
        setMediaUrls(data.media_urls ?? {});
        setCapabilities(data.capabilities);
        setSelectedCid(drafts[0]?.cid ?? null);
        setSnapshot(
          JSON.stringify([editableOf(data.form), drafts.map(toPayload)])
        );
        setLoadState('ready');

        // Tem resposta? (apagar fica bloqueado). A RLS escopa pela conta.
        const { count } = await createClient()
          .from('form_responses')
          .select('id', { count: 'exact', head: true })
          .eq('form_id', formId);
        if (!cancelled) setHasResponses((count ?? 0) > 0);
      } catch (err) {
        console.error(err);
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formId]);

  const dirty = useMemo(
    () =>
      form
        ? JSON.stringify([editableOf(form), fields.map(toPayload)]) !== snapshot
        : false,
    [form, fields, snapshot]
  );

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const selected = fields.find((f) => f.cid === selectedCid) ?? null;
  const archived = form?.status === 'archived';

  const patchForm = useCallback(
    (patch: Partial<Form>) =>
      setForm((prev) => (prev ? { ...prev, ...patch } : prev)),
    []
  );
  const patchSettings = useCallback(
    (patch: Partial<FormSettings>) =>
      setForm((prev) =>
        prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev
      ),
    []
  );
  const patchField = useCallback(
    (cid: string, patch: Partial<DraftField>) =>
      setFields((prev) =>
        prev.map((f) => (f.cid === cid ? { ...f, ...patch } : f))
      ),
    []
  );

  // ---------------- erros da API ----------------
  const reportProblem = useCallback(
    (p: ApiProblem) => {
      if (p.error === 'INVALID_FORM' && p.issues?.length) {
        setIssues(p.issues);
        return;
      }

      toast.error(
        isFormsApiErrorCode(p.error)
          ? te(p.error, {
              limit: typeof p.body.limit === 'number' ? p.body.limit : 0,
            })
          : te('generic')
      );
    },
    [te]
  );

  // ---------------- salvar ----------------
  const save = useCallback(async (): Promise<boolean> => {
    if (!form || saving) return false;
    setSaving(true);
    try {
      const putFields = () =>
        fetch(`/api/forms/${formId}/fields`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: fields.map(toPayload) }),
        });
      const putForm = () =>
        fetch(`/api/forms/${formId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editableOf(form)),
        });

      const saved: { fields: FormField[] | null; form: Form | null } = {
        fields: null,
        form: null,
      };
      const runFields = async (): Promise<ApiProblem | null> => {
        const res = await putFields();
        if (!res.ok) return problemOf(res);
        saved.fields = ((await res.json()) as { fields: FormField[] }).fields;
        return null;
      };
      const runForm = async (): Promise<ApiProblem | null> => {
        const res = await putForm();
        if (!res.ok) return problemOf(res);
        saved.form = ((await res.json()) as { form: Form }).form;
        return null;
      };

      let problem = (await runFields()) ?? (await runForm());
      if (problem && problem.status === 422 && form.status === 'published') {
        // Os blocos foram recusados contra o formulário gravado: a mudança
        // pode só ser válida com o formulário gravado ANTES. Ordem inversa,
        // uma vez (ver o cabeçalho do arquivo).
        if (!saved.fields) problem = (await runForm()) ?? (await runFields());
      }
      if (problem) {
        reportProblem(problem);
        return false;
      }

      const nextFields = saved.fields
        ? fields.map((d, i) => ({ ...d, id: saved.fields?.[i]?.id ?? d.id }))
        : fields;
      const nextForm = saved.form ?? form;
      setFields(nextFields);
      setForm(nextForm);
      setSnapshot(
        JSON.stringify([editableOf(nextForm), nextFields.map(toPayload)])
      );
      toast.success(t('bar.savedToast'));
      return true;
    } catch (err) {
      console.error(err);
      toast.error(te('generic'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [form, fields, formId, saving, reportProblem, t, te]);

  // ---------------- ações do ciclo de vida ----------------
  async function post(path: string, body?: unknown) {
    const res = await fetch(`/api/forms/${formId}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      reportProblem(await problemOf(res));
      return null;
    }
    return res.json();
  }

  async function publish() {
    if (!form) return;
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      const found = validateFormForPublish(form, fields.map(toPayload));
      if (found.length > 0) {
        setIssues(found);
        return;
      }
      const data = (await post('publish')) as { form: Form } | null;
      if (!data) return;
      patchForm(data.form);
      toast.success(t('bar.publishedToast'));
      setShareOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function transition(path: 'unpublish' | 'archive' | 'restore') {
    setBusy(true);
    try {
      const data = (await post(path)) as { form: Form } | null;
      if (data) {
        patchForm(data.form);
        toast.success(t(`bar.${path}Toast`));
      }
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!form || !window.confirm(t('bar.archiveConfirm', { name: form.name })))
      return;
    await transition('archive');
  }

  async function duplicate() {
    if (!form) return;
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      const data = (await post('duplicate', {
        name: copyName(form.name, form.locale),
      })) as { form: Form } | null;
      if (data) {
        toast.success(t('bar.duplicatedToast'));
        router.push(`/forms/${data.form.id}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!form || !window.confirm(t('bar.deleteConfirm', { name: form.name })))
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/forms/${formId}`, { method: 'DELETE' });
      if (!res.ok) return reportProblem(await problemOf(res));
      toast.success(t('bar.deletedToast'));
      router.push('/forms');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- edição dos blocos ----------------
  function addBlock(type: FieldType) {
    if (!form) return;
    const texts = blockDefaultTexts(type, form.locale);
    const draft = createDraftField(
      type,
      texts,
      fields.map((f) => f.key)
    );
    const at = selected
      ? fields.findIndex((f) => f.cid === selected.cid) + 1
      : undefined;
    setFields((prev) => insertDraft(prev, draft, at));
    setSelectedCid(draft.cid);
    setTab('block');
    setMobilePane('panel');
  }

  function deleteBlock(cid: string) {
    const target = fields.find((f) => f.cid === cid);
    if (!target || !form) return;
    if (target.is_identity && form.settings.accept_generic_link !== false) {
      toast.error(t('blocks.identityLocked'));
      return;
    }
    const deps = dependentsOf(fields, target.key);
    if (
      deps.length > 0 &&
      !window.confirm(t('blocks.deleteWithLogic', { count: deps.length }))
    ) {
      return;
    }
    const idx = fields.findIndex((f) => f.cid === cid);
    const next = removeDraft(fields, cid);
    setFields(next);
    if (selectedCid === cid) {
      setSelectedCid(next[Math.min(idx, next.length - 1)]?.cid ?? null);
    }
  }

  function duplicateBlock(cid: string) {
    const src = fields.find((f) => f.cid === cid);
    if (!src) return;
    if (src.is_identity) {
      toast.error(t('blocks.identityNoDuplicate'));
      return;
    }
    const { id: savedId, ...rest } = src;
    void savedId;
    const copy: DraftField = {
      ...rest,
      cid: newCid(),
      key: uniqueKey(
        src.key,
        fields.map((f) => f.key)
      ),
      is_identity: false,
    };
    const at = fields.findIndex((f) => f.cid === cid) + 1;
    setFields((prev) => insertDraft(prev, copy, at));
    setSelectedCid(copy.cid);
  }

  function toggleIdentity(cid: string, on: boolean) {
    setFields((prev) =>
      pinIdentity(
        prev.map((f) =>
          f.cid === cid
            ? { ...f, is_identity: on, required: on ? true : f.required }
            : on
              ? { ...f, is_identity: false }
              : f
        )
      )
    );
  }

  function setAcceptGenericLink(on: boolean) {
    if (!form) return;
    patchSettings({ accept_generic_link: on });
    if (on) {
      setFields((prev) => ensureIdentity(prev, identityTexts(form.locale)));
    }
  }

  // ---------------- prévia ----------------
  const payload = useMemo(
    () =>
      form ? buildPreviewPayload(form, fields.map(toPayload), mediaUrls) : null,
    [form, fields, mediaUrls]
  );
  const rememberMediaUrl = useCallback(
    (path: string, url: string) =>
      setMediaUrls((prev) => ({ ...prev, [path]: url })),
    []
  );

  // ---------------- estados de carga ----------------
  if (loadState === 'loading' || profileLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (loadState !== 'ready' || !form || !payload) {
    const key =
      loadState === 'notFound'
        ? 'notFound'
        : loadState === 'forbidden'
          ? 'forbidden'
          : 'loadError';
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground text-sm">{t(`state.${key}`)}</p>
        <Button variant="outline" onClick={() => router.push('/forms')}>
          {t('state.back')}
        </Button>
      </div>
    );
  }
  if (!canEdit) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Lock className="text-muted-foreground h-6 w-6" />
        <p className="text-muted-foreground text-sm">{t('state.forbidden')}</p>
      </div>
    );
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const fieldLabel = (key: string) =>
    fields.find((f) => f.key === key)?.label || key;

  const panelDisabled = archived;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PublishBar
        formId={form.id}
        name={form.name}
        status={form.status}
        dirty={dirty}
        saving={saving}
        busy={busy}
        hasResponses={hasResponses}
        onName={(name) => patchForm({ name })}
        onSave={() => void save()}
        onPublish={() => void publish()}
        onUnpublish={() => void transition('unpublish')}
        onShare={() => setShareOpen(true)}
        onArchive={() => void archive()}
        onRestore={() => void transition('restore')}
        onDuplicate={() => void duplicate()}
        onDelete={() => void remove()}
      />

      {archived && (
        <p className="border-border bg-muted/50 text-muted-foreground border-b px-4 py-2 text-xs">
          {t('bar.archivedNotice')}
        </p>
      )}

      {/* Abas do celular */}
      <div className="border-border flex border-b lg:hidden" role="tablist">
        {(['blocks', 'preview', 'panel'] as const).map((pane) => (
          <button
            key={pane}
            type="button"
            role="tab"
            aria-selected={mobilePane === pane}
            onClick={() => setMobilePane(pane)}
            className={cn(
              'flex-1 py-2 text-sm font-medium',
              mobilePane === pane
                ? 'border-primary text-foreground border-b-2'
                : 'text-muted-foreground'
            )}
          >
            {t(`mobile.${pane}`)}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[300px_minmax(0,1fr)_400px]">
        {/* Blocos */}
        <aside
          className={cn(
            'border-border min-h-0 overflow-y-auto border-r p-3',
            mobilePane === 'blocks' ? 'block' : 'hidden',
            'lg:block'
          )}
        >
          <BlockList
            fields={fields}
            selectedCid={selectedCid}
            onSelect={(cid) => {
              setSelectedCid(cid);
              setTab((prev) =>
                prev === 'theme' || prev === 'settings' ? 'block' : prev
              );
              setMobilePane('panel');
            }}
            onMove={(from, to) =>
              setFields((prev) => moveDraft(prev, from, to))
            }
            onAdd={() => setPaletteOpen(true)}
            onDuplicate={duplicateBlock}
            onDelete={deleteBlock}
          />
        </aside>

        {/* Prévia */}
        <section
          className={cn(
            'bg-muted/30 min-h-0 overflow-hidden p-3',
            mobilePane === 'preview' ? 'block' : 'hidden',
            'lg:block'
          )}
        >
          <PhoneFrame onRestart={() => setPreviewKey((k) => k + 1)}>
            {() => (
              <PublicForm
                key={`${previewKey}-${form.locale}`}
                payload={payload}
                messages={
                  publicMessages[form.locale] ?? publicMessages['pt-BR']
                }
                mode="preview"
                filesDisabledNotice={t('preview.filesDisabled')}
                jumpTo={selected?.key ?? null}
              />
            )}
          </PhoneFrame>
        </section>

        {/* Painel */}
        <aside
          className={cn(
            'border-border min-h-0 overflow-y-auto border-l p-3',
            mobilePane === 'panel' ? 'block' : 'hidden',
            'lg:block'
          )}
        >
          <fieldset disabled={panelDisabled} className="min-w-0">
            <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)}>
              <TabsList className="h-auto w-full flex-wrap justify-start">
                {(
                  ['block', 'theme', 'logic', 'scoring', 'settings'] as const
                ).map((id) => (
                  <TabsTrigger key={id} value={id} className="px-2 text-xs">
                    {t(`tabs.${id}`)}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="block" className="pt-4">
                {selected ? (
                  <BlockEditor
                    field={selected}
                    formId={form.id}
                    onChange={(patch) => patchField(selected.cid, patch)}
                    onRenameKey={(key) =>
                      setFields((prev) => renameKey(prev, selected.cid, key))
                    }
                    isKeyAvailable={(key) =>
                      isKeyAvailable(fields, selected.cid, key)
                    }
                    onToggleIdentity={(on) => toggleIdentity(selected.cid, on)}
                    acceptGenericLink={
                      form.settings.accept_generic_link !== false
                    }
                    refs={refs}
                    mediaUrls={mediaUrls}
                    onMediaUrl={rememberMediaUrl}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm">
                    {t('tabs.noBlock')}
                  </p>
                )}
              </TabsContent>

              <TabsContent value="theme" className="pt-4">
                <ThemeEditor
                  formId={form.id}
                  theme={form.theme as FormTheme}
                  locale={form.locale}
                  onTheme={(theme) => patchForm({ theme })}
                  onLocale={(locale) => patchForm({ locale })}
                  mediaUrls={mediaUrls}
                  onMediaUrl={rememberMediaUrl}
                />
              </TabsContent>

              <TabsContent value="logic" className="pt-4">
                {selected ? (
                  <LogicEditor
                    fields={fields}
                    field={selected}
                    onChange={(patch) => patchField(selected.cid, patch)}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm">
                    {t('tabs.noBlock')}
                  </p>
                )}
              </TabsContent>

              <TabsContent value="scoring" className="pt-4">
                <ScoringEditor
                  fields={fields}
                  bands={form.scoring.bands ?? []}
                  onFields={setFields}
                  onBands={(bands) =>
                    patchForm({ scoring: { ...form.scoring, bands } })
                  }
                  refs={refs}
                />
              </TabsContent>

              <TabsContent value="settings" className="pt-4">
                <SettingsEditor
                  form={form}
                  origin={origin}
                  capabilities={capabilities}
                  onForm={patchForm}
                  onSettings={patchSettings}
                  onAcceptGenericLink={setAcceptGenericLink}
                />
              </TabsContent>
            </Tabs>
          </fieldset>
        </aside>
      </div>

      <BlockPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onPick={addBlock}
      />
      <ShareDialog
        formId={form.id}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <IssuesDialog
        issues={issues}
        fieldLabel={fieldLabel}
        onClose={() => setIssues(null)}
      />
    </div>
  );
}
