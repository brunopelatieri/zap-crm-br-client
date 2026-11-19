import type { Viewport } from 'next';
import type { ReactNode } from 'react';

// Página pública do formulário (SPEC 085 §10): fora do shell da CRM e sem o
// tema do usuário — as cores vêm do formulário, por CSS variables. O
// `<html lang>` do formulário é acertado por `HtmlLang` na página (um layout
// aninhado não troca o elemento raiz).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light',
};

export default function PublicFormLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <div style={{ colorScheme: 'light' }}>{children}</div>;
}
