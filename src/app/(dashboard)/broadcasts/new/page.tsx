'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { MessageTemplate } from '@/types';
import { Step0ChooseChannel } from '@/components/broadcasts/step0-choose-channel';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import {
  Step4ScheduleSend,
  type SendOptions,
} from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { AB_DEFAULT_SPLIT_PERCENT } from '@/lib/broadcasts/ab-test';
import type { AudienceConfig } from '@/lib/audience/estimate';
import { Check, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { accountCapabilityCoverage } from '@/lib/channels/capabilities';
import { selectableChannels } from '@/lib/channels/selectable';
import type { ChannelType } from '@/lib/channels/types';
import {
  findTemplateRowForWaba,
  wabaIdOfChannel,
} from '@/lib/whatsapp/template-waba';

/**
 * Os passos do assistente, na ordem fixa (SPEC 065 D-1). `'sendFrom'` só
 * é MONTADO com dois ou mais canais elegíveis — com um canal só, ele
 * nunca entra em `visibleStepKeys` e o assistente segue com quatro
 * etapas, exatamente como antes desta SPEC.
 *
 * Navegar por CHAVE, não por índice numérico, é o que evita o
 * off-by-one: `eligibleChannels` só termina de carregar depois do
 * primeiro render, então um índice fixo (0/1/2/3) apontaria para o
 * passo errado assim que a lista chegasse e o passo "Enviar por"
 * aparecesse ou sumisse.
 */
type StepKey = 'sendFrom' | 'template' | 'audience' | 'personalize' | 'send';
const ALL_STEP_KEYS: StepKey[] = [
  'sendFrom',
  'template',
  'audience',
  'personalize',
  'send',
];

interface DraftRow {
  id: string;
  status: string;
  template_name: string;
  template_language: string;
  channel_id: string | null;
}

export default function NewBroadcastPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resumeDraftId = searchParams.get('draftId');
  const t = useTranslations('Broadcasts.new');
  const tWizard = useTranslations('Broadcasts.wizard');
  const tAudience = useTranslations('Broadcasts.audience');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } =
    useBroadcastSending();

  // SPEC 049 §5.3 — step 1 of the wizard, not a server error at step 4:
  // an account whose only channel is QR gets told WHY before it invests
  // time picking a template and an audience. `loading` avoids a false
  // "blocked" flash for the (common) case where the account simply
  // hasn't finished fetching channels yet.
  const accountChannels = useAccountChannels();
  const channelTypes: ChannelType[] =
    accountChannels.byId.size > 0
      ? Array.from(accountChannels.byId.values()).map((c) => c.type)
      : ['whatsapp_cloud'];
  const broadcastBlocked =
    !accountChannels.loading &&
    accountCapabilityCoverage(channelTypes, 'broadcast') === 'none';

  // ── "Enviar por" (SPEC 065 D-1) ─────────────────────────────────
  // Elegibilidade vem de UM lugar só — a regra que já corrigiu o bug do
  // passo 4 original (esconder o padrão quebrado atrás de "só uma
  // opção"). Nunca reescrever este filtro à mão aqui.
  const eligibleChannels = useMemo(
    () =>
      selectableChannels(
        Array.from(accountChannels.byId.values()),
        'broadcast'
      ),
    [accountChannels.byId]
  );
  const showChannelStep = eligibleChannels.length > 1;

  const [channelId, setChannelId] = useState<string | null>(null);
  // Pré-seleciona o padrão assim que a lista chega — o padrão é o mesmo
  // que o servidor escolheria de qualquer forma na ausência de escolha,
  // e é o que a SPEC descreve como "sempre aparecerá como selecionado".
  useEffect(() => {
    if (channelId || eligibleChannels.length === 0) return;
    setChannelId(eligibleChannels[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleChannels]);

  // Com um canal só, ninguém É FORÇADO a escolher — o servidor resolve o
  // padrão sozinho (mesmo comportamento de antes desta SPEC). É esta
  // variável, não `channelId` cru, que alimenta o disparo, o teste de
  // envio e o resumo do passo 4.
  const effectiveChannelId = showChannelStep ? channelId : null;

  const [currentStepKey, setCurrentStepKey] = useState<StepKey>('template');
  // Assim que os canais terminam de carregar, se a conta tem mais de um
  // e ninguém navegou ainda (ainda no passo padrão 'template'), entra
  // pelo passo novo. A checagem `prev === 'template'` torna isto
  // idempotente: não empurra para trás quem já avançou.
  useEffect(() => {
    if (resumeDraftId) return;
    if (accountChannels.loading || !showChannelStep) return;
    setCurrentStepKey((prev) => (prev === 'template' ? 'sendFrom' : prev));
  }, [accountChannels.loading, showChannelStep, resumeDraftId]);

  const visibleStepKeys = showChannelStep
    ? ALL_STEP_KEYS
    : ALL_STEP_KEYS.filter((key) => key !== 'sendFrom');
  const currentStepIndex = visibleStepKeys.indexOf(currentStepKey);

  // Retoma de um rascunho já triado (SPEC 044 §3.3): a triagem não
  // guarda `template`/`variables` — só navega de volta para cá com
  // `?draftId=`, e é aqui que o template é reidratado a partir do que
  // o stage já persistiu (`template_name`/`template_language`).
  const [resuming, setResuming] = useState(Boolean(resumeDraftId));

  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');
  // SPEC 069 R6 — "checar antes de disparar".
  const [checkBeforeSend, setCheckBeforeSend] = useState(false);

  // ── Teste A/B (SPEC 044 §6.6) ──────────────────────────────────
  // O segundo template tem os PRÓPRIOS placeholders e a própria mídia
  // de header: um mapa de variáveis compartilhado mandaria o valor
  // errado no lugar certo para metade da audiência.
  const [variantTemplate, setVariantTemplate] =
    useState<MessageTemplate | null>(null);
  const [variantVariables, setVariantVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [variantHeaderMediaUrl, setVariantHeaderMediaUrl] = useState('');
  const [splitPercent, setSplitPercent] = useState(AB_DEFAULT_SPLIT_PERCENT);

  useEffect(() => {
    if (!resumeDraftId || !accountId) return;
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('broadcasts')
        .select('id, status, template_name, template_language, channel_id')
        .eq('id', resumeDraftId)
        .maybeSingle();

      if (cancelled) return;

      const draft = data as DraftRow | null;

      if (!draft || draft.status !== 'draft') {
        toast.error(tAudience('triage.draftNotFound'));
        router.replace('/broadcasts/new');
        return;
      }

      // SPEC 065 §2.A A4 — o mesmo nome+idioma pode existir em DOIS
      // WABAs (migração 072): `.eq(name).eq(language).maybeSingle()`
      // quebra com "multiple rows" assim que o segundo WABA ganha um
      // template de mesmo nome. Resolve pelo WABA do canal GRAVADO no
      // rascunho — a mesma regra de adoção que o disparo de verdade usa.
      const wabaId = await wabaIdOfChannel(
        supabase,
        accountId,
        draft.channel_id
      );
      const templateRow = await findTemplateRowForWaba(supabase, {
        accountId,
        name: draft.template_name,
        language: draft.template_language,
        wabaId: wabaId ?? null,
      });

      if (cancelled) return;

      if (!templateRow) {
        toast.error(tAudience('triage.draftNotFound'));
        router.replace('/broadcasts/new');
        return;
      }

      setChannelId(draft.channel_id ?? null);
      setTemplate(templateRow as MessageTemplate);
      setAudience({ type: 'staged', draftId: resumeDraftId });
      setCurrentStepKey('personalize');
      setResuming(false);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeDraftId, accountId]);

  /**
   * Trocar o template A pode invalidar a variante B: ela precisa ser
   * outro template E da mesma categoria (§6.6 — categorias diferentes
   * excluem opt-out de formas diferentes, ver `planAbTestBroadcast`).
   * Limpar aqui é o que impede o wizard de carregar até o passo 4 uma
   * combinação que o servidor vai recusar.
   */
  function handleTemplateSelect(next: MessageTemplate) {
    setTemplate(next);
    if (
      variantTemplate &&
      (variantTemplate.id === next.id ||
        variantTemplate.category !== next.category)
    ) {
      handleVariantSelect(null);
    }
  }

  function handleVariantSelect(next: MessageTemplate | null) {
    setVariantTemplate(next);
    // O mapeamento pertence ao template: mantê-lo ao trocar de variante
    // reaproveitaria `{{1}}` de um texto em outro que quer outra coisa.
    setVariantVariables({});
    setVariantHeaderMediaUrl('');
  }

  /**
   * Trocar de canal no passo "Enviar por" muda o WABA — a lista de
   * templates do passo seguinte passa a ser outra. Manter um template
   * já escolhido do canal ANTERIOR reproduziria o `#132001` que o
   * filtro por canal existe para evitar (SPEC 065 §2.E), então limpa os
   * dois braços, com aviso (mesmo cuidado de `handleTemplateSelect`).
   */
  function handleChannelChange(next: string) {
    if (next === channelId) return;
    setChannelId(next);
    if (template) {
      setTemplate(null);
      handleVariantSelect(null);
      toast.warning(tWizard('chooseChannel.templateResetWarning'));
    }
  }

  /**
   * SPEC 069 R6 — em vez de disparar, cria a campanha (rascunho ou
   * agendada) e a enfileira para checagem. Caminho DELIBERADAMENTE
   * separado de `createAndSendBroadcast`: aquele resolve a audiência,
   * valida cota e dispara AGORA — exatamente o que "checar antes" não
   * pode fazer. A resolução de audiência de verdade acontece dentro
   * de `POST /api/contacts/check-queue`, a partir do `audience_filter`
   * que este INSERT grava.
   */
  async function handleSendWithCheck(options: SendOptions) {
    if (!template || !accountId) return;
    if (variantTemplate) {
      toast.error(tAudience('checkBeforeSend.noAbTest'));
      return;
    }

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }

    const { data: created, error } = await supabase
      .from('broadcasts')
      .insert({
        user_id: user.id,
        account_id: accountId,
        name: name.trim() || template.name,
        template_name: template.name,
        template_language: template.language ?? 'en_US',
        template_variables: variables,
        audience_filter: audience,
        header_media_url: headerMediaUrl || null,
        channel_id: effectiveChannelId,
        status: options.scheduledAt ? 'scheduled' : 'draft',
        scheduled_at: options.scheduledAt ?? null,
        scheduled_timezone: options.scheduledAt
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : null,
        window_override: options.windowOverride,
        total_recipients: 0,
      })
      .select('id')
      .single();

    if (error || !created) {
      toast.error(
        tAudience('checkBeforeSend.createError', {
          error: error?.message ?? 'unknown',
        })
      );
      return;
    }

    try {
      const res = await fetch('/api/contacts/check-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'broadcast',
          broadcastId: created.id,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(
          typeof body?.error === 'string'
            ? body.error
            : tAudience('checkBeforeSend.enqueueError')
        );
        // A campanha continua existindo como draft/scheduled — o
        // usuário pode reabri-la e tentar de novo, em vez de perder o
        // que já preencheu no wizard.
        router.push(`/broadcasts/${created.id}`);
        return;
      }
    } catch (err) {
      console.error('[broadcasts/new] check-queue enqueue failed:', err);
      toast.error(tAudience('checkBeforeSend.enqueueError'));
      router.push(`/broadcasts/${created.id}`);
      return;
    }

    toast.success(tAudience('checkBeforeSend.queuedToast'));
    router.push(`/broadcasts/${created.id}`);
  }

  async function handleSend(options: SendOptions) {
    if (!template) return;
    if (checkBeforeSend) {
      await handleSendWithCheck(options);
      return;
    }

    try {
      const result = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
          draftId: audience.draftId,
        },
        variables,
        headerMediaUrl,
        scheduledAt: options.scheduledAt,
        windowOverride: options.windowOverride,
        channelId: effectiveChannelId ?? undefined,
        abTest: variantTemplate
          ? {
              template: variantTemplate,
              variables: variantVariables,
              headerMediaUrl: variantHeaderMediaUrl,
              splitPercent,
            }
          : undefined,
      });

      // Agendado não tem progresso para acompanhar — a tela de detalhe
      // mostraria uma campanha parada, o que parece defeito. A lista, com
      // o status `scheduled` e a data, é a resposta certa.
      if (result.status === 'scheduled') {
        toast.success(
          tAudience('schedule.scheduledToast', {
            when: result.scheduledAt
              ? new Date(result.scheduledAt).toLocaleString()
              : '',
          })
        );
        router.push('/broadcasts');
        return;
      }

      router.push(`/broadcasts/${result.broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      // Persiste a `AudienceConfig` inteira, não só `{type, tagIds}` —
      // é o que fecha a lacuna da §1.5: sem isto, um rascunho salvo com
      // `custom_field`, uma importação ou uma triagem já feita
      // (`draftId`) perdia tudo além do tipo ao ser reaberto.
      audience_filter: audience,
      // SPEC 065 D-1 — o rascunho leva o canal escolhido, para a
      // retomada reidratar o mesmo template×WABA (ver o efeito acima).
      channel_id: effectiveChannelId,
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  if (broadcastBlocked) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="border-border bg-card flex flex-col items-center gap-4 rounded-lg border p-10 text-center">
          <ShieldAlert className="text-amber-400" size={32} />
          <h1 className="text-foreground text-lg font-semibold">
            {t('channelBlocked.title')}
          </h1>
          <p className="text-muted-foreground max-w-md text-sm">
            {t('channelBlocked.body')}
          </p>
          <Link
            href="/broadcasts"
            className="text-primary text-sm font-medium hover:underline"
          >
            {t('channelBlocked.back')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {visibleStepKeys.map((key, index) => {
          const isActive = index === currentStepIndex;
          const isCompleted = index < currentStepIndex;

          return (
            <div key={key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-primary bg-primary/10 text-primary border-2'
                        : 'border-border bg-muted text-muted-foreground border'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive
                      ? 'text-foreground'
                      : isCompleted
                        ? 'text-primary'
                        : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${key}`)}
                </span>
              </div>
              {index < visibleStepKeys.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStepIndex ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        {resuming ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div
            className="transition-all duration-300 ease-in-out"
            style={{
              opacity: isProcessing ? 0.6 : 1,
              pointerEvents: isProcessing ? 'none' : 'auto',
            }}
          >
            {currentStepKey === 'sendFrom' && (
              <Step0ChooseChannel
                channels={eligibleChannels}
                selectedChannelId={channelId}
                onSelect={handleChannelChange}
                onNext={() => setCurrentStepKey('template')}
                onBack={() => router.push('/broadcasts')}
              />
            )}
            {currentStepKey === 'template' && (
              <Step1ChooseTemplate
                channelId={channelId}
                selectedTemplate={template}
                onSelect={handleTemplateSelect}
                variantTemplate={variantTemplate}
                onVariantSelect={handleVariantSelect}
                splitPercent={splitPercent}
                onSplitPercentChange={setSplitPercent}
                onNext={() => setCurrentStepKey('audience')}
                onBack={() =>
                  showChannelStep
                    ? setCurrentStepKey('sendFrom')
                    : router.push('/broadcasts')
                }
              />
            )}
            {currentStepKey === 'audience' && template && (
              <Step2SelectAudience
                template={template}
                channelId={effectiveChannelId}
                audience={audience}
                onUpdate={setAudience}
                onBack={() => setCurrentStepKey('template')}
                checkBeforeSend={checkBeforeSend}
                onCheckBeforeSendChange={setCheckBeforeSend}
              />
            )}
            {currentStepKey === 'personalize' && template && (
              <Step3Personalize
                channelId={effectiveChannelId}
                template={template}
                variables={variables}
                onUpdate={setVariables}
                headerMediaUrl={headerMediaUrl}
                onHeaderMediaUrlChange={setHeaderMediaUrl}
                variantTemplate={variantTemplate}
                variantVariables={variantVariables}
                onVariantUpdate={setVariantVariables}
                variantHeaderMediaUrl={variantHeaderMediaUrl}
                onVariantHeaderMediaUrlChange={setVariantHeaderMediaUrl}
                onNext={() => setCurrentStepKey('send')}
                onBack={() =>
                  // Uma audiência `staged` não tem "passo audiência" para
                  // voltar — a triagem que produziu o rascunho é que faz
                  // esse papel. `setCurrentStepKey('audience')` aqui
                  // reabriria um Step2 sem a fonte original (Sheets/
                  // Excel/tags/…), então volta para a triagem em vez de
                  // reconstruir um estado que já não existe no cliente.
                  audience.type === 'staged' && audience.draftId
                    ? router.push(`/broadcasts/new/${audience.draftId}/triage`)
                    : setCurrentStepKey('audience')
                }
              />
            )}
            {currentStepKey === 'send' && template && (
              <Step4ScheduleSend
                name={name}
                onNameChange={setName}
                template={template}
                variantTemplate={variantTemplate}
                splitPercent={splitPercent}
                audience={audience}
                channel={
                  showChannelStep
                    ? (accountChannels.byId.get(channelId ?? '') ?? null)
                    : null
                }
                onChangeChannel={
                  showChannelStep
                    ? () => setCurrentStepKey('sendFrom')
                    : undefined
                }
                onSend={handleSend}
                onSaveDraft={
                  // Rascunho guarda UM template (`template_name`), então
                  // salvar um teste A/B perderia a variante B em
                  // silêncio. Some o botão em vez de mentir sobre o que
                  // foi salvo — agendar continua disponível e preserva
                  // as duas variantes (§6.6).
                  audience.type === 'staged' || variantTemplate
                    ? undefined
                    : handleSaveDraft
                }
                onBack={() => setCurrentStepKey('personalize')}
                isProcessing={isProcessing}
                progress={progress}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
