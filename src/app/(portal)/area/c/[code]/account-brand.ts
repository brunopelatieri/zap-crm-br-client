import { getTranslations } from 'next-intl/server';

import { portalService } from '@/lib/contact-portal/service';

/**
 * "Área de <conta>" quando o código existe e a área dela está elegível;
 * senão o genérico "Área do contato". Falha de banco (inclusive a 095
 * ainda não aplicada) também cai no genérico: o nome é enfeite, não
 * pode derrubar a tela de entrar.
 */
export async function accountBrand(publicCode: string | null): Promise<string> {
  const t = await getTranslations('ContactPortal');
  if (!publicCode) return t('brand');
  try {
    const name = await portalService().publicAccountName(publicCode);
    return name ? t('brandOf', { account: name }) : t('brand');
  } catch {
    return t('brand');
  }
}
