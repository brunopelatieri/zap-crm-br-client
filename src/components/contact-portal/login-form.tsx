'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { PasswordInput } from './password-input';
import { PortalAlert } from './portal-card';
import { accountQuery, postPortal, type PortalErrorCode } from './portal-api';

export function LoginForm({ publicCode }: { publicCode: string | null }) {
  const t = useTranslations('ContactPortal');
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<PortalErrorCode | null>(null);
  const [loading, setLoading] = useState(false);
  const q = accountQuery(publicCode);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const r = await postPortal<{ next: string }>('/area/api/login', {
      phone,
      password,
    });
    if (!r.ok) {
      setError(r.code);
      setLoading(false);
      return;
    }
    router.push(r.data.next);
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && <PortalAlert tone="error">{t(`errors.${error}`)}</PortalAlert>}
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
      <PasswordInput
        id="password"
        label={t('passwordLabel')}
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? t('loading') : t('login.submit')}
      </Button>
      <div className="flex justify-between text-sm">
        <Link
          href={`/area/primeiro-acesso${q}`}
          className="text-primary hover:underline"
        >
          {t('login.firstAccess')}
        </Link>
        <Link
          href={`/area/recuperar${q}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {t('login.forgot')}
        </Link>
      </div>
    </form>
  );
}
