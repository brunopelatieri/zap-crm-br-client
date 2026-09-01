'use client';

/**
 * Passo "Enviar por" do assistente de disparo — SPEC 065 D-1/§7.1.
 *
 * É o PRIMEIRO passo, antes do template: trocar de canal aqui é o que
 * faz o passo seguinte já nascer filtrado pelo WABA certo (D-2). Só é
 * montado quando `channels.length > 1` — com um canal só, `new/page.tsx`
 * nem monta este passo, e o assistente segue com quatro etapas, igual a
 * antes desta SPEC.
 *
 * `channels` chega já filtrada e ordenada por `selectableChannels(...,
 * 'broadcast')` — este componente não decide elegibilidade, só lista.
 */

import { ArrowRight, Check, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import type { Channel } from '@/lib/channels/types';

interface Step0Props {
  channels: Channel[];
  selectedChannelId: string | null;
  onSelect: (channelId: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step0ChooseChannel({
  channels,
  selectedChannelId,
  onSelect,
  onNext,
  onBack,
}: Step0Props) {
  const t = useTranslations('Broadcasts.wizard');
  const tSend = useTranslations('Broadcasts.wizard.scheduleSend');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('chooseChannel.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('chooseChannel.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {channels.map((channel) => {
          const isSelected = selectedChannelId === channel.id;
          return (
            <button
              key={channel.id}
              type="button"
              onClick={() => onSelect(channel.id)}
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                  : 'border-border bg-card/50 hover:border-border hover:bg-card'
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Smartphone className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-foreground truncate text-sm font-medium">
                    {channel.name}
                  </p>
                  {isSelected && (
                    <Check className="text-primary h-3.5 w-3.5 shrink-0" />
                  )}
                </div>
                {channel.identifier && (
                  <p className="text-muted-foreground truncate text-xs">
                    {channel.identifier}
                  </p>
                )}
                {(channel.is_default || channel.status !== 'connected') && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {channel.is_default && (
                      <span className="bg-muted text-muted-foreground inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium">
                        {tSend('sendFromDefault')}
                      </span>
                    )}
                    {/* `error`/`disconnected` aparecem de propósito — ver
                        `lib/channels/selectable.ts`: esconder o padrão
                        quebrado atrás de "só uma opção" foi o bug que
                        este seletor existe para corrigir. */}
                    {channel.status !== 'connected' && (
                      <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                        {tSend('sendFromUnhealthy')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedChannelId}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
