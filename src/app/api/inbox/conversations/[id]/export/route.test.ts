import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 067 F7 — POST /api/inbox/conversations/[id]/export
//
// O foco é a ROTA: as guardas (papel, frequência, corpo, fuso, teto), a
// ORDEM delas, o 404 genérico e o vínculo entre o `exportId` impresso no
// PDF e a linha da trilha. Coleta, render e zip são mockados na
// fronteira — cada um já tem teste próprio.
// ---------------------------------------------------------------------------

const auditInserts: Array<Record<string, unknown>> = [];
let auditInsertResult: { error: { message: string } | null } = { error: null };
let auditInsertThrows = false;

let threadResult: unknown = null;
let renderedHeader: Record<string, unknown> | null = null;

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return { ...actual, requireRole: vi.fn() };
});

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        if (auditInsertThrows) throw new Error('trilha caiu');
        auditInserts.push(row);
        return Promise.resolve(auditInsertResult);
      },
    }),
  }),
}));

const recordActivityMock = vi.fn(async () => undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivityMock(...(args as [])),
}));

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'pt-BR',
  // Devolve a própria chave — o teste não afere tradução, e assim
  // qualquer chave ausente apareceria como texto óbvio.
  getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/lib/inbox/export/fetch-thread', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/inbox/export/fetch-thread')>();
  return { ...actual, fetchThreadForExport: vi.fn(async () => threadResult) };
});

vi.mock('@/lib/inbox/export/fetch-media', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/inbox/export/fetch-media')>();
  return { ...actual, fetchMediaBytes: vi.fn(async () => new Map()) };
});

vi.mock('@/lib/inbox/export/pdf', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/inbox/export/pdf')>();
  return {
    ...actual,
    renderConversationPdf: vi.fn(
      async (input: { header: Record<string, unknown> }) => {
        renderedHeader = input.header;
        return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
      }
    ),
  };
});

import { ForbiddenError, requireRole } from '@/lib/auth/account';
import { fetchThreadForExport } from '@/lib/inbox/export/fetch-thread';
import { fetchMediaBytes } from '@/lib/inbox/export/fetch-media';
import { CONVERSATION_EXPORT_MAX_MESSAGES } from '@/lib/inbox/export/fetch-thread';
import { POST } from './route';

const CONVERSATION_ID = '11111111-2222-3333-4444-555555555555';

/** Cada teste usa um usuário próprio: o rate limit é um Map de processo
 *  e vazaria de um teste para o outro. */
let userSeq = 0;
function nextUserId(): string {
  userSeq += 1;
  return `user-${userSeq}`;
}

function mockContext(userId: string) {
  vi.mocked(requireRole).mockResolvedValue({
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { full_name: 'João Pereira' },
              error: null,
            }),
          }),
        }),
      }),
    },
    userId,
    accountId: 'acct-1',
    role: 'agent',
    account: { id: 'acct-1', name: 'Loja da Maria' },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
}

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    conversation: { id: CONVERSATION_ID, channel_id: 'chan-1' },
    contact: { id: 'contact-1', name: 'Maria Silva', phone: '5511999999999' },
    channel: { id: 'chan-1', name: 'Oficial', identifier: '+5511400000000' },
    agentNames: new Map(),
    messages: [
      {
        id: 'm1',
        conversation_id: CONVERSATION_ID,
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'Oi',
        status: 'delivered',
        created_at: '2026-08-12T14:32:00.000Z',
      },
    ],
    reactions: [],
    truncated: false,
    total: 1,
    ...overrides,
  };
}

