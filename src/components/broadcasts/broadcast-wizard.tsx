'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import {
  hasDraftChanges,
  loadBroadcastDraft,
  saveBroadcastDraft,
  type DraftHydration,
  type DraftSnapshot,
} from '@/lib/broadcasts/draft';
import type { AudienceConfig } from '@/lib/audience/estimate';
import { Check, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { accountCapabilityCoverage } from '@/lib/channels/capabilities';
import { selectableChannels } from '@/lib/channels/selectable';
import type { ChannelType } from '@/lib/channels/types';

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
export type StepKey =
  'sendFrom' | 'template' | 'audience' | 'personalize' | 'send';
const ALL_STEP_KEYS: StepKey[] = [
  'sendFrom',
  'template',
  'audience',
  'personalize',
  'send',
];

/**
 * `'create'` é `/broadcasts/new`; `'edit'` é `/broadcasts/[id]/edit`
 * (SPEC 070 §2). Uma implementação só, dois modos — copiar o
 * assistente para a rota de edição garantiria divergência na primeira
 * correção de bug (§2.1).
 */
export type WizardMode = 'create' | 'edit';

export interface BroadcastWizardProps {
  mode: WizardMode;
  /**
   * Retomada da triagem (`/broadcasts/new?draftId=…`, SPEC 044 §3.3).
   * Vem por prop porque `useSearchParams()` pertence à rota, não ao
   * assistente — a rota de edição não tem query nenhuma. Só o modo
   * `'create'` a usa (§2.3).
   */
  resumeDraftId?: string | null;
  /**
   * Passo em que abrir. Omitido, vale o comportamento de hoje:
   * `'template'`, promovido a `'sendFrom'` quando a conta tem dois ou
   * mais canais elegíveis.
   */
  initialStep?: StepKey;
  /**
   * Hidratação completa do rascunho (SPEC 070 §3.1) — obrigatória em
   * `'edit'`, ausente em `'create'`. `loadBroadcastDraft` já validou
   * estado e propriedade antes de a rota montar o wizard; daqui para
   * frente o `broadcastId` de `draft` é a fonte de verdade para salvar
   * (§4), nunca `audience.draftId` sozinho.
   */
  draft?: DraftHydration;
}

export function BroadcastWizard({
  mode,
  resumeDraftId: resumeDraftIdProp = null,
  initialStep,
  draft,
}: BroadcastWizardProps) {
  const router = useRouter();
  // Em `'edit'` a hidratação chega pronta (F4) — um `?draftId=` que
  // sobrasse na URL não pode reabrir o caminho da triagem por baixo dela.
  const resumeDraftId = mode === 'create' ? resumeDraftIdProp : null;
  const t = useTranslations('Broadcasts.new');
  const tEdit = useTranslations('Broadcasts.edit');
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

  const [channelId, setChannelId] = useState<string | null>(
    draft?.channelId ?? null
  );
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

  const [currentStepKey, setCurrentStepKey] = useState<StepKey>(
    initialStep ?? 'template'
  );
  // Assim que os canais terminam de carregar, se a conta tem mais de um
  // e ninguém navegou ainda (ainda no passo padrão 'template'), entra
  // pelo passo novo. A checagem `prev === 'template'` torna isto
  // idempotente: não empurra para trás quem já avançou.
  //
  // `initialStep` explícito manda mais: quem pediu um passo de entrada
  // não quer ser empurrado para "Enviar por" quando a lista de canais
  // chega — mesma razão pela qual a retomada da triagem já era exceção.
  useEffect(() => {
    if (resumeDraftId || initialStep) return;
    if (accountChannels.loading || !showChannelStep) return;
    setCurrentStepKey((prev) => (prev === 'template' ? 'sendFrom' : prev));
  }, [accountChannels.loading, showChannelStep, resumeDraftId, initialStep]);

  // Retoma de um rascunho já triado (SPEC 044 §3.3): a triagem não
  // guarda `template`/`variables` — só navega de volta para cá com
  // `?draftId=`, e é aqui que o template é reidratado a partir do que
  // o stage já persistiu (`template_name`/`template_language`).
  const [resuming, setResuming] = useState(Boolean(resumeDraftId));
  /**
   * Hidratação obtida pela retomada da triagem (`?draftId=`). Alimenta
   * exatamente o que `draft` alimenta em modo edição — resumo da
   * audiência (§5.1), aviso de template ausente (§3.1) e a linha a
   * adotar (§6.1) —, para os dois caminhos não divergirem.
   */
  const [resumedDraft, setResumedDraft] = useState<DraftHydration | null>(null);
  const openDraft = draft ?? resumedDraft;

  const [template, setTemplate] = useState<MessageTemplate | null>(
    draft?.template ?? null
  );
  const [audience, setAudience] = useState<AudienceConfig>(
    draft?.audience ?? { type: 'all' }
  );

  /**
   * SPEC 070 §5.1 (F6) — em modo edição, o passo Audiência abre em
   * RESUMO ("Audiência atual" + Rever triagem / Trocar audiência) em
   * vez do seletor de fontes, e trocar a fonte re-estagia na MESMA
   * linha. Só faz sentido quando existe audiência triada para proteger:
   * sem linhas em staging (D-12, rascunho de "checar antes" cuja fila
   * falhou), o passo abre exigindo uma escolha, como na criação.
   */
  const restage =
    openDraft && openDraft.audienceSummary.total > 0
      ? {
          broadcastId: openDraft.broadcastId,
          summary: openDraft.audienceSummary,
        }
      : undefined;

  /**
   * A linha de `broadcasts` que ESTA sessão do assistente já possui
   * (SPEC 070 §1.3, "uma campanha, uma linha"):
   *
   *   • `'edit'`   — o rascunho aberto pela rota;
   *   • `'create'` — o rascunho que a triagem criou (`audience.draftId`),
   *                  porque no fluxo de criação toda audiência passa
   *                  pelo stage antes de chegar ao passo 4.
   *
   * É ela que "Salvar" atualiza (§4) e que disparar/agendar ADOTA em vez
   * de inserir outra (§6.1).
   */
  const targetBroadcastId =
    openDraft?.broadcastId ??
    (audience.type === 'staged' ? (audience.draftId ?? null) : null);

  const visibleStepKeys = ALL_STEP_KEYS.filter((key) =>
    key === 'sendFrom' ? showChannelStep : true
  );
  const currentStepIndex = visibleStepKeys.indexOf(currentStepKey);

  // "Sair do assistente" a partir do primeiro passo visível: em
  // 'create' não há para onde voltar além da lista; em 'edit' existe
  // uma campanha de verdade por trás — volta para o detalhe dela, não
  // para a lista genérica.
  const exitHref =
    mode === 'edit' && openDraft
      ? `/broadcasts/${openDraft.broadcastId}`
      : '/broadcasts';

  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >(draft?.variables ?? {});
  const [headerMediaUrl, setHeaderMediaUrl] = useState(
    draft?.headerMediaUrl ?? ''
  );
  const [name, setName] = useState(draft?.name ?? '');
  // SPEC 069 R6 — "checar antes de disparar".
  const [checkBeforeSend, setCheckBeforeSend] = useState(
    draft?.checkBeforeSend ?? false
  );

  /**
   * "Sair da edição com alterações não salvas" (SPEC 070 §7, última
   * linha). O baseline nunca precisa avançar depois de um "Salvar
   * alterações" bem-sucedido: `handleSaveDraft` sempre navega para
   * fora do assistente ao terminar (§4), então o componente desmonta
   * antes de qualquer comparação nova acontecer. `useState(() => …)`
   * roda a função só no mount — em 'create' (sem `draft`) fica `null`
   * para sempre, e nenhuma comparação é feita.
   */
  const [savedSnapshot] = useState<DraftSnapshot | null>(() =>
    mode === 'edit' && draft
      ? {
          name: draft.name,
          templateName: draft.template?.name ?? '',
          templateLanguage: draft.template?.language ?? 'en_US',
          channelId: draft.channelId,
          audience: draft.audience,
          variables: draft.variables,
          headerMediaUrl: draft.headerMediaUrl,
          checkBeforeSend: draft.checkBeforeSend,
        }
      : null
  );
  const currentSnapshot: DraftSnapshot = {
    name,
    templateName: template?.name ?? '',
    templateLanguage: template?.language ?? 'en_US',
    // O MESMO valor que `handleSaveDraft` grava — comparar contra
    // `channelId` cru acusaria "mudou" toda vez que a conta tem um
    // canal só (`effectiveChannelId` é sempre `null` nesse caso).
    channelId: effectiveChannelId,
    audience,
    variables,
    headerMediaUrl,
    checkBeforeSend,
  };
  const isDirty = savedSnapshot
    ? hasDraftChanges(savedSnapshot, currentSnapshot)
    : false;

  // Fecha a aba / F5 / link externo com alterações no ar. Não cobre
  // navegação interna via `<Link>` (barra lateral, por exemplo) — o
  // App Router não expõe um gancho de "antes de trocar de rota" para
  // isso, e nada mais no projeto tenta (mesma lacuna documentada em
  // `flow-editor-state.tsx`). O que ESTE componente controla — os dois
  // pontos de saída do próprio assistente, `exitHref` abaixo — pede
  // confirmação via `confirmedNavigate`.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  function confirmedNavigate(href: string) {
    if (isDirty && !window.confirm(tEdit('discardChanges'))) return;
    router.push(href);
  }

  // §3.1 — "recuperável, não fatal": o template do rascunho sumiu do
  // WABA do canal, mas o resto (audiência, nome, agendamento) já
  // reidratou acima. Só derruba o aviso quando o usuário ESCOLHE um
  // template novo — `template` (não `draft.templateMissing`) é quem
  // decide se o banner ainda aparece.
  const showTemplateMissingWarning = Boolean(openDraft?.templateMissing);

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
      // SPEC 070 §2.3 — hidratação COMPLETA, a mesma da rota de edição.
      // Antes desta SPEC a retomada lia cinco colunas à mão e FORÇAVA
      // `audience = {type:'staged', draftId}` sem olhar
      // `audience_filter`. Isso era correto por acidente (toda audiência
      // passava pelo stage) e deixou de ser: um rascunho salvo (§4) ou
      // re-estagiado (§5) grava esse campo, e presumir `staged` faria a
      // volta da triagem apontar para linhas que podem ter sido
      // substituídas. `hydrateAudienceConfig` decide pelo que existe.
      const loaded = await loadBroadcastDraft(supabase, {
        accountId,
        broadcastId: resumeDraftId,
      });

      if (cancelled) return;

      if (!loaded.ok) {
        toast.error(tAudience('triage.draftNotFound'));
        router.replace('/broadcasts/new');
        return;
      }

      const hydrated = loaded.draft;

      // Template fora do WABA do canal (`templateMissing`) não derruba a
      // retomada — abre no passo Template com o aviso, preservando o que
      // já estava preenchido, como na rota de edição (§3.1).
      setChannelId(hydrated.channelId);
      setTemplate(hydrated.template);
      setAudience(hydrated.audience);
      setVariables(hydrated.variables);
      setHeaderMediaUrl(hydrated.headerMediaUrl);
      setName(hydrated.name);
      setCheckBeforeSend(hydrated.checkBeforeSend);
      setResumedDraft(hydrated);
      setCurrentStepKey(hydrated.template ? 'personalize' : 'template');
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

    const campaign = {
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
    };

    // SPEC 070 §1.3 — editando um rascunho, a campanha JÁ EXISTE: um
    // INSERT aqui criaria uma segunda linha ao lado da que o usuário
    // abriu, e a fila de checagem trabalharia na cópia. `total_recipients`
    // fica de fora do UPDATE de propósito: o valor do rascunho descreve a
    // audiência staged, e zerá-lo esconderia dela a própria audiência.
    const { data: created, error } = targetBroadcastId
      ? await supabase
          .from('broadcasts')
          .update(campaign)
          .eq('id', targetBroadcastId)
          .eq('account_id', accountId)
          .eq('status', 'draft')
          .select('id')
          .maybeSingle()
      : await supabase
          .from('broadcasts')
          .insert({
            user_id: user.id,
            account_id: accountId,
            ...campaign,
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
        // SPEC 070 §6.1 — disparar/agendar ADOTA a linha que já existe
        // (o rascunho aberto, ou o da triagem) em vez de inserir outra.
        draftId: targetBroadcastId ?? undefined,
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
   * Grava o rascunho — SEMPRE `UPDATE`, nunca um segundo `INSERT`
   * (SPEC 070 §4/§4.1, "uma campanha, uma linha"). A linha já existe
   * em ambos os modos: em `'create'` desde o stage da audiência
   * (§Contexto — "todo rascunho é um rascunho de triagem", então
   * `audience.draftId` É o id da linha); em `'edit'`, é `draft.broadcastId`,
   * o rascunho que a rota abriu.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    // Defensivo: no fluxo real de 'create', `audience` chega sempre
    // `staged` neste passo (o único jeito de avançar da Audiência é o
    // stage). Não deveria disparar — mas silenciar aqui esconderia um
    // bug de estado em vez de avisar.
    if (!targetBroadcastId) {
      toast.error(t('toastNoDraftId'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const supabase = createClient();

    // Achado de code review (SPEC 070) — sem isto, uma sessão expirada
    // no meio da edição fazia `saveBroadcastDraft` bater na RLS (0
    // linhas casadas) e devolver `draft_not_found`, que o ramo abaixo
    // trata como "esta campanha não existe mais" e NAVEGA PARA FORA —
    // descartando nome/variáveis/audiência/mídia não salvos por uma
    // mensagem que nem é verdadeira. Checar a sessão ANTES distingue
    // "não estou logado" (fica no lugar, pode reautenticar e tentar de
    // novo) de "o rascunho realmente sumiu" (aí sim, navegar é certo).
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }

    const result = await saveBroadcastDraft(supabase, {
      accountId,
      broadcastId: targetBroadcastId,
      name,
      template,
      channelId: effectiveChannelId,
      audience,
      variables,
      headerMediaUrl,
      checkBeforeSend,
    });

    if (!result.ok) {
      if (result.error === 'draft_not_found') {
        toast.error(tEdit('gone'));
        router.push('/broadcasts');
        return;
      }
      toast.error(t('toastFailedDraft', { error: 'unknown' }));
      return;
    }

    toast.success(mode === 'edit' ? tEdit('saved') : t('toastDraftSaved'));
    router.push(
      mode === 'edit' ? `/broadcasts/${targetBroadcastId}` : '/broadcasts'
    );
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
        <h1 className="text-foreground text-2xl font-bold">
          {mode === 'edit' ? tEdit('title') : t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {mode === 'edit'
            ? tEdit('subtitle', {
                name: openDraft?.name || template?.name || '',
              })
            : t('subtitle')}
        </p>
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
                onBack={() => confirmedNavigate(exitHref)}
              />
            )}
            {currentStepKey === 'template' && (
              <>
                {showTemplateMissingWarning && !template && (
                  <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                    <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <p>{tEdit('templateMissingWarning')}</p>
                  </div>
                )}
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
                      : confirmedNavigate(exitHref)
                  }
                />
              </>
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
                restage={restage}
                onNext={() => setCurrentStepKey('personalize')}
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
                onBack={() => {
                  // Em 'edit', o passo Audiência sabe se representar
                  // sozinho (resumo + "Trocar audiência", §5.1), então
                  // voltar para ele é seguro.
                  if (mode === 'edit') {
                    setCurrentStepKey('audience');
                    return;
                  }
                  // Na CRIAÇÃO, uma audiência `staged` não tem "passo
                  // audiência" para voltar — a triagem que produziu o
                  // rascunho é que faz esse papel. `setCurrentStepKey`
                  // aqui reabriria um Step2 sem a fonte original
                  // (Sheets/Excel/tags/…), então volta para a triagem em
                  // vez de reconstruir um estado que já não existe no
                  // cliente.
                  if (audience.type === 'staged' && audience.draftId) {
                    router.push(`/broadcasts/new/${audience.draftId}/triage`);
                    return;
                  }
                  setCurrentStepKey('audience');
                }}
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
                  // as duas variantes (§6.6). Fora do A/B, o botão
                  // aparece em AMBOS os modos (SPEC 070 §4.1) — em
                  // 'create' a linha já existe desde o stage
                  // (`audience.draftId`), então não há mais motivo para
                  // escondê-lo quando `audience.type === 'staged'`.
                  variantTemplate ? undefined : handleSaveDraft
                }
                saveDraftLabel={
                  mode === 'edit'
                    ? tWizard('scheduleSend.saveChanges')
                    : undefined
                }
                saveDraftHiddenReason={
                  variantTemplate
                    ? tWizard('scheduleSend.abTestNoDraft')
                    : undefined
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
