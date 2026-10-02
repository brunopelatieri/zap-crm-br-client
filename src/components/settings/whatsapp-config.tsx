'use client';

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  Timer,
  Plus,
  Star,
  Pencil,
  Trash2,
  Activity,
  ChevronLeft,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useAccountPlan } from '@/hooks/use-account-plan';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppBillingCard } from './whatsapp-billing-card';
import { BillingStateBadge } from './whatsapp-billing-state-badge';
import { fetchBillingSummary } from '@/lib/whatsapp/billing-client';
import type { ChannelBillingSummaryDto } from '@/lib/whatsapp/billing-dto';
import { formatMoney } from '@/lib/whatsapp/billing-format';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';

const MASKED_TOKEN = '••••••••••••••••';

/** Realce das instruções de configuração: tag `<strong>` nas mensagens i18n. */
const richStrong = {
  strong: (chunks: ReactNode) => (
    <strong className="text-foreground">{chunks}</strong>
  ),
};

/**
 * Um número oficial como a rota o descreve (SPEC 064 §5/F7).
 *
 * Substitui a linha crua de `whatsapp_config` que este componente lia
 * direto do navegador: a policy `whatsapp_config_select` é
 * `is_account_member`, então o `select('*')` entregava o `access_token`
 * cifrado a qualquer membro — `viewer` inclusive — e, com N números,
 * entregaria N. `GET /api/whatsapp/config` não devolve segredo nenhum.
 */
interface CloudNumber {
  channel_id: string;
  name: string;
  identifier: string | null;
  /** D-9: `false` enquanto o canal guarda o `phone_number_id` antigo. */
  identifier_is_phone: boolean;
  status: string;
  is_default: boolean;
  phone_number_id: string | null;
  waba_id: string | null;
  registered_at: string | null;
  last_registration_error: string | null;
  subscribed_apps_at: string | null;
  broadcast_cooldown_days: number | null;
  messaging_limit_tier: string | null;
}

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

/**
 * Aba "WhatsApp Oficial" (SPEC 064 F7).
 *
 * Com 0 ou 1 número, abre direto no detalhe — nenhuma conta existente
 * vê uma lista de um item onde antes havia um formulário. Com mais de
 * um, mostra a lista (rótulo, telefone, status, padrão, tier, cooldown)
 * com as ações Editar · Diagnosticar · Definir como padrão · Remover, e
 * "Conectar outro número" abre o mesmo detalhe em modo criação.
 */
