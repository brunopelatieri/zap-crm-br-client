/**
 * Vínculo telefone → LID do canal WhatsApp QRCode (SPEC 048 §6.4).
 *
 * `POST /user/info` NÃO traduz LID em telefone (medido — devolve
 * `LID: null`). O vínculo só nasce no sentido telefone → LID, via
 * `POST /user/check`, e é gravado em `contact_identities` — é por essa
 * tabela que um inbound que chegue SÓ com LID casa com o contato certo.
 *
 * Por que isto existe como módulo à parte (e não só dentro do webhook)
 *
 *   O único gatilho original era reativo: um inbound chegar identificado
 *   por TELEFONE (não por LID) disparava o backfill. Isso pressupõe que,
 *   cedo ou tarde, uma mensagem inbound phone-identified vai aparecer —
 *   mas o rollout de privacidade do WhatsApp faz muitos contatos
 *   chegarem SEMPRE por LID em mensagens recebidas, nunca por telefone.
 *   Pra esses contatos o gatilho reativo nunca dispara, e toda mensagem
 *   futura deles é descartada silenciosamente pra sempre (visto em
 *   produção: "remetente só identificável por LID sem vínculo
 *   conhecido" repetido pro mesmo contato, mesmo com conversa já aberta
 *   e funcionando no sentido CRM → contato).
 *
 *   `ensureContactIdentity` fecha essa lacuna sendo chamada nos DOIS
 *   sentidos — pelo webhook (inbound phone-identified, sobra do
 *   comportamento original) e pelo adaptador de envio (outbound,
 *   sempre que sabemos o telefone). No sentido outbound o vínculo nasce
 *   ANTES de o contato precisar responder, então o gatilho reativo nunca
 *   chega a fazer falta.
 *
 * Idempotente: se `contact_identities` já tem uma linha pra este
 * contato neste canal, não bate `/user/check` de novo.
 *
 * 🔴 **Achado da SPEC 069 F3 (2026-09-03): este módulo nunca extraiu o
 * LID de verdade em produção.** O parser original cobria dois formatos
 * hipotéticos para `/user/check` (array cru de objetos planos, ou um
 * objeto único) — nenhum dos dois é o que o servidor realmente devolve.
 * Medido contra `go.local.ia.br`: `{"data":{"Users":[{Query,
 * IsInWhatsapp,JID,RemoteJID,LID,VerifiedName}]},"message":"success"}`.
 * Com o parser antigo, `Object.values({Users:[...]})` produzia UM valor
 * — o próprio array `Users` — e `asRecord()` o rejeitava por ser array,
 * então a função sempre devolvia `null`. Ou seja: toda vez que o
 * gatilho deste módulo disparou desde a SPEC 048, o LID nunca foi
 * gravado, e o backfill que o cabeçalho acima descreve nunca aconteceu
 * de verdade — o problema de produção que ele existe para fechar
 * ("remetente só identificável por LID sem vínculo conhecido") pode
 * muito bem ainda estar ocorrendo. Corrigido reaproveitando o parser
 * compartilhado de `user.ts` (`checkWhatsappUsers`/`matchCheckResult`),
 * que já cobre a forma real medida — ver o cabeçalho daquele módulo
 * para os cinco achados completos.
 *
 * ⚠️ Isso pressupõe que o LID de um contato, uma vez aprendido, nunca
 * muda — o SPEC 048 §6.4 não afirma isso explicitamente, e o schema
 * (PK em `account_id, channel_type, external_id`, migração 056) não
 * impede múltiplas linhas por `contact_id`. Se o WhatsApp algum dia
 * reatribuir o LID de um contato (troca de aparelho, reinstalação), a
 * linha antiga não é substituída — este `if` continua pulando pra
 * sempre, e o inbound com o LID novo volta a ser descartado como "sem
 * vínculo conhecido". Não há evidência de que isso aconteça na prática
 * (por isso o trade-off: bater `/user/check` a cada envio custaria uma
 * chamada de rede à Evolution por mensagem), mas se voltar a acontecer
 * em produção, a correção é trocar este `if` por uma reverificação
 * periódica (ex.: um `verified_at` com TTL), não removê-lo.
 *
 * Best-effort e fora do caminho crítico em ambos os chamadores: uma
 * falha aqui custa a resolução de uma futura mensagem só-LID, nunca a
 * mensagem/envio atual.
 */

import { supabaseAdmin } from '@/lib/supabase/admin';
import { readEvolutionConfig } from './config';
import { checkWhatsappUsers, matchCheckResult } from './user';

export async function ensureContactIdentity(params: {
  accountId: string;
  instanceToken: string;
  phone: string;
}): Promise<void> {
  const { accountId, instanceToken, phone } = params;
  try {
    // Antes de qualquer round-trip ao banco: sem Evolution configurada,
    // não há o que fazer — checagem síncrona e de graça.
    const config = readEvolutionConfig();
    if (!config) return;

    const db = supabaseAdmin();

    // `phone_normalized` (migração 022), não a coluna `phone` crua: nem
    // todo caminho de criação de contato sanitiza dígitos antes de
    // gravar (a importação por CSV, por exemplo, grava a célula da
    // planilha como veio — "+55 (19) 99249-6598"). `phone` já chega
    // aqui só-dígitos (o chamador sanitiza), então casar pela coluna
    // gerada é o que funciona independente de como o contato nasceu.
    const { data: contact } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('phone_normalized', phone)
      .maybeSingle();
    if (!contact) return;

    const { data: existing } = await db
      .from('contact_identities')
      .select('id')
      .eq('account_id', accountId)
      .eq('channel_type', 'whatsapp_qr')
      .eq('contact_id', contact.id)
      .maybeSingle();
    if (existing) return;

    const results = await checkWhatsappUsers(config, instanceToken, [phone]);
    const matched = matchCheckResult(results, phone);
    const lid = matched?.lid ?? null;
    if (!lid) return;

    const { error } = await db.from('contact_identities').upsert(
      {
        account_id: accountId,
        contact_id: contact.id,
        channel_type: 'whatsapp_qr',
        external_id: lid,
      },
      { onConflict: 'account_id,channel_type,external_id' }
    );
    if (error) {
      console.error(
        '[evolution] contact_identities upsert failed:',
        error.message
      );
    }
  } catch (err) {
    console.error('[evolution] LID backfill failed:', err);
  }
}
