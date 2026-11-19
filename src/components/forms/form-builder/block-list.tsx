'use client';

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Copy,
  GitBranch,
  GripVertical,
  Lock,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DraftField } from '@/lib/forms/builder';
import { cn } from '@/lib/utils';

import { FIELD_TYPE_ICONS } from './block-palette';

/** Lista ordenável de blocos (arrastar com mouse, toque ou teclado). */
export function BlockList({
  fields,
  selectedCid,
  onSelect,
  onMove,
  onAdd,
  onDuplicate,
  onDelete,
}: {
  fields: DraftField[];
  selectedCid: string | null;
  onSelect: (cid: string) => void;
  onMove: (from: number, to: number) => void;
  onAdd: () => void;
  onDuplicate: (cid: string) => void;
  onDelete: (cid: string) => void;
}) {
  const t = useTranslations('Forms.builder');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = fields.findIndex((f) => f.cid === active.id);
    const to = fields.findIndex((f) => f.cid === over.id);
    if (from === -1 || to === -1) return;
    // A lista (e a fixação do bloco de identidade) é do `moveDraft`, no
    // estado do construtor.
    onMove(from, to);
  }

  return (
    <div className="flex flex-col gap-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={fields.map((f) => f.cid)}
          strategy={verticalListSortingStrategy}
        >
          <ol className="flex flex-col gap-1.5">
            {fields.map((field, index) => (
              <BlockRow
                key={field.cid}
                field={field}
                index={index}
                selected={field.cid === selectedCid}
                onSelect={() => onSelect(field.cid)}
                onDuplicate={() => onDuplicate(field.cid)}
                onDelete={() => onDelete(field.cid)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      <Button variant="outline" onClick={onAdd} className="mt-1">
        <Plus className="h-4 w-4" />
        {t('blocks.add')}
      </Button>
    </div>
  );
}

function BlockRow({
  field,
  index,
  selected,
  onSelect,
  onDuplicate,
  onDelete,
}: {
  field: DraftField;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('Forms.builder');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.cid });
  const Icon = FIELD_TYPE_ICONS[field.type];
  const hasLogic =
    !!field.show_if || (field.options ?? []).some((o) => !!o.jump_to);

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={cn(
        'group flex items-center gap-1.5 rounded-lg border p-1.5',
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card hover:border-primary/40'
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('blocks.drag')}
        className="text-muted-foreground hover:text-foreground cursor-grab touch-none p-1 active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="bg-muted text-muted-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold">
          {index + 1}
        </span>
        <Icon className="text-primary h-4 w-4 shrink-0" />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm">
          {field.label || t('blocks.untitled')}
        </span>
        {field.is_identity && (
          <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
            <Lock className="h-3 w-3" />
            {t('blocks.identity')}
          </Badge>
        )}
        {field.required && !field.is_identity && (
          <span
            className="text-destructive shrink-0 text-sm"
            title={t('blocks.required')}
          >
            *
          </span>
        )}
        {hasLogic && (
          <GitBranch
            className="text-muted-foreground h-3.5 w-3.5 shrink-0"
            aria-label={t('blocks.hasLogic')}
          />
        )}
      </button>

      <div className="flex shrink-0 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDuplicate}
          aria-label={t('blocks.duplicate')}
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDelete}
          aria-label={t('blocks.delete')}
          className="text-muted-foreground hover:text-red-400"
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}
