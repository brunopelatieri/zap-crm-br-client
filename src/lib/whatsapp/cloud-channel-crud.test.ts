import { describe, it, expect } from 'vitest';

import {
  CloudChannelError,
  createCloudChannel,
  saveCloudConfigRow,
  identifierFromDisplayPhone,
  nextCloudChannelName,
  reconcileCloudChannel,
  removeCloudChannel,
  resolveSaveTarget,
  updateCloudChannelOnSave,
} from './cloud-channel-crud';

// ---------------------------------------------------------------------------
// SPEC 064 F4 — CRUD de número oficial
//
// O que estes testes protegem, e por que nenhum deles existia antes:
// até esta fase `POST /api/whatsapp/config` **não tocava a tabela
// `channels`** (§1.1.E.1). Não havia criação para compensar, não havia
// canal para readotar e o `DELETE` apagava a linha da conta inteira. As
// regras abaixo nascem com a fase — o que elas guardam são os desfechos
// que a SPEC nomeia como caros de errar: canal órfão consumindo quota,
// segundo canal para o mesmo número a cada duplo clique, e configuração
// (cooldown, tier, WABA) apagada sem volta.
//
// O banco falso é deliberadamente burro: filtra por `eq`/`neq` e nada
// mais. Ele não valida FK nem dispara trigger — o que a `072` garante é
// verificado nas asserções da própria migração, não aqui.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete';

interface FakeState {
  channels: Row[];
  whatsapp_config: Row[];
  conversations: Row[];
  /** Falhas injetadas: `{ table, op, message }`. */
  fail: { table: string; op: Op; message: string }[];
}

function makeState(partial: Partial<FakeState> = {}): FakeState {
  return {
    channels: [],
    whatsapp_config: [],
    conversations: [],
    fail: [],
    ...partial,
  };
}

