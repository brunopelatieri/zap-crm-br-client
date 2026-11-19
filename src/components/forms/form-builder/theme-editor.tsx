'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { DEFAULT_THEME_COLORS } from '@/components/forms/public/public-form';
import { isLowContrast } from '@/lib/forms/contrast';
import {
  isCssHexColor,
  type FormFont,
  type FormLocale,
  type FormRadius,
  type FormTheme,
} from '@/lib/forms/types';

import { MediaField } from './media-field';
import { Field, NativeSelect, Section, ToggleRow } from './ui';

const COLOR_KEYS = ['primary', 'background', 'text', 'button'] as const;
const FONTS: FormFont[] = ['system', 'serif', 'rounded', 'mono'];
const RADII: FormRadius[] = ['rounded', 'square'];

export function ThemeEditor({
  formId,
  theme,
  locale,
  onTheme,
  onLocale,
  mediaUrls,
  onMediaUrl,
}: {
  formId: string;
  theme: FormTheme;
  locale: FormLocale;
  onTheme: (theme: FormTheme) => void;
  onLocale: (locale: FormLocale) => void;
  mediaUrls: Record<string, string>;
  onMediaUrl: (path: string, url: string) => void;
}) {
  const t = useTranslations('Forms.builder.theme');
  const colors = { ...DEFAULT_THEME_COLORS, ...theme.colors };
  const welcome = theme.welcome ?? {};
  const thank = theme.thank_you ?? {};

  const setColor = (key: (typeof COLOR_KEYS)[number], value: string) =>
    onTheme({ ...theme, colors: { ...theme.colors, [key]: value } });
  const setWelcome = (patch: Partial<NonNullable<FormTheme['welcome']>>) =>
    onTheme({ ...theme, welcome: { ...welcome, ...patch } });
  const setThank = (patch: Partial<NonNullable<FormTheme['thank_you']>>) =>
    onTheme({ ...theme, thank_you: { ...thank, ...patch } });

  const lowContrast = isLowContrast(colors.text, colors.background);
  const redirectBad =
    !!thank.redirect_url && !/^https:\/\//i.test(thank.redirect_url);

  return (
    <div className="grid gap-6">
      <Section title={t('brand')}>
        <Field label={t('logo')}>
          <MediaField
            imageOnly
            formId={formId}
            value={
              theme.logo_path ? { kind: 'image', path: theme.logo_path } : null
            }
            onChange={(media) =>
              onTheme({
                ...theme,
                logo_path: media?.kind === 'image' ? media.path : null,
              })
            }
            mediaUrls={mediaUrls}
            onMediaUrl={onMediaUrl}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          {COLOR_KEYS.map((key) => {
            const value = theme.colors?.[key] ?? colors[key];
            const valid = isCssHexColor(value);
            return (
              <Field key={key} label={t(`colors.${key}`)}>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t(`colors.${key}`)}
                    value={valid && value.length === 7 ? value : colors[key]}
                    onChange={(e) => setColor(key, e.target.value)}
                    className="border-input h-8 w-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                  />
                  <Input
                    value={value}
                    onChange={(e) => setColor(key, e.target.value)}
                    aria-invalid={!valid}
                    maxLength={9}
                    className="font-mono"
                  />
                </div>
              </Field>
            );
          })}
        </div>
        {lowContrast && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('lowContrast')}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('font')}>
            <NativeSelect
              value={theme.font ?? 'system'}
              onChange={(e) =>
                onTheme({ ...theme, font: e.target.value as FormFont })
              }
            >
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {t(`fonts.${f}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('radius')}>
            <NativeSelect
              value={theme.radius ?? 'rounded'}
              onChange={(e) =>
                onTheme({ ...theme, radius: e.target.value as FormRadius })
              }
            >
              {RADII.map((r) => (
                <option key={r} value={r}>
                  {t(`radii.${r}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>

        <Field label={t('language')} hint={t('languageHint')}>
          <NativeSelect
            value={locale}
            onChange={(e) => onLocale(e.target.value as FormLocale)}
          >
            <option value="pt-BR">Português (Brasil)</option>
            <option value="en">English</option>
          </NativeSelect>
        </Field>
      </Section>

      <Section title={t('welcome')}>
        <Field label={t('welcomeTitle')}>
          <Input
            value={welcome.title ?? ''}
            maxLength={200}
            onChange={(e) => setWelcome({ title: e.target.value })}
          />
        </Field>
        <Field label={t('welcomeDescription')}>
          <Textarea
            value={welcome.description ?? ''}
            rows={2}
            maxLength={1000}
            onChange={(e) => setWelcome({ description: e.target.value })}
          />
        </Field>
        <Field label={t('welcomeButton')}>
          <Input
            value={welcome.button_label ?? ''}
            maxLength={60}
            onChange={(e) => setWelcome({ button_label: e.target.value })}
          />
        </Field>
        <Field label={t('welcomeMedia')}>
          <MediaField
            formId={formId}
            value={welcome.media ?? null}
            onChange={(media) => setWelcome({ media })}
            mediaUrls={mediaUrls}
            onMediaUrl={onMediaUrl}
          />
        </Field>
      </Section>

      <Section title={t('thankYou')}>
        <Field label={t('thankTitle')}>
          <Input
            value={thank.title ?? ''}
            maxLength={200}
            onChange={(e) => setThank({ title: e.target.value })}
          />
        </Field>
        <Field label={t('thankBody')}>
          <Textarea
            value={thank.body ?? ''}
            rows={3}
            maxLength={2000}
            onChange={(e) => setThank({ body: e.target.value })}
          />
        </Field>
        <ToggleRow label={t('whatsappCta')} hint={t('whatsappCtaHint')}>
          <Switch
            checked={thank.whatsapp_cta === true}
            onCheckedChange={(checked) => setThank({ whatsapp_cta: checked })}
          />
        </ToggleRow>
        {thank.whatsapp_cta && (
          <Field label={t('whatsappText')}>
            <Input
              value={thank.whatsapp_text ?? ''}
              maxLength={500}
              onChange={(e) => setThank({ whatsapp_text: e.target.value })}
            />
          </Field>
        )}
        <Field
          label={t('redirectUrl')}
          hint={redirectBad ? undefined : t('redirectUrlHint')}
        >
          <Input
            type="url"
            placeholder="https://"
            value={thank.redirect_url ?? ''}
            onChange={(e) => setThank({ redirect_url: e.target.value || null })}
            aria-invalid={redirectBad}
          />
          {redirectBad && (
            <p className="text-destructive text-xs">
              {t('redirectUrlInvalid')}
            </p>
          )}
        </Field>
      </Section>
    </div>
  );
}
