'use client';

// ============================================================
// Compartilhar: link genérico, QR code e snippet de embed (SPEC 085 §4.3).
//
// O QR é gerado AQUI, no navegador, com `qrcode` (E-15): nenhum serviço
// externo recebe a URL do formulário. O link com token por contato não
// mora aqui (inbox, disparo e automação — SPEC 086); este diálogo é o
// link que vai na bio, no anúncio e no site.
// ============================================================

import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

interface LinkInfo {
  url: string;
  slug: string;
  status: string;
  tokenAvailable: boolean;
  embed: { iframe: string; script: string; html: string };
  embedOrigins: string[];
}

export function ShareDialog({
  formId,
  open,
  onOpenChange,
}: {
  formId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('Forms.share');
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState<'link' | 'embed' | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(false);
    (async () => {
      try {
        const res = await fetch(`/api/forms/${formId}/link`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as LinkInfo;
        if (cancelled) return;
        setInfo(data);
        const dataUrl = await QRCode.toDataURL(data.url, {
          width: 320,
          margin: 2,
          errorCorrectionLevel: 'M',
        });
        if (!cancelled) setQr(dataUrl);
      } catch (err) {
        console.error(err);
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, formId]);

  async function copy(kind: 'link' | 'embed', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error(t('copyError'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {!info && !error && (
          <div className="flex justify-center py-8">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        )}
        {error && <p className="text-destructive text-sm">{t('loadError')}</p>}

        {info && (
          <div className="grid gap-5">
            {info.status !== 'published' && (
              <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">
                {t('notPublished')}
              </p>
            )}

            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t('link')}</p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={info.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="border-input bg-background h-8 min-w-0 flex-1 rounded-lg border px-2 font-mono text-xs"
                  aria-label={t('link')}
                />
                <Button
                  variant="outline"
                  onClick={() => copy('link', info.url)}
                >
                  {copied === 'link' ? <Check /> : <Copy />}
                  {copied === 'link' ? t('copied') : t('copy')}
                </Button>
              </div>
              {!info.tokenAvailable && (
                <p className="text-muted-foreground text-xs">
                  {t('tokenMissing')}
                </p>
              )}
            </div>

            {qr && (
              <div className="flex items-center gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qr}
                  alt={t('qrAlt')}
                  width={160}
                  height={160}
                  className="rounded-lg border bg-white p-1"
                />
                <div className="grid gap-2">
                  <p className="text-muted-foreground text-xs">{t('qrHint')}</p>
                  <a
                    href={qr}
                    download={`${info.slug}-qr.png`}
                    className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t('qrDownload')}
                  </a>
                </div>
              </div>
            )}

            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t('embed')}</p>
              <p className="text-muted-foreground text-xs">
                {info.embedOrigins.length > 0
                  ? t('embedOrigins', { origins: info.embedOrigins.join(', ') })
                  : t('embedNoOrigins')}
              </p>
              <Textarea
                readOnly
                rows={5}
                value={info.embed.html}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
                aria-label={t('embed')}
              />
              <Button
                variant="outline"
                className="w-fit"
                onClick={() => copy('embed', info.embed.html)}
              >
                {copied === 'embed' ? <Check /> : <Copy />}
                {copied === 'embed' ? t('copied') : t('copyEmbed')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
