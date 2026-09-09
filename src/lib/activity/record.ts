// ============================================================
// `recordActivity()` — o escritor central de `account_activity_log`
// (SPEC 075 §5). Molde de postura em `writePlatformAudit`
// (`src/lib/platform/audit.ts`): união de literais para `action`,
// "nunca lança" — mas NÃO o molde de implementação, por uma razão de
// produção que a SPEC não previu.
//
// DESVIO DA ASSINATURA DA SPEC, e por quê
// ----------------------------------------
// A SPEC mostra `recordActivity(db: SupabaseClient, entry)` como se
// `db` fosse usado para o INSERT. A migração 084 revogou INSERT/UPDATE/
// DELETE em `account_activity_log` de `anon` e `authenticated` — é
// append-only por RLS E por grant (§3.3 da migração). Um `ctx.supabase`
// de rota (sessão do usuário) NUNCA teria permissão de gravar aqui; se
// esta função usasse `db` para o INSERT, TODO chamador do caminho
// quente (F3) gravaria silenciosamente nada, e "nunca lança" (regra 5)
// esconderia o buraco por completo.
//
// Por isso o INSERT sempre passa por `supabaseAdmin()`, internamente —
// igual à gravação de `message_deletion_log` na rota de apagar mensagem
// (SPEC 074) e de `platform_audit_log` em metade dos chamadores de
// `writePlatformAudit`. `db` continua no parâmetro e é usado só para o
// enriquecimento OPCIONAL de nome/papel do ator (leitura da própria
// linha em `profiles`, que a RLS de sessão já permite) — quando o
// chamador não informa `actor.name`/`actor.role` de antemão. A maioria
// dos chamadores de F3/F4 já tem `ctx.role` de `requireRole()`; passar
// isso evita a consulta extra.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AccountRole } from '@/lib/auth/roles';
import type { ChannelType } from '@/lib/channels/types';
import {
  isValidActivityAction,
  type ActivityAction,
  type ActivityResourceType,
} from './types';

export type ActivityActor =
  | {
      kind: 'user';
      userId: string;
      name?: string | null;
      role?: AccountRole | null;
    }
  | { kind: 'system'; name?: string | null }
  | { kind: 'api'; keyId: string }
  | { kind: 'contact'; contactId: string };

export interface ActivityEntry {
  accountId: string;
  action: ActivityAction;
  resourceType: ActivityResourceType;
  resourceId?: string | null;
  /** Truncado em 160 caracteres por esta função (regra 1, §5). Se o
   *  rótulo puder conter um telefone, o CHAMADOR deve passá-lo já
   *  mascarado por `maskPhoneForLog` — esta função não sabe distinguir
   *  um telefone de qualquer outra string. */
  resourceLabel?: string | null;
  actor: ActivityActor;
  channelId?: string | null;
  channelType?: ChannelType | null;
  conversationId?: string | null;
  contactId?: string | null;
  source?: { table: string; id: string } | null;
  /** Truncado em 4 KB e higienizado (regras 2-3, §5) antes de gravar. */
  metadata?: Record<string, unknown>;
}

const RESOURCE_LABEL_MAX = 160;
const METADATA_MAX_BYTES = 4096;

// Regra 2: nenhum segredo em `metadata`, checado em runtime — não só
// por convenção. Casa qualquer chave que contenha um destes radicais,
// em qualquer profundidade do objeto (case-insensitive). Deliberadamente
// amplo: é preferível derrubar um campo legítimo por engano (e ver isso
// no console) do que deixar passar um token por descuido de nomeação.
const FORBIDDEN_KEY_PATTERN =
  /token|secret|password|passwd|authoriza|credential|api[_-]?key|content_text|message_content/i;

/**
 * Remove (recursivamente) qualquer chave de `metadata` cujo nome bata
 * com {@link FORBIDDEN_KEY_PATTERN}. Retorna um objeto novo — nunca
 * muta a entrada do chamador — e loga cada remoção, porque uma chave
 * proibida chegando aqui é sinal de um call site que precisa de
 * correção, não um evento silencioso.
 */
function stripForbiddenKeys(
  value: unknown,
  path: string,
  removed: string[]
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      stripForbiddenKeys(item, `${path}[${i}]`, removed)
    );
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        removed.push(fullPath);
        continue;
      }
      out[key] = stripForbiddenKeys(val, fullPath, removed);
    }
    return out;
  }
  return value;
}

/**
 * Higieniza e limita `metadata` (regras 2-3, §5). Nunca lança: um
 * `JSON.stringify` que falhar (referência circular, `BigInt`) vira
 * `{}` com o erro no console, em vez de derrubar o registro inteiro.
 */
