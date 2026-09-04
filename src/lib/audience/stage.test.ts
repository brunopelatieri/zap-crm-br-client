import { describe, expect, it } from 'vitest';

import { stageAudience } from './stage';
import { createSupabaseMock, opArgs } from './supabase-mock';

const ACCOUNT = 'acct-1';
const USER = 'user-1';
const TEMPLATE = 'promo';
const LANG = 'pt_BR';

function templateFound(table: string) {
  return table === 'message_templates'
    ? { data: [{ id: 'tpl-1' }] }
    : undefined;
}

describe('stageAudience — csv', () => {
  it('cruza telefones válidos com contatos existentes, sem materializar', async () => {
    const inserted: unknown[][] = [];

    const mock = createSupabaseMock((table, ops) => {
      const found = templateFound(table);
      if (found) return found;

      if (table === 'contacts') {
        // Cross-reference: só a primeira linha já é contato.
        return { data: [{ id: 'c-1', phone: '+5511999990001' }] };
      }
      if (table === 'broadcasts') {
        if (opArgs(ops, 'insert')) return { data: { id: 'draft-1' } };
        return undefined;
      }
      if (table === 'broadcast_audience_staging') {
        inserted.push(opArgs(ops, 'insert')?.[0] as unknown[]);
        return { data: null };
      }
      return undefined;
    });

    const result = await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: {
        type: 'csv',
        rows: [
          { phone: '+5511999990001', name: 'Alice', sourceRow: 2 },
          { phone: '+5511999990002', name: 'Bob', sourceRow: 3 },
        ],
        invalidRows: [
          { sourceRow: 4, rawPhone: 'abc', reason: 'invalid_length' },
        ],
      },
    });

    expect(result.draftId).toBe('draft-1');
    expect(result.summary).toEqual({
      read: 3,
      valid: 2,
      duplicates: 0,
      invalid: 1,
      existingContacts: 1,
      // c-1 já existente sem email/company na planilha → nada a
      // atualizar; a segunda linha não tem contato → 1 criação.
      willCreate: 1,
      willUpdate: 0,
      tagsToCreate: [],
      tagsSkipped: [],
    });

    // Nunca insere/atualiza `contacts` — a materialização é do envio.
    expect(mock.callsFor('contacts').some((c) => opArgs(c.ops, 'insert'))).toBe(
      false
    );

    expect(inserted).toHaveLength(1);
    const rows = inserted[0] as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      phone: '+5511999990001',
      existing_contact_id: 'c-1',
      invalid_reason: null,
    });
    expect(rows[1]).toMatchObject({
      phone: '+5511999990002',
      existing_contact_id: null,
      invalid_reason: null,
    });
    expect(rows[2]).toMatchObject({
      phone: 'abc',
      invalid_reason: 'invalid_length',
      source_row: 4,
    });
  });

  it('desmarca automaticamente quem está em cooldown após o stage (§6.2)', async () => {
    const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

    const mock = createSupabaseMock(
      (table, ops) => {
        const found = templateFound(table);
        if (found) return found;
        if (table === 'contacts') return { data: [] };
        if (table === 'broadcasts') {
          if (opArgs(ops, 'insert')) return { data: { id: 'draft-3' } };
          return undefined;
        }
        if (table === 'broadcast_audience_staging') return { data: null };
        return undefined;
      },
      (fn, args) => {
        rpcCalls.push({ fn, args });
        return { data: 2 };
      }
    );

    await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: {
        type: 'csv',
        rows: [{ phone: '+5511999990001', name: 'Alice', sourceRow: 2 }],
        invalidRows: [],
      },
    });

    expect(rpcCalls).toEqual([
      {
        fn: 'triage_set_selection',
        args: {
          p_draft_id: 'draft-3',
          p_selected: false,
          p_search: null,
          p_filter: 'cooldown',
        },
      },
    ]);
  });

  it('não derruba o stage se o auto-deselect de cooldown falhar', async () => {
    const mock = createSupabaseMock(
      (table, ops) => {
        const found = templateFound(table);
        if (found) return found;
        if (table === 'contacts') return { data: [] };
        if (table === 'broadcasts') {
          if (opArgs(ops, 'insert')) return { data: { id: 'draft-4' } };
          return undefined;
        }
        if (table === 'broadcast_audience_staging') return { data: null };
        return undefined;
      },
      () => ({ error: new Error('boom') })
    );

    const result = await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: {
        type: 'csv',
        rows: [{ phone: '+5511999990001', name: 'Alice', sourceRow: 2 }],
        invalidRows: [],
      },
    });

    expect(result.draftId).toBe('draft-4');
  });

  // SPEC 064 D-2 — stage.ts não escolhe WABA (o canal só é escolhido no
  // Step 4), então a checagem de existência tem de aceitar as DUAS
  // linhas sem estourar. Antes desta correção, `.maybeSingle()` devolvia
  // erro para "multiple rows" e o código, ignorando `error`, tratava
  // isso como `template_not_found` — um falso negativo bem no meio do
  // cenário que a SPEC 064 introduziu.
  it('não rejeita quando o mesmo nome+idioma existe em dois WABAs', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'message_templates') {
        return {
          data: [{ id: 'tpl-waba-a' }, { id: 'tpl-waba-b' }],
        };
      }
      if (table === 'contacts') return { data: [] };
      if (table === 'broadcasts') return { data: { id: 'draft-two-waba' } };
      if (table === 'broadcast_audience_staging') return { data: null };
      return undefined;
    });

    const result = await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: {
        type: 'csv',
        rows: [{ phone: '+5511999990001', name: 'Alice', sourceRow: 2 }],
        invalidRows: [],
      },
    });

    expect(result.draftId).toBe('draft-two-waba');
  });

  it('rejeita quando o template não existe para a conta', async () => {
    const mock = createSupabaseMock((table) =>
      table === 'message_templates' ? { data: null } : undefined
    );

    await expect(
      stageAudience(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        templateName: TEMPLATE,
        templateLanguage: LANG,
        canCreateTags: false,
        audience: { type: 'csv', rows: [], invalidRows: [] },
      })
    ).rejects.toMatchObject({ code: 'template_not_found' });
  });

  it('rejeita um arquivo vazio', async () => {
    const mock = createSupabaseMock((table) => templateFound(table));

    await expect(
      stageAudience(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        templateName: TEMPLATE,
        templateLanguage: LANG,
        canCreateTags: false,
        audience: { type: 'csv', rows: [], invalidRows: [] },
      })
    ).rejects.toMatchObject({ code: 'empty_audience' });
  });

  // SPEC 057 D-7 — a projeção mostrada na triagem, sem escrever nada.
  it('projeta willUpdate quando o contato existente tem campo vazio e a planilha traz valor', async () => {
    const mock = createSupabaseMock((table) => {
      const found = templateFound(table);
      if (found) return found;
      if (table === 'contacts') {
        // Contato existente SEM email — a planilha traz um.
        return {
          data: [
            {
              id: 'c-1',
              phone: '+5511999990001',
              email: null,
              company: 'Acme',
            },
          ],
        };
      }
      if (table === 'broadcasts') return { data: { id: 'draft-5' } };
      if (table === 'broadcast_audience_staging') return { data: null };
      return undefined;
    });

    const result = await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: {
        type: 'csv',
        // company já preenchida (Acme) — não conta como update; email vazio conta.
        rows: [
          {
            phone: '+5511999990001',
            name: 'Alice',
            email: 'alice@example.com',
            company: 'Acme',
            sourceRow: 2,
          },
        ],
        invalidRows: [],
      },
    });

    expect(result.summary.willCreate).toBe(0);
    expect(result.summary.willUpdate).toBe(1);
  });

  it('projeta tagsToCreate quando canCreateTags e tagsSkipped quando não', async () => {
    const baseMock = () =>
      createSupabaseMock((table) => {
        const found = templateFound(table);
        if (found) return found;
        if (table === 'contacts') return { data: [] };
        if (table === 'tags') {
          // Conta já tem "vip"; "novaetiqueta" ainda não existe.
          return { data: [{ name: 'vip' }] };
        }
        if (table === 'broadcasts') return { data: { id: 'draft-6' } };
        if (table === 'broadcast_audience_staging') return { data: null };
        return undefined;
      });

    const rowsWithTags = {
      type: 'csv' as const,
      rows: [
        {
          phone: '+5511999990001',
          name: 'Alice',
          tagNames: ['vip', 'novaetiqueta'],
          sourceRow: 2,
        },
      ],
      invalidRows: [],
    };

    const adminMock = baseMock();
    const admin = await stageAudience(adminMock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: true,
      audience: rowsWithTags,
    });
    expect(admin.summary.tagsToCreate).toEqual(['novaetiqueta']);
    expect(admin.summary.tagsSkipped).toEqual([]);
    // Projeção pura — nenhuma escrita em `tags` (D-7).
    expect(
      adminMock
        .callsFor('tags')
        .some((c) => c.ops.some((o) => o.fn === 'insert'))
    ).toBe(false);

    const agentMock = baseMock();
    const agent = await stageAudience(agentMock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: rowsWithTags,
    });
    expect(agent.summary.tagsToCreate).toEqual([]);
    expect(agent.summary.tagsSkipped).toEqual(['novaetiqueta']);
  });
});

