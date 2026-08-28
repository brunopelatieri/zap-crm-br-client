import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeAuthClient(
  user: {
    email?: string | null;
    email_confirmed_at?: string | null;
  } | null
) {
  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: user ? { id: 'user-1', ...user } : null },
          error: null,
        }),
    },
  };
}

const createClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createClient(),
}));

const { isPlatformOwnerEmail, requirePlatformOwner, PlatformOwnerError } =
  await import('./owner');

const ORIGINAL_ENV = process.env.PLATFORM_OWNER_EMAILS;

afterEach(() => {
  vi.clearAllMocks();
  process.env.PLATFORM_OWNER_EMAILS = ORIGINAL_ENV;
});

beforeEach(() => {
  process.env.PLATFORM_OWNER_EMAILS = 'bruno@zapcrmbr.com, ana@zapcrmbr.com';
});

describe('isPlatformOwnerEmail', () => {
  it('lista vazia (variável ausente) recusa qualquer e-mail', () => {
    delete process.env.PLATFORM_OWNER_EMAILS;
    expect(isPlatformOwnerEmail('bruno@zapcrmbr.com')).toBe(false);
  });

  it('lista vazia (variável em branco) recusa', () => {
    process.env.PLATFORM_OWNER_EMAILS = '';
    expect(isPlatformOwnerEmail('bruno@zapcrmbr.com')).toBe(false);
  });

  it('aceita e-mail exato na lista', () => {
    expect(isPlatformOwnerEmail('bruno@zapcrmbr.com')).toBe(true);
  });

  it('normaliza espaços ao redor do e-mail candidato', () => {
    expect(isPlatformOwnerEmail('  bruno@zapcrmbr.com  ')).toBe(true);
  });

  it('normaliza maiúsculas/minúsculas', () => {
    expect(isPlatformOwnerEmail('Bruno@ZapCRMBR.com')).toBe(true);
  });

  it('e-mail parcialmente igual (subdomínio a mais) não casa', () => {
    expect(isPlatformOwnerEmail('bruno@zapcrmbr.com.br')).toBe(false);
  });

  it('e-mail parcialmente igual (prefixo a mais) não casa', () => {
    expect(isPlatformOwnerEmail('xbruno@zapcrmbr.com')).toBe(false);
  });

  it('e-mail nulo ou vazio recusa', () => {
    expect(isPlatformOwnerEmail(null)).toBe(false);
    expect(isPlatformOwnerEmail(undefined)).toBe(false);
    expect(isPlatformOwnerEmail('')).toBe(false);
  });

  it('respeita espaços na lista configurada (vírgula + espaço)', () => {
    expect(isPlatformOwnerEmail('ana@zapcrmbr.com')).toBe(true);
  });
});

describe('requirePlatformOwner', () => {
  it('lança quando PLATFORM_OWNER_EMAILS está ausente', async () => {
    delete process.env.PLATFORM_OWNER_EMAILS;
    createClient.mockReturnValue(
      makeAuthClient({
        email: 'bruno@zapcrmbr.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      })
    );
    await expect(requirePlatformOwner()).rejects.toBeInstanceOf(
      PlatformOwnerError
    );
  });

  it('lança quando não há sessão', async () => {
    createClient.mockReturnValue(makeAuthClient(null));
    await expect(requirePlatformOwner()).rejects.toBeInstanceOf(
      PlatformOwnerError
    );
  });

  it('lança quando o e-mail não está confirmado', async () => {
    createClient.mockReturnValue(
      makeAuthClient({
        email: 'bruno@zapcrmbr.com',
        email_confirmed_at: null,
      })
    );
    await expect(requirePlatformOwner()).rejects.toBeInstanceOf(
      PlatformOwnerError
    );
  });

  it('lança quando o e-mail confirmado não está na lista', async () => {
    createClient.mockReturnValue(
      makeAuthClient({
        email: 'estranho@outraempresa.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      })
    );
    await expect(requirePlatformOwner()).rejects.toBeInstanceOf(
      PlatformOwnerError
    );
  });

  it('resolve o contexto quando as quatro condições valem', async () => {
    createClient.mockReturnValue(
      makeAuthClient({
        email: 'Bruno@ZapCRMBR.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      })
    );
    const ctx = await requirePlatformOwner();
    expect(ctx).toEqual({ email: 'bruno@zapcrmbr.com', userId: 'user-1' });
  });
});
