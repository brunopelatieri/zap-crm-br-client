'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { PasswordStrengthMeter } from '@/components/auth/password-strength-meter';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { PasswordInput } from './password-input';
import { PortalAlert } from './portal-card';
import {
  accountQuery,
  postPortal,
  recallPhone,
  type PortalErrorCode,
} from './portal-api';

/**
 * Código + nova senha numa tela só (SPEC 083 E-3). O link da mensagem
 * traz o código no fragmento (`#c=123456`, que não vai ao servidor):
 * a tela o lê, preenche o campo e tira o fragmento da barra de endereço.
 */
export function CodeForm({ publicCode }: { publicCode: string | null }) {
  const t = useTranslations('ContactPortal');
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<PortalErrorCode | null>(null);
  const [loading, setLoading] = useState(false);
  const q = accountQuery(publicCode);

  useEffect(() => {
    // Valores que só existem no navegador (fragmento e sessionStorage):
    // lidos uma vez, depois da hidratação.
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get(
      'c'
    );
    const remembered = recallPhone();
    /* eslint-disable react-hooks/set-state-in-effect */
    if (fromHash && /^\d{6}$/.test(fromHash)) setCode(fromHash);
    if (remembered) setPhone(remembered);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (window.location.hash) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const r = await postPortal<{ next: string }>('/area/api/complete-code', {
      phone,
      code,
      password,
      confirmPassword: confirm,
      termsAccepted: terms,
      publicCode,
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
      <div className="flex flex-col gap-2">
        <Label htmlFor="code" className="text-muted-foreground">
          {t('code.codeLabel')}
        </Label>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={9}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </div>
      <PasswordInput
        id="password"
        label={t('code.newPassword')}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
      <PasswordStrengthMeter password={password} />
      <PasswordInput
        id="confirm"
        label={t('code.confirmPassword')}
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      <label className="text-muted-foreground flex items-start gap-2 text-sm">
        <Checkbox
          checked={terms}
          onCheckedChange={(v) => setTerms(v === true)}
          className="mt-0.5"
        />
        <span>{t('code.terms')}</span>
      </label>
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? t('loading') : t('code.submit')}
      </Button>
      <div className="flex justify-between text-sm">
        <Link
          href={`/area/recuperar${q}`}
          className="text-primary hover:underline"
        >
          {t('code.resend')}
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
