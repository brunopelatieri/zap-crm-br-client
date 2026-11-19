'use client';

// ============================================================
// Bloco de arquivo da página pública (SPEC 085 §4.2 item 6, E-6).
//
// O arquivo vai DIRETO ao Storage por URL assinada (a sessão pede a URL à
// rota, que valida tipo, tamanho e quota antes de assinar); aqui só se
// escolhe, mostra o andamento e guarda a referência `{path,name,mime,size}`
// que o envio reconfere no servidor. Remover tira da resposta — o objeto
// órfão é varrido depois (cron `forms`, F4).
// ============================================================

import { Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';

import type { UploadOutcome } from '@/lib/forms/form-session';
import type { PublicFormTranslator } from '@/lib/forms/public-messages';
import type { AnswerValue, FileRef, PublicField } from '@/lib/forms/types';

const MB = 1024 * 1024;

export interface FileUploadControlProps {
  field: PublicField;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue | undefined) => void;
  upload: (file: File) => Promise<UploadOutcome>;
  t: PublicFormTranslator;
  describedBy?: string;
}

function uploadErrorMessage(
  t: PublicFormTranslator,
  code: string,
  maxBytes?: number
): string {
  switch (code) {
    case 'file_too_large':
      return t('fileTooLarge', {
        max: Math.max(1, Math.round((maxBytes ?? 16 * MB) / MB)),
      });
    case 'file_type_not_allowed':
      return t('fileTypeNotAllowed');
    case 'network':
      return t('networkError');
    case 'invalid_file':
    case 'invalid_field':
      return t('invalidFile');
    default:
      return t('uploadFailed');
  }
}

export function FileUploadControl({
  field,
  value,
  onChange,
  upload,
  t,
  describedBy,
}: FileUploadControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const files = Array.isArray(value) ? (value as FileRef[]) : [];
  const maxFiles = field.validation.max_files ?? 1;
  const full = files.length >= maxFiles;

  async function onPick(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError(null);
    setBusy(true);
    const next = [...files];
    try {
      for (const file of Array.from(list)) {
        if (next.length >= maxFiles) {
          setError(t('tooManyFiles', { max: maxFiles }));
          break;
        }
        const r = await upload(file);
        if (!r.ok) {
          setError(uploadErrorMessage(t, r.code, r.maxBytes));
          break;
        }
        next.push(r.ref);
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
      onChange(next.length ? next : undefined);
    }
  }

  return (
    <div className="flex flex-col gap-3" aria-describedby={describedBy}>
      {files.length > 0 && (
        <ul className="flex flex-col gap-2">
          {files.map((f) => (
            <li
              key={f.path}
              className="flex items-center gap-2 border px-3 py-2 text-base"
              style={{
                borderRadius: 'var(--pf-radius)',
                borderColor:
                  'color-mix(in srgb, var(--pf-text) 30%, transparent)',
              }}
            >
              <Paperclip className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1 truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => {
                  const next = files.filter((x) => x.path !== f.path);
                  onChange(next.length ? next : undefined);
                }}
                aria-label={`${t('removeFile')}: ${f.name}`}
                className="rounded p-1 hover:opacity-100 focus-visible:outline-2"
                style={{ outlineColor: 'var(--pf-primary)' }}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {!full && (
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="flex flex-col items-center gap-2 border-2 border-dashed px-4 py-8 text-center transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
          style={{
            borderRadius: 'var(--pf-radius)',
            color: 'var(--pf-text)',
            borderColor: 'color-mix(in srgb, var(--pf-text) 35%, transparent)',
            outlineColor: 'var(--pf-primary)',
          }}
        >
          <Paperclip className="h-6 w-6" aria-hidden="true" />
          <span className="text-base font-medium">
            {busy ? t('uploading') : t('chooseFile')}
          </span>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        multiple={maxFiles > 1}
        accept={field.validation.accept?.join(',') || undefined}
        onChange={(e) => void onPick(e.target.files)}
      />

      <p
        role="alert"
        aria-live="polite"
        className="min-h-5 text-sm font-medium"
        style={{ color: '#dc2626' }}
      >
        {error ?? ''}
      </p>
    </div>
  );
}
