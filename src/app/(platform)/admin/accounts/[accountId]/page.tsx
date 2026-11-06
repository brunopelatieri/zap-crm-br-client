'use client';

// ============================================================
// /admin/accounts/[accountId] — o detalhe (SPEC 062 §7.3)
//
// Seções, na ordem: cabeçalho · plano · uso · membros · histórico.
// A barra de uso é `PlanUsageBars`, o MESMO componente que o cliente
// vê em `/plan` — a garantia de que o proprietário vê exatamente o
// que o cliente vê quando liga reclamando dela.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';
import { PlanUsageBars } from '@/components/plan/plan-usage-bars';
import { BlockToggle } from '@/components/platform/block-toggle';
import { DeleteAccountButton } from '@/components/platform/delete-account-button';
import { ChangePlanDialog } from '@/components/platform/change-plan-dialog';
import { ChangePeriodEndDialog } from '@/components/platform/change-period-end-dialog';
import { RecordPaymentDialog } from '@/components/platform/record-payment-dialog';
import { PaymentsCard } from '@/components/platform/payments-card';
import {
  EditUserIdentityDialog,
  type EditableMember,
} from '@/components/platform/edit-user-identity-dialog';
import { formatSpDate } from '@/components/platform/console-format';
import { AccountRetentionPanel } from '@/components/retention/retention-panel';
import { ChannelLimitsPanel } from '@/components/platform/channel-limits-panel';
import { Button } from '@/components/ui/button';
import {
  AUDIT_EVENTS_LIMIT,
  PLAN_EVENTS_LIMIT,
  type AccountAuditEvent,
  type AccountDetail,
  type AccountMember,
} from '@/lib/platform/accounts';
import {
  describeAuditEvent,
  mergeAccountHistory,
} from '@/lib/platform/audit-feed';
import type { AccountPayment } from '@/lib/plans/payments';
import type { PlanUsage } from '@/lib/plans/types';
import type { PortalAccountSummary } from '@/lib/contact-portal/account';

interface AccountDetailResponse {
  account: AccountDetail;
  usage: PlanUsage | null;
  quotasEnforced: boolean;
  events: {
    id: string;
    from_plan_code: string | null;
    to_plan_code: string | null;
    from_status: string | null;
    to_status: string | null;
    actor: string;
    reason: string | null;
    created_at: string;
  }[];
  /** SPEC 078 §9.4 — o que o console fez nesta conta. */
  auditEvents: AccountAuditEvent[];
  /** SPEC 078 §4.4 — `null` = a leitura dos pagamentos falhou. */
  payments: AccountPayment[] | null;
  /** SPEC 078 §9.3 — membros que SÃO o proprietário da plataforma. */
  platformOwnerUserIds: string[];
  /** SPEC 083 — área do contato; `null` = a leitura falhou. */
  contactPortal: PortalAccountSummary | null;
  self: {
    /** A conta aberta é a do próprio proprietário (§4.4). */
    isOwnAccount: boolean;
    /** `user_id` do proprietário neste banco, quando ele tem perfil aqui. */
    ownUserId: string | null;
  };
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
}

function formatDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function AccountDetailContent({ accountId }: { accountId: string }) {
  const t = useTranslations('Platform.accountDetail');
  const tAudit = useTranslations('Platform.audit');
  const tPay = useTranslations('Platform.payments');
  const tPlan = useTranslations('Plan');
  const tBlock = useTranslations('Platform.block');
  const locale = useLocale();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AccountDetailResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [changingPlan, setChangingPlan] = useState(false);
  const [changingPeriodEnd, setChangingPeriodEnd] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [editingMember, setEditingMember] = useState<EditableMember | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform/accounts/${accountId}`, {
        cache: 'no-store',
      });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      setData((await res.json()) as AccountDetailResponse);
    } catch (err) {
      console.error('[/admin/accounts/[id]] load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [accountId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  if (notFound || !data) {
    return <p className="text-muted-foreground text-sm">{t('notFound')}</p>;
  }

  const { account, usage, events, auditEvents, self } = data;
  const owner = account.members.find((m) => m.role === 'owner') ?? null;
  const platformOwnerIds = new Set(data.platformOwnerUserIds);

  // SPEC 078 §9.4: eventos de plano e ações do console, intercalados.
  const history = mergeAccountHistory(events, auditEvents, {
    plan: PLAN_EVENTS_LIMIT,
    audit: AUDIT_EVENTS_LIMIT,
  });

  const describeAudit = (event: AccountAuditEvent) => {
    const { key, values } = describeAuditEvent(event, {
      date: (iso) => formatSpDate(iso, locale),
      method: (code) =>
        tPay.has(`methods.${code}`) ? tPay(`methods.${code}`) : code,
      field: (code) =>
        tAudit(code === 'email' ? 'fieldEmail' : 'fieldFullName'),
    });
    return tAudit(key, values);
  };

  return (
    <div className="space-y-6">
      <Link
        href="/admin/accounts"
        className={buttonVariants({
          variant: 'ghost',
          size: 'sm',
          className: '-ml-2',
        })}
      >
        <ArrowLeft className="size-4" />
        {t('back')}
      </Link>

      <div className="flex items-center gap-3">
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {account.accountName}
        </h1>
        {account.blockedAt ? (
          <Badge variant="destructive">
            {t('blockedSince', { date: formatDate(account.blockedAt, locale) })}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground text-sm">
          {t('createdAt', { date: formatDate(account.createdAt, locale) })}
        </p>
        <BlockToggle
          target="account"
          id={account.accountId}
          blocked={account.blockedAt !== null}
          disabledReason={
            self.isOwnAccount ? tBlock('selfBlockDisabled') : null
          }
          onChanged={load}
        />
        <DeleteAccountButton
          accountId={account.accountId}
          accountName={account.accountName}
          ownerEmail={owner?.email ?? null}
          onDeleted={() => router.push('/admin/accounts')}
        />
      </div>
      {account.blockedReason ? (
        <p className="text-muted-foreground text-sm">
          {t('blockedReason', { reason: account.blockedReason })}
        </p>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('planSection')}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {/* Sem ciclo não há vencimento (D-1): o motivo vai no wrapper,
                porque `title` num botão desabilitado não aparece. */}
            <span
              title={account.hasBillingCycle ? undefined : t('noCycleHint')}
            >
              <Button
                size="sm"
                variant="outline"
                disabled={!account.hasBillingCycle}
                onClick={() => setChangingPeriodEnd(true)}
              >
                {t('changePeriodEnd')}
              </Button>
            </span>
            <span
              title={account.hasBillingCycle ? undefined : t('noCycleHint')}
            >
              <Button
                size="sm"
                variant="outline"
                disabled={!account.hasBillingCycle}
                onClick={() => setRecordingPayment(true)}
              >
                {t('recordPayment')}
              </Button>
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setChangingPlan(true)}
            >
              {t('changePlan')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">{t('cycle')}: </span>
            {account.planName} ·{' '}
            {tPlan(`billingPeriod.${account.billingCycle}`)}
          </div>
          <div>
            <Badge variant="secondary">
              {tPlan(`status.${account.status}`)}
            </Badge>
          </div>
          <div>
            {t('startedAt', { date: formatDate(account.startedAt, locale) })}
          </div>
          <div>
            {account.currentPeriodEnd
              ? t('expiresAt', {
                  date: formatSpDate(account.currentPeriodEnd, locale),
                })
              : t('noExpiration')}
          </div>
          {account.cancelAtPeriodEnd ? (
            <div className="text-amber-600 sm:col-span-2 dark:text-amber-400">
              {t('cancelScheduled')}
            </div>
          ) : null}
          {account.graceUntil ? (
            <div className="text-destructive sm:col-span-2">
              {t('graceUntil', {
                date: formatDate(account.graceUntil, locale),
              })}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {account.hasBillingCycle ? (
        <PaymentsCard
          accountId={account.accountId}
          currentPeriodEnd={account.currentPeriodEnd}
          payments={data.payments}
          onChanged={load}
        />
      ) : null}

      {usage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('usageSection')}</CardTitle>
          </CardHeader>
          <CardContent>
            <PlanUsageBars buckets={usage.buckets} />
          </CardContent>
        </Card>
      ) : null}

      {data.contactPortal ? (
        <ContactPortalSummaryCard summary={data.contactPortal} />
      ) : null}

      {/* SPEC 062 §7.5 — a retenção desta conta, com os mesmos cartões
          que o dono via em Configurações até a 069 e a prévia calculada
          sobre os dados reais dela. */}
      <AccountRetentionPanel accountId={account.accountId} />

      {/* SPEC 069 D-9/F10 — limite de segurança é alavanca comercial;
          quem configura é o proprietário, aqui, não o cliente. */}
      <ChannelLimitsPanel accountId={account.accountId} />

      <Card>
        <CardHeader>
          <CardTitle>{t('membersSection')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colName')}</TableHead>
                <TableHead>{t('colEmail')}</TableHead>
                <TableHead>{t('colRole')}</TableHead>
                <TableHead>{t('colMemberStatus')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {account.members.map((member: AccountMember) => (
                <TableRow key={member.userId}>
                  <TableCell>{member.fullName ?? '—'}</TableCell>
                  <TableCell>{member.email}</TableCell>
                  <TableCell className="capitalize">{member.role}</TableCell>
                  <TableCell>
                    {member.blockedAt ? (
                      <Badge variant="destructive">{t('memberBlocked')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('memberActive')}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label={t('editMember')}
                        title={t('editMember')}
                        onClick={() =>
                          setEditingMember({
                            userId: member.userId,
                            fullName: member.fullName,
                            email: member.email,
                            role: member.role,
                          })
                        }
                      >
                        <Pencil />
                      </Button>
                      <BlockToggle
                        target="user"
                        id={member.userId}
                        blocked={member.blockedAt !== null}
                        isAccountOwner={member.role === 'owner'}
                        disabledReason={
                          self.ownUserId === member.userId
                            ? tBlock('selfBlockDisabled')
                            : null
                        }
                        onChanged={load}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('historySection')}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noEvents')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {history.map((item) => (
                <li
                  key={`${item.kind}-${item.event.id}`}
                  className="text-muted-foreground"
                >
                  <span className="text-foreground">
                    {formatDateTime(item.at, locale)}
                  </span>{' '}
                  — {item.event.actor} —{' '}
                  {item.kind === 'audit'
                    ? describeAudit(item.event)
                    : item.event.from_plan_code || item.event.to_plan_code
                      ? t('eventChange', {
                          from: item.event.from_plan_code ?? '—',
                          to: item.event.to_plan_code ?? '—',
                        })
                      : t('eventChange', {
                          from: item.event.from_status ?? '—',
                          to: item.event.to_status ?? '—',
                        })}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {changingPeriodEnd ? (
        <ChangePeriodEndDialog
          accountId={account.accountId}
          accountName={account.accountName}
          currentPeriodEnd={account.currentPeriodEnd}
          billingCycle={account.billingCycle}
          status={account.status}
          cancelAtPeriodEnd={account.cancelAtPeriodEnd}
          onClose={() => setChangingPeriodEnd(false)}
          onChanged={() => {
            setChangingPeriodEnd(false);
            void load();
          }}
        />
      ) : null}

      {recordingPayment ? (
        <RecordPaymentDialog
          accountId={account.accountId}
          accountName={account.accountName}
          currentPeriodEnd={account.currentPeriodEnd}
          billingCycle={account.billingCycle}
          accountBlocked={account.blockedAt !== null}
          cancelAtPeriodEnd={account.cancelAtPeriodEnd}
          onClose={() => setRecordingPayment(false)}
          onChanged={() => {
            setRecordingPayment(false);
            void load();
          }}
        />
      ) : null}

      {editingMember ? (
        <EditUserIdentityDialog
          member={editingMember}
          isPlatformOwner={platformOwnerIds.has(editingMember.userId)}
          onClose={() => setEditingMember(null)}
          onChanged={() => {
            setEditingMember(null);
            void load();
          }}
        />
      ) : null}

      {changingPlan ? (
        <ChangePlanDialog
          accountId={account.accountId}
          accountName={account.accountName}
          currentPlanCode={account.planCode}
          currentStatus={account.status}
          onClose={() => setChangingPlan(false)}
          onChanged={() => {
            setChangingPlan(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

export default function PlatformAccountDetailPage() {
  const params = useParams<{ accountId: string }>();
  return (
    <RequirePlatformOwner>
      <AccountDetailContent accountId={params.accountId} />
    </RequirePlatformOwner>
  );
}

/** SPEC 083 — PRD 082 §6.3: "ligada/desligada · N contatos com acesso". */
function ContactPortalSummaryCard({
  summary,
}: {
  summary: PortalAccountSummary;
}) {
  const t = useTranslations('Platform.contactPortal');
  const state = !summary.enabled
    ? t('off')
    : summary.eligible
      ? t('on')
      : t('ineligible');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('section')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 text-sm">
        <Badge
          variant={
            summary.enabled && summary.eligible ? 'default' : 'secondary'
          }
        >
          {state}
        </Badge>
        <span className="text-muted-foreground">
          {t('activeCount', { count: summary.activeCount })}
        </span>
        {summary.publicCode ? (
          <code className="text-muted-foreground text-xs">
            /area/c/{summary.publicCode}
          </code>
        ) : null}
      </CardContent>
    </Card>
  );
}