function makeDb(state: FakeState) {
  let nextId = 1;

  type Table = 'channels' | 'whatsapp_config' | 'conversations';

  function from(table: Table) {
    const filters: { op: 'eq' | 'neq'; col: string; val: unknown }[] = [];
    let op: Op = 'select';
    let payload: Row = {};
    let wantCount = false;

    const rows = () =>
      (state[table] as Row[]).filter((r) =>
        filters.every((f) =>
          f.op === 'eq' ? r[f.col] === f.val : r[f.col] !== f.val
        )
      );

    const failure = () =>
      state.fail.find((f) => f.table === table && f.op === op);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (): any => {
      const fail = failure();
      if (fail) {
        return { data: null, error: { message: fail.message }, count: null };
      }

      if (op === 'select') {
        const matched = rows();
        return wantCount
          ? { data: null, error: null, count: matched.length }
          : { data: matched, error: null, count: null };
      }
      if (op === 'insert') {
        const inserted = { id: `row-${nextId++}`, ...payload };
        (state[table] as Row[]).push(inserted);
        return { data: inserted, error: null };
      }
      if (op === 'update') {
        const matched = rows();
        for (const r of matched) Object.assign(r, payload);
        return { data: matched, error: null };
      }
      const matched = rows();
      state[table] = (state[table] as Row[]).filter(
        (r) => !matched.includes(r)
      );
      return { data: matched, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    b.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count) wantCount = true;
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      filters.push({ op: 'eq', col, val });
      return b;
    };
    b.neq = (col: string, val: unknown) => {
      filters.push({ op: 'neq', col, val });
      return b;
    };
    b.insert = (p: Row) => {
      op = 'insert';
      payload = p;
      return b;
    };
    b.update = (p: Row) => {
      op = 'update';
      payload = p;
      return b;
    };
    b.delete = () => {
      op = 'delete';
      return b;
    };
    b.maybeSingle = async () => {
      const res = run();
      if (res.error) return res;
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
      return { data, error: null };
    };
    b.single = async () => {
      const res = run();
      if (res.error) return res;
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
      return data
        ? { data, error: null }
        : { data: null, error: { message: 'no rows' } };
    };
    b.then = (resolve: (v: unknown) => unknown) => resolve(run());
    return b;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any;
}

const ACCOUNT = 'acct-1';
const OTHER_ACCOUNT = 'acct-2';

function cloudChannel(overrides: Row = {}): Row {
  return {
    id: 'chan-cloud-1',
    account_id: ACCOUNT,
    type: 'whatsapp_cloud',
    name: 'WhatsApp Oficial',
    identifier: '892352847302912',
    status: 'connected',
    status_detail: null,
    is_default: true,
    connected_at: null,
    ...overrides,
  };
}

function cloudConfig(overrides: Row = {}): Row {
  return {
    id: 'cfg-1',
    account_id: ACCOUNT,
    channel_id: 'chan-cloud-1',
    phone_number_id: '892352847302912',
    waba_id: '1596497364872182',
    access_token: 'cipher',
    verify_token: 'cipher-verify',
    status: 'connected',
    registered_at: '2026-08-01T00:00:00.000Z',
    broadcast_cooldown_days: 21,
    messaging_limit_tier: 'TIER_2K',
    ...overrides,
  };
}

describe('resolveSaveTarget — qual número este POST está salvando (§5)', () => {
  it('canal explícito de OUTRA conta é 404, nunca leitura', async () => {
    const db = makeDb(
      makeState({
        channels: [cloudChannel({ account_id: OTHER_ACCOUNT })],
      })
    );

    await expect(
      resolveSaveTarget(db, ACCOUNT, {
        channelId: 'chan-cloud-1',
        phoneNumberId: '999',
      })
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('canal explícito de outro TIPO é recusado', async () => {
    const db = makeDb(
      makeState({
        channels: [cloudChannel({ id: 'chan-qr', type: 'whatsapp_qr' })],
      })
    );

    await expect(
      resolveSaveTarget(db, ACCOUNT, {
        channelId: 'chan-qr',
        phoneNumberId: '999',
      })
    ).rejects.toMatchObject({ status: 400, code: 'wrong_type' });
  });

  it('sem channel_id, número já conhecido da conta ATUALIZA aquele canal', async () => {
    // A idempotência do §5: o bundle antigo em cache POSTa sempre sem
    // id, e o duplo clique repete a mesma requisição. Sem esta regra,
    // cada salvamento criaria um canal novo para o MESMO número — dois
    // itens indistinguíveis no filtro do inbox e duas vagas de quota.
    const db = makeDb(
      makeState({
        channels: [cloudChannel()],
        whatsapp_config: [cloudConfig()],
      })
    );

    const target = await resolveSaveTarget(db, ACCOUNT, {
      channelId: null,
      phoneNumberId: '892352847302912',
    });

    expect(target.mode).toBe('update');
    expect(target.channel?.id).toBe('chan-cloud-1');
  });

  it('`channel_id` vazio não conta como id', async () => {
    const db = makeDb(
      makeState({
        channels: [cloudChannel()],
        whatsapp_config: [cloudConfig()],
      })
    );

    const target = await resolveSaveTarget(db, ACCOUNT, {
      channelId: '   ',
      phoneNumberId: '892352847302912',
    });

    expect(target.mode).toBe('update');
  });

  it('canal desativado com o mesmo número é READOTADO, não duplicado (D-12)', async () => {
    const db = makeDb(
      makeState({
        channels: [cloudChannel({ status: 'disabled' })],
        whatsapp_config: [cloudConfig({ access_token: '' })],
      })
    );

    const target = await resolveSaveTarget(db, ACCOUNT, {
      channelId: null,
      phoneNumberId: '892352847302912',
    });

    expect(target.mode).toBe('readopt');
    expect(target.channel?.id).toBe('chan-cloud-1');
  });

  it('credencial ÓRFÃ (channel_id nulo) é ADOTADA, nunca recriada', async () => {
    // `phone_number_id` é UNIQUE global (013): inserir uma segunda
    // linha para o mesmo número colide com a própria linha da conta e
    // devolve 500 em TODA tentativa. É o estado que o bug §1.1.E.1
    // deixou em qualquer deployment onde a 072 (que põe `channel_id`
    // NOT NULL) ainda não rodou.
    const db = makeDb(
      makeState({
        whatsapp_config: [cloudConfig({ channel_id: null })],
      })
    );

    const target = await resolveSaveTarget(db, ACCOUNT, {
      channelId: null,
      phoneNumberId: '892352847302912',
    });

    expect(target.mode).toBe('adopt');
    expect(target.config?.id).toBe('cfg-1');
  });

  it('config apontando para canal inexistente também adota', async () => {
    const db = makeDb(
      makeState({
        whatsapp_config: [cloudConfig({ channel_id: 'chan-sumiu' })],
      })
    );

    const target = await resolveSaveTarget(db, ACCOUNT, {
      channelId: null,
      phoneNumberId: '892352847302912',
    });

    expect(target.mode).toBe('adopt');
  });

  it('canal explícito SEM credencial devolve config nula, e não erro', async () => {
    // Canal órfão: a lista o mostra de propósito, então a tela vai
    // mandar este id. Quem salva precisa saber que não há linha para
    // atualizar.
    const db = makeDb(makeState({ channels: [cloudChannel()] }));

    const target = await resolveSaveTarget(db, ACCOUNT, {
      channelId: 'chan-cloud-1',
      phoneNumberId: '892352847302912',
    });

    expect(target.mode).toBe('update');
    expect(target.config).toBeNull();
  });

  it('número desconhecido da conta cria', async () => {
    const db = makeDb(
      makeState({
        channels: [cloudChannel()],
        whatsapp_config: [cloudConfig()],
      })
    );

    const target = await resolveSaveTarget(db, ACCOUNT, {
      channelId: null,
      phoneNumberId: '111111111111111',
    });

    expect(target.mode).toBe('create');
  });

  it('falha de leitura não vira "cria" — seria um canal a mais', async () => {
    const db = makeDb(
      makeState({
        fail: [{ table: 'whatsapp_config', op: 'select', message: 'timeout' }],
      })
    );

    await expect(
      resolveSaveTarget(db, ACCOUNT, {
        channelId: null,
        phoneNumberId: '892352847302912',
      })
    ).rejects.toBeInstanceOf(CloudChannelError);
  });
});

describe('createCloudChannel — duas escritas, nenhuma transação (§5)', () => {
  const input = {
    accountId: ACCOUNT,
    userId: 'user-1',
    name: 'WhatsApp Oficial 2',
    identifier: '5519992496598',
    status: 'connected' as const,
    statusDetail: null,
    connectedAt: '2026-08-28T00:00:00.000Z',
    configRow: {
      account_id: ACCOUNT,
      user_id: 'user-1',
      phone_number_id: '111111111111111',
      access_token: 'cipher',
    },
  };

  it('grava canal e credencial, e NÃO escreve is_default', async () => {
    // `is_default` é território exclusivo de `set_default_channel` e das
    // triggers `claim_default_*` (072 §6.1/§7.1). Um valor escrito daqui
    // competiria com o índice único parcial por (conta, tipo).
    const state = makeState();
    const db = makeDb(state);

    const { channelId } = await createCloudChannel(db, input);

    expect(state.channels).toHaveLength(1);
    expect(state.channels[0]).toMatchObject({
      account_id: ACCOUNT,
      type: 'whatsapp_cloud',
      identifier: '5519992496598',
      status: 'connected',
    });
    expect(state.channels[0]).not.toHaveProperty('is_default');
    expect(state.whatsapp_config).toHaveLength(1);
    expect(state.whatsapp_config[0].channel_id).toBe(channelId);
  });

  it('credencial falhou → o canal recém-criado é APAGADO', async () => {
    // Sem esta compensação sobra um canal sem credencial: ele não envia
    // nada, mas ocupa vaga de quota e aparece no filtro do inbox.
    const state = makeState({
      fail: [{ table: 'whatsapp_config', op: 'insert', message: 'boom' }],
    });
    const db = makeDb(state);

    await expect(createCloudChannel(db, input)).rejects.toMatchObject({
      message: 'boom',
    });
    expect(state.channels).toHaveLength(0);
  });

  it('nem apagar deu → o canal fica `disabled` com o motivo escrito', async () => {
    const state = makeState({
      fail: [
        { table: 'whatsapp_config', op: 'insert', message: 'boom' },
        { table: 'channels', op: 'delete', message: 'delete refused' },
      ],
    });
    const db = makeDb(state);

    await expect(createCloudChannel(db, input)).rejects.toMatchObject({
      message: 'boom',
    });
    expect(state.channels).toHaveLength(1);
    expect(state.channels[0].status).toBe('disabled');
    expect(String(state.channels[0].status_detail)).toContain('boom');
    expect(String(state.channels[0].status_detail)).toContain('delete refused');
  });
});

describe('createCloudChannel — adoção da credencial órfã', () => {
  const input = {
    accountId: ACCOUNT,
    userId: 'user-1',
    name: 'WhatsApp Oficial',
    identifier: '5519992496598',
    status: 'connected' as const,
    statusDetail: null,
    connectedAt: '2026-08-28T00:00:00.000Z',
    configRow: {
      account_id: ACCOUNT,
      user_id: 'user-1',
      phone_number_id: '892352847302912',
      access_token: 'cipher-novo',
    },
  };

  it('liga a linha existente ao canal novo, sem inserir uma segunda', async () => {
    const state = makeState({
      whatsapp_config: [cloudConfig({ channel_id: null })],
    });
    const db = makeDb(state);

    const { channelId } = await createCloudChannel(db, {
      ...input,
      adoptConfigId: 'cfg-1',
    });

    expect(state.whatsapp_config).toHaveLength(1);
    expect(state.whatsapp_config[0].channel_id).toBe(channelId);
    expect(state.whatsapp_config[0].access_token).toBe('cipher-novo');
    // O cooldown da linha adotada sobrevive: ele não está no `configRow`.
    expect(state.whatsapp_config[0].broadcast_cooldown_days).toBe(21);
  });

  it('linha que sumiu no meio do caminho dispara a compensação', async () => {
    // `UPDATE` que não casa linha nenhuma NÃO é erro no PostgREST —
    // sem conferir a contagem, o canal ficaria apontando para o nada.
    const state = makeState();
    const db = makeDb(state);

    await expect(
      createCloudChannel(db, { ...input, adoptConfigId: 'cfg-sumiu' })
    ).rejects.toMatchObject({ message: expect.stringContaining('vanished') });
    expect(state.channels).toHaveLength(0);
  });
});

describe('saveCloudConfigRow — UPDATE que não casa linha vira INSERT', () => {
  it('atualiza a credencial do canal quando ela existe', async () => {
    const state = makeState({
      channels: [cloudChannel()],
      whatsapp_config: [cloudConfig()],
    });
    const db = makeDb(state);

    await saveCloudConfigRow(db, {
      accountId: ACCOUNT,
      userId: 'user-1',
      channelId: 'chan-cloud-1',
      row: { access_token: 'cipher-novo' },
    });

    expect(state.whatsapp_config).toHaveLength(1);
    expect(state.whatsapp_config[0].access_token).toBe('cipher-novo');
  });

  it('canal ÓRFÃO ganha a linha em vez de um sucesso silencioso', async () => {
    // Sem este ramo, o `UPDATE` casaria zero linhas, o PostgREST não
    // chamaria isso de erro, e a rota responderia `success: true` sobre
    // um canal que continua sem credencial nenhuma — todo envio por ele
    // morrendo depois em `resolveCloudConfig` com `no_credentials`.
    const state = makeState({ channels: [cloudChannel()] });
    const db = makeDb(state);

    await saveCloudConfigRow(db, {
      accountId: ACCOUNT,
      userId: 'user-1',
      channelId: 'chan-cloud-1',
      row: { phone_number_id: '892352847302912', access_token: 'cipher' },
    });

    expect(state.whatsapp_config).toHaveLength(1);
    expect(state.whatsapp_config[0]).toMatchObject({
      account_id: ACCOUNT,
      channel_id: 'chan-cloud-1',
      access_token: 'cipher',
    });
  });

  it('erro de escrita sobe — não vira sucesso', async () => {
    const state = makeState({
      channels: [cloudChannel()],
      whatsapp_config: [cloudConfig()],
      fail: [{ table: 'whatsapp_config', op: 'update', message: 'boom' }],
    });

    await expect(
      saveCloudConfigRow(makeDb(state), {
        accountId: ACCOUNT,
        userId: 'user-1',
        channelId: 'chan-cloud-1',
        row: { access_token: 'x' },
      })
    ).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('reconcileCloudChannel — o diagnóstico alinha, mas não ressuscita', () => {
  it('grava o telefone da Meta no lugar do phone_number_id (D-9)', async () => {
    const state = makeState({
      channels: [cloudChannel({ status: 'disconnected' })],
    });
    const db = makeDb(state);

    await reconcileCloudChannel(db, ACCOUNT, 'chan-cloud-1', {
      identifier: '5519992496598',
      status: 'connected',
      statusDetail: null,
    });

    expect(state.channels[0].identifier).toBe('5519992496598');
    expect(state.channels[0].status).toBe('connected');
  });

  it('NÃO reativa um canal desativado', async () => {
    // "Desativar número" é ação deliberada do operador (D-12). Um
    // diagnóstico de fundo — que roda a cada abertura da aba de
    // configuração — não pode desfazê-la pelas costas.
    const state = makeState({
      channels: [cloudChannel({ status: 'disabled' })],
    });
    const db = makeDb(state);

    await reconcileCloudChannel(db, ACCOUNT, 'chan-cloud-1', {
      status: 'connected',
      statusDetail: null,
    });

    expect(state.channels[0].status).toBe('disabled');
  });

  it('canal de outra conta não é tocado', async () => {
    const state = makeState({
      channels: [cloudChannel({ account_id: OTHER_ACCOUNT })],
    });
    const db = makeDb(state);

    await reconcileCloudChannel(db, ACCOUNT, 'chan-cloud-1', {
      status: 'error',
      statusDetail: 'falhou',
    });

    expect(state.channels[0].status).toBe('connected');
  });
});

describe('updateCloudChannelOnSave — salvar É o que reativa (D-12)', () => {
  it('tira o canal de `disabled`, ao contrário da reconciliação', async () => {
    const state = makeState({
      channels: [
        cloudChannel({ status: 'disabled', status_detail: 'removido' }),
      ],
    });
    const db = makeDb(state);

    await updateCloudChannelOnSave(db, ACCOUNT, 'chan-cloud-1', {
      identifier: '5519992496598',
      status: 'connected',
      statusDetail: null,
      connectedAt: '2026-08-28T00:00:00.000Z',
    });

    expect(state.channels[0].status).toBe('connected');
    expect(state.channels[0].status_detail).toBeNull();
  });

  it('resposta da Meta sem telefone não apaga o identifier atual', async () => {
    const state = makeState({
      channels: [cloudChannel({ identifier: '5519992496598' })],
    });
    const db = makeDb(state);

    await updateCloudChannelOnSave(db, ACCOUNT, 'chan-cloud-1', {
      identifier: null,
      status: 'connected',
      statusDetail: null,
      connectedAt: null,
    });

    expect(state.channels[0].identifier).toBe('5519992496598');
  });

  it('erro sobe — reativar com o plano no teto precisa ser dito', async () => {
    const state = makeState({
      channels: [cloudChannel({ status: 'disabled' })],
      fail: [
        {
          table: 'channels',
          op: 'update',
          message: 'QUOTA_EXCEEDED:channels_whatsapp_cloud:1:1',
        },
      ],
    });
    const db = makeDb(state);

    await expect(
      updateCloudChannelOnSave(db, ACCOUNT, 'chan-cloud-1', {
        identifier: null,
        status: 'connected',
        statusDetail: null,
        connectedAt: null,
      })
    ).rejects.toMatchObject({
      message: 'QUOTA_EXCEEDED:channels_whatsapp_cloud:1:1',
    });
  });
});

describe('removeCloudChannel — desativar, não apagar (D-12)', () => {
  it('COM conversas: zera o segredo, preserva cooldown, tier e WABA', async () => {
    // Apagar a linha levaria junto `broadcast_cooldown_days`,
    // `messaging_limit_tier` e `waba_id`. A reconexão nasceria com o
    // DEFAULT 7 do cooldown e a triagem de audiência voltaria a incluir
    // contatos em descanso — sem aviso nenhum.
    const state = makeState({
      channels: [cloudChannel()],
      whatsapp_config: [cloudConfig()],
      conversations: [{ id: 'conv-1', channel_id: 'chan-cloud-1' }],
    });
    const db = makeDb(state);

    const outcome = await removeCloudChannel(
      db,
      ACCOUNT,
      'chan-cloud-1',
      'Número removido pelo operador'
    );

    expect(outcome).toBe('disabled');
    expect(state.channels).toHaveLength(1);
    expect(state.channels[0].status).toBe('disabled');
    expect(state.channels[0].status_detail).toBe(
      'Número removido pelo operador'
    );
    expect(state.whatsapp_config[0]).toMatchObject({
      access_token: '',
      verify_token: null,
      broadcast_cooldown_days: 21,
      messaging_limit_tier: 'TIER_2K',
      waba_id: '1596497364872182',
    });
  });

  it('SEM conversas: apaga o canal de verdade, liberando o número', async () => {
    const state = makeState({
      channels: [cloudChannel()],
      whatsapp_config: [cloudConfig()],
    });
    const db = makeDb(state);

    const outcome = await removeCloudChannel(
      db,
      ACCOUNT,
      'chan-cloud-1',
      'Número removido pelo operador'
    );

    expect(outcome).toBe('deleted');
    expect(state.channels).toHaveLength(0);
  });

  it('conversa de OUTRO canal não impede a exclusão', async () => {
    const state = makeState({
      channels: [cloudChannel()],
      whatsapp_config: [cloudConfig()],
      conversations: [{ id: 'conv-1', channel_id: 'chan-outro' }],
    });
    const db = makeDb(state);

    expect(
      await removeCloudChannel(db, ACCOUNT, 'chan-cloud-1', 'removido')
    ).toBe('deleted');
  });

  it('canal de outra conta é 404', async () => {
    const state = makeState({
      channels: [cloudChannel({ account_id: OTHER_ACCOUNT })],
    });
    const db = makeDb(state);

    await expect(
      removeCloudChannel(db, ACCOUNT, 'chan-cloud-1', 'removido')
    ).rejects.toMatchObject({ status: 404 });
  });

  it('canal QRCode não é removido por esta rota', async () => {
    const state = makeState({
      channels: [cloudChannel({ type: 'whatsapp_qr' })],
    });
    const db = makeDb(state);

    await expect(
      removeCloudChannel(db, ACCOUNT, 'chan-cloud-1', 'removido')
    ).rejects.toMatchObject({ status: 400, code: 'wrong_type' });
  });

  it('contagem de conversas indisponível desativa em vez de apagar', async () => {
    // Erro de leitura sobe; o que este teste fixa é a direção da
    // dúvida — na ausência de resposta, o caminho reversível vence.
    const state = makeState({
      channels: [cloudChannel()],
      whatsapp_config: [cloudConfig()],
      fail: [{ table: 'conversations', op: 'select', message: 'timeout' }],
    });
    const db = makeDb(state);

    await expect(
      removeCloudChannel(db, ACCOUNT, 'chan-cloud-1', 'removido')
    ).rejects.toMatchObject({ code: 'read_failed' });
    expect(state.channels).toHaveLength(1);
  });

  it('segredo zerado ANTES de desativar — a ordem inversa deixaria token vivo', async () => {
    const state = makeState({
      channels: [cloudChannel()],
      whatsapp_config: [cloudConfig()],
      conversations: [{ id: 'conv-1', channel_id: 'chan-cloud-1' }],
      fail: [{ table: 'channels', op: 'update', message: 'no' }],
    });
    const db = makeDb(state);

    await expect(
      removeCloudChannel(db, ACCOUNT, 'chan-cloud-1', 'removido')
    ).rejects.toMatchObject({ code: 'update_failed' });
    // O canal continua ativo (a desativação falhou), mas o token já foi
    // embora: `resolveCloudConfig` recusa por `no_credentials`.
    expect(state.whatsapp_config[0].access_token).toBe('');
  });
});

describe('helpers', () => {
  it('identifierFromDisplayPhone guarda só os dígitos', () => {
    expect(identifierFromDisplayPhone('+55 19 99249-6598')).toBe(
      '5519992496598'
    );
    expect(identifierFromDisplayPhone('')).toBeNull();
    expect(identifierFromDisplayPhone(undefined)).toBeNull();
  });

  it('nextCloudChannelName segue o padrão do backfill da 072', async () => {
    expect(await nextCloudChannelName(makeDb(makeState()), ACCOUNT)).toBe(
      'WhatsApp Oficial'
    );
    expect(
      await nextCloudChannelName(
        makeDb(makeState({ channels: [cloudChannel()] })),
        ACCOUNT
      )
    ).toBe('WhatsApp Oficial 2');
  });

  it('canal desativado ainda ocupa o número do rótulo', async () => {
    // Dois "WhatsApp Oficial 2" na mesma conta seriam indistinguíveis
    // no filtro do inbox.
    const state = makeState({
      channels: [cloudChannel({ status: 'disabled' })],
    });
    expect(await nextCloudChannelName(makeDb(state), ACCOUNT)).toBe(
      'WhatsApp Oficial 2'
    );
  });
});