describe('stageAudience — tags', () => {
  it('resolve contatos por etiqueta e aplica excludeTagIds', async () => {
    const inserted: unknown[][] = [];

    const mock = createSupabaseMock((table, ops) => {
      const found = templateFound(table);
      if (found) return found;

      if (table === 'contact_tags') {
        const inArgs = opArgs(ops, 'in');
        if (inArgs?.[0] === 'tag_id') {
          return { data: [{ contact_id: 'c-1' }, { contact_id: 'c-2' }] };
        }
        return { data: [] };
      }
      if (table === 'contacts') {
        const ids = (opArgs(ops, 'in')?.[1] ?? []) as string[];
        return {
          data: ids.map((id) => ({ id, phone: `+551199999${id}` })),
        };
      }
      if (table === 'broadcasts') {
        if (opArgs(ops, 'insert')) return { data: { id: 'draft-2' } };
        return undefined;
      }
      if (table === 'broadcast_audience_staging') {
        inserted.push(opArgs(ops, 'insert')?.[0] as unknown[]);
        return { data: null };
      }
      return undefined;
    });

    const result = await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: { type: 'tags', tagIds: ['t-1'] },
    });

    expect(result.draftId).toBe('draft-2');
    expect(result.summary.valid).toBe(2);
    expect(result.summary.willCreate).toBe(0);
    expect(result.summary.willUpdate).toBe(0);
    expect(result.summary.tagsToCreate).toEqual([]);
    expect(result.summary.tagsSkipped).toEqual([]);
    const rows = inserted[0] as Record<string, unknown>[];
    expect(rows.map((r) => r.existing_contact_id)).toEqual(['c-1', 'c-2']);
    // Contatos já existentes: nenhuma linha nasce inválida.
    expect(rows.every((r) => r.invalid_reason === null)).toBe(true);
  });

  it('rejeita quando o filtro não encontra nenhum contato', async () => {
    const mock = createSupabaseMock((table) => {
      const found = templateFound(table);
      if (found) return found;
      return { data: [] };
    });

    await expect(
      stageAudience(mock.db, {
        accountId: ACCOUNT,
        userId: USER,
        templateName: TEMPLATE,
        templateLanguage: LANG,
        canCreateTags: false,
        audience: { type: 'tags', tagIds: ['t-empty'] },
      })
    ).rejects.toMatchObject({ code: 'empty_audience' });
  });
});

