'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { CustomField, MessageTemplate, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  RefreshCw,
  Users,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  isImportSource,
  useAudienceSourceOptions,
  type AudienceSourceId,
} from './audience/audience-source-options';
import { AudienceImportSummary } from './audience/audience-import-summary';
import { GoogleSheetsSource } from '@/components/import/google-sheets-source';
import { ImportSourcePicker } from '@/components/import/import-source-picker';
import { SpreadsheetTemplateHint } from '@/components/import/spreadsheet-template-hint';
import { SpreadsheetDropzone } from '@/components/import/spreadsheet-dropzone';
import { QuotaMeter, exceedsQuota } from './quota-meter';
import { useMessagingLimit } from './messaging-limit-provider';
import { useSpreadsheetParser } from '@/hooks/use-spreadsheet-parser';
import { estimateAudience } from '@/lib/audience/estimate';
import { excludesOptedOut } from '@/lib/contacts/consent';
import type {
  AudienceConfig,
  CustomFieldFilter,
  CustomFieldOperator,
} from '@/lib/audience/estimate';
import { toCsvContacts } from '@/lib/audience/normalize';
import type { NormalizedAudience } from '@/lib/audience/types';
import { saveStageSummary } from '@/lib/audience/stage-summary-storage';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCheckInstances } from '@/lib/evolution/use-check-instances';
import {
  describeDraftAudience,
  type DraftAudienceDescription,
  type DraftAudienceSummary,
} from '@/lib/broadcasts/draft';

/**
 * Fonte visível na UI (§3.1), mais estreita que `AudienceConfig['type']`:
 * `'staged'` só existe DEPOIS da triagem e nunca é uma escolha deste
 * passo — este componente sempre parte de uma das seis fontes da §2.
 */
type AudienceType = Exclude<AudienceConfig['type'], 'staged'>;

/** Códigos tipados de `/api/broadcasts/audience/stage` → chaves de i18n. */
const STAGE_ERROR_CODES = new Set([
  'template_not_found',
  'too_many_rows',
  'empty_audience',
  'bad_request',
  'internal',
  // SPEC 070 §5.2 — troca de audiência de um rascunho existente.
  'draft_not_found',
  'restage_failed',
]);

interface Step2Props {
  /** Escolhido no passo 1 — obrigatório para gravar o rascunho no stage. */
  template: MessageTemplate;
  /**
   * Canal escolhido no passo "Enviar por" (SPEC 065 D-1) — grava junto do
   * rascunho staged, para a retomada (`new/page.tsx`) reidratar o mesmo
   * template×WABA depois. `null` = conta com um canal só.
   */
  channelId: string | null;
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onBack: () => void;
  /** SPEC 069 R6 — "checar antes de disparar". */
  checkBeforeSend: boolean;
  onCheckBeforeSendChange: (checked: boolean) => void;
  /**
   * SPEC 070 §5.1 — modo EDIÇÃO de um rascunho que já tem audiência
   * triada. O passo abre em RESUMO ("Audiência atual"), e trocar a
   * fonte é uma ação explícita, com confirmação (D-6), porque descarta
   * as linhas importadas e a seleção da triagem.
   *
   * Ausente = fluxo de criação, exatamente como antes desta SPEC.
   * Presente, `handleAnalyze` re-estagia na MESMA linha (`draftId`) em
   * vez de criar outro rascunho (§1.3).
   */
  restage?: {
    broadcastId: string;
    summary: DraftAudienceSummary;
  };
  /**
   * Avançar SEM re-estagiar — só existe em modo edição (`restage`): no
   * fluxo de criação, a única saída para frente é `handleAnalyze`, que
   * passa obrigatoriamente pela triagem.
   */
  onNext?: () => void;
}

/**
 * A fonte da UI é mais granular que o tipo que viaja para o hook de
 * envio: Google Sheets e planilha local produzem a mesma coisa (uma
 * lista importada) e ambas viram `'csv'`. Manter o tipo do wire
 * inalterado é o que permite não tocar em `useBroadcastSending`.
 */
function toAudienceType(source: AudienceSourceId): AudienceType {
  return isImportSource(source) ? 'csv' : (source as AudienceType);
}

