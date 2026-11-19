'use client';

import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { EMBED_ORIGINS_MAX } from '@/lib/forms/validate';
import { isReservedSlug, SLUG_PATTERN, suggestSlug } from '@/lib/forms/slug';
import type { Form, FormSettings, PortalVisibility } from '@/lib/forms/types';

import { Field, NativeSelect, Section, ToggleRow } from './ui';

export interface BuilderCapabilities {
  link_token: boolean;
  turnstile: boolean;
}

/** `https://host` (sem caminho, sem barra final) — mesma regra do validador. */
function isHttpsOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash &&
      !value.endsWith('/') &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

const PORTAL_OPTIONS: PortalVisibility[] = [
  'none',
  'fill',
  'responses',
  'both',
];

export function SettingsEditor({
  form,
  origin,
  capabilities,
  onForm,
  onSettings,
  onAcceptGenericLink,
}: {
  form: Form;
  /** Origem pública do app, só para mostrar `…/f/<slug>`. */
  origin: string;
  capabilities: BuilderCapabilities;
  onForm: (patch: Partial<Form>) => void;
  onSettings: (patch: Partial<FormSettings>) => void;
  onAcceptGenericLink: (on: boolean) => void;
}) {
  const t = useTranslations('Forms.builder.settings');
  const s = form.settings ?? {};
  const [originInput, setOriginInput] = useState('');
  const [originError, setOriginError] = useState(false);

  const slugFormatBad = !SLUG_PATTERN.test(form.slug);
  const slugReserved = !slugFormatBad && isReservedSlug(form.slug);
  const origins = s.embed_origins ?? [];

  function addOrigin() {
    const value = originInput.trim();
    if (!value) return;
    if (!isHttpsOrigin(value) || origins.includes(value)) {
      setOriginError(true);
      return;
    }
    setOriginError(false);
    setOriginInput('');
    onSettings({ embed_origins: [...origins, value] });
  }

  return (
    <div className="grid gap-6">
      <Section title={t('link')}>
        <Field
          label={t('slug')}
          hint={
            slugFormatBad ? undefined : (
              <span className="font-mono break-all">
                {origin}/f/{form.slug}
              </span>
            )
          }
        >
          <div className="flex gap-2">
            <Input
              value={form.slug}
              maxLength={60}
              aria-invalid={slugFormatBad || slugReserved}
              onChange={(e) => onForm({ slug: e.target.value.toLowerCase() })}
              className="font-mono"
            />
            <Button
              variant="outline"
              onClick={() => onForm({ slug: suggestSlug(form.name) })}
            >
              {t('suggestSlug')}
            </Button>
          </div>
          {(slugFormatBad || slugReserved) && (
            <p className="text-destructive text-xs">
              {slugReserved ? t('slugReserved') : t('slugInvalid')}
            </p>
          )}
          {form.status === 'published' && (
            <p className="text-xs text-amber-300">
              {t('slugPublishedWarning')}
            </p>
          )}
        </Field>

        <ToggleRow label={t('acceptGeneric')} hint={t('acceptGenericHint')}>
          <Switch
            checked={s.accept_generic_link !== false}
            onCheckedChange={onAcceptGenericLink}
          />
        </ToggleRow>
        <ToggleRow label={t('confirmPhone')} hint={t('confirmPhoneHint')}>
          <Switch
            checked={s.confirm_phone_with_token === true}
            onCheckedChange={(checked) =>
              onSettings({ confirm_phone_with_token: checked })
            }
          />
        </ToggleRow>
        <Field
          label={t('tokenTtl')}
          hint={capabilities.link_token ? t('tokenTtlHint') : t('tokenMissing')}
        >
          <Input
            type="number"
            min={1}
            max={365}
            value={s.token_ttl_days ?? 30}
            onChange={(e) =>
              onSettings({
                token_ttl_days: Number(e.target.value) || undefined,
              })
            }
          />
        </Field>
      </Section>

      <Section title={t('answers')}>
        <ToggleRow label={t('multiple')} hint={t('multipleHint')}>
          <Switch
            checked={s.allow_multiple_responses === true}
            onCheckedChange={(checked) =>
              onSettings({ allow_multiple_responses: checked })
            }
          />
        </ToggleRow>
        <ToggleRow
          label={t('turnstile')}
          hint={
            capabilities.turnstile ? t('turnstileHint') : t('turnstileMissing')
          }
        >
          <Switch
            checked={s.turnstile === true}
            disabled={!capabilities.turnstile && s.turnstile !== true}
            onCheckedChange={(checked) => onSettings({ turnstile: checked })}
          />
        </ToggleRow>
        <p className="text-muted-foreground text-xs">{t('honeypot')}</p>
        <ToggleRow label={t('noindex')} hint={t('noindexHint')}>
          <Switch
            checked={s.robots_noindex === true}
            onCheckedChange={(checked) =>
              onSettings({ robots_noindex: checked })
            }
          />
        </ToggleRow>
      </Section>

      <Section title={t('embed')} description={t('embedHint')}>
        <div className="grid gap-1.5">
          {origins.map((o) => (
            <div
              key={o}
              className="border-border flex items-center gap-2 rounded-lg border px-2 py-1"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {o}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('removeOrigin')}
                onClick={() =>
                  onSettings({ embed_origins: origins.filter((x) => x !== o) })
                }
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
        {origins.length < EMBED_ORIGINS_MAX && (
          <div className="grid gap-1">
            <div className="flex gap-2">
              <Input
                value={originInput}
                placeholder="https://www.suaempresa.com.br"
                aria-invalid={originError}
                onChange={(e) => {
                  setOriginInput(e.target.value);
                  setOriginError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addOrigin();
                  }
                }}
              />
              <Button
                variant="outline"
                onClick={addOrigin}
                disabled={!originInput.trim()}
              >
                <Plus className="h-4 w-4" />
                {t('addOrigin')}
              </Button>
            </div>
            {originError && (
              <p className="text-destructive text-xs">{t('originInvalid')}</p>
            )}
          </div>
        )}
      </Section>

      <Section title={t('portalAndAi')} description={t('portalAndAiHint')}>
        <Field label={t('portal')}>
          <NativeSelect
            value={form.portal_visibility}
            onChange={(e) =>
              onForm({ portal_visibility: e.target.value as PortalVisibility })
            }
          >
            {PORTAL_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {t(`portalOptions.${p}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <ToggleRow label={t('aiOfferable')} hint={t('aiOfferableHint')}>
          <Switch
            checked={form.ai_offerable}
            onCheckedChange={(checked) => onForm({ ai_offerable: checked })}
          />
        </ToggleRow>
        {form.ai_offerable && (
          <Field label={t('aiHint')} hint={t('aiHintHint')}>
            <Textarea
              rows={2}
              maxLength={300}
              value={form.ai_offer_hint ?? ''}
              onChange={(e) =>
                onForm({ ai_offer_hint: e.target.value || null })
              }
            />
          </Field>
        )}
      </Section>

      <Section title={t('internal')}>
        <Field label={t('description')} hint={t('descriptionHint')}>
          <Textarea
            rows={2}
            maxLength={1000}
            value={form.description ?? ''}
            onChange={(e) => onForm({ description: e.target.value || null })}
          />
        </Field>
      </Section>
    </div>
  );
}