describe('stageAudience — audience_filter na criação (achado de code review, SPEC 070 D-3)', () => {
  // Sem isto, `hydrateAudienceConfig` (draft.ts) nunca tem de onde ler
  // a origem de volta — este é o ÚNICO momento em que ela existe ainda
  // não colapsada em `staged` (o resto do assistente, retomada de
  // triagem incluída, só vê `audience` já como `{type:'staged'}`).

  it('grava o filtro real (tags) no INSERT — não fica null', async () => {
    let insertPayload: Record<string, unknown> | undefined;

    const mock = createSupabaseMock((table, ops) => {
      const found = templateFound(table);
      if (found) return found;

      if (table === 'contact_tags') {
        // A mesma tabela resolve tagIds E excludeTagIds — precisa
        // diferenciar pelo `.in('tag_id', …)` de cada chamada, senão a
        // exclusão devolveria o MESMO contato que a inclusão trouxe.
        const inArgs = opArgs(ops, 'in');
        if (inArgs?.[0] === 'tag_id' && (inArgs[1] as string[])[0] === 't-1') {
          return { data: [{ contact_id: 'c-1' }] };
        }
        return { data: [] };
      }
      if (table === 'contacts')
        return { data: [{ id: 'c-1', phone: '+5511999990001' }] };
      if (table === 'broadcasts') {
        const args = opArgs(ops, 'insert');
        if (args) {
          insertPayload = args[0] as Record<string, unknown>;
          return { data: { id: 'draft-1' } };
        }
        return undefined;
      }
      if (table === 'broadcast_audience_staging') return { data: null };
      return undefined;
    });

    await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: {
        type: 'tags',
        tagIds: ['t-1'],
        excludeTagIds: ['t-vip'],
      },
    });

    expect(insertPayload?.audience_filter).toEqual({
      type: 'tags',
      tagIds: ['t-1'],
      customField: undefined,
      excludeTagIds: ['t-vip'],
    });
  });

  it('grava o filtro real (custom_field) no INSERT', async () => {
    let insertPayload: Record<string, unknown> | undefined;

    const mock = createSupabaseMock((table, ops) => {
      const found = templateFound(table);
      if (found) return found;
      if (table === 'contact_custom_values')
        return { data: [{ contact_id: 'c-1' }] };
      if (table === 'contacts')
        return { data: [{ id: 'c-1', phone: '+5511999990001' }] };
      if (table === 'broadcasts') {
        const args = opArgs(ops, 'insert');
        if (args) {
          insertPayload = args[0] as Record<string, unknown>;
          return { data: { id: 'draft-1' } };
        }
        return undefined;
      }
      if (table === 'broadcast_audience_staging') return { data: null };
      return undefined;
    });

    const customField = {
      fieldId: 'f-1',
      operator: 'is' as const,
      value: 'ativo',
    };
    await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: { type: 'custom_field', customField },
    });

    expect(insertPayload?.audience_filter).toEqual({
      type: 'custom_field',
      tagIds: undefined,
      customField,
      excludeTagIds: undefined,
    });
  });

  it('csv grava só o marcador de D-4 (importedRows), nunca as linhas', async () => {
    let insertPayload: Record<string, unknown> | undefined;

    const mock = createSupabaseMock((table, ops) => {
      const found = templateFound(table);
      if (found) return found;
      if (table === 'contacts') return { data: [] };
      if (table === 'broadcasts') {
        const args = opArgs(ops, 'insert');
        if (args) {
          insertPayload = args[0] as Record<string, unknown>;
          return { data: { id: 'draft-1' } };
        }
        return undefined;
      }
      if (table === 'broadcast_audience_staging') return { data: null };
      return undefined;
    });

    await stageAudience(mock.db, {
      accountId: ACCOUNT,
      userId: USER,
      templateName: TEMPLATE,
      templateLanguage: LANG,
      canCreateTags: false,
      audience: {
        type: 'csv',
        rows: [{ phone: '+5511999990001', name: 'Alice', sourceRow: 2 }],
        invalidRows: [],
      },
    });

    expect(insertPayload?.audience_filter).toEqual({
      type: 'csv',
      importedRows: 1,
    });
  });
});

