import type { ReactNode } from 'react';
import { KeyRound } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * Moldura das telas da área do contato: visual próprio, sem o shell do
 * app da conta (PRD 082 §6.2). `brand` é "Área do contato" ou "Área de
 * <conta>", acima do título.
 */
export function PortalCard({
  brand,
  title,
  description,
  children,
}: {
  brand: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4 py-8">
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            <KeyRound className="text-primary h-6 w-6" />
          </div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {brand}
          </p>
          <CardTitle className="text-foreground text-xl">{title}</CardTitle>
          {description && (
            <CardDescription className="text-muted-foreground">
              {description}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

export function PortalAlert({
  tone,
  children,
}: {
  tone: 'error' | 'info';
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={
        tone === 'error'
          ? 'rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400'
          : 'border-primary/20 bg-primary/10 text-foreground rounded-lg border px-4 py-3 text-sm'
      }
    >
      {children}
    </div>
  );
}
