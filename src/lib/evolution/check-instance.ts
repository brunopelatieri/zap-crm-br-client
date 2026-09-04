/**
 * Qual instância desta conta valida números agora (SPEC 069 D-10).
 *
 * Hoje resolve para a ÚNICA instância `check_enabled` e conectada da
 * conta — não há ainda tela (F9) para o cliente escolher entre várias.
 * Com mais de uma instância habilitada, a ordem é `created_at` (a mais
 * antiga primeiro): um critério estável e testável, não uma política
 * de produto — quando a F9 chegar, o passo de audiência pergunta e
 * este critério deixa de importar.
 *
 * `channels.status = 'connected'` é lido do BANCO, não de uma chamada
 * ao vivo em `/instance/status`: essa coluna já é mantida por quem
 * monitora a conexão (`getInstanceLiveStatus`), e reconsultar a
 * Evolution aqui gastaria uma chamada de rede por item enfileirado.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';

export interface CheckInstance {
  instanceId: string;
  channelId: string;
  token: string;
}

interface CheckInstanceRow {
  id: string;
  channel_id: string;
  channels: { status: string } | { status: string }[] | null;
}

export async function resolveCheckInstance(
  db: SupabaseClient,
  accountId: string
): Promise<CheckInstance | null> {
  const { data, error } = await db
    .from('evolution_instances')
    .select('id, channel_id, channels!inner(status)')
    .eq('account_id', accountId)
    .eq('check_enabled', true)
    .eq('channels.status', 'connected')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as unknown as CheckInstanceRow;

  const { data: secret, error: secretError } = await db
    .from('evolution_instance_secrets')
    .select('instance_token_encrypted')
    .eq('instance_id', row.id)
    .maybeSingle();

  if (secretError || !secret) return null;

  return {
    instanceId: row.id,
    channelId: row.channel_id,
    token: decrypt(secret.instance_token_encrypted),
  };
}
