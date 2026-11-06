'use client';

// ============================================================
// Área do contato na ficha do contato (SPEC 083, PRD 082 §6.3).
//
// Estado do acesso + último login para todo mundo (`viewer`+);
// "Enviar acesso" (J1) para `agent`+; bloquear/desbloquear e encerrar
// sessões para `admin`+. Os botões são conveniência — quem decide é a
// rota (`requireRole`), que também confere pela RLS que o contato é
// visível para quem chama.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'next-intl';
import { KeyRound, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCan } from '@/hooks/use-can';
import type { ContactAccessState } from '@/lib/contact-portal/account';
import type { AccessStatus } from '@/lib/contact-portal/types';

const REASON_KEYS = [
  'opted_out',
  'blocked',
  'not_eligible',
  'invalid_phone',
  'throttled',
  'not_found',
  'no_channel',
  'needs_template',
  'cold_limit',
  'send_failed',
] as const;

type Busy = 'invite' | 'block' | 'sessions' | null;

export function ContactPortalAccessCard({ contactId }: { contactId: string }) {
  const t = useTranslations('Contacts.portalAccess');
  const format = useFormatter();
  const canInvite = useCan('send-messages');
  const canManage = useCan('edit-settings');

  const [loaded, setLoaded] = useState(false);
  /**
   * Plano sem o item (SPEC 083 §8.4, PRD 082 D-4): a rota responde 403
   * `FEATURE_NOT_IN_PLAN` e o cartão simplesmente não existe — sem toast,
   * sem estado "sem acesso". A aba de Configurações é quem explica.
   */
  const [hidden, setHidden] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [state, setState] = useState<ContactAccessState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/contact-portal/contacts/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactIds: [contactId] }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        eligible: boolean;
        statuses: ContactAccessState[];
      };
      setEligible(data.eligible);
      setState(data.statuses[0] ?? null);
    } else if (res.status === 403) {
      setHidden(true);
    }
    setLoaded(true);
  }, [contactId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const reasonMessage = (code: unknown) =>
    (REASON_KEYS as readonly unknown[]).includes(code)
      ? t(`reasons.${code as (typeof REASON_KEYS)[number]}`)
      : t('failed');

  const run = async (
    kind: Exclude<Busy, null>,
    request: () => Promise<Response>,
    success: string
  ) => {
    setBusy(kind);
    const res = await request();
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        code?: unknown;
      } | null;
      toast.error(reasonMessage(body?.code));
      return;
    }
    toast.success(success);
    void load();
  };

  const invite = () =>
    run(
      'invite',
      () =>
        fetch(`/api/contact-portal/contacts/${contactId}/invite`, {
          method: 'POST',
        }),
      t('inviteSent')
    );

  const toggleBlock = (blocked: boolean) =>
    run(
      'block',
      () =>
        fetch(`/api/contact-portal/contacts/${contactId}/block`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ blocked }),
        }),
      blocked ? t('blocked') : t('unblocked')
    );

  const endSessions = () =>
    run(
      'sessions',
      () =>
        fetch(`/api/contact-portal/contacts/${contactId}/sessions`, {
          method: 'DELETE',
        }),
      t('sessionsEnded')
    );

  if (!loaded || hidden) return null;

  const status: AccessStatus = state?.status ?? 'none';
  const isBlocked = status === 'blocked';

  return (
    <div className="border-border space-y-2 border-t pt-3">
      <h3 className="text-foreground flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-3.5" />
        {t('title')}
      </h3>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={status === 'active' ? 'default' : 'secondary'}>
          {t(`status.${status}`)}
        </Badge>
        {status !== 'none' && (
          <span className="text-muted-foreground text-xs">
            {state?.lastLoginAt
              ? t('lastLogin', {
                  date: format.dateTime(new Date(state.lastLoginAt), {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  }),
                })
              : t('neverLoggedIn')}
          </span>
        )}
      </div>

      {!eligible ? (
        <p className="text-muted-foreground text-xs">{t('areaOff')}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {canInvite && !isBlocked && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={invite}
              className="border-border text-muted-foreground"
            >
              {busy === 'invite' && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              {t('invite')}
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => toggleBlock(!isBlocked)}
              className="border-border text-muted-foreground"
            >
              {busy === 'block' && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              {isBlocked ? t('unblock') : t('block')}
            </Button>
          )}
          {canManage && status === 'active' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={endSessions}
              className="text-muted-foreground"
            >
              {busy === 'sessions' && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              {t('endSessions')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
