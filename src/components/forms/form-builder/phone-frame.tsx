'use client';

import { Monitor, RotateCcw, Smartphone } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const PHONE_WIDTH = 375;
export const PHONE_HEIGHT = 812;

/**
 * Moldura da prévia (SPEC 085 §4.3): celular 375×812 ou cartão de desktop.
 * Quem desenha o conteúdo é o `PublicForm` (o MESMO da página pública); a
 * moldura só dá o tamanho. A coluna rola quando é mais baixa que 812 px, e
 * a página dentro continua a ver 375 px de largura.
 */
export function PhoneFrame({
  children,
  onRestart,
}: {
  /** Recebe o modo da moldura; quem pede o reinício troca a `key` do conteúdo. */
  children: (viewport: 'phone' | 'desktop') => ReactNode;
  onRestart: () => void;
}) {
  const t = useTranslations('Forms.builder.preview');
  const [viewport, setViewport] = useState<'phone' | 'desktop'>('phone');

  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-3">
      <div className="flex items-center gap-1">
        <Button
          variant={viewport === 'phone' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setViewport('phone')}
          aria-pressed={viewport === 'phone'}
        >
          <Smartphone className="h-3.5 w-3.5" />
          {t('phone')}
        </Button>
        <Button
          variant={viewport === 'desktop' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setViewport('desktop')}
          aria-pressed={viewport === 'desktop'}
        >
          <Monitor className="h-3.5 w-3.5" />
          {t('desktop')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onRestart}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t('restart')}
        </Button>
      </div>

      <div className="flex min-h-0 w-full flex-1 items-start justify-center overflow-auto pb-2">
        {viewport === 'phone' ? (
          <div
            className={cn(
              'border-foreground/80 bg-background relative shrink-0 overflow-hidden rounded-[2.5rem] border-[10px] shadow-xl'
            )}
            style={{ width: PHONE_WIDTH + 20, height: PHONE_HEIGHT + 20 }}
            aria-label={t('phoneLabel')}
          >
            <div
              className="bg-foreground/80 absolute top-0 left-1/2 z-10 h-5 w-28 -translate-x-1/2 rounded-b-2xl"
              aria-hidden="true"
            />
            <div className="h-full w-full">{children('phone')}</div>
          </div>
        ) : (
          <div
            className="border-border bg-background h-[640px] w-full max-w-3xl overflow-hidden rounded-lg border shadow-lg"
            aria-label={t('desktopLabel')}
          >
            {children('desktop')}
          </div>
        )}
      </div>
    </div>
  );
}
