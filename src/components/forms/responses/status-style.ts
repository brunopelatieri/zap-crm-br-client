import type { ResponseStatus } from '@/lib/forms/types';

/** Cor do selo de status da resposta (mesma família de `STATUS_STYLES` do formulário). */
export const STATUS_BADGE: Record<ResponseStatus, string> = {
  completed: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300',
  partial: 'border-amber-600/40 bg-amber-500/10 text-amber-300',
  abandoned: 'border-border bg-muted/50 text-muted-foreground',
};
