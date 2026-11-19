'use client';

// Peças pequenas do construtor: select nativo (muitas listas curtas, sem o
// custo do Base UI), rótulo com dica e seção.

import type { ComponentProps, ReactNode } from 'react';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export const nativeSelectClass =
  'border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full min-w-0 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50';

export function NativeSelect({
  className,
  ...props
}: ComponentProps<'select'>) {
  return <select className={cn(nativeSelectClass, className)} {...props} />;
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? (
        <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>
      ) : null}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h3 className="text-foreground text-sm font-semibold">{title}</h3>
        {description ? (
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function ToggleRow({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">{label}</p>
        {hint ? (
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {hint}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}
