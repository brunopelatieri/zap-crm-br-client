import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Área do contato (SPEC 083): fora do shell do app da conta, e fora de
// busca — as telas só fazem sentido para quem recebeu o endereço.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export default function PortalLayout({ children }: { children: ReactNode }) {
  return children;
}