// ============================================================
// SPEC 070 §5.2 — trocar a audiência de um rascunho (F6)
// ============================================================

const DRAFT = '11111111-2222-4333-8444-555555555555';

/**
 * Mock do caminho de re-staging: template existe, o rascunho existe e
 * ainda é `draft`, e o filtro resolve para um contato.
 *
 * `broadcastRow` permite o teste trocar o estado da linha (enviada,
 * funil de webhook, inexistente) sem reescrever o resto.
 */
function restageMock(
  options: {
    broadcastRow?: Record<string, unknown> | null;
    stagingInsertError?: unknown;
    updateResult?: { data?: unknown; error?: unknown };
  } = {}
) {
  const {
    broadcastRow = { id: DRAFT, status: 'draft', source: 'dashboard' },
    stagingInsertError,
    updateResult = { data: { id: DRAFT } },
  } = options;

  return createSupabaseMock((table, ops) => {
    const found = templateFound(table);
    if (found) return found;

    if (table === 'contacts') {
      return { data: [{ id: 'c-1', phone: '+5511999990001' }] };
    }
    if (table === 'contact_tags') {
      return { data: [{ contact_id: 'c-1' }] };
    }
    if (table === 'broadcasts') {
      if (opArgs(ops, 'update')) return updateResult;
      // Leitura de pré-condição do rascunho.
      return { data: broadcastRow };
    }
    if (table === 'broadcast_audience_staging') {
      if (opArgs(ops, 'insert')) {
        return stagingInsertError
          ? { error: stagingInsertError }
          : { data: null };
      }
      return { data: null };
    }
    return undefined;
  });
}

function restageParams() {
  return {
    accountId: ACCOUNT,
    userId: USER,
    templateName: TEMPLATE,
    templateLanguage: LANG,
    canCreateTags: false,
    audience: { type: 'tags' as const, tagIds: ['t-1'] },
    draftId: DRAFT,
  };
}

