// ============================================================
// A sessão da área na requisição atual (Server Components e rotas).
//
// Reconfere no banco a cada chamada (SPEC 083 E-1): área desligada,
// conta bloqueada ou acesso bloqueado somem da sessão na hora, sem
// cache. Separado de `session.ts` para que aquele fique puro (sem
// `next/headers`) e testável.
// ============================================================

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { portalService, type PortalService } from './service';
import {
  hashSessionToken,
  readSessionToken,
  type CookieReader,
} from './session';
import type { PortalSession } from './types';

export async function resolvePortalSession(
  store: CookieReader,
  service: Pick<PortalService, 'resolveSession'>
): Promise<PortalSession | null> {
  const token = readSessionToken(store);
  if (!token) return null;
  return service.resolveSession(hashSessionToken(token));
}

export async function getPortalSession(): Promise<PortalSession | null> {
  return resolvePortalSession(await cookies(), portalService());
}

/** Para as telas de sessão aberta: sem sessão válida, volta para entrar. */
export async function requirePortalSession(): Promise<PortalSession> {
  const session = await getPortalSession();
  if (!session) redirect('/area');
  return session;
}

/** Para onde vai quem já tem sessão e abre uma tela de entrar. */
export function homeOf(session: PortalSession): string {
  return session.current ? '/area/painel' : '/area/escolher-conta';
}
