'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { PortalAlert } from './portal-card';
import {
  accountQuery,
  postPortal,
  rememberPhone,
  type PortalErrorCode,
} from './portal-api';

/**
 * Primeiro acesso e "esqueci minha senha" são o mesmo fluxo (PRD 082
 * §6.2). A resposta é sempre a mesma frase — a tela não sabe, e não
 * pode mostrar, se o número tem acesso.
 */
export function RequestCodeForm({
  mode,
  publicCode,
}: {
  mode: 'first_access' | 'reset';
  publicCode: string | null;
}) {
  const t = useTranslations('ContactPortal');
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<PortalErrorCode | null>(null);
  const [loading, setLoading] = useState(false);
  const q = accountQuery(publicCode);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const r = await postPortal('/area/api/request-code', {
      phone,
      purpose: mode,
      publicCode,
    });
    setLoading(false);
    if (!r.ok) {
      setError(r.code);
      return;
    }
    rememberPhone(phone);
    setSent(true);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && <PortalAlert tone="error">{t(`errors.${error}`)}</PortalAlert>}
      {sent && <PortalAlert tone="info">{t('request.sent')}</PortalAlert>}
      <div className="flex flex-col gap-2">
        <Label htmlFor="phone" className="text-muted-foreground">
          {t('phoneLabel')}
        </Label>
        <Input
          id="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder={t('phonePlaceholder')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? t('loading') : t('request.submit')}
      </Button>
      <div className="flex justify-between text-sm">
        <Link
          href={`/area/codigo${q}`}
          className="text-primary hover:underline"
        >
          {t('request.haveCode')}
        </Link>
        <Link
          href={publicCode ? `/area/c/${publicCode}` : '/area'}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {t('backToLogin')}
        </Link>
      </div>
    </form>
  );
}
