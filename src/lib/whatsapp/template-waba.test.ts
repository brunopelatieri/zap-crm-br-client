import { describe, it, expect, vi } from 'vitest';
import {
  createSupabaseMock,
  type MockResult,
  type QueryOp,
} from '@/lib/audience/supabase-mock';
import {
  assertTemplateChannelCompatible,
  findTemplateRowForWaba,
  templateBelongsToWaba,
  TemplateChannelMismatchError,
} from './template-waba';

const ACCOUNT = 'acct-1';

describe('templateBelongsToWaba (SPEC 064 D-2)', () => {
  it('matches a template whose waba_id equals the channel waba', () => {
    expect(templateBelongsToWaba('waba-a', 'waba-a')).toBe(true);
  });

  it('rejects a template belonging to a DIFFERENT waba', () => {
    expect(templateBelongsToWaba('waba-b', 'waba-a')).toBe(false);
  });

  it('treats a legacy (null) waba_id as belonging to any channel', () => {
    expect(templateBelongsToWaba(null, 'waba-a')).toBe(true);
    expect(templateBelongsToWaba(null, null)).toBe(true);
  });

  it('treats a missing waba_id key (undefined) the same as null', () => {
    expect(templateBelongsToWaba(undefined, 'waba-a')).toBe(true);
  });

  it('rejects a real waba_id when the channel has none on file', () => {
    expect(templateBelongsToWaba('waba-a', null)).toBe(false);
  });
});

function makeDb(candidates: Record<string, unknown>[]) {
  const handler = (table: string, _ops: QueryOp[]): MockResult | undefined => {
    if (table === 'message_templates') return { data: candidates };
    return undefined;
  };
  return createSupabaseMock(handler).db;
}

function makeErrorDb(message: string) {
  const handler = (table: string, _ops: QueryOp[]): MockResult | undefined => {
    if (table === 'message_templates') {
      return { data: null, error: { message } };
    }
    return undefined;
  };
  return createSupabaseMock(handler).db;
}

