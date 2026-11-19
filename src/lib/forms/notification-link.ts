// Destino do clique num aviso `form_response_received` (SPEC 085 F4).
// Fora de `page.tsx` de propósito: um arquivo de página do Next não pode
// exportar nada além do componente e das configurações de rota.

export function notificationHref(n: {
  form_id?: string | null;
  form_response_id?: string | null;
}): string {
  if (!n.form_id) return '/forms';
  return n.form_response_id
    ? `/forms/${n.form_id}/respostas?r=${n.form_response_id}`
    : `/forms/${n.form_id}/respostas`;
}
