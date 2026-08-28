/**
 * Canal padrão da conta (SPEC 064 D-11).
 *
 * Mora fora de `send.ts` pelo mesmo motivo de `errors.ts`:
 * `cloud-channels.ts` chama esta função e `send.ts` chama
 * `cloud-channels.ts`. Deixá-la no meio do caminho de envio fecharia o
 * ciclo. `send.ts` reexporta — nenhum importador mudou.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { ChannelNotConfiguredError } from './errors';
import type { ChannelType } from './types';

/**
 * O `channels.id` padrão da conta (migração 059, redefinido pela 072).
 *
 * Usado pelos pontos que abrem conversa fora do `ingest.ts` (API
 * pública, envio do inbox por `contact_id`), onde ninguém escolheu
 * canal.
 *
 * ⚠️ **`is_default` é por (conta, TIPO) desde a migração 072** — o
 * índice único que garantia um só padrão por conta virou
 * `idx_channels_one_default_per_account_type`. Uma conta com um número
 * oficial e uma instância QRCode tem, legitimamente, DOIS canais com
 * `is_default = TRUE`, então o `.maybeSingle()` que esta função usava
 * passou a devolver `PGRST116` — e como o erro era descartado, o
 * resultado não era um 500 e sim um fallback mudo para
 * `whatsapp_config`, que por sua vez quebra assim que a conta tem dois
 * números. Daí a derivação explícita abaixo.
 *
 * Regra do D-11, nesta ordem: **padrão do `whatsapp_cloud` → padrão do
 * `whatsapp_qr` → erro**. O número oficial é o canal de negócio; o
 * QRCode é complemento. Derivar em vez de guardar em
 * `accounts.default_channel_id` evita a segunda fonte de verdade que
 * sempre acaba divergindo.
 *
 * Canais `disabled` nunca são devolvidos: eles não podem enviar, e
 * `set_default_channel` (072 §6.1) recusa promovê-los pelo mesmo motivo.
 *
 * `type` restringe a busca a um tipo — é o que os caminhos específicos
 * usam (o desvio `fallback_channel` das automações pede um canal QR
 * explicitamente, e um Cloud não serviria; `resolveCloudConfig` pede um
 * Cloud pelo mesmo motivo).
 */
export async function resolveDefaultChannelId(
  db: SupabaseClient,
  accountId: string,
  type?: ChannelType
): Promise<string> {
  // Preferência de tipo, do D-11. Com `type`, a lista tem um item só.
  const preference: ChannelType[] = type
    ? [type]
    : ['whatsapp_cloud', 'whatsapp_qr'];

  const { data: channels, error } = await db
    .from('channels')
    .select('id, type, is_default, status, created_at')
    .eq('account_id', accountId)
    .in('type', preference)
    .neq('status', 'disabled');

  // Erro de leitura não pode virar "conta sem canal": isso mandaria o
  // chamador criar/abortar por um motivo que não é o verdadeiro.
  if (error) {
    throw new ChannelNotConfiguredError(
      `failed to read channels for account ${accountId}: ${error.message}`
    );
  }

  for (const wanted of preference) {
    const ofType = (channels ?? []).filter((c) => c.type === wanted);
    if (ofType.length === 0) continue;

    const marked = ofType.find((c) => c.is_default);
    if (marked) return marked.id;

    // Tipo com canal ativo mas sem padrão marcado: a 072 elege um no
    // backfill, então isto só acontece se alguém mexeu em `is_default`
    // fora da RPC. Mais antigo primeiro, o mesmo critério do backfill —
    // determinístico, nunca "o primeiro que aparecer".
    return ofType.sort((a, b) =>
      String(a.created_at).localeCompare(String(b.created_at))
    )[0].id;
  }

  throw new ChannelNotConfiguredError();
}
