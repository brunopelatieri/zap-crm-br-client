'use client';

// O `<html lang>` vem do layout raiz (idioma do cookie do visitante) e um
// layout aninhado não pode trocá-lo. A página pública usa o idioma do
// FORMULÁRIO (PRD D-8): o contêiner já leva `lang`, e isto acerta também o
// elemento raiz depois da hidratação, para leitores de tela e tradutores.

import { useEffect } from 'react';

export function HtmlLang({ locale }: { locale: string }) {
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = locale;
    return () => {
      document.documentElement.lang = previous;
    };
  }, [locale]);
  return null;
}
