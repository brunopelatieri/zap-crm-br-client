'use client';

import { isTrustedEmbedUrl } from '@/lib/forms/media-url';
import type { PublicFieldMedia } from '@/lib/forms/types';

/**
 * Imagem (URL assinada gerada no servidor) ou vídeo (só embed de host
 * conhecido — `normalizeVideoEmbedUrl` já filtrou ao salvar; aqui é a
 * segunda trava, porque iframe é superfície de ataque).
 */
export function FormMedia({
  media,
  radius,
  title,
}: {
  media: PublicFieldMedia | null | undefined;
  radius: string;
  /** Texto do bloco: nome acessível do vídeo (já está no idioma do formulário). */
  title: string;
}) {
  if (!media) return null;
  if (media.kind === 'image') {
    return (
      // URL assinada de curta duração: next/image não otimiza o que expira.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={media.url}
        alt=""
        className="mb-6 max-h-64 w-full object-cover"
        style={{ borderRadius: radius }}
      />
    );
  }
  if (!isTrustedEmbedUrl(media.url)) return null;
  return (
    <div
      className="mb-6 aspect-video w-full overflow-hidden"
      style={{ borderRadius: radius }}
    >
      <iframe
        src={media.url}
        title={title}
        className="h-full w-full border-0"
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="fullscreen; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
