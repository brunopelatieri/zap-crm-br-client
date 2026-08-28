'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';

/**
 * Botão de sair do console. Não usa `useAuth()` (o `AuthProvider` de
 * conta só existe dentro de `(dashboard)` — o layout do console é
 * independente de propósito, §7) — chama o cliente Supabase do
 * navegador direto, mesma primitiva que `useAuth().signOut` usa por
 * baixo.
 */
export function PlatformSignOutButton({ label }: { label: string }) {
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
    <Button
      variant="ghost"
      size="sm"
      onClick={handleSignOut}
      disabled={pending}
    >
      {label}
    </Button>
  );
}
