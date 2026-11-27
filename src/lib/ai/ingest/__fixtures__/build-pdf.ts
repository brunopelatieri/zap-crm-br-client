// PDF mínimo e válido com N páginas (sem texto), para o teste do teto de
// páginas. Tabela xref correta: o pdf.js não precisa reconstruí-la.

export function buildBlankPdf(pages: number): Uint8Array {
  const objects: string[] = [];
  // 1 = catálogo, 2 = árvore de páginas, 3.. = páginas.
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(
    ' '
  );
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>');
  }

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
