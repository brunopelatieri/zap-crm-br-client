'use client';

// ============================================================
// HarvestedContactsTab — aba "Importados do telefone" (SPEC 069 §8
// ponto 6, D-3). A triagem da agenda captada pelas instâncias QRCode:
// NADA aqui é `contacts` até um humano promover — ver a nota de LGPD
// fixa no topo, que é a razão de produto de esta tela existir.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAccountChannels } from '@/lib/channels/use-account-channels';

interface HarvestedRow {
  id: string;
  channel_id: string;
  jid: string;
  phone_normalized: string | null;
  push_name: string | null;
  full_name: string | null;
  business_name: string | null;
  status: string;
  created_at: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const payload = await res.json().catch(() => ({}));
  return typeof payload?.error === 'string' ? payload.error : fallback;
}

function displayName(row: HarvestedRow): string {
  return row.full_name || row.push_name || row.business_name || row.jid;
}

export function HarvestedContactsTab() {
  const t = useTranslations('Contacts.harvested');
  const channels = useAccountChannels();

  const [rows, setRows] = useState<HarvestedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        const url = new URL('/api/evolution/harvested', window.location.origin);
        url.searchParams.set('status', 'new');
        if (cursor) url.searchParams.set('cursor', cursor);
        const res = await fetch(url.toString(), { cache: 'no-store' });
        if (!res.ok) {
          toast.error(await readError(res, t('loadFailed')));
          return;
        }
        const data = (await res.json()) as {
          items: HarvestedRow[];
          next_cursor: string | null;
        };
        setRows((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setNextCursor(data.next_cursor);
      } catch (err) {
        console.error('[HarvestedContactsTab] load error:', err);
        toast.error(t('loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))
    );
  }

  async function runAction(path: 'promote' | 'ignore') {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/evolution/harvested/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) {
        toast.error(await readError(res, t('actionFailed')));
        return;
      }
      if (path === 'promote') {
        const data = (await res.json()) as {
          promoted: number;
          blocked: Array<{ id: string; reason: string }>;
        };
        if (data.blocked.length > 0) {
          toast.warning(
            t('promoteQuotaError', {
              promoted: data.promoted,
              blocked: data.blocked.length,
            })
          );
        } else if (data.promoted > 0) {
          toast.success(t('promoted', { count: data.promoted }));
        }
      }
      setRows((prev) => prev.filter((r) => !selected.has(r.id)));
      setSelected(new Set());
    } catch (err) {
      console.error(`[HarvestedContactsTab] ${path} error:`, err);
      toast.error(t('actionFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* LGPD — fixa no topo, não em tooltip (SPEC 069 §8, D-3). */}
      <Alert className="border-amber-500/30 bg-amber-500/5">
        <AlertDescription className="text-sm text-amber-100/80">
          {t('lgpdNotice')}
        </AlertDescription>
      </Alert>

      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="border-border flex flex-col items-center gap-2 rounded-xl border py-12 text-center">
          <Users className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            {t('emptyTitle')}
          </p>
          <p className="text-muted-foreground max-w-md text-sm">
            {t('emptyBody')}
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.size === rows.length && rows.length > 0}
                onCheckedChange={toggleAll}
              />
              {selected.size > 0
                ? `${selected.size} / ${rows.length}`
                : rows.length}
            </label>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || selected.size === 0}
                onClick={() => void runAction('ignore')}
              >
                {t('ignore')}
              </Button>
              <Button
                size="sm"
                disabled={busy || selected.size === 0}
                onClick={() => void runAction('promote')}
              >
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {t('promote')}
              </Button>
            </div>
          </div>

          <div className="divide-border border-border divide-y rounded-xl border">
            {rows.map((row) => (
              <label
                key={row.id}
                className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5"
              >
                <Checkbox
                  checked={selected.has(row.id)}
                  onCheckedChange={() => toggle(row.id)}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm font-medium">
                    {displayName(row)}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {row.phone_normalized ?? row.jid}
                    {' · '}
                    {t('sourceInstance', {
                      instance: channels.byId.get(row.channel_id)?.name ?? '—',
                    })}
                  </p>
                </div>
              </label>
            ))}
          </div>

          {nextCursor && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void load(nextCursor)}
              >
                {loading && <Loader2 className="size-3.5 animate-spin" />}
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
