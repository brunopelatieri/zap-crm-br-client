'use client';

/**
 * Editor toolbar — flow name / description, status chip, dirty
 * indicator, and the action buttons (Save, Activate/Pause, Delete,
 * View runs, Back).
 *
 * Restyled to the Flow Builder design handoff: a single compact
 * toolbar row (back · icon · inline-editable name · status chip ·
 * edited dot on the left; Runs · Delete · Activate · Save on the
 * right) followed by a subtle, full-width description "note" line.
 * Replaces the old three-row stack so the editor reads as one app
 * chrome bar above the canvas/list stage.
 *
 * Lifted out of flow-builder.tsx so the same toolbar renders above
 * both views in FlowEditorShell. Without this, canvas users had no
 * way to save without toggling to list view.
 *
 * Reads everything from the editor context (`useFlowEditor`) so it
 * stays in sync with whichever view is mutating state, and routes
 * router navigation locally (back to /flows, View runs to
 * /flows/[id]/runs) — those don't belong in the hook.
 */

import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  CircleDot,
  History,
  Loader2,
  PauseCircle,
  PlayCircle,
  Save,
  Trash2,
  Workflow,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { selectableChannels } from '@/lib/channels/selectable';
import { useFlowEditor, type BuilderState } from './flow-editor-state';

export function EditorHeader() {
  const router = useRouter();
  const {
    flow,
    state,
    setState,
    dirty,
    saving,
    activating,
    canActivate,
    save,
    setStatus,
    deleteFlow,
  } = useFlowEditor();

  return (
    <div className="flex flex-col gap-1.5 px-6 pt-5">
      <div className="flex flex-wrap items-center gap-3">
        {/* ---- left: back · icon · name · status · edited ---- */}
        <button
          type="button"
          onClick={() => router.push('/flows')}
          title="Back to Flows"
          aria-label="Back to Flows"
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="bg-primary-soft text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <Workflow className="h-[18px] w-[18px]" />
        </span>
        <input
          value={state.name}
          onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          placeholder="Flow name"
          spellCheck={false}
          aria-label="Flow name"
          className="text-foreground hover:bg-muted focus:border-primary max-w-[340px] min-w-[120px] rounded-lg border border-transparent bg-transparent px-2 py-1 text-lg leading-tight font-bold tracking-tight transition-colors outline-none focus:bg-transparent focus:shadow-[0_0_0_3px_var(--primary-soft)]"
        />
        <StatusChip status={state.status} />
        {dirty && (
          <span
            className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-medium tracking-wide text-amber-300 uppercase"
            title="Unsaved changes — hit Save to persist"
            aria-live="polite"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            Edited
          </span>
        )}

        {/* ---- right: runs · delete · activate · save ---- */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/flows/${flow.id}/runs`)}
          >
            <History className="h-3.5 w-3.5" />
            Runs
            <span className="bg-muted text-muted-foreground ml-0.5 rounded px-1.5 py-0.5 font-mono text-[11px]">
              {flow.execution_count}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void deleteFlow()}
            className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
          {state.status === 'active' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void setStatus('draft')}
              disabled={activating}
            >
              {activating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PauseCircle className="h-3.5 w-3.5" />
              )}
              Pause
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void setStatus('active')}
              disabled={activating || !canActivate}
              title={
                !canActivate
                  ? 'Fix the issues below before activating'
                  : undefined
              }
            >
              {activating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlayCircle className="h-3.5 w-3.5" />
              )}
              Activate
            </Button>
          )}
          <Button onClick={() => void save()} disabled={saving} size="sm">
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>

      {/* ---- description note (subtle, inline-editable) ---- */}
      <input
        value={state.description}
        onChange={(e) =>
          setState((s) => ({ ...s, description: e.target.value }))
        }
        placeholder="Add a short description (internal — customers don't see this)"
        aria-label="Flow description"
        className="text-muted-foreground placeholder:text-muted-foreground/60 hover:bg-muted/50 focus:border-primary focus:text-foreground w-full max-w-[78ch] rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] transition-colors outline-none focus:bg-transparent"
      />

      {/* ---- channel scope: "Vale para o número" (SPEC 065 D-6/D-10) ---- */}
      <ChannelScopeSelect
        channelId={state.channel_id}
        onChange={(v) => setState((s) => ({ ...s, channel_id: v }))}
      />
    </div>
  );
}

/**
 * NULL = "Todos os números" (padrão, e o comportamento de todo fluxo
 * anterior a esta coluna). Escopo do GATILHO apenas — o fluxo sempre
 * responde pelo canal da conversa (SPEC 065 D-6); esta escolha só decide
 * a QUAIS conversas ele reage.
 *
 * Mesmo vocabulário do construtor de automações (D-10), mesma fonte de
 * elegibilidade (`selectableChannels(..., 'scope')`) — aceita qualquer
 * tipo de canal, inclusive QRCode.
 */
function ChannelScopeSelect({
  channelId,
  onChange,
}: {
  channelId: string | null;
  onChange: (v: string | null) => void;
}) {
  const t = useTranslations('Flows.editorState');
  const accountChannels = useAccountChannels();
  const channels = useMemo(
    () =>
      selectableChannels(Array.from(accountChannels.byId.values()), 'scope'),
    [accountChannels.byId]
  );

  if (channels.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <label className="text-muted-foreground shrink-0 text-[13px]">
        {t('channelScope.label')}
      </label>
      <select
        value={channelId ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="border-border bg-muted text-foreground focus:border-primary max-w-xs rounded-md border px-2 py-1 text-[13px] outline-none"
      >
        <option value="">{t('channelScope.allChannels')}</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.identifier ? ` — ${c.identifier}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatusChip({ status }: { status: BuilderState['status'] }) {
  const cfg = {
    draft: {
      // Neutral, not amber — amber is reserved for the adjacent
      // "Edited" dirty signal, so the two don't read as the same alert.
      cls: 'border-border bg-muted text-muted-foreground',
      label: 'Draft',
    },
    active: {
      cls: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300',
      label: 'Active',
    },
    archived: {
      cls: 'border-border bg-muted/50 text-muted-foreground',
      label: 'Archived',
    },
  }[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium',
        cfg.cls
      )}
    >
      <CircleDot className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}
