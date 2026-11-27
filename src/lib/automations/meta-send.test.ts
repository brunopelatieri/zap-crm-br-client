/**
 * SPEC 064 D-2 — `engineSendTemplate` (via `sendViaMeta`) precisa escolher
 * a linha de `message_templates` do WABA do canal que a conversa usa, não
 * qualquer linha com o mesmo nome+idioma. Antes da correção, a consulta era
 * `.eq('account_id',...).eq('name',...).eq('language',...).maybeSingle()`
 * — cega ao WABA, e por isso podia adotar a linha de OUTRO número quando a
 * conta tem o mesmo template aprovado em dois WABAs.
 *
 * O fake de Supabase é escrito à mão (não `createSupabaseMock`) porque
 * `vi.mock('./admin-client', ...)` é hoistado para o topo do módulo pelo
 * Vitest — referenciar um import comum de dentro da fábrica do mock
 * dispararia "cannot access before initialization". `vi.hoisted` resolve
 * isso (mesmo padrão de `engine.fallback-channel.test.ts`).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    inserted: [] as Record<string, unknown>[],
    /** Achado de code review — testa qual erro vence quando os dois quebram. */
    accountBlockedAt: null as string | null,
    contactRow: { id: 'contact-1', phone: '+5511999990001' } as Record<
      string,
      unknown
    > | null,
  };

  interface Ops {
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }

  function resolve(table: string, ops: Ops) {
    if (table === 'accounts') {
      return { data: { blocked_at: state.accountBlockedAt }, error: null };
    }
    if (table === 'conversations') {
      if (ops.type === 'update') return { data: null, error: null };
      return { data: { channel_id: 'chan-b' }, error: null };
    }
    if (table === 'channels') {
      return {
        data: {
          id: 'chan-b',
          account_id: 'acct-1',
          user_id: 'user-1',
          type: 'whatsapp_cloud',
          name: 'Numero B',
          identifier: '+5511900000000',
          status: 'connected',
          status_detail: null,
          is_default: false,
          connected_at: null,
          last_seen_at: null,
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
        },
        error: null,
      };
    }
    if (table === 'whatsapp_config') {
      return {
        data: {
          channel_id: 'chan-b',
          account_id: 'acct-1',
          phone_number_id: 'PNID-B',
          access_token: 'enc-token-b',
          waba_id: 'waba-b',
          user_id: 'user-1',
        },
        error: null,
      };
    }
    if (table === 'contacts') {
      return { data: state.contactRow, error: null };
    }
    if (table === 'message_templates') {
      // Mesmo nome+idioma, um em cada WABA — exatamente o cenário que a
      // consulta antiga (sem escopo de WABA) não sabia desambiguar.
      return {
        data: [
          {
            id: 'tpl-waba-a',
            user_id: 'user-1',
            name: 'promo',
            language: 'pt_BR',
            waba_id: 'waba-a',
            body_text: 'Corpo do WABA A {{1}}',
            header_type: null,
            header_content: null,
            footer_text: 'Rodape WABA A',
            buttons: null,
            header_media_url: null,
          },
          {
            id: 'tpl-waba-b',
            user_id: 'user-1',
            name: 'promo',
            language: 'pt_BR',
            waba_id: 'waba-b',
            body_text: 'Corpo do WABA B {{1}}',
            header_type: null,
            header_content: null,
            footer_text: 'Rodape WABA B',
            buttons: null,
            header_media_url: null,
          },
        ],
        error: null,
      };
    }
    if (table === 'messages') {
      if (ops.type === 'insert') {
        state.inserted.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops: Ops = { type: 'select', payload: undefined, filters: [] };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(['in', k, v]), b),
      neq: (k: string, v: unknown) => (ops.filters.push(['neq', k, v]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(table, ops)),
      maybeSingle: () => Promise.resolve(resolve(table, ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(table, ops)).then(onF, onR),
    };
    return b;
  }

  const client = {
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ error: null }),
  };

  const cloudAdapter = {
    type: 'whatsapp_cloud' as const,
    capabilities: {} as unknown,
    sendText: vi.fn(async () => ({ providerMessageId: 'wamid.text' })),
    sendMedia: vi.fn(),
    sendTemplate: vi.fn(async () => ({ providerMessageId: 'wamid.tpl' })),
    normalizeInbound: vi.fn(() => []),
  };

  return { state, client, cloudAdapter };
});

vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.client }));
// P-15: `resolveCloudConfig` lê a credencial pelo service role canônico.
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => h.client }));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}));

vi.mock('@/lib/channels/registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/channels/registry')>();
  return {
    ...actual,
    getAdapter: (type: string) =>
      type === 'whatsapp_cloud'
        ? h.cloudAdapter
        : actual.getAdapter(type as never),
  };
});

import { engineSendTemplate } from './meta-send';
import { AccountBlockedError } from '@/lib/platform/blocked';

beforeEach(() => {
  h.state.inserted.length = 0;
  h.state.accountBlockedAt = null;
  h.state.contactRow = { id: 'contact-1', phone: '+5511999990001' };
  h.cloudAdapter.sendTemplate.mockClear();
});

describe('engineSendTemplate — escopo de WABA (SPEC 064 D-2)', () => {
  it('resolve o canal da conversa e adota a linha de message_templates do MESMO WABA, não a de outro número', async () => {
    await engineSendTemplate({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      templateName: 'promo',
      language: 'pt_BR',
      params: ['Bruno'],
    });

    expect(h.cloudAdapter.sendTemplate).toHaveBeenCalledTimes(1);
    const [, params] = h.cloudAdapter.sendTemplate.mock.calls[0] as unknown as [
      unknown,
      { definition?: { id?: string; waba_id?: string } },
    ];
    // A linha adotada tem de ser a do WABA do canal da conversa
    // (waba-b), nunca a do outro número (waba-a) — mesmo nome+idioma.
    expect(params.definition?.id).toBe('tpl-waba-b');
    expect(params.definition?.waba_id).toBe('waba-b');

    expect(h.state.inserted).toHaveLength(1);
    expect(h.state.inserted[0].content_text as string).toContain('WABA B');
    expect(
      (h.state.inserted[0].template_preview as { footer: string }).footer
    ).toBe('Rodape WABA B');
  });
});

// Achado de code review: a resolução do canal (para descobrir o WABA)
// passou a rodar ANTES da validação do contato. Se as duas estiverem
// quebradas ao mesmo tempo, o motivo real (contato inválido) não pode
// ficar mascarado por "conta bloqueada" só porque a nova resolução de
// canal rodou primeiro — a ordem original (contato primeiro, dentro de
// `sendAndPersistOutbound`) tem de prevalecer.
describe('engineSendTemplate — ordem de erro quando conta E contato estão quebrados', () => {
  it('reporta "contato não encontrado", não a conta bloqueada, quando os dois falham', async () => {
    h.state.accountBlockedAt = '2026-08-30T00:00:00.000Z';
    h.state.contactRow = null;

    await expect(
      engineSendTemplate({
        accountId: 'acct-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-missing',
        templateName: 'promo',
        language: 'pt_BR',
      })
    ).rejects.toMatchObject({ message: 'contact not found for this account' });

    // O erro de conta bloqueada existe (a resolução de canal para o WABA
    // o encontrou e degradou), mas não é ele que sobe — prova de que o
    // catch dentro de sendViaMeta não deixou a resolução de canal
    // "furar a fila" na frente da validação do contato.
    expect(h.cloudAdapter.sendTemplate).not.toHaveBeenCalled();
  });

  it('ainda reporta conta bloqueada quando só a conta está quebrada (contato válido)', async () => {
    h.state.accountBlockedAt = '2026-08-30T00:00:00.000Z';

    await expect(
      engineSendTemplate({
        accountId: 'acct-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        templateName: 'promo',
        language: 'pt_BR',
      })
    ).rejects.toBeInstanceOf(AccountBlockedError);
  });
});
