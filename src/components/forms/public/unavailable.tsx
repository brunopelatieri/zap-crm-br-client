// ============================================================
// Página neutra de "formulário indisponível" (PRD 084 D-11, L5; SPEC 085
// §4.2 item 1).
//
// O MESMO HTML para qualquer motivo (inexistente, rascunho, arquivado,
// plano, quota, conta bloqueada, token obrigatório): quem tenta adivinhar
// slug não aprende nada. Por isso não usa o idioma nem o tema do
// formulário — ele pode nem existir; usa o idioma do DEPLOY e cores fixas.
// ============================================================

import { AlertCircle } from 'lucide-react';

export function Unavailable({
  title,
  body,
  lang,
}: {
  title: string;
  body: string;
  lang: string;
}) {
  return (
    <main
      lang={lang}
      className="flex min-h-dvh items-center justify-center px-6 py-10"
      style={{ background: '#ffffff', color: '#111827' }}
    >
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <AlertCircle
          className="h-10 w-10"
          aria-hidden="true"
          style={{ color: '#6b7280' }}
        />
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-base" style={{ color: '#4b5563' }}>
          {body}
        </p>
      </div>
    </main>
  );
}