function sanitizeMetadata(
  raw: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!raw || Object.keys(raw).length === 0) return {};

  const removed: string[] = [];
  let clean: unknown;
  try {
    clean = stripForbiddenKeys(raw, '', removed);
  } catch (err) {
    console.error('[activity/record] falha ao higienizar metadata:', err);
    return {};
  }

  if (removed.length > 0) {
    console.error(
      `[activity/record] chave(s) proibida(s) removida(s) de metadata: ${removed.join(', ')}`
    );
  }

  try {
    const json = JSON.stringify(clean);
    if (Buffer.byteLength(json, 'utf8') > METADATA_MAX_BYTES) {
      console.error(
        `[activity/record] metadata excedeu ${METADATA_MAX_BYTES} bytes — truncado.`
      );
      return {
        truncated: true,
        original_keys: Object.keys(clean as Record<string, unknown>),
      };
    }
    return clean as Record<string, unknown>;
  } catch (err) {
    console.error('[activity/record] metadata não serializável:', err);
    return {};
  }
}

/**
 * Grava uma linha em `account_activity_log`. Nunca lança (regra 5): uma
 * ação sem rastro é ruim, uma ação que falha por causa do rastro é
 * pior — mesma postura de `writePlatformAudit`. O preço é que o log
 * pode ter buracos, e a tela precisa dizer isso (D-12).
 */
export async function recordActivity(
  db: SupabaseClient,
  entry: ActivityEntry
): Promise<void> {
  try {
    if (!entry.accountId) {
      console.error('[activity/record] accountId ausente — evento descartado.');
      return;
    }

    // Catálogo fechado: uma action fora do §4 é sinal de bug no
    // chamador, não um evento novo silenciosamente aceito.
    if (!isValidActivityAction(entry.resourceType, entry.action)) {
      console.error(
        `[activity/record] ação "${entry.action}" não pertence ao catálogo de "${entry.resourceType}" — evento descartado.`
      );
      return;
    }

    // Regra 4: ator 'user' sem userId não filtra nada — descartar em
    // vez de gravar um evento que a página não consegue atribuir.
    if (entry.actor.kind === 'user' && !entry.actor.userId) {
      console.error(
        '[activity/record] actor.kind === "user" sem userId — evento descartado.'
      );
      return;
    }

    let actorUserId: string | null = null;
    let actorName: string | null = null;
    let actorRole: AccountRole | null = null;

    if (entry.actor.kind === 'user') {
      actorUserId = entry.actor.userId;
      actorName = entry.actor.name ?? null;
      actorRole = entry.actor.role ?? null;

      // Enriquecimento best-effort: só consulta quando o chamador não
      // trouxe o que precisa. A maioria dos chamadores de F3/F4 já tem
      // `ctx.role` de `requireRole()` e evita esta volta ao banco.
      if (actorName === null || actorRole === null) {
        try {
          const { data } = await db
            .from('profiles')
            .select('full_name, account_role')
            .eq('user_id', entry.actor.userId)
            .eq('account_id', entry.accountId)
            .maybeSingle();
          if (data) {
            actorName ??= (data.full_name as string | null) ?? null;
            actorRole ??= (data.account_role as AccountRole | null) ?? null;
          }
        } catch (err) {
          // Best-effort de verdade: a linha ainda é gravada sem nome/
          // papel, não com o evento inteiro descartado.
          console.error(
            '[activity/record] falha ao enriquecer nome/papel do ator:',
            err
          );
        }
      }
    } else if (entry.actor.kind === 'system') {
      actorName = entry.actor.name ?? null;
    } else if (entry.actor.kind === 'api') {
      // Sem coluna própria para a chave — o nome carrega o suficiente
      // para a UI mostrar "API" em vez de um ator em branco.
      actorName = `API (${entry.actor.keyId})`;
    }

    const resourceLabel = entry.resourceLabel
      ? entry.resourceLabel.slice(0, RESOURCE_LABEL_MAX)
      : null;

    const { error } = await supabaseAdmin()
      .from('account_activity_log')
      .insert({
        account_id: entry.accountId,
        actor_kind: entry.actor.kind,
        actor_user_id: actorUserId,
        actor_name: actorName,
        actor_role: actorRole,
        resource_type: entry.resourceType,
        action: entry.action,
        resource_id: entry.resourceId ?? null,
        resource_label: resourceLabel,
        channel_id: entry.channelId ?? null,
        channel_type: entry.channelType ?? null,
        conversation_id: entry.conversationId ?? null,
        contact_id: entry.contactId ?? null,
        source_table: entry.source?.table ?? null,
        source_id: entry.source?.id ?? null,
        metadata: sanitizeMetadata(entry.metadata),
      });

    if (error) {
      console.error(
        `[activity/record] insert falhou (${entry.action}):`,
        error.message
      );
    }
  } catch (err) {
    // Regra 5, sem exceção: nada aqui pode propagar para o chamador.
    console.error('[activity/record] recordActivity lançou internamente:', err);
  }
}