function post(body: unknown, id = CONVERSATION_ID) {
  return POST(
    new Request('http://localhost/api/inbox/conversations/x/export', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

const validBody = { format: 'pdf', timeZone: 'America/Sao_Paulo' };

beforeEach(() => {
  vi.clearAllMocks();
  auditInserts.length = 0;
  auditInsertResult = { error: null };
  auditInsertThrows = false;
  threadResult = makeThread();
  renderedHeader = null;
  mockContext(nextUserId());
});

describe('guardas de autorização', () => {
  it('viewer recebe 403 e não toca no banco', async () => {
    vi.mocked(requireRole).mockRejectedValue(
      new ForbiddenError("This action requires the 'agent' role or higher")
    );

    const res = await post(validBody);
    expect(res.status).toBe(403);
    expect(fetchThreadForExport).not.toHaveBeenCalled();
  });

  it('conversa invisível para o chamador devolve 404 genérico, nunca 403', async () => {
    threadResult = null;
    const res = await post(validBody);

    expect(res.status).toBe(404);
    // Um 403 aqui confirmaria a existência da conversa para quem sonda ids.
    expect(res.status).not.toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Conversation not found',
    });
  });

  it('id que não é UUID devolve 404 sem consultar o banco', async () => {
    const res = await post(validBody, 'nao-e-uuid');
    expect(res.status).toBe(404);
    expect(fetchThreadForExport).not.toHaveBeenCalled();
  });
});

describe('validação do corpo', () => {
  it('formato desconhecido devolve 400 em inglês (regra de /api/**)', async () => {
    const res = await post({ format: 'docx', timeZone: 'UTC' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'format must be "pdf" or "zip"',
    });
  });

  it('corpo não-JSON devolve 400', async () => {
    const res = await POST(
      new Request('http://localhost/x', { method: 'POST', body: 'nada' }),
      { params: Promise.resolve({ id: CONVERSATION_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it('fuso inválido é 400, não 500', async () => {
    const res = await post({ format: 'pdf', timeZone: 'Marte/Olympus' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'timeZone is not a valid IANA time zone',
    });
  });

  it('from depois de to devolve 400', async () => {
    const res = await post({
      format: 'pdf',
      timeZone: 'UTC',
      from: '2026-08-20',
      to: '2026-08-10',
    });
    expect(res.status).toBe(400);
  });

  it('data sem sentido devolve 400', async () => {
    const res = await post({ format: 'pdf', timeZone: 'UTC', from: 'ontem' });
    expect(res.status).toBe(400);
  });

  it('período em data pura chega à coleta expandido para o dia inteiro', async () => {
    await post({
      format: 'pdf',
      timeZone: 'America/Sao_Paulo',
      from: '2026-08-12',
      to: '2026-08-12',
    });

    expect(fetchThreadForExport).toHaveBeenCalledWith(expect.anything(), {
      conversationId: CONVERSATION_ID,
      from: '2026-08-12T03:00:00.000Z',
      to: '2026-08-13T02:59:59.999Z',
    });
  });
});

describe('teto de mensagens', () => {
  it('acima do teto devolve 413 com o total', async () => {
    threadResult = makeThread({ truncated: true, total: 25_000, messages: [] });

    const res = await post(validBody);
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: 'export_too_large',
      total: 25_000,
      max: CONVERSATION_EXPORT_MAX_MESSAGES,
    });
  });
});

describe('frequência (D-9)', () => {
  it('a quarta exportação em 10 minutos devolve 429 com Retry-After', async () => {
    const shared = nextUserId();
    mockContext(shared);

    for (let i = 0; i < 3; i++) {
      const ok = await post(validBody);
      expect(ok.status).toBe(200);
    }

    const res = await post(validBody);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('caminho feliz', () => {
  it('devolve o PDF com Content-Disposition contendo filename*', async () => {
    const res = await post(validBody);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('attachment;');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain('.pdf');
  });

  it('publica os contadores de diagnóstico nos cabeçalhos', async () => {
    const res = await post(validBody);
    expect(res.headers.get('X-Export-Message-Count')).toBe('1');
    expect(res.headers.get('X-Export-Media-Count')).toBe('0');
    expect(res.headers.get('X-Export-Media-Missing')).toBe('0');
  });

  it('grava UMA linha na trilha, com o mesmo id impresso no PDF', async () => {
    await post(validBody);

    expect(auditInserts).toHaveLength(1);
    const row = auditInserts[0];
    // É esse vínculo que permite pegar um PDF em papel e achar quem o
    // exportou (§9.1).
    expect(row.id).toBe(renderedHeader?.exportId);
    expect(row.account_id).toBe('acct-1');
    expect(row.conversation_id).toBe(CONVERSATION_ID);
    expect(row.contact_id).toBe('contact-1');
    expect(row.format).toBe('pdf');
    expect(row.message_count).toBe(1);
  });

  it('SPEC 075 F3: registra conversation.exported no feed de atividade', async () => {
    await post(validBody);

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        resourceType: 'conversation',
        action: 'conversation.exported',
        resourceId: CONVERSATION_ID,
        contactId: 'contact-1',
        source: { table: 'conversation_exports', id: renderedHeader?.exportId },
      })
    );
  });

  it('formato zip devolve application/zip', async () => {
    const res = await post({ ...validBody, format: 'zip' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
  });

  it('no formato só-PDF nenhuma mídia não-imagem é baixada', async () => {
    // Sem anexo nenhum no transcrito, o plano fica vazio e não há
    // motivo para uma única viagem ao Storage.
    await post(validBody);
    expect(fetchMediaBytes).not.toHaveBeenCalled();
  });
});

describe('contagem de mídia ausente (regressão de review)', () => {
  it('vídeo nunca baixado no formato só-PDF NÃO conta como ausente', async () => {
    // Antes do fix, `missingMedia` usava `plan.length` (TODOS os
    // anexos, inclusive vídeo/áudio/documento que o formato PDF nunca
    // tenta baixar por design) em vez de `planToFetch.length` (só o que
    // foi de fato tentado) — um vídeo virava "mídia ausente" na trilha
    // de auditoria e no toast do usuário sem nunca ter falhado nada.
    threadResult = makeThread({
      messages: [
        {
          id: 'm-img',
          conversation_id: CONVERSATION_ID,
          sender_type: 'customer',
          content_type: 'image',
          media_path: 'acc-1/foto.jpg',
          status: 'delivered',
          created_at: '2026-08-12T14:32:00.000Z',
        },
        {
          id: 'm-vid',
          conversation_id: CONVERSATION_ID,
          sender_type: 'customer',
          content_type: 'video',
          media_path: 'acc-1/video.mp4',
          status: 'delivered',
          created_at: '2026-08-12T14:33:00.000Z',
        },
      ],
      total: 2,
    });
    vi.mocked(fetchMediaBytes).mockResolvedValueOnce(
      new Map([
        [
          1,
          {
            index: 1,
            status: 'ok',
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'image/jpeg',
            byteLength: 3,
          },
        ],
      ])
    );

    const res = await post(validBody); // validBody.format === 'pdf'

    expect(res.status).toBe(200);
    // A imagem foi baixada e deu certo; o vídeo nunca foi tentado (é
    // cartão por design) — nem um nem outro é "ausente".
    expect(res.headers.get('X-Export-Media-Missing')).toBe('0');
  });

  it('imagem que falha de verdade no formato só-PDF continua contando como ausente', async () => {
    threadResult = makeThread({
      messages: [
        {
          id: 'm-img',
          conversation_id: CONVERSATION_ID,
          sender_type: 'customer',
          content_type: 'image',
          media_path: 'acc-1/foto.jpg',
          status: 'delivered',
          created_at: '2026-08-12T14:32:00.000Z',
        },
      ],
      total: 1,
    });
    vi.mocked(fetchMediaBytes).mockResolvedValueOnce(
      new Map([
        [
          1,
          {
            index: 1,
            status: 'missing',
            bytes: null,
            mimeType: null,
            byteLength: 0,
          },
        ],
      ])
    );

    const res = await post(validBody);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Export-Media-Missing')).toBe('1');
  });

  it('maxFileBytes do modo só-PDF não passa de maxTotalBytes', async () => {
    // Regressão do achado de review: `EMBEDDED_IMAGE_LIMITS` reduzia só
    // `maxTotalBytes` para 40MB e herdava `maxFileBytes` em 50MB do
    // padrão — um único arquivo abaixo do teto POR ARQUIVO já estourava
    // sozinho o orçamento TOTAL do modo, porque a checagem de total só
    // roda antes de cada download começar, não durante.
    threadResult = makeThread({
      messages: [
        {
          id: 'm-img',
          conversation_id: CONVERSATION_ID,
          sender_type: 'customer',
          content_type: 'image',
          media_path: 'acc-1/foto.jpg',
          status: 'delivered',
          created_at: '2026-08-12T14:32:00.000Z',
        },
      ],
      total: 1,
    });

    await post(validBody); // validBody.format === 'pdf'

    const call = vi.mocked(fetchMediaBytes).mock.calls[0];
    const limits = call[3] as { maxFileBytes: number; maxTotalBytes: number };
    expect(limits.maxFileBytes).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(limits.maxFileBytes).toBe(40 * 1024 * 1024);
  });
});

describe('resiliência da trilha', () => {
  it('erro no INSERT não derruba o download', async () => {
    auditInsertResult = { error: { message: 'permission denied' } };

    const res = await post(validBody);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('exceção no INSERT não derruba o download', async () => {
    auditInsertThrows = true;

    const res = await post(validBody);
    expect(res.status).toBe(200);
  });
});
