'use client';

// ============================================================
// /admin/accounts — a lista agrupada (SPEC 062 §7.2)
//
// Uma linha por CONTA (nunca por usuário — §4 do PRD). Os filtros vêm
// da querystring — os cards de `/admin` já levam para cá com o filtro
// aplicado (`?status=`, `?blocked=`, `?expiringInDays=`, `?expired=`,
// `?overage=`).
// ============================================================

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';
import type {
  AccountListItem,
  AccountListResult,
} from '@/lib/platform/accounts';
import type { AccountPlanStatus } from '@/lib/plans/types';

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
}

function statusVariant(status: AccountPlanStatus): 'secondary' | 'destructive' {
  return status === 'past_due' ||
    status === 'suspended' ||
    status === 'canceled'
    ? 'destructive'
    : 'secondary';
}

function AccountsListContent() {
  const t = useTranslations('Platform.accounts');
  const tPlan = useTranslations('Plan');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<AccountListResult | null>(null);
  const [q, setQ] = useState(searchParams.get('q') ?? '');

  const page = Number(searchParams.get('page') ?? '1');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams(searchParams.toString());
      const res = await fetch(`/api/platform/accounts?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      setResult((await res.json()) as AccountListResult);
    } catch (err) {
      console.error('[/admin/accounts] load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [searchParams, t]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === '') {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    params.delete('page');
    router.push(`/admin/accounts?${params.toString()}`);
  }

  function goToPage(nextPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(nextPage));
    router.push(`/admin/accounts?${params.toString()}`);
  }

  const items: AccountListItem[] = result?.items ?? [];
  const pageSize = result?.pageSize ?? 25;
  const totalPages = result
    ? Math.max(1, Math.ceil(result.total / pageSize))
    : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          updateParam('q', q || null);
        }}
        className="flex max-w-sm items-center gap-2"
      >
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('searchPlaceholder')}
        />
        <Button type="submit" variant="secondary" size="icon">
          <Search className="size-4" />
        </Button>
      </form>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colAccount')}</TableHead>
                <TableHead>{t('colPlan')}</TableHead>
                <TableHead>{t('colStatus')}</TableHead>
                <TableHead>{t('colExpires')}</TableHead>
                <TableHead>{t('colMembers')}</TableHead>
                <TableHead>{t('colContacts')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.accountId}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{item.accountName}</span>
                      {item.blockedAt ? (
                        <Badge variant="destructive">{t('blockedBadge')}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {item.planName}
                    <span className="text-muted-foreground">
                      {' · '}
                      {tPlan(`billingPeriod.${item.billingCycle}`)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(item.status)}>
                      {tPlan(`status.${item.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {formatDate(item.currentPeriodEnd, locale)}
                  </TableCell>
                  <TableCell>{item.membersCount}</TableCell>
                  <TableCell>
                    {item.contactsUsed}
                    {item.contactsLimit !== null
                      ? ` / ${item.contactsLimit}`
                      : ''}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/accounts/${item.accountId}`}
                      className={buttonVariants({
                        variant: 'ghost',
                        size: 'sm',
                      })}
                    >
                      {t('openAccount')}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              {t('pageOf', { page, total: totalPages })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                {t('prevPage')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => goToPage(page + 1)}
              >
                {t('nextPage')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function PlatformAccountsPage() {
  return (
    <RequirePlatformOwner>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-12">
            <Loader2 className="text-primary size-6 animate-spin" />
          </div>
        }
      >
        <AccountsListContent />
      </Suspense>
    </RequirePlatformOwner>
  );
}