/**
 * Reconstrói a fonte da UI ao voltar de outro passo do wizard.
 *
 * `'staged'` não tem fonte de UI própria — na prática este componente
 * nunca é montado com uma audiência já staged (a §3.3 redireciona de
 * volta para a triagem em vez de reabrir este passo), mas o tipo largo
 * de `AudienceConfig` exige um retorno válido mesmo assim. `'all'` é o
 * fallback mais seguro: nunca fica com um filtro escondido pré-marcado.
 *
 * `'contact_ids'` (SPEC 069 R6) cai no mesmo fallback pelo mesmo
 * motivo, e por um a mais: ele é construído SÓ pelo servidor, no
 * disparo parcial, e nunca é persistido em `audience_filter` — então
 * este passo não tem como recebê-lo de volta. Está aqui porque o tipo
 * permite, não porque acontece.
 */
function initialSource(audience: AudienceConfig): AudienceSourceId {
  if (audience.type === 'csv') return 'spreadsheet';
  if (audience.type === 'staged' || audience.type === 'contact_ids') {
    return 'all';
  }
  return audience.type;
}

/**
 * Descritor puro (`describeDraftAudience`, SPEC 070 §3.3) → texto da
 * tela. A resolução de NOMES (etiqueta, campo personalizado) mora aqui
 * de propósito: é este componente que já carregou as duas listas, e é o
 * que mantém a função de `lib/` pura e testável sem i18n nem banco.
 */