describe('stageAudience — troca de audiência (draftId)', () => {
  it('apaga o staging antigo, insere o novo e ATUALIZA o rascunho — sem INSERT em broadcasts', async () => {
    const mock = restageMock();

    const result = await stageAudience(mock.db, restageParams());

    expect(result.draftId).toBe(DRAFT);

    // A linha é a mesma: nada de um segundo rascunho ao lado (§1.3).
    expect(
      mock.callsFor('broadcasts').some((c) => opArgs(c.ops, 'insert'))
    ).toBe(false);

    const purge = mock
      .callsFor('broadcast_audience_staging')
      .find((c) => c.ops.some((o) => o.fn === 'delete'));
    expect(purge).toBeDefined();
    expect(
      purge?.ops.some(
        (o) =>
          o.fn === 'eq' && o.args[0] === 'broadcast_id' && o.args[1] === DRAFT
      )
    ).toBe(true);

    const update = mock
      .callsFor('broadcasts')
      .find((c) => opArgs(c.ops, 'update'));
    expect(update).toBeDefined();
    const payload = opArgs(update!.ops, 'update')?.[0] as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      template_name: TEMPLATE,
      template_language: LANG,
      total_recipients: 1,
    });
    // A pré-condição de estado é o que impede sobrescrever uma campanha
    // que outra aba já disparou.
    expect(
      update!.ops.some(
        (o) => o.fn === 'eq' && o.args[0] === 'status' && o.args[1] === 'draft'
      )
    ).toBe(true);
  });

  it('reescreve audience_filter para a origem nova — o filtro antigo não pode sobreviver à troca', async () => {
    const mock = restageMock();
    await stageAudience(mock.db, restageParams());

    const update = mock
      .callsFor('broadcasts')
      .find((c) => opArgs(c.ops, 'update'));
    const payload = opArgs(update!.ops, 'update')?.[0] as Record<
      string,
      unknown
    >;
    // Depois da troca a audiência de verdade é a TRIADA — quem manda é
    // a seleção da triagem, não o filtro que a originou.
    expect(payload.audience_filter).toEqual({ type: 'staged', draftId: DRAFT });
  });

  it('importação grava o marcador de D-4 (nunca as linhas) em audience_filter', async () => {
    const mock = restageMock();

    await stageAudience(mock.db, {
      ...restageParams(),
      audience: {
        type: 'csv',
        rows: [{ phone: '+5511999990001', name: 'Alice', sourceRow: 2 }],
        invalidRows: [],
      },
    });

    const update = mock
      .callsFor('broadcasts')
      .find((c) => opArgs(c.ops, 'update'));
    const payload = opArgs(update!.ops, 'update')?.[0] as Record<
      string,
      unknown
    >;
    expect(payload.audience_filter).toEqual({ type: 'csv', importedRows: 1 });
  });

  it('não sobrescreve channel_id quando o cliente não mandou canal', async () => {
    const mock = restageMock();
    await stageAudience(mock.db, restageParams());

    const update = mock
      .callsFor('broadcasts')
      .find((c) => opArgs(c.ops, 'update'));
    const payload = opArgs(update!.ops, 'update')?.[0] as Record<
      string,
      unknown
    >;
    expect('channel_id' in payload).toBe(false);
  });

  it('draft_not_found quando a campanha já saiu de draft — staging antigo intacto', async () => {
    const mock = restageMock({
      broadcastRow: { id: DRAFT, status: 'sent', source: 'dashboard' },
    });

    await expect(stageAudience(mock.db, restageParams())).rejects.toMatchObject(
      { code: 'draft_not_found' }
    );

    // Falhou ANTES de tocar no staging: a audiência anterior continua lá.
    expect(mock.callsFor('broadcast_audience_staging')).toHaveLength(0);
  });

  it('draft_not_found quando a linha não existe (ou é de outra conta)', async () => {
    const mock = restageMock({ broadcastRow: null });

    await expect(stageAudience(mock.db, restageParams())).rejects.toMatchObject(
      { code: 'draft_not_found' }
    );
  });

  it('recusa um funil de webhook — ele não tem passo de audiência', async () => {
    const mock = restageMock({
      broadcastRow: { id: DRAFT, status: 'draft', source: 'webhook' },
    });

    await expect(stageAudience(mock.db, restageParams())).rejects.toMatchObject(
      { code: 'bad_request' }
    );
  });

  it('falha ao inserir as linhas novas NÃO marca o rascunho como failed (§5.2)', async () => {
    const mock = restageMock({ stagingInsertError: { message: 'boom' } });

    await expect(stageAudience(mock.db, restageParams())).rejects.toMatchObject(
      { code: 'restage_failed' }
    );

    // O rascunho não é novo: marcá-lo `failed` transformaria a campanha
    // do usuário em lixo por causa de uma troca que deu errado.
    const markedFailed = mock
      .callsFor('broadcasts')
      .some(
        (c) =>
          (opArgs(c.ops, 'update')?.[0] as Record<string, unknown> | undefined)
            ?.status === 'failed'
      );
    expect(markedFailed).toBe(false);
  });
});
