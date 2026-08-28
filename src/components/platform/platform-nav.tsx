'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/admin', labelKey: 'navOverview' as const, exact: true },
  { href: '/admin/accounts', labelKey: 'navAccounts' as const, exact: false },
  { href: '/admin/plans', labelKey: 'navPlans' as const, exact: false },
  { href: '/admin/retention', labelKey: 'navRetention' as const, exact: false },
  { href: '/admin/requests', labelKey: 'navRequests' as const, exact: false },
  {
    href: '/admin/notifications',
    labelKey: 'navNotifications' as const,
    exact: false,
  },
  { href: '/admin/settings', labelKey: 'navSettings' as const, exact: false },
];

/** Navegação entre as seções do console (SPEC 062 §7, F6). */
export function PlatformNav() {
  const t = useTranslations('Platform.layout');
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {ITEMS.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-sm transition-colors',
              active
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            {t(item.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
