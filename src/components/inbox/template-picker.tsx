'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Contact, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, ChevronRight, LayoutTemplate, Loader2 } from 'lucide-react';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { templateBelongsToWaba } from '@/lib/whatsapp/template-waba';
import { useTranslations } from 'next-intl';

export interface TemplateSendValues {
  body: string[];
  headerText?: string;
  buttonParams?: Record<number, string>;
}

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: MessageTemplate, values: TemplateSendValues) => void;
  /** Used to auto-suggest the contact's name for the body's {{1}} variable. */
  contact?: Contact | null;
  /**
   * `conversations.channel_id` da thread ativa (SPEC 064 D-2). Templates
   * pertencem ao WABA da Meta, não à conta — sem filtrar por ele, o
   * seletor oferecia templates aprovados em OUTRO número oficial da
   * mesma conta, e a Meta rejeitava o envio com
   * "(#132001) Template name does not exist in the translation" porque,
   * do ponto de vista do WABA que está enviando, o nome realmente não
   * existe lá.
   */
  channelId?: string | null;
  /**
   * Reenvio de uma mensagem apagada de template (SPEC 074 §8): pula a
   * lista e abre direto no formulário de variáveis, pré-selecionado por
   * nome. Sem correspondência (template renomeado/apagado da Meta desde
   * então) cai de volta na lista normal — nunca um erro.
   */
  initialTemplateName?: string | null;
}

function renderBodyPreview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

/**
 * Templates may need values for: body variables, a text-header
 * variable, and per-URL-button suffixes. Collect them all so the
 * send-message path doesn't 400 on missing parameters.
 */