function currentAudienceLabel(
  description: DraftAudienceDescription,
  deps: {
    tAudience: ReturnType<typeof useTranslations>;
    tags: Tag[];
    customFields: CustomField[];
    operatorLabels: { value: CustomFieldOperator; label: string }[];
  }
): string {
  const { tAudience, tags, customFields, operatorLabels } = deps;

  switch (description.key) {
    case 'tags': {
      // Uma etiqueta apagada depois do rascunho não tem nome para
      // mostrar — o id cru diria menos do que nada, então some da lista.
      const names = description.tagIds
        .map((id) => tags.find((tag) => tag.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return tAudience('current.tags', {
        names: names.length > 0 ? names.join(', ') : '—',
      });
    }
    case 'customField': {
      const field = customFields.find((f) => f.id === description.fieldId);
      return tAudience('current.customField', {
        field: field?.field_name ?? '—',
        operator:
          operatorLabels.find((o) => o.value === description.operator)?.label ??
          description.operator,
        value: description.value,
      });
    }
    case 'imported':
      return tAudience('current.imported', {
        selected: description.selected,
        total: description.total,
      });
    case 'staged':
      return tAudience('current.staged', {
        selected: description.selected,
        total: description.total,
      });
    case 'empty':
      return tAudience('current.empty');
  }
}

export function Step2SelectAudience({
  template,
  channelId,
  audience,
  onUpdate,
  onBack,
  checkBeforeSend,
  onCheckBeforeSendChange,
  restage,
  onNext,
}: Step2Props) {
  const router = useRouter();
  const t = useTranslations('Broadcasts.wizard');
  const tAudience = useTranslations('Broadcasts.audience');
  const tCheck = useTranslations('Contacts.check');
  const tParseError = useTranslations('Import.parseError');
  const tStageError = useTranslations('Broadcasts.audience.stageError');
  const sourceOptions = useAudienceSourceOptions();
  const { instances: checkInstances, loading: checkInstancesLoading } =
    useCheckInstances();

  const OPERATOR_OPTIONS = useMemo<
    { value: CustomFieldOperator; label: string }[]
  >(
    () => [
      { value: 'is', label: t('selectAudience.operatorIs') },
      { value: 'is_not', label: t('selectAudience.operatorIsNot') },
      { value: 'contains', label: t('selectAudience.operatorContains') },
    ],
    [t]
  );

  const [source, setSource] = useState<AudienceSourceId>(() =>
    initialSource(audience)
  );
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);

  // Estado da importação. `imported` guarda o resultado normalizado
  // para o resumo; `audience.csvContacts` guarda a forma reduzida que
  // o envio consome.
  const [file, setFile] = useState<File | null>(null);
  const [imported, setImported] = useState<NormalizedAudience | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | undefined>();
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [sheetsErrorCode, setSheetsErrorCode] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);

  // SPEC 070 §5.1 — enquanto `false`, o passo mostra só o resumo da
  // audiência atual; `true` revela o seletor de fontes normal. É estado
  // LOCAL de propósito: cancelar a troca não pode ter mexido em nada no
  // rascunho, e uma flag no pai daria a impressão de que já mexeu.
  const [switchingAudience, setSwitchingAudience] = useState(false);
  const [confirmRestage, setConfirmRestage] = useState(false);

  const parser = useSpreadsheetParser();
  const { batchLimit, loading: quotaLoading } = useMessagingLimit();

  // Tags alimentam tanto o filtro por etiqueta quanto a lista de
  // exclusão (que vale para qualquer fonte) — carregar sempre.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data } = await supabase.from('tags').select('*').order('name');
        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  useEffect(() => {
    // Em modo edição o resumo pode precisar do NOME do campo mesmo sem
    // a fonte "campo personalizado" estar escolhida no seletor (que nem
    // aparece enquanto o passo está em resumo).
    if (source !== 'custom_field' && audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [source, audience.type]);

  // ── Resultado do parser → estado do wizard ────────────────────
  useEffect(() => {
    if (!parser.result) return;
    setImported(parser.result.audience);
    setActiveSheet(parser.result.sheetName);
    onUpdate({
      ...audience,
      type: 'csv',
      tagIds: undefined,
      customField: undefined,
      csvContacts: toCsvContacts(parser.result.audience),
    });
    // `audience`/`onUpdate` mudam de identidade a cada render do pai;
    // depender deles reentraria em laço. O gatilho é o resultado novo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parser.result]);

  // ── Estimativa unificada ──────────────────────────────────────
  // `excludeOptedOut` segue a categoria do template escolhido no passo 1
  // (§6.8): mesma regra do passo 4 e do envio, para o alcance não mudar
  // de valor entre as telas.
  const fetchEstimate = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();
      setEstimatedCount(
        await estimateAudience(supabase, audience, {
          excludeOptedOut: excludesOptedOut(template.category),
          // Não depende da categoria do template (§6.4) — sempre true.
          excludeInvalidWhatsapp: true,
        })
      );
    } finally {
      setLoadingCount(false);
    }
  }, [audience, template.category]);

  useEffect(() => {
    fetchEstimate();
  }, [fetchEstimate]);

  // ── Ações ─────────────────────────────────────────────────────
  function handleSourceChange(next: AudienceSourceId) {
    setSource(next);
    setSheetsErrorCode(null);

    // Trocar de fonte limpa o que pertencia à anterior — senão uma
    // configuração órfã segue viajando para o passo 4.
    const type = toAudienceType(next);
    const keepsImport = isImportSource(next);
    if (!keepsImport) {
      setFile(null);
      setImported(null);
      setActiveSheet(undefined);
      parser.reset();
    }

    onUpdate({
      ...audience,
      type,
      tagIds: next === 'tags' ? audience.tagIds : undefined,
      customField: next === 'custom_field' ? audience.customField : undefined,
      csvContacts: keepsImport ? audience.csvContacts : undefined,
    });
  }

  function handleFileSelected(selected: File) {
    setFile(selected);
    setImported(null);
    setActiveSheet(undefined);
    parser.parseFile(selected);
  }

  function handleClearFile() {
    setFile(null);
    setImported(null);
    setActiveSheet(undefined);
    parser.reset();
    onUpdate({ ...audience, csvContacts: undefined });
  }

  function handleSheetChange(name: string) {
    if (!file) return;
    setActiveSheet(name);
    parser.parseFile(file, { sheetName: name });
  }

  async function handleSheetsImport(url: string) {
    setSheetsLoading(true);
    setSheetsErrorCode(null);
    setImported(null);
    try {
      const res = await fetch('/api/import/google-sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSheetsErrorCode(body.code ?? 'fetch_failed');
        return;
      }

      // O CSV baixado segue o mesmo caminho de um arquivo local —
      // uma única implementação de parsing para as três fontes.
      await parser.parseCsvText(await res.text());
    } catch {
      setSheetsErrorCode('fetch_failed');
    } finally {
      setSheetsLoading(false);
    }
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    onUpdate({
      ...audience,
      tagIds: current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId],
    });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    onUpdate({
      ...audience,
      excludeTagIds: current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId],
    });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  /**
   * "Analisar audiência" — grava o rascunho staged e leva para a
   * triagem roteada (SPEC 044 §3.3). Todas as seis fontes passam por
   * aqui: quem resolve o filtro em linhas é sempre o servidor, nunca o
   * navegador, pelo mesmo motivo do `/api/broadcasts/send` (§6.1).
   */
  async function handleAnalyze() {
    setStaging(true);
    try {
      const audienceBody = isImportSource(source)
        ? {
            type: 'csv' as const,
            rows: imported?.rows ?? [],
            invalidRows: imported?.invalid ?? [],
          }
        : source === 'tags'
          ? {
              type: 'tags' as const,
              tagIds: audience.tagIds ?? [],
              excludeTagIds: audience.excludeTagIds,
            }
          : source === 'custom_field'
            ? {
                type: 'custom_field' as const,
                customField: audience.customField,
                excludeTagIds: audience.excludeTagIds,
              }
            : { type: 'all' as const, excludeTagIds: audience.excludeTagIds };

      const res = await fetch('/api/broadcasts/audience/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateName: template.name,
          templateLanguage: template.language ?? 'en_US',
          audience: audienceBody,
          channelId: channelId ?? undefined,
          // SPEC 070 §5.2 — re-estagia na MESMA linha quando o passo
          // está editando um rascunho; ausente, cria um rascunho novo.
          draftId: restage?.broadcastId,
        }),
      });

      if (res.status === 429) {
        toast.error(tStageError('rate_limited'));
        return;
      }

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const code = typeof data?.code === 'string' ? data.code : 'internal';
        toast.error(
          STAGE_ERROR_CODES.has(code)
            ? tStageError(code)
            : tStageError('internal')
        );
        return;
      }

      if (typeof data?.draftId !== 'string') {
        toast.error(tStageError('internal'));
        return;
      }

      if (data.summary) {
        // SPEC 057 F6 — a triagem lê isto para o aviso "estes contatos
        // serão salvos" (projeção D-7, nunca escrita aqui).
        saveStageSummary(data.draftId, data.summary);
      }

      // Achado de code review (SPEC 070) — `?from=edit` diz à triagem
      // para onde voltar. Sem isto, "Continuar" sempre mandava para
      // `/broadcasts/new?draftId=…` (o fluxo de CRIAÇÃO), tirando o
      // usuário do modo edição no meio de uma campanha real, e
      // "Descartar rascunho" apagava essa campanha inteira em vez de só
      // cancelar a troca de audiência.
      router.push(
        `/broadcasts/new/${data.draftId}/triage${restage ? '?from=edit' : ''}`
      );
    } catch {
      toast.error(tStageError('internal'));
    } finally {
      setStaging(false);
    }
  }

  // ── Validação ─────────────────────────────────────────────────
  const selectedCount = estimatedCount ?? 0;
  const overQuota = exceedsQuota(selectedCount, batchLimit);

  const hasAudience =
    source === 'all' ||
    (source === 'tags' && (audience.tagIds?.length ?? 0) > 0) ||
    (source === 'custom_field' &&
      !!audience.customField?.fieldId &&
      (audience.customField?.value.length ?? 0) > 0) ||
    (isImportSource(source) && (audience.csvContacts?.length ?? 0) > 0);

  // A cota é bloqueio de UX aqui; o servidor revalida no stage e no envio.
  const canContinue =
    hasAudience && !overQuota && !parser.parsing && !sheetsLoading && !staging;

  // ── Modo edição: resumo da audiência atual (SPEC 070 §5.1) ──────
  const restageConfirmDialog = restage ? (
    <Dialog open={confirmRestage} onOpenChange={setConfirmRestage}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {tAudience('restage.confirmTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {tAudience('restage.confirmBody', { rows: restage.summary.total })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setConfirmRestage(false)}
            className="border-border text-muted-foreground"
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={() => {
              setConfirmRestage(false);
              setSwitchingAudience(true);
            }}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {tAudience('restage.button')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  if (restage && !switchingAudience) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-foreground text-lg font-semibold">
            {t('selectAudience.title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('selectAudience.subtitle')}
          </p>
        </div>

        <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
          <p className="text-foreground text-sm font-medium">
            {tAudience('current.title')}
          </p>
          <p className="text-muted-foreground text-sm">
            {currentAudienceLabel(
              describeDraftAudience(audience, restage.summary),
              {
                tAudience,
                tags,
                customFields,
                operatorLabels: OPERATOR_OPTIONS,
              }
            )}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="outline"
              onClick={() =>
                router.push(
                  `/broadcasts/new/${restage.broadcastId}/triage?from=edit`
                )
              }
              className="border-border text-muted-foreground"
            >
              <Users className="h-4 w-4" />
              {tAudience('restage.reviewTriage')}
            </Button>
            <Button
              variant="outline"
              onClick={() => setConfirmRestage(true)}
              className="border-border text-muted-foreground"
            >
              <RefreshCw className="h-4 w-4" />
              {tAudience('restage.button')}
            </Button>
          </div>
        </div>

        {/* SPEC 069 R6 — a checagem é decisão desta etapa nos dois
            modos; trocá-la não exige re-estagiar nada. */}
        <div className="border-border bg-card/50 space-y-1.5 rounded-xl border p-4">
          <div className="flex items-start gap-2">
            <Checkbox
              id="check-before-send-edit"
              checked={checkBeforeSend}
              disabled={checkInstancesLoading || checkInstances.length === 0}
              onCheckedChange={(checked) =>
                onCheckBeforeSendChange(checked === true)
              }
            />
            <label
              htmlFor="check-before-send-edit"
              className="text-foreground text-sm leading-tight"
            >
              {tCheck('enqueueLabel')}
            </label>
          </div>
          <p className="text-muted-foreground pl-6 text-xs">
            {checkInstances.length === 0 && !checkInstancesLoading
              ? tCheck('enqueueDisabledNoInstance')
              : tCheck('enqueueHint')}
          </p>
        </div>

        <div className="border-border flex items-center justify-between border-t pt-4">
          <Button
            variant="outline"
            onClick={onBack}
            className="border-border text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('back')}
          </Button>
          <Button
            onClick={onNext}
            disabled={!onNext}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <ArrowRight className="h-4 w-4" />
            {t('next')}
          </Button>
        </div>

        {restageConfirmDialog}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('selectAudience.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('selectAudience.subtitle')}
        </p>
      </div>

      <ImportSourcePicker
        value={source}
        onChange={handleSourceChange}
        options={sourceOptions}
        recommendedLabel={tAudience('source.recommended')}
      />

      {/* Modelo + colunas aceitas. Vem ANTES do campo de upload de
          propósito: quem chega aqui sem planilha pronta baixa o modelo
          em vez de descobrir o formato pelo erro de parsing. */}
      {isImportSource(source) && (
        <SpreadsheetTemplateHint
          namespace="Broadcasts.audience.template"
          showTagsNote
          showHeaderNote
          // Sem showTagCreationNote: a audiência de disparo não cria
          // etiqueta a partir da planilha (SPEC 052 §5.3) — mostrar a
          // nota aqui seria informar uma regra que não existe.
        />
      )}

      {/* ── Google Sheets ─────────────────────────────────────── */}
      {source === 'google_sheets' && (
        <GoogleSheetsSource
          onImport={handleSheetsImport}
          loading={sheetsLoading || parser.parsing}
          errorCode={sheetsErrorCode}
        />
      )}

      {/* ── Planilha local ────────────────────────────────────── */}
      {source === 'spreadsheet' && (
        <SpreadsheetDropzone
          file={file}
          parsing={parser.parsing}
          progress={parser.progress}
          onFileSelected={handleFileSelected}
          onClear={handleClearFile}
          sheetNames={parser.result?.sheetNames ?? parser.error?.sheetNames}
          activeSheet={activeSheet}
          onSheetChange={handleSheetChange}
        />
      )}

      {/* Erro de parsing vale para as duas fontes importadas. */}
      {isImportSource(source) && parser.error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {tParseError(parser.error.code, parser.error.meta ?? {})}
        </div>
      )}

      {isImportSource(source) && imported && (
        <AudienceImportSummary
          audience={imported}
          sheetName={
            source === 'spreadsheet' ? parser.result?.sheetName : undefined
          }
        />
      )}

      {/* ── Etiquetas ─────────────────────────────────────────── */}
      {source === 'tags' && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <p className="text-foreground mb-3 text-sm font-medium">
            {t('selectAudience.selectTags')}
          </p>
          {loadingTags ? (
            <Loader2 className="text-primary h-5 w-5 animate-spin" />
          ) : tags.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('selectAudience.noTagsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:border-border'
                    }`}
                  >
                    <span
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Campo personalizado ───────────────────────────────── */}
      {source === 'custom_field' && (
        <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
          <p className="text-foreground text-sm font-medium">
            {t('selectAudience.method.customField')}
          </p>
          {loadingFields ? (
            <Loader2 className="text-primary h-5 w-5 animate-spin" />
          ) : customFields.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('selectAudience.errorLoadFields')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
              >
                <option value="">{t('selectAudience.selectField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
              >
                {OPERATOR_OPTIONS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder={t('selectAudience.valuePlaceholder')}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
              />
            </div>
          )}
        </div>
      )}

      {/* ── Exclusão por etiqueta (vale para qualquer fonte) ───── */}
      <div className="border-border bg-card/50 rounded-xl border p-4">
        <div className="mb-3 flex items-center gap-2">
          <X className="h-4 w-4 text-red-400" />
          <p className="text-foreground text-sm font-medium">
            {t('selectAudience.excludeTags')}
          </p>
        </div>
        {tags.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            {t('selectAudience.noTagsFound')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded = audience.excludeTagIds?.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleExcludeTag(tag.id)}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isExcluded
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-border bg-muted text-muted-foreground hover:border-border'
                  }`}
                >
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
        {isImportSource(source) && (
          <p className="text-muted-foreground mt-2 text-xs">
            {tAudience('excludeNotAppliedToImport')}
          </p>
        )}
      </div>

      {/* ── Cota da Meta ──────────────────────────────────────── */}
      <QuotaMeter selected={selectedCount} />

      {/* ── Resumo do alcance ─────────────────────────────────── */}
      <div className="border-border bg-card/50 rounded-xl border p-4">
        <p className="text-foreground mb-2 text-sm font-medium">
          {tAudience('estimate.title')}
        </p>
        {loadingCount ? (
          <div className="flex items-center gap-2">
            <Loader2 className="text-primary h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-xs">
              {tAudience('estimate.calculating')}
            </span>
          </div>
        ) : estimatedCount !== null ? (
          <div className="flex items-center gap-2">
            <Users className="text-primary h-4 w-4" />
            <span className="text-foreground text-sm">
              {estimatedCount.toLocaleString()}
            </span>
            <span className="text-muted-foreground text-xs">
              {tAudience('estimate.recipients')}
            </span>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            {tAudience('estimate.empty')}
          </p>
        )}
      </div>

      {/* ── Checar antes de disparar (SPEC 069 R6) ───────────────── */}
      <div className="border-border bg-card/50 space-y-1.5 rounded-xl border p-4">
        <div className="flex items-start gap-2">
          <Checkbox
            id="check-before-send"
            checked={checkBeforeSend}
            disabled={checkInstancesLoading || checkInstances.length === 0}
            onCheckedChange={(checked) =>
              onCheckBeforeSendChange(checked === true)
            }
          />
          <label
            htmlFor="check-before-send"
            className="text-foreground text-sm leading-tight"
          >
            {tCheck('enqueueLabel')}
          </label>
        </div>
        <p className="text-muted-foreground pl-6 text-xs">
          {checkInstances.length === 0 && !checkInstancesLoading
            ? tCheck('enqueueDisabledNoInstance')
            : tCheck('enqueueHint')}
        </p>
      </div>

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={handleAnalyze}
          disabled={!canContinue || quotaLoading}
          title={overQuota ? tAudience('quota.blockedHint') : undefined}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {staging ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="h-4 w-4" />
          )}
          {t('selectAudience.analyze')}
        </Button>
      </div>
    </div>
  );
}
