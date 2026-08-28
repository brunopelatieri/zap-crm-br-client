'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ChannelType } from '@/lib/channels/types';
import type { RetentionPurgeResult } from '@/lib/retention/types';

interface RetentionPreviewProps {
  channelType: ChannelType;
  /**
   * Rota de prévia. Passada pelo chamador porque a mesma prévia serve
   * a contas diferentes no console (SPEC 062 §7.5) — o componente não
   * conhece nem escolhe conta, só reporta o que a rota respondeu.
   */
  endpoint: string;
  /** Valores CRUS do formulário — string vazia = herdar, ainda não
   *  validados; a rota de prévia valida e resolve contra o `.env`. */
  maxMessages: string;
  retentionDays: string;
  maxFavorites: string;
}

/**
 * "Ver o que seria removido" (SPEC 060 §8.2 ponto 1) — a prévia roda
 * sobre os limites AINDA NÃO SALVOS que estão nos campos agora, não
 * sobre a política gravada. Salvar sem antes ver o impacto é a forma
 * mais provável de perder histórico nesta SPEC (§8.2), então este
 * botão fica ao lado do "Salvar", não escondido atrás dele.
 */
export function RetentionPreview({
  channelType,
  endpoint,
  maxMessages,
  retentionDays,
  maxFavorites,
}: RetentionPreviewProps) {
  const t = useTranslations('Platform.retention');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RetentionPurgeResult | null>(null);

  async function handlePreview() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelType,
          maxMessages: maxMessages === '' ? null : maxMessages,
          retentionDays: retentionDays === '' ? null : retentionDays,
          maxFavorites: maxFavorites === '' ? null : maxFavorites,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('previewFailed'));
        return;
      }
      setResult(payload.result as RetentionPurgeResult);
    } catch (err) {
      console.error('[RetentionPreview] preview failed:', err);
      toast.error(t('previewFailed'));
    } finally {
      setLoading(false);
    }
  }

  const totalRemoved =
    (result?.by_age ?? 0) +
    (result?.by_count ?? 0) +
    (result?.favorites_demoted ?? 0);

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handlePreview}
        disabled={loading}
        className="self-start"
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Search className="size-3.5" />
        )}
        {t('previewButton')}
      </Button>

      {result && (
        <div className="bg-muted/50 rounded-md p-3 text-xs">
          {totalRemoved === 0 ? (
            <p className="text-muted-foreground">
              {t('previewNothingToRemove')}
            </p>
          ) : (
            <p className="text-foreground">
              {t('previewResult', {
                byAge: result.by_age,
                byCount: result.by_count,
                favoritesDemoted: result.favorites_demoted,
              })}
            </p>
          )}
          {result.truncated && (
            <p className="text-muted-foreground mt-1">
              {t('previewTruncated')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
