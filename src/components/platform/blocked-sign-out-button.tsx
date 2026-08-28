'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';

/**
 * Sair, da tela de bloqueio (SPEC 062 §4.2).
 *
 * Não usa `useAuth()`: o `AuthProvider` vive dentro de `(dashboard)`,
 * e `/blocked` está fora dele justamente porque aquele layout
 * redireciona para cá. Chama o cliente do navegador direto — a mesma
 * primitiva que `useAuth().signOut` usa por baixo.
 */
export function BlockedSignOutButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <Button variant="outline" onClick={handleSignOut} disabled={pending}>
      {label}
    </Button>
  );
}
