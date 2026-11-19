'use client';

import {
  Archive,
  ArrowLeft,
  ClipboardList,
  Copy,
  EyeOff,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Rocket,
  Save,
  Share2,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { FormIssue } from '@/lib/forms/validate';
import type { FormStatus } from '@/lib/forms/types';
import { cn } from '@/lib/utils';

export const STATUS_STYLES: Record<FormStatus, string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  published: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300',
  archived: 'border-border bg-muted/50 text-muted-foreground',
};

export interface PublishBarProps {
  formId: string;
  name: string;
  status: FormStatus;
  dirty: boolean;
  saving: boolean;
  busy: boolean;
  hasResponses: boolean;
  onName: (name: string) => void;
  onSave: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onShare: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/** Barra superior do construtor (SPEC 085 §4.3). */
export function PublishBar({
  formId,
  name,
  status,
  dirty,
  saving,
  busy,
  hasResponses,
  onName,
  onSave,
  onPublish,
  onUnpublish,
  onShare,
  onArchive,
  onRestore,
  onDuplicate,
  onDelete,
}: PublishBarProps) {
  const t = useTranslations('Forms.builder.bar');
  const ts = useTranslations('Forms.status');
  const archived = status === 'archived';

  return (
    <header className="border-border bg-card flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <Link
        href="/forms"
        aria-label={t('back')}
        className={buttonVariants({ variant: 'ghost', size: 'icon' })}
      >
        <ArrowLeft />
      </Link>

      <Input
        value={name}
        maxLength={120}
        disabled={archived}
        onChange={(e) => onName(e.target.value)}
        aria-label={t('name')}
        className="h-8 w-full max-w-xs min-w-0 flex-1 font-medium sm:flex-none"
      />
      <Badge
        variant="outline"
        className={cn('shrink-0', STATUS_STYLES[status])}
      >
        {ts(status)}
      </Badge>
      <span
        className="text-muted-foreground hidden text-xs sm:inline"
        aria-live="polite"
      >
        {saving ? t('saving') : dirty ? t('unsaved') : t('saved')}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Link
          href={`/forms/${formId}/respostas`}
          className={buttonVariants({ variant: 'outline' })}
        >
          <ClipboardList className="h-4 w-4" />
          {t('responses')}
        </Link>
        {status === 'published' && (
          <Button variant="outline" onClick={onShare}>
            <Share2 className="h-4 w-4" />
            {t('share')}
          </Button>
        )}
        {!archived && (
          <Button
            variant="outline"
            onClick={onSave}
            disabled={saving || busy || !dirty}
          >
            {saving ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('save')}
          </Button>
        )}
        {status === 'draft' && (
          <Button onClick={onPublish} disabled={saving || busy}>
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            {t('publish')}
          </Button>
        )}
        {status === 'published' && (
          <Button
            variant="outline"
            onClick={onUnpublish}
            disabled={saving || busy}
          >
            <EyeOff className="h-4 w-4" />
            {t('unpublish')}
          </Button>
        )}
        {archived && (
          <Button onClick={onRestore} disabled={busy}>
            <RotateCcw className="h-4 w-4" />
            {t('restore')}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-lg focus:outline-none"
            aria-label={t('more')}
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="bg-popover text-popover-foreground ring-border min-w-52"
          >
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy className="h-4 w-4" />
              {t('duplicate')}
            </DropdownMenuItem>
            {!archived && (
              <DropdownMenuItem onClick={onArchive}>
                <Archive className="h-4 w-4" />
                {t('archive')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              disabled={hasResponses || status === 'published'}
              className="text-red-400"
            >
              <Trash2 className="h-4 w-4" />
              {t('delete')}
            </DropdownMenuItem>
            {(hasResponses || status === 'published') && (
              <p className="text-muted-foreground px-2 py-1 text-xs">
                {hasResponses
                  ? t('deleteBlockedResponses')
                  : t('deleteBlockedPublished')}
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/** Lista os problemas que impedem publicar (cliente e servidor devolvem o mesmo formato). */
export function IssuesDialog({
  issues,
  fieldLabel,
  onClose,
}: {
  issues: FormIssue[] | null;
  /** `key` do bloco → rótulo, para o texto citar o bloco pelo nome. */
  fieldLabel: (key: string) => string;
  onClose: () => void;
}) {
  const t = useTranslations('Forms.issues');
  const tb = useTranslations('Forms.builder.bar');
  return (
    <Dialog open={!!issues} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tb('issuesTitle')}</DialogTitle>
          <DialogDescription>{tb('issuesDescription')}</DialogDescription>
        </DialogHeader>
        <ul className="grid max-h-80 gap-2 overflow-y-auto text-sm">
          {(issues ?? []).map((issue, i) => (
            <li
              key={`${issue.code}-${issue.field ?? ''}-${i}`}
              className="border-border rounded-lg border p-2"
            >
              {t(issue.code, {
                field: issue.field ? fieldLabel(issue.field) : '',
                detail: issue.detail ?? '',
              })}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={onClose}>{tb('issuesClose')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