describe('findTemplateRowForWaba (SPEC 064 D-2)', () => {
  it('returns null when there are no candidates at all', async () => {
    const db = makeDb([]);
    await expect(
      findTemplateRowForWaba(db, {
        accountId: ACCOUNT,
        name: 'promo',
        language: 'en_US',
        wabaId: 'waba-a',
      })
    ).resolves.toBeNull();
  });

  it('picks the row belonging to the requested WABA over a legacy (null) one', async () => {
    const rowA = { id: 't-a', waba_id: 'waba-a' };
    const rowLegacy = { id: 't-legacy', waba_id: null };
    const db = makeDb([rowLegacy, rowA]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: 'waba-a',
    });
    expect(found).toBe(rowA);
  });

  it('never returns a row from a DIFFERENT WABA — the same name legitimately exists twice', async () => {
    const rowB = { id: 't-b', waba_id: 'waba-b' };
    const db = makeDb([rowB]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: 'waba-a',
    });
    expect(found).toBeNull();
  });

  it('adopts a legacy (waba_id NULL) row when no row matches the requested WABA', async () => {
    const rowLegacy = { id: 't-legacy', waba_id: null };
    const db = makeDb([rowLegacy]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: 'waba-a',
    });
    expect(found).toBe(rowLegacy);
  });

  it('treats a row missing the waba_id key as legacy (undefined normalizes to null)', async () => {
    const rowNoKey = { id: 't-no-key' }; // no `waba_id` at all
    const db = makeDb([rowNoKey]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: null,
    });
    expect(found).toBe(rowNoKey);
  });

  it('resolving for wabaId=null matches only the legacy row, not a real-WABA one', async () => {
    const rowA = { id: 't-a', waba_id: 'waba-a' };
    const db = makeDb([rowA]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: null,
    });
    expect(found).toBeNull();
  });

  // SPEC 064 code review — a leitura falhando não pode derrubar o
  // disparo inteiro: todo chamador que esta função substituiu lia com
  // `.maybeSingle()` sem checar `error`, e uma falha transitória
  // degradava para "sem template local" em vez de propagar.
  it('degrades to null (does not throw) on a transient read error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeErrorDb('connection reset');

    await expect(
      findTemplateRowForWaba(db, {
        accountId: ACCOUNT,
        name: 'promo',
        language: 'en_US',
        wabaId: 'waba-a',
      })
    ).resolves.toBeNull();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ------------------------------------------------------------
// SPEC 065 D-3 / §5.3 — compatibilidade template×canal
// ------------------------------------------------------------

/**
 * Banco com UM canal Cloud (`ch-a`, WABA `waba-a`) na conta `acct-1` e
 * os candidatos de `message_templates` que o teste informar. O escopo de
 * conta é respeitado nas duas tabelas: um `channel_id` de outra conta
 * simplesmente não casa.
 */
function makeCompatDb(
  candidates: Record<string, unknown>[],
  opts: { channelWabaId?: string | null; configMissing?: boolean } = {}
) {
  const handler = (table: string, ops: QueryOp[]): MockResult | undefined => {
    if (table === 'message_templates') return { data: candidates };
    if (table === 'whatsapp_config') {
      if (opts.configMissing) return { data: null };
      const eqs = ops
        .filter((o) => o.fn === 'eq')
        .map((o) => o.args as [string, unknown]);
      const wanted = Object.fromEntries(eqs);
      if (wanted.account_id !== ACCOUNT || wanted.channel_id !== 'ch-a') {
        return { data: null };
      }
      // `in`, não `??`: `channelWabaId: null` é um caso do teste (canal
      // Cloud anterior ao backfill da 072), e `??` o trocaria por
      // 'waba-a'.
      return {
        data: {
          waba_id: 'channelWabaId' in opts ? opts.channelWabaId : 'waba-a',
        },
      };
    }
    return undefined;
  };
  return createSupabaseMock(handler).db;
}

const COMPAT = {
  accountId: ACCOUNT,
  channelId: 'ch-a',
  templateName: 'promo_agosto',
  templateLanguage: 'pt_BR',
};

describe('assertTemplateChannelCompatible (SPEC 065 D-3)', () => {
  it('passa quando o template é do MESMO WABA do canal', async () => {
    const db = makeCompatDb([{ id: 't-a', waba_id: 'waba-a' }]);

    await expect(
      assertTemplateChannelCompatible(db, COMPAT)
    ).resolves.toBeUndefined();
  });

  // O caso que a Meta hoje recusa com
  // "(#132001) Template name does not exist in the translation" — só
  // depois de aceitar o payload, cobrar a tentativa e sujar o log.
  it('recusa quando o template pertence a OUTRO WABA, com código estável e 400', async () => {
    const db = makeCompatDb([{ id: 't-b', waba_id: 'waba-b' }]);

    await expect(assertTemplateChannelCompatible(db, COMPAT)).rejects.toThrow(
      TemplateChannelMismatchError
    );

    let err: unknown;
    try {
      await assertTemplateChannelCompatible(db, COMPAT);
    } catch (e) {
      err = e;
    }
    if (!(err instanceof TemplateChannelMismatchError)) {
      throw new Error('esperava TemplateChannelMismatchError');
    }
    expect(err.code).toBe('template_waba_mismatch');
    expect(err.status).toBe(400);
    expect(err.templateWabaId).toBe('waba-b');
    expect(err.channelWabaId).toBe('waba-a');
    // Mensagem em inglês (AGENTS.md: `/api/**` fala inglês, a UI traduz),
    // nomeando AS DUAS pontas — sem os dois WABAs, o operador não sabe
    // se troca o template ou o número.
    expect(err.message).toContain('promo_agosto');
    expect(err.message).toContain('waba-a');
    expect(err.message).toContain('waba-b');
  });

  it('template legado (waba_id NULL) serve para qualquer canal', async () => {
    const db = makeCompatDb([{ id: 't-legacy', waba_id: null }]);

    await expect(
      assertTemplateChannelCompatible(db, COMPAT)
    ).resolves.toBeUndefined();
  });

  it('basta UM candidato compatível entre vários do mesmo nome', async () => {
    const db = makeCompatDb([
      { id: 't-b', waba_id: 'waba-b' },
      { id: 't-a', waba_id: 'waba-a' },
    ]);

    await expect(
      assertTemplateChannelCompatible(db, COMPAT)
    ).resolves.toBeUndefined();
  });

  // Template que não existe LOCALMENTE é caminho suportado (`templateRow:
  // null` nos chamadores, corpo simples). Não há mismatch a provar.
  it('não recusa quando o nome não existe na tabela local', async () => {
    const db = makeCompatDb([]);

    await expect(
      assertTemplateChannelCompatible(db, COMPAT)
    ).resolves.toBeUndefined();
  });

  // Canal de outra conta: `wabaIdOfChannel` devolve "não sei". Inventar
  // um mismatch aqui daria ao operador o erro ERRADO — quem recusa esse
  // canal é `resolveCloudConfig`, com `not_found`, e nada é enviado.
  it('canal de outra conta não vira mismatch — a recusa é de resolveCloudConfig', async () => {
    const db = makeCompatDb([{ id: 't-b', waba_id: 'waba-b' }]);

    await expect(
      assertTemplateChannelCompatible(db, {
        ...COMPAT,
        channelId: 'ch-de-outra-conta',
      })
    ).resolves.toBeUndefined();
  });

  it('canal sem linha de credencial não vira mismatch', async () => {
    const db = makeCompatDb([{ id: 't-b', waba_id: 'waba-b' }], {
      configMissing: true,
    });

    await expect(
      assertTemplateChannelCompatible(db, COMPAT)
    ).resolves.toBeUndefined();
  });

  // Mesmo raciocínio de `findTemplateRowForWaba`: um soluço de leitura
  // não pode derrubar uma campanha legítima com um 400 inventado.
  it('erro transitório ao ler os candidatos degrada, não recusa', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = (table: string): MockResult | undefined => {
      if (table === 'message_templates') {
        return { data: null, error: { message: 'connection reset' } };
      }
      if (table === 'whatsapp_config') return { data: { waba_id: 'waba-a' } };
      return undefined;
    };
    const db = createSupabaseMock(handler).db;

    await expect(
      assertTemplateChannelCompatible(db, COMPAT)
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('canal Cloud sem WABA gravado aceita o legado e recusa o de WABA real', async () => {
    const legacyOk = makeCompatDb([{ id: 't-legacy', waba_id: null }], {
      channelWabaId: null,
    });
    await expect(
      assertTemplateChannelCompatible(legacyOk, COMPAT)
    ).resolves.toBeUndefined();

    const realWaba = makeCompatDb([{ id: 't-a', waba_id: 'waba-a' }], {
      channelWabaId: null,
    });
    await expect(
      assertTemplateChannelCompatible(realWaba, COMPAT)
    ).rejects.toThrow(TemplateChannelMismatchError);
  });
});
