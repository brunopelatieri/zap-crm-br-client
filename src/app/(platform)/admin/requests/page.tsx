'use client';

// ============================================================
// /admin/requests — solicitações de plano sob medida (SPEC 062 §6)
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { RequirePlatformOwner } from '@/components/platform/require-platform-owner';

interface PlanRequestRow {
  id: string;
  account_id: string;
  status: 'pending' | 'approved' | 'rejected';
  message: string | null;
  created_at: string;
  plans: { code: string; name: string } | null;
  accounts: { name: string } | null;
}

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
}

function statusBadgeVariant(
  status: PlanRequestRow['status']
): 'secondary' | 'destructive' {
  return status === 'rejected' ? 'destructive' : 'secondary';
}

function RequestsContent() {
  const t = useTranslations('Platform.requests');
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<PlanRequestRow[]>([]);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform/requests?status=${filter}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      const data = (await res.json()) as { requests: PlanRequestRow[] };
      setRequests(data.requests);
    } catch (err) {
      console.error('[/admin/requests] load failed:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(id: string, decision: 'approved' | 'rejected') {
    setActingId(id);
    try {
      const res = await fetch('/api/platform/requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision, note: notes[id] || null }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('actionFailed'));
        return;
      }
      toast.success(
        decision === 'approved' ? t('approveSuccess') : t('rejectSuccess')
      );
      void load();
    } catch (err) {
      console.error('[/admin/requests] resolve failed:', err);
      toast.error(t('networkError'));
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant={filter === 'pending' ? 'secondary' : 'outline'}
          onClick={() => setFilter('pending')}
        >
          {t('filterPending')}
        </Button>
        <Button
          size="sm"
          variant={filter === 'all' ? 'secondary' : 'outline'}
          onClick={() => setFilter('all')}
        >
          {t('filterAll')}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      ) : requests.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colAccount')}</TableHead>
              <TableHead>{t('colPlan')}</TableHead>
              <TableHead>{t('colMessage')}</TableHead>
              <TableHead>{t('colDate')}</TableHead>
              <TableHead>{t('colStatus')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((req) => (
              <TableRow key={req.id}>
                <TableCell>{req.accounts?.name ?? '—'}</TableCell>
                <TableCell>{req.plans?.name ?? '—'}</TableCell>
                <TableCell className="max-w-xs truncate">
                  {req.message ?? '—'}
                </TableCell>
                <TableCell>{formatDate(req.created_at, locale)}</TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant(req.status)}>
                    {t(
                      `status${req.status.charAt(0).toUpperCase()}${req.status.slice(1)}`
                    )}
                  </Badge>
                </TableCell>
                <TableCell>
                  {req.status === 'pending' ? (
                    <div className="flex flex-col items-end gap-2">
                      <Textarea
                        placeholder={t('noteLabel')}
                        className="w-56"
                        rows={1}
                        value={notes[req.id] ?? ''}
                        onChange={(e) =>
                          setNotes((prev) => ({
                            ...prev,
                            [req.id]: e.target.value,
                          }))
                        }
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actingId === req.id}
                          onClick={() => resolve(req.id, 'rejected')}
                        >
                          {t('reject')}
                        </Button>
                        <Button
                          size="sm"
                          disabled={actingId === req.id}
                          onClick={() => resolve(req.id, 'approved')}
                        >
                          {actingId === req.id ? (
                            <Loader2 className="animate-spin" />
                          ) : null}
                          {t('approve')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export default function PlatformRequestsPage() {
  return (
    <RequirePlatformOwner>
      <RequestsContent />
    </RequirePlatformOwner>
  );
}
