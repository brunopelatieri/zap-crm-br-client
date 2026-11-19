// ============================================================
// As jornadas da área do contato do lado do servidor (SPEC 083 §8.2).
//
// Cada rota de `/area/api/**` é uma casca fina: confere `Origin`, lê o
// corpo, chama UMA função daqui e traduz o status em HTTP. Toda regra
// (telefone → candidatos, política de senha, criação de sessão, envio
// do código) mora aqui, testável sem Next.
//
// Anti-enumeração (PRD 082 §6.1, §7): o pedido de código responde
// sempre igual, e o envio acontece DEPOIS da resposta (`deliver`, que a
// rota agenda em `after()`). Sem isso, o tempo do envio pelo WhatsApp
// denunciaria quem é contato.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  evaluatePassword,
  isPasswordValid,
  normalizePassword,
  passwordsMatch,
} from '@/lib/auth/password-policy';
import { formatPhoneForDisplay } from '@/lib/phone/br';
import { maskPhoneForLog } from '@/lib/phone/mask-for-log';

import { createPortalAccountService } from './account';
import { generateCode, normalizeCodeInput } from './code';
import { deliverAccessCode, loadAuthTemplate } from './delivery';
import { phoneCandidates } from './phone';
import { portalDb, portalService, type PortalService } from './service';
import { generateSessionToken, hashSessionToken } from './session';
import type { PortalCodePurpose, PortalSession } from './types';

/**
 * Versão do texto de uso aceito no primeiro acesso (PRD 082 D-9).
 *
 * TODO: trocar pela data do texto aprovado (PRD 082 D-9). Até lá a área só
 * vai a produção desligada em todos os planos (PRD 082 D-1); quando o texto
 * chegar, muda a versão aqui e o aceite novo passa a ser gravado com ela.
 */
export const PORTAL_TERMS_VERSION = '2026-11-05';

export interface JourneyDeps {
  service: PortalService;
  db: () => SupabaseClient;
}

const defaultDeps = (): JourneyDeps => ({
  service: portalService(),
  db: portalDb,
});

/** Bytes que o bcrypt aceita; acima disso nem vale ir ao banco. */
function passwordFits(password: string): boolean {
  const bytes = new TextEncoder().encode(password).length;
  return bytes >= 1 && bytes <= 72;
}

// ------------------------------------------------------------
// J3 / J5 — pedir código pela web
// ------------------------------------------------------------

export async function requestAccessCode(
  input: {
    rawPhone: string;
    publicCode: string | null;
    purpose: PortalCodePurpose;
    ipHash: string;
    siteOrigin: string | null;
  },
  deps: JourneyDeps = defaultDeps()
): Promise<{ deliver: (() => Promise<void>) | null }> {
  const phones = phoneCandidates(input.rawPhone);
  if (!phones) return { deliver: null };

  const code = generateCode();
  const r = await deps.service.requestCode({
    phones,
    publicCode: input.publicCode,
    purpose: input.purpose,
    code,
    ipHash: input.ipHash,
  });
  if (r.status !== 'sent' || !r.contactId || !r.accountId) {
    return { deliver: null };
  }

  const { contactId, accountId } = r;
  return {
    deliver: async () => {
      try {
        const db = deps.db();

        // F5-05: este pedido é ANÔNIMO (qualquer um digita o telefone de
        // outro). Contato que pediu para sair (`opted_out`) não recebe
        // código: a resposta da rota já saiu igual (`{ok:true}`, mesmo piso
        // de tempo), então nada denuncia isso a quem pediu. Ele continua
        // com a J2 (palavra-chave), que é ele quem inicia. Leitura que
        // falha ou contato que sumiu: não envia (falha fechada).
        const [{ data: contact, error: contactError }, settings] =
          await Promise.all([
            db
              .from('contacts')
              .select('opt_in_status')
              .eq('id', contactId)
              .eq('account_id', accountId)
              .maybeSingle(),
            createPortalAccountService(db).getSettings(accountId),
          ]);
        if (!contact || contact.opt_in_status === 'opted_out') {
          // Só o motivo no log: nunca telefone nem código.
          console.warn(
            `[contact-portal] code not delivered (${
              contactError
                ? 'contact_read_failed'
                : contact
                  ? 'opted_out'
                  : 'contact_not_found'
            })`
          );
          return;
        }
        if (!settings) return;
        const [authTemplate, account] = await Promise.all([
          loadAuthTemplate(db, accountId, settings.authTemplateId),
          db.from('accounts').select('name').eq('id', accountId).maybeSingle(),
        ]);
        const outcome = await deliverAccessCode({
          db,
          accountId,
          accountName: (account.data?.name as string | undefined) ?? '',
          contactId,
          code,
          kind: 'code',
          publicCode: settings.publicCode,
          channelId: settings.channelId,
          authTemplate,
          siteOrigin: input.siteOrigin,
        });
        if (!outcome.ok) {
          console.warn(
            `[contact-portal] code not delivered (${outcome.reason})`
          );
        }
      } catch (err) {
        const name = err instanceof Error ? err.name : typeof err;
        console.error(`[contact-portal] code delivery crashed (${name})`);
      }
    },
  };
}

