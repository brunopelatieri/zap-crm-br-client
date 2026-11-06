'use client';

// ============================================================
// Apresentação compartilhada do feed de atividade (SPEC 075 F6/F7).
//
// O widget do dashboard e a página `/activity` mostram as MESMAS linhas
// com densidades diferentes. O que não pode divergir entre os dois — o
// ícone por tipo de recurso e, principalmente, a FRASE — mora aqui.
//
// Duas linhas divergindo é o risco concreto: o widget dizendo "Fulano
// editou o contato" e a página dizendo outra coisa para o mesmo evento
// faria o operador duvidar dos dois.
// ============================================================

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Briefcase,
  ClipboardList,
  CreditCard,
  Download,
  Inbox,
  MessageSquare,
  Radio,
  Smartphone,
  Tag as TagIcon,
  UserPlus,
  UsersRound,
  Webhook,
  Workflow,
  Zap,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type { ActivityFeedEntry } from '@/lib/activity/feed';
import type { ActivityResourceType } from '@/lib/activity/types';

export interface KindTheme {
  icon: ComponentType<{ className?: string }>;
  /** Classes Tailwind do badge redondo do ícone. */
  badge: string;
}

/**
 * Um tema por `resource_type` da migração 084 — inclusive `export` e
 * `tag`, que nenhuma ação da v1 usa ainda (§4). Estão aqui porque o
 * `Record` é exaustivo por tipo: quando `contact.tagged` (D-7) entrar,
 * o compilador não deixa esquecer o ícone.
 */
export const KIND_THEME: Record<ActivityResourceType, KindTheme> = {
  message: { icon: MessageSquare, badge: 'bg-blue-500/10 text-blue-400' },
  conversation: { icon: Inbox, badge: 'bg-sky-500/10 text-sky-400' },
  contact: { icon: UserPlus, badge: 'bg-primary/10 text-primary' },
  deal: { icon: Briefcase, badge: 'bg-emerald-500/10 text-emerald-400' },
  broadcast: { icon: Radio, badge: 'bg-amber-500/10 text-amber-400' },
  automation: { icon: Zap, badge: 'bg-rose-500/10 text-rose-400' },
  flow: { icon: Workflow, badge: 'bg-violet-500/10 text-violet-400' },
  channel: { icon: Smartphone, badge: 'bg-teal-500/10 text-teal-400' },
  member: { icon: UsersRound, badge: 'bg-indigo-500/10 text-indigo-400' },
  export: { icon: Download, badge: 'bg-muted text-muted-foreground' },
  plan: { icon: CreditCard, badge: 'bg-amber-500/10 text-amber-400' },
  tag: { icon: TagIcon, badge: 'bg-pink-500/10 text-pink-400' },
  webhook: { icon: Webhook, badge: 'bg-orange-500/10 text-orange-400' },
  form: { icon: ClipboardList, badge: 'bg-lime-500/10 text-lime-400' },
};

const KNOWN_ROLES = new Set(['owner', 'admin', 'agent', 'viewer']);

/**
 * Devolve a função que traduz uma linha do feed.
 *
 * Todo fallback acontece aqui, e não em `lib/activity/feed.ts`: a parte
 * pura não tem `t`, então ela entrega valores crus (string vazia quando
 * falta) e é a UI que decide como isso se lê.
 */
export function useActivityText(): (entry: ActivityFeedEntry) => string {
  const t = useTranslations('Activity');

  return useCallback(
    (entry: ActivityFeedEntry) => {
      const values: Record<string, string | number> = { ...entry.values };

      // Rótulo vazio não pode virar "criou o contato " — o recurso
      // apagado sem nome é exatamente o caso que a auditoria mais
      // encontra (§3.1).
      for (const [key, value] of Object.entries(values)) {
        if (value === '') values[key] = t('unknownResource');
      }

      // O papel vem cru do banco ('admin'); a frase mostra traduzido.
      if (typeof values.role === 'string' && KNOWN_ROLES.has(values.role)) {
        values.role = t(`roles.${values.role}`);
      }

      values.actor = actorLabel(entry, t);

      return t(`actions.${entry.action}`, values);
    },
    [t]
  );
}

/**
 * Nome de quem fez, com a regra do §7.3: o `actor_name` CONGELADO vence
 * sempre — é o que sobra do colega que saiu da equipe, e mostrar
 * "Desconhecido" no lugar dele apagaria a única informação que a linha
 * ainda tem sobre a autoria.
 */
export function actorLabel(
  entry: Pick<ActivityFeedEntry, 'actorName' | 'actorKind'>,
  t: ReturnType<typeof useTranslations>
): string {
  // SPEC 078 §8.1 — o console do proprietário grava `system`/`platform`;
  // o cliente lê "Suporte da plataforma" (traduzido), não a palavra crua
  // do banco.
  if (entry.actorKind === 'system' && entry.actorName === 'platform') {
    return t('actors.platform');
  }
  const frozen = entry.actorName?.trim();
  if (frozen) return frozen;
  // `user` sem nome congelado não deveria existir (o helper e a trigger
  // gravam os dois juntos), mas um evento antigo ou uma gravação
  // parcial cai aqui — e 'actors.user' não existe de propósito.
  if (entry.actorKind === 'user') return t('actors.unknown');
  return t(`actors.${entry.actorKind}`);
}
