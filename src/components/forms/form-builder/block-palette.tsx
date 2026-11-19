'use client';

import {
  AlignLeft,
  Calendar,
  CheckSquare,
  ChevronDownSquare,
  CircleDot,
  Hash,
  Mail,
  MessageSquareText,
  Paperclip,
  Phone,
  ShieldCheck,
  Star,
  ThumbsUp,
  Type,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FIELD_TYPES, type FieldType } from '@/lib/forms/types';

export const FIELD_TYPE_ICONS: Record<FieldType, typeof Type> = {
  short_text: Type,
  long_text: AlignLeft,
  email: Mail,
  phone: Phone,
  number: Hash,
  date: Calendar,
  single_select: CircleDot,
  multi_select: CheckSquare,
  dropdown: ChevronDownSquare,
  yes_no: ThumbsUp,
  rating: Star,
  file_upload: Paperclip,
  statement: MessageSquareText,
  consent: ShieldCheck,
};

/** Galeria dos 14 tipos de bloco (SPEC 085 §4.1, §4.3). */
export function BlockPalette({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (type: FieldType) => void;
}) {
  const t = useTranslations('Forms.builder');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('palette.title')}</DialogTitle>
          <DialogDescription>{t('palette.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FIELD_TYPES.map((type) => {
            const Icon = FIELD_TYPE_ICONS[type];
            return (
              <button
                key={type}
                type="button"
                onClick={() => {
                  onPick(type);
                  onOpenChange(false);
                }}
                className="border-border bg-background hover:border-primary/40 hover:bg-muted flex items-start gap-3 rounded-lg border p-3 text-left transition-colors"
              >
                <Icon className="text-primary mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="text-foreground block text-sm font-medium">
                    {t(`types.${type}.name`)}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {t(`types.${type}.hint`)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