export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const locale = useLocale();
  const {
    user,
    accountId,
    loading: authLoading,
    profileLoading,
    canEditSettings,
  } = useAuth();
  const { data: planData, refetch: refetchPlan } = useAccountPlan();

  const [loadingList, setLoadingList] = useState(true);
  const [channels, setChannels] = useState<CloudNumber[]>([]);
  const loadedAccountIdRef = useRef<string | null>(null);
  // `null` = tela raiz (detalhe único ou lista, conforme `channels.length`);
  // `'new'` = formulário de criação; string = editando aquele canal.
  const [view, setView] = useState<'new' | string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  // Resumo do monitor de cobrança por número (SPEC 076 §9.2). Vazio com o
  // flag desligado ou se a leitura falhar: a lista só fica sem o selo.
  const [billingByChannel, setBillingByChannel] = useState<
    Record<string, ChannelBillingSummaryDto>
  >({});
  // Só a resposta da busca MAIS NOVA do resumo vale: `fetchChannels` roda
  // várias vezes seguidas (remover, definir padrão), e um resumo lento de
  // uma chamada anterior não pode sobrescrever o selo atual.
  const billingSeq = useRef(0);

  const fetchChannels = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch('/api/whatsapp/config', { cache: 'no-store' });
      const payload = await res.json();
      setChannels((payload.channels ?? []) as CloudNumber[]);
      // Sem await: o selo chega depois e nunca atrasa a lista.
      const mine = ++billingSeq.current;
      fetchBillingSummary().then((res) => {
        if (mine !== billingSeq.current) return;
        if (res.status !== 'ok') {
          setBillingByChannel({});
          return;
        }
        setBillingByChannel(
          Object.fromEntries(res.data.channels.map((c) => [c.channel_id, c]))
        );
      });
    } catch (err) {
      console.error('fetchChannels error:', err);
      toast.error(t('list.loadFailed'));
    } finally {
      setLoadingList(false);
    }
  }, [t]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoadingList(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, profileLoading, user?.id, accountId, fetchChannels]);

  async function handleDiagnose(channel: CloudNumber) {
    setProbingId(channel.channel_id);
    try {
      const res = await fetch(
        `/api/whatsapp/config?channel_id=${encodeURIComponent(channel.channel_id)}`,
        { cache: 'no-store' }
      );
      const payload = await res.json();
      if (payload.connected) {
        toast.success(
          payload.phone_info?.verified_name
            ? t('list.diagnoseOkNamed', {
                name: payload.phone_info.verified_name,
              })
            : t('list.diagnoseOk')
        );
      } else {
        toast.error(payload.message || t('list.diagnoseFailed'));
      }
    } catch (err) {
      console.error('diagnose error:', err);
      toast.error(t('list.diagnoseFailed'));
    } finally {
      setProbingId(null);
      // A sondagem reconcilia `status`/`identifier` no banco (D-9) —
      // recarrega para a linha refletir o que acabou de acontecer.
      fetchChannels();
    }
  }

  async function handleSetDefault(channel: CloudNumber) {
    if (channel.is_default) return;
    setSettingDefaultId(channel.channel_id);
    try {
      const supabase = createClient();
      // `set_default_channel` (migração 072) — a ÚNICA forma de escrever
      // `is_default` fora da migração, e a única que desmarca o anterior
      // do MESMO TIPO na mesma transação (§6.1).
      const { error } = await supabase.rpc('set_default_channel', {
        p_channel_id: channel.channel_id,
      });
      if (error) {
        console.error('set_default_channel error:', error);
        toast.error(t('list.setDefaultFailed'));
        return;
      }
      toast.success(t('list.setDefaultSuccess', { name: channel.name }));
      await fetchChannels();
    } finally {
      setSettingDefaultId(null);
    }
  }

  async function handleRemoveRow(channel: CloudNumber) {
    if (
      !confirm(
        t('list.removeConfirm', {
          name: channel.name,
        })
      )
    ) {
      return;
    }
    setRemovingId(channel.channel_id);
    try {
      const res = await fetch(
        `/api/whatsapp/config?channel_id=${encodeURIComponent(channel.channel_id)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('list.removeFailed'));
        return;
      }
      toast.success(
        data.outcome === 'deleted'
          ? t('list.removeSuccessDeleted', { name: channel.name })
          : t('list.removeSuccessDisabled', { name: channel.name })
      );
      await fetchChannels();
      await refetchPlan();
    } catch (err) {
      console.error('remove error:', err);
      toast.error(t('list.removeFailed'));
    } finally {
      setRemovingId(null);
    }
  }

  async function handleBackToList() {
    setView(null);
    await fetchChannels();
  }

  if (loadingList) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      </section>
    );
  }

  const cloudBucket = planData?.usage.buckets.find(
    (b) => b.key === 'channels_whatsapp_cloud'
  );
  const atQuotaCap = Boolean(
    cloudBucket &&
    cloudBucket.limit !== null &&
    cloudBucket.used >= cloudBucket.limit
  );
  const quotaHint =
    atQuotaCap && cloudBucket
      ? t('list.quotaCapped', {
          used: cloudBucket.used,
          limit: cloudBucket.limit ?? 0,
        })
      : undefined;

  const connectAnotherButton = (
    <Button
      onClick={() => setView('new')}
      disabled={atQuotaCap}
      title={quotaHint}
      className="bg-primary hover:bg-primary/90 text-primary-foreground"
    >
      <Plus className="size-4" />
      {t('list.connectAnother')}
    </Button>
  );

  // ── Detalhe: criando um número novo ──────────────────────────────
  if (view === 'new') {
    return (
      <section className="animate-in fade-in-50 space-y-4 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        {channels.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleBackToList}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <ChevronLeft className="size-4" />
            {t('list.back')}
          </Button>
        )}
        <CloudNumberDetail
          key="new"
          accountId={accountId ?? ''}
          canEditSettings={canEditSettings}
          initial={null}
          onCreated={async (channelId) => {
            await refetchPlan();
            // A lista do pai precisa refletir o canal recém-criado
            // ANTES de navegar — sem isto, o próximo render (ramo
            // "editando um número existente") busca `channelId` numa
            // lista ainda sem ele, acha `null`, e o detalhe reabre em
            // branco como se o salvamento tivesse falhado.
            await fetchChannels();
            setView(channelId);
          }}
          onDeleted={handleBackToList}
        />
      </section>
    );
  }

  // ── Detalhe: editando um número existente (via a lista) ───────────
  if (typeof view === 'string') {
    const current = channels.find((c) => c.channel_id === view) ?? null;
    return (
      <section className="animate-in fade-in-50 space-y-4 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Button
          variant="outline"
          size="sm"
          onClick={handleBackToList}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          <ChevronLeft className="size-4" />
          {t('list.back')}
        </Button>
        <CloudNumberDetail
          key={view}
          accountId={accountId ?? ''}
          canEditSettings={canEditSettings}
          initial={current}
          onCreated={() => setView(null)}
          onDeleted={handleBackToList}
        />
      </section>
    );
  }

  // ── Raiz: 0 ou 1 número, sem lista de propósito (§6.1) ────────────
  if (channels.length <= 1) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t('title')}
          description={t('description')}
          action={channels.length === 1 ? connectAnotherButton : undefined}
        />
        <CloudNumberDetail
          // A CHAVE precisa mudar quando o número some (hard-delete):
          // sem ela, o mesmo componente monta continuaria com o estado
          // interno do canal apagado — nenhum `initial` novo chega
          // depois da montagem, e sem `key` React não remonta sozinho.
          key={channels[0]?.channel_id ?? 'empty'}
          accountId={accountId ?? ''}
          canEditSettings={canEditSettings}
          initial={channels[0] ?? null}
          onCreated={async () => {
            await refetchPlan();
            await fetchChannels();
          }}
          onDeleted={fetchChannels}
        />
      </section>
    );
  }

  // ── Raiz: lista de números (§6.1) ─────────────────────────────────
  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={connectAnotherButton}
      />
      <div className="space-y-3">
        {channels.map((c) => (
          <Card key={c.channel_id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-foreground font-medium">{c.name}</h3>
                  {c.is_default && (
                    <Badge className="border-primary/30 bg-primary/10 text-primary border text-xs">
                      {t('list.defaultBadge')}
                    </Badge>
                  )}
                  <Badge
                    className={`border text-xs ${
                      c.status === 'connected'
                        ? 'border-emerald-700/40 bg-emerald-950/30 text-emerald-400'
                        : c.status === 'error'
                          ? 'border-red-700/40 bg-red-950/30 text-red-400'
                          : 'border-border bg-muted text-muted-foreground'
                    }`}
                  >
                    {t(`list.status.${c.status}` as 'list.status.connected')}
                  </Badge>
                  {billingByChannel[c.channel_id] && (
                    <BillingStateBadge
                      state={billingByChannel[c.channel_id].state}
                    />
                  )}
                </div>
                <p className="text-muted-foreground text-sm">
                  {c.identifier_is_phone
                    ? c.identifier
                    : t('list.identifierPending')}
                </p>
                {billingByChannel[c.channel_id]?.spend_total != null && (
                  <p className="text-muted-foreground text-xs">
                    {t('billing.spendShort', {
                      amount: formatMoney(
                        locale,
                        billingByChannel[c.channel_id].currency,
                        billingByChannel[c.channel_id].spend_total as number
                      ),
                    })}
                  </p>
                )}
                <p className="text-muted-foreground text-xs">
                  {t('list.tierAndCooldown', {
                    tier: c.messaging_limit_tier ?? t('list.tierUnknown'),
                    cooldown: c.broadcast_cooldown_days ?? 7,
                  })}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDiagnose(c)}
                  disabled={probingId === c.channel_id}
                  className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2"
                >
                  {probingId === c.channel_id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Activity className="size-3.5" />
                  )}
                  {t('list.diagnose')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setView(c.channel_id)}
                  className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2"
                >
                  <Pencil className="size-3.5" />
                  {t('list.edit')}
                </Button>
                {canEditSettings && !c.is_default && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSetDefault(c)}
                    disabled={settingDefaultId === c.channel_id}
                    className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2"
                  >
                    {settingDefaultId === c.channel_id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Star className="size-3.5" />
                    )}
                    {t('list.setDefault')}
                  </Button>
                )}
                {canEditSettings && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveRow(c)}
                    disabled={removingId === c.channel_id}
                    aria-label={t('list.removeAria', { name: c.name })}
                    className="text-muted-foreground h-8 w-8 hover:bg-red-950/30 hover:text-red-400"
                  >
                    {removingId === c.channel_id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

interface CloudNumberDetailProps {
  accountId: string;
  canEditSettings: boolean;
  /** Metadados já carregados da lista — `null` = criando um número novo. */
  initial: CloudNumber | null;
  /** Disparado só na PRIMEIRA vez que este número é salvo (channel_id nasce agora). */
  onCreated: (channelId: string) => void;
  /** Disparado após "Reset Configuration" apagar ou desativar o canal. */
  onDeleted: () => void;
}

/**
 * Formulário + diagnóstico de UM número oficial.
 *
 * Corpo herdado quase inteiro do componente único que esta tela era
 * antes da F7 — a diferença é que ele agora recebe o canal por prop
 * (`initial`) em vez de sempre pegar "o primeiro que a rota devolve", e
 * avisa o pai quando cria ou apaga um canal para a navegação (lista ↔
 * detalhe) se ajustar.
 */
function CloudNumberDetail({
  accountId,
  canEditSettings,
  initial,
  onCreated,
  onDeleted,
}: CloudNumberDetailProps) {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();

  const [channelId, setChannelId] = useState<string | null>(
    initial?.channel_id ?? null
  );
  const [config, setConfig] = useState<CloudNumber | null>(initial);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [cooldownDaysInput, setCooldownDaysInput] = useState(
    String(initial?.broadcast_cooldown_days ?? 7)
  );
  const [savingCooldown, setSavingCooldown] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const [phoneNumberId, setPhoneNumberId] = useState(
    initial?.phone_number_id || ''
  );
  const [wabaId, setWabaId] = useState(initial?.waba_id || '');
  const [accessToken, setAccessToken] = useState(initial ? MASKED_TOKEN : '');
  const [verifyToken, setVerifyToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [showAppSecret, setShowAppSecret] = useState(false);
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  /**
   * Sonda ESTE canal.
   *
   * `id` nulo é "formulário de número novo" — e não pode cair no
   * endpoint sem `channel_id`, porque esse endpoint sonda o canal
   * PADRÃO da conta (§5). Numa conta que já tem um número, isso
   * mostraria "Credenciais válidas" para um número que ainda nem foi
   * salvo — o próprio padrão dos outros, emprestado por engano. Sem
   * canal, não há o que sondar: mostra "não conectado" sem rede.
   */
  const probeNow = useCallback(
    async (id: string | null) => {
      if (!id) {
        setConnectionStatus('unknown');
        setResetReason(null);
        setStatusMessage('');
        setRegistrationProbe(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(
          `/api/whatsapp/config?channel_id=${encodeURIComponent(id)}`,
          { cache: 'no-store' }
        );
        const payload = await res.json();
        setRegistrationProbe(null);
        if (payload.connected) {
          setConnectionStatus('connected');
          setResetReason(null);
          setStatusMessage('');
        } else {
          setConnectionStatus('disconnected');
          setResetReason(
            payload.needs_reset
              ? 'token_corrupted'
              : payload.reason === 'meta_api_error'
                ? 'meta_api_error'
                : null
          );
          setStatusMessage(payload.message || '');
        }
      } catch (err) {
        console.error('probeNow error:', err);
        setConnectionStatus('disconnected');
        toast.error(t('toastLoadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  /** Recarrega os metadados (não-segredo) deste canal a partir da lista. */
  const refreshMetadata = useCallback(async (id: string) => {
    try {
      const res = await fetch('/api/whatsapp/config', { cache: 'no-store' });
      const payload = await res.json();
      const numbers = (payload.channels ?? []) as CloudNumber[];
      const mine = numbers.find((n) => n.channel_id === id) ?? null;
      setConfig(mine);
      setCooldownDaysInput(String(mine?.broadcast_cooldown_days ?? 7));
    } catch (err) {
      console.error('refreshMetadata error:', err);
    }
  }, []);

  useEffect(() => {
    probeNow(channelId);
    // Só na montagem — trocar de canal remonta o componente inteiro
    // (a chave é `channel_id ?? 'new'` no componente pai), então este
    // efeito nunca precisa reagir a uma mudança de `channelId` em vida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error('Phone Number ID is required');
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access Token is required for initial setup');
      return;
    }

    try {
      setSaving(true);

      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
        app_secret: appSecret.trim() || null,
        pin: pin.trim() || null,
        // Idempotência (§5): com o id, o salvamento atualiza ESTE
        // número. Sem ele a rota ainda acerta pelo `phone_number_id`.
        ...(channelId ? { channel_id: channelId } : {}),
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        toast.error('Please re-enter the Access Token to save changes');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        setSaving(false);
        return;
      }

      if (data.registered === false && data.registration_error) {
        toast.error(
          `Saved, but Meta couldn't register the number: ${data.registration_error}`,
          { duration: 12000 }
        );
        // PIN preservado de propósito: o registro falhou e o caminho de
        // retry é digitar (ou corrigir) o PIN e salvar de novo — limpar
        // aqui faria o usuário redigitar um PIN de vida curta à toa.
      } else if (data.registration_skipped) {
        toast.success(
          'Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.',
          { duration: 10000 }
        );
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Live — ${data.phone_info.verified_name} can now receive events.`
            : 'WhatsApp connected. Events will start flowing within a minute.'
        );
        // Limpa para que um próximo salvamento não re-registre sem
        // querer (o que anularia a inscrição ativa se o PIN estiver
        // vencido).
        setPin('');
      }

      const wasNew = !channelId;
      const newChannelId = data.channel_id as string;
      setChannelId(newChannelId);
      await refreshMetadata(newChannelId);
      await probeNow(newChannelId);
      if (wasNew) onCreated(newChannelId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch(
        channelId
          ? `/api/whatsapp/config?channel_id=${encodeURIComponent(channelId)}`
          : '/api/whatsapp/config',
        { method: 'GET', cache: 'no-store' }
      );
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `Connected to ${payload.phone_info.verified_name}`
            : 'API connection successful'
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(
          payload.needs_reset
            ? 'token_corrupted'
            : payload.reason === 'meta_api_error'
              ? 'meta_api_error'
              : null
        );
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'API connection failed');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch(
        channelId
          ? `/api/whatsapp/config/verify-registration?channel_id=${encodeURIComponent(channelId)}`
          : '/api/whatsapp/config/verify-registration',
        { method: 'GET' }
      );
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success('Number is fully wired — Meta is delivering events.');
      } else {
        toast.error(
          'Number is not fully registered. See the checks below for which step failed.',
          { duration: 8000 }
        );
      }
      if (channelId) await refreshMetadata(channelId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Could not reach the verification endpoint.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!channelId) {
      toast.error('No number to reset yet.');
      return;
    }
    if (
      !confirm(
        'This clears the stored credentials so you can re-enter them. Conversation history, cooldown and messaging tier are preserved. Continue?'
      )
    ) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch(
        `/api/whatsapp/config?channel_id=${encodeURIComponent(channelId)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success(
        data.outcome === 'deleted'
          ? 'Configuration cleared. You can now re-enter your credentials.'
          : 'Credentials cleared. Conversation history was preserved — save the number again to reconnect it.'
      );
      onDeleted();
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  /**
   * Anti-fadiga (SPEC 044 §6.2), por número (SPEC 064 D-4). Escreve
   * direto em `whatsapp_config` — a policy `whatsapp_config_update`
   * (017) já é admin+, então não há motivo para passar pela rota cheia
   * de POST /api/whatsapp/config (que reverifica credenciais com a Meta
   * a cada chamada) só para trocar um número.
   */
  async function handleSaveCooldown() {
    if (!accountId || !channelId) return;
    const parsed = Number(cooldownDaysInput);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 90) {
      toast.error(t('cooldown.invalid'));
      return;
    }

    setSavingCooldown(true);
    // Por CANAL, não por conta (D-4): `.eq('account_id')` escreveria o
    // cooldown de um número na linha do outro assim que a conta tiver
    // dois. O `account_id` fica junto como escopo, não como chave.
    const { error } = await supabase
      .from('whatsapp_config')
      .update({ broadcast_cooldown_days: parsed })
      .eq('channel_id', channelId)
      .eq('account_id', accountId);
    setSavingCooldown(false);

    if (error) {
      console.error('Save cooldown error:', error);
      toast.error(t('cooldown.saveFailed'));
      return;
    }

    setConfig((prev) =>
      prev ? { ...prev, broadcast_cooldown_days: parsed } : prev
    );
    toast.success(t('cooldown.saveSuccess'));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="border-amber-600/40 bg-amber-950/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" />
              <div className="flex-1">
                <AlertTitle className="mb-1 text-amber-200">
                  Stored token can&apos;t be decrypted
                </AlertTitle>
                <AlertDescription className="text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 text-white hover:bg-amber-700"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('resetting')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('resetConfig')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="text-primary size-4" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected'
                ? t('credentialsValid')
                : t('notConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? t('connectedDesc')
              : statusMessage || t('notConnectedDesc')}
          </AlertDescription>
        </Alert>

        {/* Registration Status */}
        {config && (
          <Alert
            className={
              isRegistered
                ? 'border-emerald-700/50 bg-emerald-950/30'
                : 'border-amber-700/50 bg-amber-950/30'
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' +
                    (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                  }
                >
                  {isRegistered ? t('registered') : t('notRegistered')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border text-foreground hover:bg-muted h-7 bg-transparent"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('verifyWithMeta')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <span
                  dangerouslySetInnerHTML={{
                    __html: t('subscribedSince', {
                      date: config.registered_at
                        ? new Date(config.registered_at).toLocaleString()
                        : t('unknownDate'),
                    }),
                  }}
                />
              ) : lastRegistrationError ? (
                <>
                  {t('lastAttemptFailed')}
                  <span className="text-red-300">
                    &quot;{lastRegistrationError}&quot;
                  </span>
                  . {t('retryHint')}
                </>
              ) : (
                <>{t('noRegistrationHint')}</>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="border-border bg-card/60 mt-3 space-y-1.5 rounded border px-3 py-2 text-[11px]">
                <p className="text-foreground font-medium">
                  {t('diagnosticLastRun')}
                  <span
                    className={
                      registrationProbe.live
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }
                  >
                    {registrationProbe.live ? t('live') : t('notLive')}
                  </span>
                </p>
                <ul className="text-muted-foreground space-y-0.5">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 shrink-0 text-emerald-400" />
                      ) : v === false ? (
                        <XCircle className="size-3 shrink-0 text-red-400" />
                      ) : (
                        <span className="border-border size-3 shrink-0 rounded-full border" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="space-y-0.5 pt-1 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* Status de envio e consumo (SPEC 076) — some sozinho com o flag
            desligado; número ainda não salvo não tem canal para consultar. */}
        {channelId && (
          <WhatsAppBillingCard
            channelId={channelId}
            canEditSettings={canEditSettings}
          />
        )}

        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">
              {t('apiCredentialsTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('apiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('phoneNumberId')}
              </Label>
              <Input
                placeholder="e.g. 100234567890123"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('wabaId')}</Label>
              <Input
                placeholder="e.g. 100234567890456"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('accessToken')}
              </Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 transition-colors"
                >
                  {showToken ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-muted-foreground text-xs">
                  {t('tokenHidden')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('webhookVerifyToken')}
              </Label>
              <Input
                placeholder={t('webhookVerifyTokenPlaceholder')}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-muted-foreground text-xs">
                {t('webhookVerifyTokenHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('appSecret')}
                <span className="text-muted-foreground ml-1">
                  {t('optional')}
                </span>
              </Label>
              <div className="relative">
                <Input
                  type={showAppSecret ? 'text' : 'password'}
                  placeholder={t('appSecretPlaceholder')}
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowAppSecret(!showAppSecret)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 transition-colors"
                >
                  {showAppSecret ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t('appSecretHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('twoStepPin')}
                <span className="text-muted-foreground ml-1">
                  {t('optional')}
                </span>
              </Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('pinPlaceholder')}
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                <span dangerouslySetInnerHTML={{ __html: t('pinHint') }} />
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Webhook URL */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">
              {t('webhookTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhookDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Cooldown / anti-fadiga (SPEC 044 §6.2) */}
        {config && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground flex items-center gap-2">
                <Timer className="text-primary size-4" />
                {t('cooldown.title')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('cooldown.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:max-w-xs">
                <Label className="text-muted-foreground">
                  {t('cooldown.label')}
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={90}
                  step={1}
                  value={cooldownDaysInput}
                  onChange={(e) => setCooldownDaysInput(e.target.value)}
                  disabled={!canEditSettings}
                  className="bg-muted border-border text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                />
                <p className="text-muted-foreground text-xs">
                  {t('cooldown.hint')}
                </p>
                {!canEditSettings && (
                  <p className="text-muted-foreground text-xs">
                    {t('cooldown.adminOnlyHint')}
                  </p>
                )}
              </div>
              {canEditSettings && (
                <Button
                  onClick={handleSaveCooldown}
                  disabled={
                    savingCooldown ||
                    cooldownDaysInput ===
                      String(config.broadcast_cooldown_days ?? 7)
                  }
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {savingCooldown ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('cooldown.saving')}
                    </>
                  ) : (
                    t('cooldown.save')
                  )}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveConfig')
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('testing')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('testConnection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:bg-red-950/40 hover:text-red-300"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">
              {t('setupInstructions')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('setupInstructionsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                      1
                    </span>
                    {t('step1')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-inside list-decimal space-y-1 text-sm">
                    <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                    <li>{t('step1_2')}</li>
                    <li>{t('step1_3')}</li>
                    <li>{t('step1_4')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                      2
                    </span>
                    {t('step2')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-inside list-decimal space-y-1 text-sm">
                    <li>{t('step2_1')}</li>
                    <li>{t('step2_2')}</li>
                    <li>{t('step2_3')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                      3
                    </span>
                    {t('step3')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-inside list-decimal space-y-1 text-sm">
                    <li>{t('step3_1')}</li>
                    <li>{t.rich('step3_2', richStrong)}</li>
                    <li>{t.rich('step3_3', richStrong)}</li>
                    <li>{t.rich('step3_4', richStrong)}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                      4
                    </span>
                    {t('step4')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-inside list-decimal space-y-1 text-sm">
                    <li>{t('step4_1')}</li>
                    <li>{t('step4_2')}</li>
                    <li>{t.rich('step4_3', richStrong)}</li>
                    <li>{t.rich('step4_4', richStrong)}</li>
                    <li>{t('step4_5')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="border-border mt-4 border-t pt-4">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:text-primary/80 inline-flex items-center gap-1.5 text-sm transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('metaDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
