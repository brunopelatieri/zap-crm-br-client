'use client';

// Liga a sessão do visitante (`form-session.ts`) ao componente de
// preenchimento em modo `live`. Uma sessão por montagem no navegador.

import { useEffect, useState } from 'react';

import { createFormSession } from '@/lib/forms/form-session';
import type { PublicFormPayload } from '@/lib/forms/types';

import { PublicForm } from './public-form';
import type { PublicFormMessages } from './use-public-translator';

export function PublicFormLive({
  payload,
  messages,
}: {
  payload: PublicFormPayload;
  messages: PublicFormMessages;
}) {
  const [session] = useState(() => createFormSession(payload));

  // Voltou a conexão: reenvia o que ficou na fila de autosave.
  useEffect(() => {
    const onOnline = () => session.retryPending();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [session]);

  return (
    <PublicForm
      payload={payload}
      messages={messages}
      mode="live"
      live={session}
      layout="page"
    />
  );
}
