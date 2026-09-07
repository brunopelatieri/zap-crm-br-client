'use client';

// ============================================================
// DangerZone — Settings → Danger zone
//
// Painel só-leitura: mostra o inventário da conta (contagens vindas
// de GET /api/account/delete/preview — a UI não pode inventar número)
// e o botão que abre o modal de exclusão (SPEC 073 §6). O `<RequireRole
// min="owner">` aqui é defesa em profundidade contra navegação direta
// por `?tab=danger` — a rota já repete a guarda no servidor.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RequireRole } from '@/components/auth/require-role';
import { SettingsPanelHead } from './settings-panel-head';
import { DeleteAccountDialog } from './delete-account-dialog';

export interface AccountInventory {
  contacts: number;
  conversations: number;
  messages: number;
  broadcasts: number;
  channels: number;
  members: number;
}

const ROW_KEYS: (keyof AccountInventory)[] = [
  'contacts',
  'conversations',
  'messages',
  'broadcasts',
  'channels',
  'members',
];

export function DangerZone() {
  const t = useTranslations('Settings.danger');
  const [inventory, setInventory] = useState<AccountInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch('/api/account/delete/preview');
        if (!res.ok) return;
        const json = (await res.json()) as { counts: AccountInventory };
        if (!cancelled) setInventory(json.counts);
      } catch (err) {
        console.error('[DangerZone] preview fetch failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <RequireRole min="owner">
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Card className="border-red-600/30">
          <CardContent className="space-y-4 pt-6">
            <div>
              <h3 className="text-foreground text-sm font-semibold">
                {t('inventoryTitle')}
              </h3>
              {loading ? (
                <Loader2 className="text-muted-foreground mt-2 size-4 animate-spin" />
              ) : (
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                  {ROW_KEYS.map((key) => (
                    <div key={key} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{t(key)}</dt>
                      <dd className="text-foreground font-medium">
                        {inventory ? inventory[key] : '—'}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            <p className="text-muted-foreground text-sm">{t('irreversible')}</p>

            <Button
              type="button"
              variant="outline"
              className="border-red-600 text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
              onClick={() => setDialogOpen(true)}
            >
              <TriangleAlert className="size-4" />
              {t('button')}
            </Button>
          </CardContent>
        </Card>

        {dialogOpen ? (
          <DeleteAccountDialog
            inventory={inventory}
            onOpenChange={setDialogOpen}
          />
        ) : null}
      </div>
    </RequireRole>
  );
}