function collectVariableSlots(template: MessageTemplate): {
  bodyVars: number[];
  headerVarCount: number;
  urlButtonSlots: UrlButtonSlot[];
} {
  const bodyVars = extractVariableIndices(template.body_text);
  const headerVarCount =
    template.header_type === 'text' && template.header_content
      ? extractVariableIndices(template.header_content).length
      : 0;
  const urlButtonSlots: UrlButtonSlot[] = [];
  (template.buttons ?? []).forEach((b, i) => {
    if (b.type === 'URL' && extractVariableIndices(b.url).length > 0) {
      urlButtonSlots.push({ index: i, text: b.text, url: b.url });
    }
  });
  return { bodyVars, headerVarCount, urlButtonSlots };
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
  contact,
  channelId,
  initialTemplateName,
}: TemplatePickerProps) {
  const t = useTranslations('Inbox.templatePicker');

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [headerText, setHeaderText] = useState<string>('');
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (!cancelled) {
          setTemplates([]);
          setLoading(false);
        }
        return;
      }

      // As duas consultas não dependem uma da outra — em paralelo, não em
      // série. `whatsapp_config` (não `/api/whatsapp/config`) porque só
      // precisamos do `waba_id`, um select direto sob RLS
      // (`is_account_member`) sem segredo nenhum; a rota HTTP existe
      // para a tela de Configurações, que também sonda a Meta ao vivo —
      // custo desnecessário aqui, num diálogo que abre a cada "Enviar
      // template".
      const [templatesResult, wabaResult] = await Promise.all([
        // Scope by RLS (message_templates_select → is_account_member), NOT
        // by user_id. Templates are account-owned, so filtering on the
        // caller's user_id hid templates that a teammate created — leaving
        // them unable to send approved templates in a shared account.
        supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .order('created_at', { ascending: false }),
        channelId
          ? supabase
              .from('whatsapp_config')
              .select('waba_id')
              .eq('channel_id', channelId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (cancelled) return;

      if (templatesResult.error) {
        console.error('Failed to fetch templates:', templatesResult.error);
        setTemplates([]);
        setLoading(false);
        return;
      }
      const allTemplates = (templatesResult.data as MessageTemplate[]) ?? [];

      if (wabaResult.error) {
        // Achado de code review: um erro aqui não pode virar "nenhum
        // template" — falha ABERTA para a lista inteira sem filtrar, o
        // mesmo raciocínio de qualquer outra falha transitória de leitura
        // neste arquivo.
        console.error(
          'Failed to resolve channel WABA for templates:',
          wabaResult.error
        );
        setTemplates(allTemplates);
        setLoading(false);
        return;
      }

      // Filtra pelo WABA do canal da conversa (SPEC 064 D-2). Sem isto o
      // seletor oferece templates aprovados em OUTRO número oficial da
      // mesma conta — a Meta aceita o payload e rejeita com
      // "(#132001) Template name does not exist in the translation"
      // porque, do lado do WABA que envia, o nome de fato não existe lá.
      //
      // Só filtra quando o canal foi de fato encontrado. `wabaRow` nulo
      // cobre dois casos, e os dois têm de falhar ABERTO (lista inteira,
      // sem filtro) pelo mesmo motivo do bloco de erro acima: sem
      // `channelId` (chamador antigo), e `channelId` que não bate
      // nenhuma linha de `whatsapp_config` (canal desativado — achado de
      // code review: filtrar aqui reduziria a lista a só os templates
      // legados em vez de mostrar tudo).
      const wabaRow = wabaResult.data as { waba_id: string | null } | null;
      setTemplates(
        wabaRow
          ? allTemplates.filter((t) =>
              templateBelongsToWaba(t.waba_id, wabaRow.waba_id)
            )
          : allTemplates
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open, channelId]);

  // Pré-seleção do reenvio (SPEC 074 §8) — só depois que a lista carrega,
  // e só UMA VEZ por abertura do diálogo. `autoPickedRef` é o que faz
  // isso valer: sem ele, o botão "Voltar" (que chama `resetSelection` e
  // zera `selected`) reabria a mesma pré-seleção na hora — o operador
  // nunca conseguia voltar para a lista livre para escolher outro
  // template (achado de code review). O ref só é marcado no instante em
  // que a pré-seleção de fato acontece, não antes — enquanto a lista
  // ainda está carregando, ou se o template não for encontrado, o efeito
  // continua livre para tentar de novo no próximo dep change.
  const autoPickedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoPickedRef.current = false;
      return;
    }
    if (loading || selected || !initialTemplateName || autoPickedRef.current) {
      return;
    }
    const match = templates.find((tpl) => tpl.name === initialTemplateName);
    if (match) {
      autoPickedRef.current = true;
      pickTemplate(match);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loading, templates, initialTemplateName, selected]);

  function resetSelection() {
    setSelected(null);
    setParams([]);
    setHeaderText('');
    setButtonParams({});
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetSelection();
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const slots = collectVariableSlots(template);
    const noInputsNeeded =
      slots.bodyVars.length === 0 &&
      slots.headerVarCount === 0 &&
      slots.urlButtonSlots.length === 0;
    if (noInputsNeeded) {
      onSelect(template, { body: [] });
      handleOpenChange(false);
      return;
    }
    const initialParams = new Array(slots.bodyVars.length).fill('');
    // Só sugere o nome do contato para {{1}} — variáveis seguintes ({{2}}...)
    // dependem de contexto que não temos como adivinhar, então ficam em branco.
    if (slots.bodyVars[0] === 1 && contact?.name) {
      initialParams[0] = contact.name;
    }
    setSelected(template);
    setParams(initialParams);
    setHeaderText('');
    setButtonParams({});
  }

  function confirm() {
    if (!selected) return;
    const values: TemplateSendValues = { body: params };
    if (headerText.trim()) values.headerText = headerText.trim();
    if (Object.keys(buttonParams).length > 0) {
      values.buttonParams = Object.fromEntries(
        Object.entries(buttonParams).map(([k, v]) => [Number(k), v.trim()])
      );
    }
    onSelect(selected, values);
    handleOpenChange(false);
  }

  const slots = useMemo(
    () => (selected ? collectVariableSlots(selected) : null),
    [selected]
  );
  const canConfirm =
    !!selected &&
    !!slots &&
    slots.bodyVars.every((_, i) => (params[i] ?? '').trim().length > 0) &&
    (slots.headerVarCount === 0 || headerText.trim().length > 0) &&
    slots.urlButtonSlots.every(
      (s) => (buttonParams[s.index] ?? '').trim().length > 0
    );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground flex items-center gap-2">
            <LayoutTemplate className="text-primary h-4 w-4" />
            {selected ? selected.name : t('sendTemplate')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {selected ? t('fillPlaceholders') : t('pickTemplate')}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-primary h-5 w-5 animate-spin" />
              </div>
            ) : templates.length === 0 ? (
              <div className="border-border bg-background/50 rounded-md border p-6 text-center">
                <p className="text-popover-foreground text-sm">
                  {t('noApprovedTemplates')}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('noApprovedTemplatesHint')}
                </p>
              </div>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  className="border-border bg-background/50 hover:border-primary/40 hover:bg-popover w-full rounded-md border p-3 text-left transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-popover-foreground truncate text-sm font-medium">
                          {t.name}
                        </p>
                        <Badge className="border-primary/30 bg-primary/20 text-primary border text-[10px]">
                          {t.category}
                        </Badge>
                        {t.language && (
                          <span className="text-muted-foreground text-[10px] uppercase">
                            {t.language}
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                        {t.body_text}
                      </p>
                    </div>
                    <ChevronRight className="text-muted-foreground h-4 w-4 flex-shrink-0" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="border-border bg-background/50 rounded-md border p-3">
              <p className="text-muted-foreground mb-1 text-xs">
                {t('preview')}
              </p>
              <p className="text-popover-foreground text-sm whitespace-pre-wrap">
                {renderBodyPreview(selected.body_text, params)}
              </p>
              {selected.footer_text && (
                <p className="text-muted-foreground mt-2 text-xs italic">
                  {selected.footer_text}
                </p>
              )}
            </div>
            {slots && slots.headerVarCount > 0 && (
              <div className="space-y-1">
                <Label className="text-popover-foreground text-xs">
                  {`Header {{1}}`}
                </Label>
                <Input
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value)}
                  placeholder={t('headerValuePlaceholder')}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}
            {slots?.bodyVars.map((v, i) => (
              <div key={v} className="space-y-1">
                <Label className="text-popover-foreground text-xs">{`Body {{${v}}}`}</Label>
                <Input
                  value={params[i] ?? ''}
                  onChange={(e) => {
                    const next = [...params];
                    next[i] = e.target.value;
                    setParams(next);
                  }}
                  placeholder={t('bodyValuePlaceholder', { val: `{{${v}}}` })}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}
            {slots?.urlButtonSlots.map((slot) => (
              <div key={slot.index} className="space-y-1">
                <Label className="text-popover-foreground text-xs">
                  {`URL button "${slot.text}" — value for `}
                  {`{{1}}`}
                </Label>
                <Input
                  value={buttonParams[slot.index] ?? ''}
                  onChange={(e) =>
                    setButtonParams((prev) => ({
                      ...prev,
                      [slot.index]: e.target.value,
                    }))
                  }
                  placeholder={t('urlSuffixValuePlaceholder')}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-muted-foreground text-[10px] break-all">
                  {t('finalUrl', {
                    url: slot.url.replace(
                      /\{\{1\}\}/g,
                      buttonParams[slot.index] || '{{1}}'
                    ),
                  })}
                </p>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('back')}
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t('send')}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
