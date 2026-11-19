'use client';

// ============================================================
// Imagem (upload no bucket privado `form-media`) ou vídeo (só URL de embed)
// de um bloco, da boas-vindas ou do logo (SPEC 085 E-16).
//
// Upload: `POST /api/forms/[id]/media` valida e assina; o navegador sobe
// direto para o Storage com `uploadToSignedUrl` (o arquivo não passa pelo
// Node); `GET …/media?path=` devolve a URL assinada de leitura para a
// miniatura e a prévia.
// ============================================================

import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { normalizeVideoEmbedUrl } from '@/lib/forms/media-url';
import type { FieldMedia } from '@/lib/forms/types';
import { createClient } from '@/lib/supabase/client';
import { FORM_MEDIA_BUCKET } from '@/lib/forms/uploads';

export function MediaField({
  formId,
  value,
  onChange,
  mediaUrls,
  onMediaUrl,
  imageOnly = false,
}: {
  formId: string;
  value: FieldMedia | null;
  onChange: (media: FieldMedia | null) => void;
  /** `path` → URL assinada, para a miniatura. */
  mediaUrls: Record<string, string>;
  onMediaUrl: (path: string, url: string) => void;
  imageOnly?: boolean;
}) {
  const t = useTranslations('Forms.builder.media');
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoError, setVideoError] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    try {
      const res = await fetch(`/api/forms/${formId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          mime: file.type,
          size: file.size,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          reason?: string;
        };
        toast.error(
          body.reason === 'file_too_large'
            ? t('tooLarge')
            : body.reason
              ? t('notAllowed')
              : t('uploadError')
        );
        return;
      }
      const { path, token, mime } = (await res.json()) as {
        path: string;
        token: string;
        mime: string;
      };
      const { error } = await createClient()
        .storage.from(FORM_MEDIA_BUCKET)
        .uploadToSignedUrl(path, token, file, { contentType: mime });
      if (error) {
        toast.error(t('uploadError'));
        return;
      }
      const read = await fetch(
        `/api/forms/${formId}/media?path=${encodeURIComponent(path)}`
      );
      if (read.ok) {
        const { url } = (await read.json()) as { url: string };
        onMediaUrl(path, url);
      }
      onChange({ kind: 'image', path });
    } catch (err) {
      console.error(err);
      toast.error(t('uploadError'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function applyVideo() {
    if (!videoUrl.trim()) return;
    const embed = normalizeVideoEmbedUrl(videoUrl);
    if (!embed) {
      setVideoError(true);
      return;
    }
    setVideoError(false);
    setVideoUrl('');
    onChange({ kind: 'video', url: embed });
  }

  return (
    <div className="grid gap-2">
      {value?.kind === 'image' && (
        <div className="border-border flex items-center gap-3 rounded-lg border p-2">
          {mediaUrls[value.path] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrls[value.path]}
              alt=""
              className="h-12 w-12 rounded object-cover"
            />
          ) : (
            <div className="bg-muted h-12 w-12 rounded" />
          )}
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {t('image')}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onChange(null)}
            aria-label={t('remove')}
          >
            <Trash2 />
          </Button>
        </div>
      )}
      {value?.kind === 'video' && (
        <div className="border-border flex items-center gap-2 rounded-lg border p-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {value.url}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onChange(null)}
            aria-label={t('remove')}
          >
            <Trash2 />
          </Button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        variant="outline"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? (
          <Loader2 className="animate-spin" />
        ) : (
          <ImagePlus className="h-4 w-4" />
        )}
        {value?.kind === 'image' ? t('replace') : t('upload')}
      </Button>

      {!imageOnly && (
        <div className="grid gap-1">
          <div className="flex gap-2">
            <Input
              value={videoUrl}
              onChange={(e) => {
                setVideoUrl(e.target.value);
                setVideoError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyVideo();
                }
              }}
              placeholder={t('videoPlaceholder')}
              aria-invalid={videoError}
            />
            <Button
              variant="outline"
              onClick={applyVideo}
              disabled={!videoUrl.trim()}
            >
              {t('useVideo')}
            </Button>
          </div>
          <p
            className={
              videoError
                ? 'text-destructive text-xs'
                : 'text-muted-foreground text-xs'
            }
          >
            {videoError ? t('videoInvalid') : t('videoHint')}
          </p>
        </div>
      )}
    </div>
  );
}
