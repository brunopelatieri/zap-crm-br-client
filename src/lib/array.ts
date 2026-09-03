// ============================================================
// `chunkArray` — fatia um array em blocos de tamanho fixo.
//
// Existe para paginar `.in('coluna', ids)`/lotes de download sem
// estourar o teto de ~1000 linhas do PostgREST ou o limite de itens em
// voo de um pool de concorrência.
//
// A mesma função existia, idêntica, em `src/lib/contacts/export-fetch.ts`
// e foi duplicada de novo em `src/lib/inbox/export/fetch-thread.ts` e
// `src/lib/inbox/export/fetch-media.ts` (achado de code review — a SPEC
// 067 até comenta "mesmo motivo do CONTACT_ID_CHUNK da 051" num desses
// dois, evidência de que a duplicata era evitável). Este módulo é a
// versão compartilhada; os três call sites foram atualizados para
// importar daqui em vez de manter cópias privadas.
// ============================================================

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
