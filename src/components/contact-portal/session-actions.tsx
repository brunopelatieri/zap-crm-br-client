'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { PasswordStrengthMeter } from '@/components/auth/password-strength-meter';
import { Button } from '@/components/ui/button';

import { PasswordInput } from './password-input';
import { PortalAlert } from './portal-card';
import { postPortal, type PortalErrorCode } from './portal-api';

/** Um botão por conta que a sessão abriu (tela "Escolher conta"). */
export function ChooseAccount({
  accesses,
}: {
  accesses: { contactId: string; accountName: string }[];
}) {
  const t = useTranslations('ContactPortal');
  const router = useRouter();
  const [error, setError] = useState<PortalErrorCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (contactId: string) => {
    setError(null);
    setBusy(contactId);
    const r = await postPortal<{ next: string }>('/area/api/select-account', {
      contactId,
    });
    if (!r.ok) {
      setError(r.code);
      setBusy(null);
      return;
    }
    router.push(r.data.next);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {error && <PortalAlert tone="error">{t(`errors.${error}`)}</PortalAlert>}
      {accesses.map((a) => (
        <Button
          key={a.contactId}
          variant="outline"
          className="justify-between"
          disabled={busy !== null}
          onClick={() => choose(a.contactId)}
        >
          <span className="truncate">{a.accountName}</span>
          <span className="text-muted-foreground text-xs">
            {busy === a.contactId ? t('loading') : t('choose.enter')}
          </span>
        </Button>
      ))}
    </div>
  );
}

export function SignOutButton({
  everywhere = false,
}: {
  everywhere?: boolean;
}) {
  const t = useTranslations('ContactPortal');
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    await postPortal('/area/api/logout', { everywhere });
    router.push('/area');
    router.refresh();
  };

  return (
    <Button
      variant={everywhere ? 'ghost' : 'outline'}
      className="w-full"
      disabled={busy}
      onClick={signOut}
    >
      {busy
        ? t('loading')
        : everywhere
          ? t('account.signOutEverywhere')
          : t('account.signOut')}
    </Button>
  );
}

export function ChangePasswordForm() {
  const t = useTranslations('ContactPortal');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<PortalErrorCode | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setLoading(true);
    const r = await postPortal('/area/api/change-password', {
      current,
      next,
      confirmNext: confirm,
    });
    setLoading(false);
    if (!r.ok) {
      setError(r.code);
      return;
    }
    setSaved(true);
    setCurrent('');
    setNext('');
    setConfirm('');
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        {t('account.changePasswordHint')}
      </p>
      {error && <PortalAlert tone="error">{t(`errors.${error}`)}</PortalAlert>}
      {saved && <PortalAlert tone="info">{t('account.saved')}</PortalAlert>}
      <PasswordInput
        id="current"
        label={t('account.currentPassword')}
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
      />
      <PasswordInput
        id="next"
        label={t('account.newPassword')}
        value={next}
        onChange={setNext}
        autoComplete="new-password"
      />
      <PasswordStrengthMeter password={next} />
      <PasswordInput
        id="confirm"
        label={t('account.confirmPassword')}
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? t('loading') : t('account.save')}
      </Button>
    </form>
  );
}
