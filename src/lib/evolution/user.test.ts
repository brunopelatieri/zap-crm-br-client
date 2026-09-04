import { describe, expect, it, vi } from 'vitest';

import { evolutionRequest } from './client';
import {
  checkWhatsappUsers,
  fetchWhatsappAvatar,
  fetchWhatsappUserInfo,
  listWhatsappContacts,
  matchCheckResult,
} from './user';

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, evolutionRequest: vi.fn() };
});

const mockedRequest = vi.mocked(evolutionRequest);

const config = {
  apiUrl: 'https://evo.example.com',
  globalApiKey: 'global',
  maxInstancesPerAccount: 3,
  maxInstancesTotal: 20,
  instancePrefix: 'zapcrm',
  webhookPublicUrl: null,
  requestTimeoutMs: 15_000,
  mediaRequestTimeoutMs: 60_000,
};

describe('checkWhatsappUsers', () => {
  it('lista vazia não chama a rede', async () => {
    const result = await checkWhatsappUsers(config, 'tok', []);
    expect(result).toEqual([]);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('a FORMA REAL medida em 2026-09-03 contra go.local.ia.br (D-14) — envelope {data:{Users:[...]}}', async () => {
    // Payload estrutural idêntico ao capturado; dígitos trocados para
    // não persistir o número real do mantenedor no repositório.
    mockedRequest.mockResolvedValueOnce({
      data: {
        Users: [
          {
            Query: '+5511900000001@s.whatsapp.net',
            IsInWhatsapp: true,
            JID: '5511900000001@s.whatsapp.net',
            RemoteJID: '5511900000001@s.whatsapp.net',
            LID: '226559659127039@lid',
            VerifiedName: 'Alguém',
          },
          {
            Query: '+5511900000002@s.whatsapp.net',
            IsInWhatsapp: false,
            JID: '5511900000002@s.whatsapp.net',
            RemoteJID: '+5511900000002@s.whatsapp.net',
            LID: null,
            VerifiedName: '',
          },
        ],
      },
      message: 'success',
    });

    const result = await checkWhatsappUsers(config, 'tok', [
      '5511900000001',
      '5511900000002',
    ]);

    expect(result).toEqual([
      {
        query: '+5511900000001@s.whatsapp.net',
        isInWhatsapp: true,
        jid: '5511900000001@s.whatsapp.net',
        lid: '226559659127039@lid',
        verifiedName: 'Alguém',
      },
      {
        query: '+5511900000002@s.whatsapp.net',
        isInWhatsapp: false,
        jid: '5511900000002@s.whatsapp.net',
        lid: null,
        verifiedName: null,
      },
    ]);
  });

  it('manda number:[] com os telefones pedidos', async () => {
    mockedRequest.mockResolvedValueOnce({
      data: { Users: [] },
      message: 'success',
    });
    await checkWhatsappUsers(config, 'tok-123', ['551190000001']);
    expect(mockedRequest).toHaveBeenCalledWith(
      config,
      '/user/check',
      expect.objectContaining({
        method: 'POST',
        key: 'tok-123',
        body: { number: ['551190000001'] },
      })
    );
  });

  it('array cru no topo (hipótese alternativa antiga) também é aceito', async () => {
    mockedRequest.mockResolvedValueOnce([
      {
        Query: '+5511900000003',
        IsInWhatsapp: true,
        JID: '5511900000003',
        LID: 'x@lid',
      },
    ]);
    const result = await checkWhatsappUsers(config, 'tok', ['5511900000003']);
    expect(result).toEqual([
      {
        query: '+5511900000003',
        isInWhatsapp: true,
        jid: '5511900000003',
        lid: 'x@lid',
        verifiedName: null,
      },
    ]);
  });

  it('objeto plano único (sem envelope Users) também é aceito', async () => {
    mockedRequest.mockResolvedValueOnce({
      Query: '+5511900000004',
      IsInWhatsapp: false,
      JID: null,
      LID: null,
    });
    const result = await checkWhatsappUsers(config, 'tok', ['5511900000004']);
    expect(result).toEqual([
      {
        query: '+5511900000004',
        isInWhatsapp: false,
        jid: null,
        lid: null,
        verifiedName: null,
      },
    ]);
  });

  it('payload irreconhecível devolve lista vazia, nunca lança', async () => {
    mockedRequest.mockResolvedValueOnce({ message: 'success' });
    const result = await checkWhatsappUsers(config, 'tok', ['5511900000005']);
    expect(result).toEqual([]);
  });
});

describe('matchCheckResult — achado nº 2: a ordem da resposta não bate com a do pedido', () => {
  const results = [
    {
      query: '+5511900000002@s.whatsapp.net',
      isInWhatsapp: false,
      jid: '5511900000002@s.whatsapp.net',
      lid: null,
      verifiedName: null,
    },
    {
      query: '+5511900000001@s.whatsapp.net',
      isInWhatsapp: true,
      jid: '5511900000001@s.whatsapp.net',
      lid: 'x@lid',
      verifiedName: 'Alguém',
    },
  ];

  it('casa pelo número pedido, não pelo índice', () => {
    expect(matchCheckResult(results, '5511900000001')).toEqual(results[1]);
    expect(matchCheckResult(results, '5511900000002')).toEqual(results[0]);
  });

  it('número não presente na resposta devolve null', () => {
    expect(matchCheckResult(results, '5511999999999')).toBeNull();
  });

  it('telefone vazio devolve null sem lançar', () => {
    expect(matchCheckResult(results, '')).toBeNull();
  });

  it('casa mesmo com grafias diferentes de +/@s.whatsapp.net', () => {
    const alt = [
      {
        query: '5511900000009',
        isInWhatsapp: true,
        jid: null,
        lid: null,
        verifiedName: null,
      },
    ];
    expect(matchCheckResult(alt, '+55 11 90000-0009')).toEqual(alt[0]);
  });
});

describe('fetchWhatsappUserInfo', () => {
  it('lista vazia não chama a rede', async () => {
    const result = await fetchWhatsappUserInfo(config, 'tok', [], 20_000);
    expect(result).toEqual([]);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('passa o timeoutMs do chamador — NÃO o padrão de conectividade (achado nº 3)', async () => {
    mockedRequest.mockResolvedValueOnce({
      data: { Users: [] },
      message: 'success',
    });
    await fetchWhatsappUserInfo(config, 'tok', ['5511900000001'], 20_000);
    expect(mockedRequest).toHaveBeenCalledWith(
      config,
      '/user/info',
      expect.objectContaining({ timeoutMs: 20_000 })
    );
  });

  it('reusa o mesmo parser de /user/check (mesmo schema CheckUser) e extrai os campos extras', async () => {
    mockedRequest.mockResolvedValueOnce({
      data: {
        Users: [
          {
            Query: '+5511900000001',
            JID: '5511900000001@s.whatsapp.net',
            VerifiedName: 'Alguém',
            Status: 'Disponível',
            PictureID: 'abc123',
          },
        ],
      },
      message: 'success',
    });
    const result = await fetchWhatsappUserInfo(
      config,
      'tok',
      ['5511900000001'],
      20_000
    );
    expect(result).toEqual([
      {
        query: '+5511900000001',
        jid: '5511900000001@s.whatsapp.net',
        verifiedName: 'Alguém',
        status: 'Disponível',
        pictureId: 'abc123',
      },
    ]);
  });

  it('erro/timeout da Evolution propaga — quem chama decide se é best-effort', async () => {
    const { EvolutionApiError } = await import('./client');
    mockedRequest.mockRejectedValueOnce(
      new EvolutionApiError(
        'channel_unavailable',
        500,
        'failed to send usync query: info query timed out'
      )
    );
    await expect(
      fetchWhatsappUserInfo(config, 'tok', ['5511900000001'], 20_000)
    ).rejects.toThrow(/timed out/);
  });
});

describe('fetchWhatsappAvatar', () => {
  it('a forma da referência: {success, avatar} sem envelope data', async () => {
    mockedRequest.mockResolvedValueOnce({ success: true, avatar: 'QkFTRTY0' });
    const result = await fetchWhatsappAvatar(config, 'tok', '5511900000001', {
      timeoutMs: 20_000,
    });
    expect(result).toEqual({ base64: 'QkFTRTY0' });
  });

  it('body {number, preview} — number é STRING, não array (diferente de check/info)', async () => {
    mockedRequest.mockResolvedValueOnce({ success: true, avatar: 'YWJj' });
    await fetchWhatsappAvatar(config, 'tok', '5511900000001', {
      preview: true,
      timeoutMs: 20_000,
    });
    expect(mockedRequest).toHaveBeenCalledWith(
      config,
      '/user/avatar',
      expect.objectContaining({
        body: { number: '5511900000001', preview: true },
        timeoutMs: 20_000,
      })
    );
  });

  it('preview default é true quando o chamador não especifica', async () => {
    mockedRequest.mockResolvedValueOnce({ success: true, avatar: 'YWJj' });
    await fetchWhatsappAvatar(config, 'tok', '5511900000001', {
      timeoutMs: 20_000,
    });
    expect(mockedRequest).toHaveBeenCalledWith(
      config,
      '/user/avatar',
      expect.objectContaining({
        body: { number: '5511900000001', preview: true },
      })
    );
  });

  it('sem avatar (campo ausente/vazio) devolve null, não lança', async () => {
    mockedRequest.mockResolvedValueOnce({ success: true, avatar: '' });
    const result = await fetchWhatsappAvatar(config, 'tok', '5511900000001', {
      timeoutMs: 20_000,
    });
    expect(result).toBeNull();
  });

  it('envelope data.avatar (defesa em profundidade, não confirmado) também é aceito', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { avatar: 'ZGF0YQ==' } });
    const result = await fetchWhatsappAvatar(config, 'tok', '5511900000001', {
      timeoutMs: 20_000,
    });
    expect(result).toEqual({ base64: 'ZGF0YQ==' });
  });
});

describe('listWhatsappContacts', () => {
  it('a FORMA REAL medida: {data:[{Jid,Found,FirstName,FullName,PushName,BusinessName}]}', async () => {
    mockedRequest.mockResolvedValueOnce({
      data: [
        {
          Jid: '5511900000001@s.whatsapp.net',
          Found: true,
          FirstName: '',
          FullName: '',
          PushName: 'Alguém',
          BusinessName: '',
        },
        {
          Jid: '226559659127039@lid',
          Found: true,
          FirstName: '',
          FullName: '',
          PushName: 'Contato só-LID',
          BusinessName: '',
        },
      ],
      message: 'success',
    });

    const result = await listWhatsappContacts(config, 'tok');

    expect(result).toEqual([
      {
        jid: '5511900000001@s.whatsapp.net',
        found: true,
        firstName: null,
        fullName: null,
        pushName: 'Alguém',
        businessName: null,
      },
      {
        jid: '226559659127039@lid',
        found: true,
        firstName: null,
        fullName: null,
        pushName: 'Contato só-LID',
        businessName: null,
      },
    ]);
  });

  it('chama GET sem body', async () => {
    mockedRequest.mockResolvedValueOnce({ data: [], message: 'success' });
    await listWhatsappContacts(config, 'tok-abc');
    expect(mockedRequest).toHaveBeenCalledWith(
      config,
      '/user/contacts',
      expect.objectContaining({ method: 'GET', key: 'tok-abc' })
    );
  });

  it('item sem Jid é descartado — não há como deduplicar sem ele', async () => {
    mockedRequest.mockResolvedValueOnce({
      data: [
        { Found: true, PushName: 'Sem Jid' },
        {
          Jid: '5511900000009@s.whatsapp.net',
          Found: true,
          PushName: 'Com Jid',
        },
      ],
      message: 'success',
    });
    const result = await listWhatsappContacts(config, 'tok');
    expect(result).toHaveLength(1);
    expect(result[0].jid).toBe('5511900000009@s.whatsapp.net');
  });

  it('array cru no topo (defesa em profundidade) também é aceito', async () => {
    mockedRequest.mockResolvedValueOnce([
      { Jid: '5511900000001@s.whatsapp.net', Found: true },
    ]);
    const result = await listWhatsappContacts(config, 'tok');
    expect(result).toHaveLength(1);
  });

  it('data que não é array (payload torto) devolve lista vazia, nunca lança', async () => {
    mockedRequest.mockResolvedValueOnce({ data: 'não é uma lista' });
    const result = await listWhatsappContacts(config, 'tok');
    expect(result).toEqual([]);
  });

  it('1144 contatos (o tamanho real medido) não estoura nem trava', async () => {
    const big = Array.from({ length: 1144 }, (_, i) => ({
      Jid: `55119${String(i).padStart(8, '0')}@s.whatsapp.net`,
      Found: true,
      PushName: `Contato ${i}`,
    }));
    mockedRequest.mockResolvedValueOnce({ data: big, message: 'success' });
    const result = await listWhatsappContacts(config, 'tok');
    expect(result).toHaveLength(1144);
  });
});