// ------------------------------------------------------------
// Código + nova senha (primeiro acesso e recuperação)
// ------------------------------------------------------------

export type CompleteCodeResult =
  | { status: 'ok'; token: string }
  | {
      status:
        | 'invalid_code'
        | 'weak_password'
        | 'password_mismatch'
        | 'terms_required'
        | 'throttled';
    };

export async function completeAccessCode(
  input: {
    rawPhone: string;
    publicCode: string | null;
    rawCode: string;
    password: string;
    confirmPassword: string;
    termsAccepted: boolean;
    ipHash: string;
  },
  deps: JourneyDeps = defaultDeps()
): Promise<CompleteCodeResult> {
  const password = normalizePassword(input.password);
  if (!isPasswordValid(evaluatePassword(password))) {
    return { status: 'weak_password' };
  }
  if (!passwordsMatch(input.password, input.confirmPassword)) {
    return { status: 'password_mismatch' };
  }
  if (!input.termsAccepted) return { status: 'terms_required' };

  const phones = phoneCandidates(input.rawPhone);
  const code = normalizeCodeInput(input.rawCode);
  if (!phones || !code) return { status: 'invalid_code' };

  const r = await deps.service.completeCode({
    phones,
    publicCode: input.publicCode,
    code,
    password,
    termsVersion: PORTAL_TERMS_VERSION,
    ipHash: input.ipHash,
  });
  if (r.status === 'throttled') return { status: 'throttled' };
  if (r.status !== 'ok' || !r.contactId) return { status: 'invalid_code' };

  // Senha criada → já entra (PRD 082 §6.1: "cria a senha, está dentro").
  const token = generateSessionToken();
  const sessionId = await deps.service.createSession({
    tokenHash: hashSessionToken(token),
    contactIds: [r.contactId],
  });
  if (!sessionId) return { status: 'invalid_code' };
  return { status: 'ok', token };
}

// ------------------------------------------------------------
// J4 — entrar
// ------------------------------------------------------------

export type SignInResult =
  | { status: 'ok'; token: string; accessCount: number }
  | { status: 'invalid' | 'throttled' };

export async function signIn(
  input: { rawPhone: string; password: string; ipHash: string },
  deps: JourneyDeps = defaultDeps()
): Promise<SignInResult> {
  const phones = phoneCandidates(input.rawPhone);
  const password = normalizePassword(input.password);
  if (!phones || !passwordFits(password)) return { status: 'invalid' };

  const r = await deps.service.login({
    phones,
    password,
    ipHash: input.ipHash,
  });
  if (r.status === 'throttled') return { status: 'throttled' };
  if (r.status !== 'ok' || r.contactIds.length === 0) {
    return { status: 'invalid' };
  }

  const token = generateSessionToken();
  const sessionId = await deps.service.createSession({
    tokenHash: hashSessionToken(token),
    contactIds: r.contactIds,
  });
  if (!sessionId) return { status: 'invalid' };
  return { status: 'ok', token, accessCount: r.contactIds.length };
}

// ------------------------------------------------------------
// Sessão aberta
// ------------------------------------------------------------

export async function signOut(
  token: string | null,
  everywhere: boolean,
  deps: JourneyDeps = defaultDeps()
): Promise<void> {
  if (!token) return;
  await deps.service.logout(hashSessionToken(token), everywhere);
}

export type ChangePasswordResult = {
  status:
    | 'ok'
    | 'invalid_current'
    | 'weak_password'
    | 'password_mismatch'
    | 'throttled'
    | 'no_session';
  changed?: number;
};

export async function changePortalPassword(
  session: PortalSession,
  input: {
    current: string;
    next: string;
    confirmNext: string;
    ipHash: string;
  },
  deps: JourneyDeps = defaultDeps()
): Promise<ChangePasswordResult> {
  const next = normalizePassword(input.next);
  if (!isPasswordValid(evaluatePassword(next))) {
    return { status: 'weak_password' };
  }
  if (!passwordsMatch(input.next, input.confirmNext)) {
    return { status: 'password_mismatch' };
  }
  const current = normalizePassword(input.current);
  if (!passwordFits(current)) return { status: 'invalid_current' };

  const r = await deps.service.changePassword(session, {
    current,
    next,
    ipHash: input.ipHash,
  });
  if (r.status === 'invalid') return { status: 'invalid_current' };
  return { status: r.status, changed: r.changed };
}

/**
 * Telefone do acesso atual, mascarado para a tela "Minha conta". Escopo
 * pela sessão: só o contato que ela abriu.
 */
export async function maskedPhoneOf(
  session: PortalSession,
  deps: Pick<JourneyDeps, 'db'> = defaultDeps()
): Promise<string | null> {
  const contactId = session.current?.contactId;
  if (!contactId) return null;
  const { data } = await deps
    .db()
    .from('contacts')
    .select('phone')
    .eq('id', contactId)
    .eq('account_id', session.current!.accountId)
    .maybeSingle();
  const phone = data?.phone as string | undefined;
  const digits = phone?.replace(/\D/g, '');
  return digits ? maskPhoneForLog(formatPhoneForDisplay(digits)) : null;
}
