// ============================================================
// Palavra-chave de autoatendimento — J2 (SPEC 083 §7, PRD 082 §6.1).
//
// O contato escreve `SENHA` (ou a palavra que a conta configurou) para o
// número da conta e recebe o código na mesma conversa. Como foi ele quem
// escreveu, a janela de 24 h está aberta e a resposta é texto livre —
// sem template, sem custo de conversa iniciada pela empresa.
//
// Roda dentro de `ingestInbound`, DEPOIS do opt-out e ANTES de flows,
// automações e IA. Quando casa, consome a mensagem: nenhum gatilho de
// conteúdo dispara e a IA não responde "SENHA". A mensagem continua no
// inbox como qualquer outra.
//
// Caminho quente de recebimento: nunca lança, e só vai ao banco quando o
// texto tem tamanho de palavra-chave (2–32 caracteres depois de
// normalizado) — "bom dia, tudo bem com vocês?" não custa uma consulta.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createPortalAccountService,
  type PortalAccountSettings,
} from './account';
import { generateCode } from './code';
import { deliverAccessCode, type DeliveryOutcome } from './delivery';
import { phoneCandidates } from './phone';
import { configuredSiteOrigin, hashIp } from './request';
import { createPortalService, type PortalService } from './service';

const MIN_LEN = 2;
const MAX_LEN = 32;

/** Sem acento, sem caixa, espaços das pontas fora e os do meio colapsados. */
export function normalizeKeyword(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function couldBeKeyword(text: string): boolean {
  const n = normalizeKeyword(text);
  return n.length >= MIN_LEN && n.length <= MAX_LEN;
}

export function matchesKeyword(text: string, keyword: string | null): boolean {
  if (!keyword) return false;
  const k = normalizeKeyword(keyword);
  return k.length >= MIN_LEN && normalizeKeyword(text) === k;
}

export interface KeywordDeps {
  getSettings(accountId: string): Promise<PortalAccountSettings | null>;
  requestCode: PortalService['requestCode'];
  accountName(accountId: string): Promise<string>;
  deliver(
    input: Omit<Parameters<typeof deliverAccessCode>[0], 'db'>
  ): Promise<DeliveryOutcome>;
}

function defaultDeps(db: SupabaseClient): KeywordDeps {
  const account = createPortalAccountService(db);
  const portal = createPortalService(db);
  return {
    getSettings: (id) => account.getSettings(id),
    requestCode: (i) => portal.requestCode(i),
    async accountName(id) {
      const { data } = await db
        .from('accounts')
        .select('name')
        .eq('id', id)
        .maybeSingle();
      return (data?.name as string | undefined) ?? '';
    },
    deliver: (i) => deliverAccessCode({ ...i, db }),
  };
}

/**
 * `true` = a mensagem era a palavra-chave de uma conta com a área
 * elegível e foi consumida (mesmo que o código não tenha saído, por
 * limite ou bloqueio). `false` = siga o caminho normal.
 */
export async function handlePortalKeyword(
  input: {
    db: SupabaseClient;
    accountId: string;
    contactId: string;
    contactPhone: string | null | undefined;
    conversationId: string;
    text: string;
  },
  deps: KeywordDeps = defaultDeps(input.db)
): Promise<boolean> {
  if (!couldBeKeyword(input.text)) return false;

  let settings: PortalAccountSettings | null;
  try {
    settings = await deps.getSettings(input.accountId);
  } catch (err) {
    logFailure('settings', err);
    return false;
  }
  if (!settings?.eligible || !matchesKeyword(input.text, settings.keyword)) {
    return false;
  }

  try {
    const phones = input.contactPhone
      ? phoneCandidates(input.contactPhone)
      : null;
    if (!phones) return true;

    const code = generateCode();
    const r = await deps.requestCode({
      phones,
      // Escopo na conta cujo número recebeu a palavra-chave (PRD 082 D-7).
      publicCode: settings.publicCode,
      purpose: 'reset',
      code,
      // Não há IP no WhatsApp; uma chave por contato mantém o limite
      // "por IP" sem que o número inteiro da conta vire um IP só.
      ipHash: hashIp(`whatsapp:${input.contactId}`),
    });
    if (r.status !== 'sent') return true;

    await deps.deliver({
      accountId: input.accountId,
      accountName: await deps.accountName(input.accountId),
      // Quem pediu: responde na conversa dele.
      contactId: input.contactId,
      conversationId: input.conversationId,
      code,
      kind: 'code',
      publicCode: settings.publicCode,
      channelId: null,
      // Janela aberta (ele acabou de escrever): texto livre.
      authTemplate: null,
      siteOrigin: configuredSiteOrigin(),
    });
  } catch (err) {
    logFailure('request', err);
  }
  return true;
}

function logFailure(stage: 'settings' | 'request', err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  console.error(
    `[contact-portal] keyword handling failed at ${stage} (${name})`
  );
}
