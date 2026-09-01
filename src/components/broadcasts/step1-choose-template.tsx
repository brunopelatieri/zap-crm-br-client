'use client';

import { useMemo } from 'react';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Loader2,
  FileText,
  ArrowRight,
  FlaskConical,
  AlertTriangle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AB_DEFAULT_SPLIT_PERCENT } from '@/lib/broadcasts/ab-test';
import { useChannelTemplates } from '@/hooks/use-channel-templates';

/** Divisões oferecidas. Configurável, mas não com um campo livre. */
const SPLIT_OPTIONS = [50, 60, 70, 80, 90];

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface Step1Props {
  /**
   * Canal escolhido no passo "Enviar por" (SPEC 065 D-1). `null` = conta
   * com um canal só (o passo não existe) ou canal ainda não escolhido —
   * `useChannelTemplates` responde com a lista INTEIRA nesse caso (falha
   * aberto), nunca com uma lista vazia.
   */
  channelId: string | null;
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  /**
   * Segundo template do teste A/B (SPEC 044 §6.6). `null` = disparo
   * comum, com um template só.
   */
  variantTemplate: MessageTemplate | null;
  onVariantSelect: (template: MessageTemplate | null) => void;
  /** Fatia da audiência que fica com a variante A. */
  splitPercent: number;
  onSplitPercentChange: (percent: number) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({
  channelId,
  selectedTemplate,
  onSelect,
  variantTemplate,
  onVariantSelect,
  splitPercent,
  onSplitPercentChange,
  onNext,
  onBack,
}: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const tAb = useTranslations('Broadcasts.wizard.abTest');
  // SPEC 065 D-2 — a MESMA variável que decide o `channel_id` do envio
  // filtra esta lista (§2.E). `templates` já vem só com o que este WABA
  // pode enviar (+ legados); a variante B (abaixo) herda o filtro de
  // graça, por sair da mesma lista.
  const { templates, loading, error, refetch } = useChannelTemplates(channelId);

  /**
   * Candidatos a variante B.
   *
   * Mesma categoria de propósito: o planner recusa categorias diferentes
   * (§6.6), porque marketing exclui quem pediu opt-out e Utility não —
   * um "teste" entre categorias compararia dois públicos. Filtrar aqui
   * transforma um erro no fim do wizard numa opção que nunca aparece.
   */
  const variantCandidates = useMemo(() => {
    if (!selectedTemplate) return [];
    return templates.filter(
      (candidate) =>
        candidate.id !== selectedTemplate.id &&
        candidate.category === selectedTemplate.category
    );
  }, [templates, selectedTemplate]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('chooseTemplate.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('chooseTemplate.subtitle')}
        </p>
      </div>

      {error ? (
        // Achado de code review: uma falha de leitura (RLS/rede
        // transitória) não pode parecer "esta conta não tem template
        // nenhum" — o operador criaria um duplicado achando que
        // realmente não havia nenhum.
        <div className="border-destructive/30 bg-destructive/5 flex h-48 flex-col items-center justify-center rounded-xl border">
          <AlertTriangle className="text-destructive mb-2 h-8 w-8" />
          <p className="text-destructive text-sm">
            {t('chooseTemplate.errorLoad')}
          </p>
          <Button variant="outline" onClick={refetch} className="mt-3">
            {t('chooseTemplate.retry')}
          </Button>
        </div>
      ) : templates.length === 0 ? (
        <div className="border-border bg-card/50 flex h-48 flex-col items-center justify-center rounded-xl border">
          <FileText className="text-muted-foreground mb-2 h-8 w-8" />
          <p className="text-muted-foreground text-sm">
            {t('chooseTemplate.noTemplates')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('chooseTemplate.createFirst')}
          </p>
        </div>
      ) : (
        <div
          style={{
            overflowY: 'scroll',
            height: '500px',
            paddingRight: '10px',
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => {
              const isSelected = selectedTemplate?.id === template.id;
              const catColor =
                categoryColors[template.category] ?? categoryColors.Utility;

              return (
                <button
                  key={template.id}
                  onClick={() => onSelect(template)}
                  className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all ${
                    isSelected
                      ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                      : 'border-border bg-card/50 hover:border-border hover:bg-card'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <h3 className="text-foreground text-sm font-medium break-all">
                      {template.name}
                    </h3>
                    <span
                      className={`ml-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                    >
                      {template.category}
                    </span>
                  </div>
                  <p className="text-muted-foreground line-clamp-3 text-xs">
                    {template.body_text}
                  </p>
                  <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
                    <span>{template.language ?? 'en_US'}</span>
                    {/* Status is omitted on purpose — every template
                        shown here is already filtered to APPROVED,
                        so the chip carried no information. */}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Teste A/B (SPEC 044 §6.6) ───────────────────────────────
          Fica no passo do template porque é disso que se trata: a mesma
          audiência recebendo dois textos. Só aparece depois de escolher
          o primeiro — antes disso não há nada com que comparar. */}
      {selectedTemplate && (
        <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={variantTemplate !== null}
              onChange={(e) =>
                onVariantSelect(
                  e.target.checked ? (variantCandidates[0] ?? null) : null
                )
              }
              disabled={variantCandidates.length === 0}
              className="mt-1 disabled:opacity-50"
            />
            <span>
              <span className="text-foreground flex items-center gap-1.5 text-sm font-medium">
                <FlaskConical className="text-primary h-4 w-4" />
                {tAb('enable')}
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                {variantCandidates.length === 0
                  ? tAb('noCandidates', { category: selectedTemplate.category })
                  : tAb('description')}
              </span>
            </span>
          </label>

          {variantTemplate && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
                  {tAb('variantTemplate')}
                </label>
                <Select
                  value={variantTemplate.id}
                  onValueChange={(id) =>
                    onVariantSelect(
                      variantCandidates.find((c) => c.id === id) ?? null
                    )
                  }
                >
                  <SelectTrigger className="border-border bg-muted text-foreground w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-popover">
                    {variantCandidates.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.name} ({candidate.language ?? 'en_US'})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
                  {tAb('split')}
                </label>
                <Select
                  value={String(splitPercent || AB_DEFAULT_SPLIT_PERCENT)}
                  onValueChange={(value) => onSplitPercentChange(Number(value))}
                >
                  <SelectTrigger className="border-border bg-muted text-foreground w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-popover">
                    {SPLIT_OPTIONS.map((percent) => (
                      <SelectItem key={percent} value={String(percent)}>
                        {tAb('splitOption', {
                          a: percent,
                          b: 100 - percent,
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {variantTemplate && (
            <p className="text-muted-foreground text-xs">
              {tAb('minimumHint')}
            </p>
          )}
        </div>
      )}

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
