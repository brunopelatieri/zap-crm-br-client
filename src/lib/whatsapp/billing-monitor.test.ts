import { describe, expect, it } from 'vitest';
import { MetaApiError } from './meta-api';
import {
  classifyGraphError,
  deriveSendState,
  HEALTH_TTL_MS,
  inferTzOffsetSeconds,
  isFresh,
  maskId,
  MAX_ERROR_MESSAGE_LENGTH,
  monthSpendWindow,
  parseBusinessUseCaseUsage,
  parseHealthStatus,
  parsePricingAnalytics,
  readStatus,
  sanitizeErrorMessage,
  type SendStateSnapshot,
} from './billing-monitor';

// Fixtures no formato medido em 01/10/2026 (SPEC 076 §4.1), com os IDs
// mascarados: <WABA_ID> → "100000000004821".
const WABA = '100000000004821';
const BUSINESS = '200000000001234';

const DAY = 86_400;
// 2026-10-01 00:00 no fuso do WABA de teste (UTC−3) = 03:00 UTC (F-9).
const OCT_1_LOCAL = 1_790_823_600;

function entity(
  type: string,
  can: string,
  extra: Record<string, unknown> = {}
) {
  return {
    entity_type: type,
    id: type === 'BUSINESS' ? BUSINESS : WABA,
    can_send_message: can,
    ...extra,
  };
}

describe('parseHealthStatus', () => {
  it('AVAILABLE com três entidades: sem problemas, moeda e business id', () => {
    const parsed = parseHealthStatus({
      id: WABA,
      currency: 'USD',
      health_status: {
        can_send_message: 'AVAILABLE',
        entities: [
          entity('WABA', 'AVAILABLE'),
          entity('BUSINESS', 'AVAILABLE'),
          entity('APP', 'AVAILABLE'),
        ],
      },
    });

    expect(parsed.overall).toBe('AVAILABLE');
    expect(parsed.currency).toBe('USD');
    expect(parsed.entities).toHaveLength(3);
    expect(parsed.problems).toEqual([]);
    expect(parsed.businessId).toBe(BUSINESS);
  });

  it('entidade BLOCKED com errors: lista o problema com os três campos', () => {
    const parsed = parseHealthStatus({
      currency: 'BRL',
      health_status: {
        can_send_message: 'BLOCKED',
        entities: [
          entity('WABA', 'AVAILABLE'),
          entity('APP', 'BLOCKED', {
            errors: [
              {
                error_code: 141000,
                error_description: 'App not verified',
                possible_solution: 'Complete business verification',
              },
            ],
          }),
        ],
      },
    });

    expect(parsed.overall).toBe('BLOCKED');
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0].entity_type).toBe('APP');
    expect(parsed.problems[0].errors).toEqual([
      {
        error_code: 141000,
        error_description: 'App not verified',
        possible_solution: 'Complete business verification',
      },
    ]);
  });

  it('LIMITED com additional_info (string e objeto descritivo)', () => {
    const parsed = parseHealthStatus({
      health_status: {
        can_send_message: 'LIMITED',
        entities: [
          entity('PHONE_NUMBER', 'LIMITED', {
            additional_info: [
              'Number pending verification',
              { description: 'Display name under review' },
              42,
            ],
          }),
        ],
      },
    });

    expect(parsed.overall).toBe('LIMITED');
    expect(parsed.problems[0].additional_info).toEqual([
      'Number pending verification',
      'Display name under review',
    ]);
  });

  it('valor desconhecido ("FOO") → overall nulo, nunca inventado', () => {
    const parsed = parseHealthStatus({
      health_status: { can_send_message: 'FOO', entities: [] },
    });
    expect(parsed.overall).toBeNull();
  });

  it('health_status ausente ou resposta fora do formato não lança', () => {
    for (const raw of [{}, { currency: 'USD' }, null, undefined, 'x', []]) {
      const parsed = parseHealthStatus(raw);
      expect(parsed.overall).toBeNull();
      expect(parsed.entities).toEqual([]);
      expect(parsed.problems).toEqual([]);
    }
  });

  it('business id que não é só dígitos não vira link (§12)', () => {
    const parsed = parseHealthStatus({
      health_status: {
        can_send_message: 'AVAILABLE',
        entities: [{ entity_type: 'BUSINESS', id: '123/../evil' }],
      },
    });
    expect(parsed.businessId).toBeNull();
  });

  it('error_code numérico em string é aceito', () => {
    const parsed = parseHealthStatus({
      health_status: {
        can_send_message: 'BLOCKED',
        entities: [
          entity('WABA', 'BLOCKED', { errors: [{ error_code: '141001' }] }),
        ],
      },
    });
    expect(parsed.problems[0].errors[0].error_code).toBe(141001);
  });
});

describe('inferTzOffsetSeconds', () => {
  it('03:00 UTC → UTC−3', () => {
    expect(inferTzOffsetSeconds(OCT_1_LOCAL)).toBe(-10_800);
  });

  it('meia-noite UTC → offset 0', () => {
    expect(inferTzOffsetSeconds(OCT_1_LOCAL - 3 * 3600)).toBe(0);
  });

  it('23:00 UTC do dia anterior → UTC+1 (normaliza para positivo)', () => {
    expect(inferTzOffsetSeconds(OCT_1_LOCAL - 4 * 3600)).toBe(3_600);
  });

  it('18:30 UTC do dia anterior → UTC+5:30', () => {
    expect(inferTzOffsetSeconds(OCT_1_LOCAL - 3 * 3600 - 5.5 * 3600)).toBe(
      19_800
    );
  });
});

describe('parsePricingAnalytics', () => {
  const NOW = new Date('2026-10-05T15:00:00Z');

  function analytics(
    points: Array<{
      start: number;
      pricing_category?: string;
      volume?: number;
      cost?: number;
    }>
  ) {
    return {
      id: WABA,
      pricing_analytics: {
        data: [
          {
            data_points: points.map((p) => ({
              end: p.start + DAY,
              ...p,
            })),
          },
        ],
      },
    };
  }

  it('payload real: 113 × MARKETING = 7.0625, SERVICE = 0; descarta o mês anterior', () => {
    const parsed = parsePricingAnalytics(
      analytics([
        // Último dia do mês anterior — fora do mês local corrente.
        {
          start: OCT_1_LOCAL - DAY,
          pricing_category: 'MARKETING',
          volume: 999,
          cost: 99,
        },
        {
          start: OCT_1_LOCAL,
          pricing_category: 'MARKETING',
          volume: 113,
          cost: 7.0625,
        },
        {
          start: OCT_1_LOCAL + DAY,
          pricing_category: 'SERVICE',
          volume: 40,
          cost: 0,
        },
      ]),
      NOW
    );

    expect(parsed.total).toBe(7.0625);
    expect(parsed.available).toBe(true);
    expect(parsed.tzOffsetSeconds).toBe(-10_800);
    expect(parsed.periodStart).toBe('2026-10-01');
    expect(parsed.byCategory).toEqual({
      MARKETING: { volume: 113, cost: 7.0625 },
      SERVICE: { volume: 40, cost: 0 },
    });
  });

  it('cost ausente → indisponível (não zero) e volume preservado', () => {
    const parsed = parsePricingAnalytics(
      analytics([
        {
          start: OCT_1_LOCAL,
          pricing_category: 'MARKETING',
          volume: 10,
          cost: 0.5,
        },
        { start: OCT_1_LOCAL + DAY, pricing_category: 'UTILITY', volume: 7 },
      ]),
      NOW
    );

    expect(parsed.available).toBe(false);
    expect(parsed.total).toBeNull();
    expect(parsed.byCategory.UTILITY).toEqual({ volume: 7, cost: null });
    expect(parsed.byCategory.MARKETING).toEqual({ volume: 10, cost: 0.5 });
  });

  it('lista vazia → zero conhecido, sem fuso inferível, mês UTC', () => {
    for (const raw of [analytics([]), {}, null]) {
      const parsed = parsePricingAnalytics(raw, NOW);
      expect(parsed.total).toBe(0);
      expect(parsed.available).toBe(true);
      expect(parsed.byCategory).toEqual({});
      expect(parsed.tzOffsetSeconds).toBeNull();
      expect(parsed.periodStart).toBe('2026-10-01');
    }
  });

  it('soma sem erro de ponto flutuante (0.1 e 0.2 em 1.000 pontos cada)', () => {
    const points = [
      ...Array.from({ length: 1000 }, () => ({
        start: OCT_1_LOCAL,
        pricing_category: 'MARKETING',
        volume: 1,
        cost: 0.1,
      })),
      ...Array.from({ length: 1000 }, () => ({
        start: OCT_1_LOCAL,
        pricing_category: 'MARKETING',
        volume: 1,
        cost: 0.2,
      })),
    ];
    const parsed = parsePricingAnalytics(analytics(points), NOW);

    // Em ponto flutuante cru isto daria 300.00000000000006 ou parecido.
    expect(parsed.total).toBe(300);
    expect(parsed.byCategory.MARKETING).toEqual({ volume: 2000, cost: 300 });
  });

  it('virada de mês: o mês corrente é o LOCAL, não o UTC', () => {
    // 2026-11-01 01:00 UTC já é 31/10 22:00 no fuso do WABA.
    const now = new Date('2026-11-01T01:00:00Z');
    const parsed = parsePricingAnalytics(
      analytics([
        {
          start: OCT_1_LOCAL + 30 * DAY, // 31/10 local
          pricing_category: 'MARKETING',
          volume: 5,
          cost: 1,
        },
      ]),
      now
    );

    expect(parsed.periodStart).toBe('2026-10-01');
    expect(parsed.total).toBe(1);
  });

  it('categoria ausente vira UNCATEGORIZED e minúsculas viram MAIÚSCULAS', () => {
    const parsed = parsePricingAnalytics(
      analytics([
        { start: OCT_1_LOCAL, volume: 1, cost: 1 },
        {
          start: OCT_1_LOCAL,
          pricing_category: 'authentication',
          volume: 2,
          cost: 2,
        },
      ]),
      NOW
    );
    expect(Object.keys(parsed.byCategory).sort()).toEqual([
      'AUTHENTICATION',
      'UNCATEGORIZED',
    ]);
  });
});

describe('monthSpendWindow', () => {
  it('começa um dia antes do dia 1 UTC e termina agora', () => {
    const now = new Date('2026-10-05T15:00:00Z');
    const { startSeconds, endSeconds } = monthSpendWindow(now);
    expect(startSeconds).toBe(Date.UTC(2026, 9, 1) / 1000 - DAY);
    expect(endSeconds).toBe(Math.floor(now.getTime() / 1000));
  });

  it('logo após a virada UTC ainda cobre o mês anterior (local pode não ter virado)', () => {
    // 01/10 05:00 UTC: no fuso UTC−12 ainda é 30/09.
    const { startSeconds } = monthSpendWindow(new Date('2026-10-01T05:00:00Z'));
    expect(startSeconds).toBe(Date.UTC(2026, 8, 1) / 1000 - DAY);
  });
});

describe('parseBusinessUseCaseUsage', () => {
  it('lê call_count e o tempo para voltar a ter acesso', () => {
    const header = JSON.stringify({
      [WABA]: [
        {
          type: 'whatsapp_business_management',
          call_count: 28,
          estimated_time_to_regain_access: 12,
        },
      ],
    });
    expect(parseBusinessUseCaseUsage(header)).toEqual({
      callCount: 28,
      estimatedMinutesToRegainAccess: 12,
    });
  });

  it('várias entradas: vale o PIOR caso, não a primeira', () => {
    const header = JSON.stringify({
      [WABA]: [
        {
          type: 'whatsapp_business_manage_events',
          call_count: 3,
          estimated_time_to_regain_access: 0,
        },
        {
          type: 'whatsapp_business_management',
          call_count: 100,
          estimated_time_to_regain_access: 17,
        },
      ],
      '999': [{ call_count: 50, estimated_time_to_regain_access: 4 }],
    });
    expect(parseBusinessUseCaseUsage(header)).toEqual({
      callCount: 100,
      estimatedMinutesToRegainAccess: 17,
    });
  });

  it('campos ausentes numa entrada não zeram os da outra', () => {
    const header = JSON.stringify({
      [WABA]: [{ type: 'a' }, { call_count: 9 }],
    });
    expect(parseBusinessUseCaseUsage(header)).toEqual({
      callCount: 9,
      estimatedMinutesToRegainAccess: null,
    });
  });

  it('ausente ou ilegível → null', () => {
    expect(parseBusinessUseCaseUsage(null)).toBeNull();
    expect(parseBusinessUseCaseUsage('')).toBeNull();
    expect(parseBusinessUseCaseUsage('{nao-json')).toBeNull();
    expect(parseBusinessUseCaseUsage('[]')).toBeNull();
    expect(parseBusinessUseCaseUsage('{"x":[]}')).toBeNull();
  });
});

describe('classifyGraphError (§13.2)', () => {
  const meta = (status: number, code: number | null) =>
    new MetaApiError('boom', status, code);

  it.each([
    [401, 190, 'auth'],
    [401, 0, 'auth'],
    [401, null, 'auth'],
    [403, 10, 'permission'],
    [403, 200, 'permission'],
    [403, 299, 'permission'],
    [403, 3, 'permission'],
    [400, 131005, 'permission'],
    [403, null, 'permission'],
    [429, 4, 'rate_limit'],
    [429, 17, 'rate_limit'],
    [429, 32, 'rate_limit'],
    [429, 613, 'rate_limit'],
    [429, 80007, 'rate_limit'],
    [429, 80008, 'rate_limit'],
    [429, 130429, 'rate_limit'],
    [429, null, 'rate_limit'],
    [500, 1, 'transient'],
    [500, 2, 'transient'],
    [500, 131000, 'transient'],
    [503, null, 'transient'],
    [400, 100, 'unknown'],
    [404, null, 'unknown'],
  ] as const)('HTTP %i, código %s → %s', (status, code, kind) => {
    expect(classifyGraphError(meta(status, code)).kind).toBe(kind);
  });

  it('o código da Meta vence o status HTTP', () => {
    // 200 (permissão) chegando com status 500 ainda é permissão.
    expect(classifyGraphError(meta(500, 200)).kind).toBe('permission');
  });

  it('código 100 pede alerta de versão/campo', () => {
    expect(classifyGraphError(meta(400, 100)).suspectVersion).toBe(true);
    expect(classifyGraphError(meta(400, 190)).suspectVersion).toBe(false);
  });

  it.each([368, 131031, 130403])(
    'código %i (restrição por política) marca policyBlocked',
    (code) => {
      const c = classifyGraphError(meta(403, code));
      expect(c.policyBlocked).toBe(true);
      expect(c.kind).toBe('unknown');
    }
  );

  it('131042 é sinal de pagamento, não erro de leitura', () => {
    const c = classifyGraphError(meta(402, 131042));
    expect(c.paymentSignal).toBe(true);
    expect(c.policyBlocked).toBe(false);
  });

  it('só instanceof MetaApiError conta: um Error com o mesmo nome é transitório', () => {
    const impostor = Object.assign(new Error('boom'), {
      name: 'MetaApiError',
      status: 401,
      code: 190,
    });
    expect(classifyGraphError(impostor).kind).toBe('transient');
  });

  it('subclasse de MetaApiError é classificada pelo status/código', () => {
    class Sub extends MetaApiError {}
    expect(classifyGraphError(new Sub('x', 401, 190)).kind).toBe('auth');
  });

  it('timeout, rede e JSON ilegível (não-MetaApiError) são transitórios', () => {
    const timeout = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    expect(classifyGraphError(timeout).kind).toBe('transient');
    expect(classifyGraphError(new TypeError('fetch failed')).kind).toBe(
      'transient'
    );
    expect(classifyGraphError(new SyntaxError('Unexpected token')).kind).toBe(
      'transient'
    );
    expect(classifyGraphError('texto solto').kind).toBe('transient');
    expect(classifyGraphError(undefined).kind).toBe('transient');
  });

  it('preserva código e status para o log', () => {
    expect(classifyGraphError(meta(401, 190))).toMatchObject({
      code: 190,
      httpStatus: 401,
    });
  });
});

describe('sanitizeErrorMessage', () => {
  const TOKEN = 'EAAGabcdefghijklmnopqrstuvwxyz0123456789';

  it('remove Bearer, access_token= e o formato EAA…', () => {
    const dirty =
      `(#190) Invalid OAuth access token. Bearer ${TOKEN} ` +
      `url=https://graph.facebook.com/x?access_token=${TOKEN}&y=1 raw ${TOKEN}`;
    const clean = sanitizeErrorMessage(dirty);

    expect(clean).not.toContain(TOKEN);
    expect(clean).not.toContain('EAAG');
    expect(clean).toContain('(#190) Invalid OAuth access token.');
    expect(clean).toContain('Bearer [redacted]');
    expect(clean).toContain('access_token=[redacted]&y=1');
  });

  it('mensagem sem segredo passa intacta', () => {
    expect(sanitizeErrorMessage('(#100) Invalid parameter')).toBe(
      '(#100) Invalid parameter'
    );
  });

  it('truncar no meio de um emoji não deixa surrogate solitário', () => {
    // 499 caracteres + um emoji (2 unidades UTF-16): o corte em 500 cairia
    // entre as duas metades do par.
    const out = sanitizeErrorMessage('x'.repeat(499) + '😀' + 'tail');

    expect(out.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
    expect(out).toBe('x'.repeat(499));
    // Todo texto resultante tem que sobreviver a um round-trip UTF-8.
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('emoji inteiro dentro do limite é preservado', () => {
    const out = sanitizeErrorMessage('x'.repeat(498) + '😀' + 'tail');
    expect(out.endsWith('😀')).toBe(true);
    expect(out).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  });

  it('limita ao teto da coluna', () => {
    expect(sanitizeErrorMessage('x'.repeat(2000))).toHaveLength(
      MAX_ERROR_MESSAGE_LENGTH
    );
  });
});

describe('maskId', () => {
  it('mostra só os quatro últimos dígitos', () => {
    expect(maskId(WABA)).toBe('****4821');
    expect(maskId(null)).toBe('-');
    expect(maskId('')).toBe('-');
  });
});

describe('isFresh', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('vale dentro do TTL e vence no limite', () => {
    expect(isFresh(ago(HEALTH_TTL_MS - 1), HEALTH_TTL_MS, now)).toBe(true);
    expect(isFresh(ago(HEALTH_TTL_MS), HEALTH_TTL_MS, now)).toBe(false);
  });

  it('ausente, ilegível ou no futuro nunca vale', () => {
    expect(isFresh(null, HEALTH_TTL_MS, now)).toBe(false);
    expect(isFresh(undefined, HEALTH_TTL_MS, now)).toBe(false);
    expect(isFresh('lixo', HEALTH_TTL_MS, now)).toBe(false);
    expect(isFresh(ago(-60_000), HEALTH_TTL_MS, now)).toBe(false);
  });
});

describe('deriveSendState (§6.2)', () => {
  const T0 = '2026-10-05T10:00:00.000Z';
  const T1 = '2026-10-05T11:00:00.000Z';

  const base: SendStateSnapshot = {
    hasCredentials: true,
    healthOverall: 'AVAILABLE',
    healthCheckedAt: T1,
    paymentPending: false,
    healthErrorKind: null,
    healthErrorAt: null,
  };
  const derive = (over: Partial<SendStateSnapshot>) =>
    deriveSendState({ ...base, ...over });

  it('1. sem credencial vence tudo', () => {
    const r = derive({
      hasCredentials: false,
      paymentPending: true,
      healthOverall: 'BLOCKED',
    });
    expect(r.state).toBe('no_credentials');
  });

  it('2. erro de credencial sem leitura boa depois → auth_error', () => {
    expect(
      derive({
        healthErrorKind: 'auth',
        healthErrorAt: T1,
        healthCheckedAt: T0,
      }).state
    ).toBe('auth_error');
    expect(
      derive({
        healthErrorKind: 'permission',
        healthErrorAt: T1,
        healthCheckedAt: null,
      }).state
    ).toBe('auth_error');
  });

  it('2. leitura boa DEPOIS do erro desfaz o auth_error', () => {
    const r = derive({
      healthErrorKind: 'auth',
      healthErrorAt: T0,
      healthCheckedAt: T1,
    });
    expect(r.state).toBe('ok');
  });

  it('2. erro e leitura boa no mesmo instante contam como recuperado', () => {
    const r = derive({
      healthErrorKind: 'permission',
      healthErrorAt: T1,
      healthCheckedAt: T1,
    });
    expect(r.state).toBe('ok');
  });

  it('2. auth_error + pagamento pendente: pagamento vira alerta secundário', () => {
    const r = derive({
      paymentPending: true,
      healthErrorKind: 'auth',
      healthErrorAt: T1,
      healthCheckedAt: T0,
    });
    expect(r.state).toBe('auth_error');
    expect(r.secondaryPaymentAlert).toBe(true);
    expect(r.paymentPending).toBe(true);
  });

  it('3. pagamento pendente → payment_blocked, mesmo com health AVAILABLE (D-4)', () => {
    const r = derive({ paymentPending: true, healthOverall: 'AVAILABLE' });
    expect(r.state).toBe('payment_blocked');
    expect(r.secondaryPaymentAlert).toBe(false);
  });

  it('3. pagamento pendente vence BLOCKED e LIMITED', () => {
    expect(
      derive({ paymentPending: true, healthOverall: 'BLOCKED' }).state
    ).toBe('payment_blocked');
    expect(
      derive({ paymentPending: true, healthOverall: 'LIMITED' }).state
    ).toBe('payment_blocked');
  });

  it('4-6. BLOCKED, LIMITED e AVAILABLE', () => {
    expect(derive({ healthOverall: 'BLOCKED' }).state).toBe('blocked');
    expect(derive({ healthOverall: 'LIMITED' }).state).toBe('limited');
    expect(derive({ healthOverall: 'AVAILABLE' }).state).toBe('ok');
  });

  it('7. nunca houve leitura → unknown', () => {
    const r = derive({ healthOverall: null, healthCheckedAt: null });
    expect(r.state).toBe('unknown');
    expect(r.stale).toBe(false);
  });

  it('transitória com retrato anterior: mantém o estado e liga stale', () => {
    for (const kind of ['transient', 'rate_limit'] as const) {
      const r = derive({
        healthOverall: 'LIMITED',
        healthCheckedAt: T0,
        healthErrorKind: kind,
        healthErrorAt: T1,
      });
      expect(r.state).toBe('limited');
      expect(r.stale).toBe(true);
    }
  });

  it('transitória SEM retrato anterior → unknown, sem stale', () => {
    const r = derive({
      healthOverall: null,
      healthCheckedAt: null,
      healthErrorKind: 'transient',
      healthErrorAt: T1,
    });
    expect(r.state).toBe('unknown');
    expect(r.stale).toBe(false);
  });

  it('transitória já superada por leitura boa não é stale', () => {
    const r = derive({
      healthCheckedAt: T1,
      healthErrorKind: 'transient',
      healthErrorAt: T0,
    });
    expect(r.state).toBe('ok');
    expect(r.stale).toBe(false);
  });

  it('erro "unknown" (ex.: código 100) sem leitura boa depois → unknown', () => {
    const r = derive({
      healthOverall: 'AVAILABLE',
      healthCheckedAt: T0,
      healthErrorKind: 'unknown',
      healthErrorAt: T1,
    });
    expect(r.state).toBe('unknown');
  });

  it('valor fora do vocabulário (health nulo) com credencial → unknown', () => {
    expect(derive({ healthOverall: null }).state).toBe('unknown');
  });
});

describe('readStatus (§10.2)', () => {
  it('failed + 131042 → paymentBlocked', () => {
    expect(
      readStatus({ status: 'failed', errors: [{ code: 131042 }] })
        .paymentBlocked
    ).toBe(true);
  });

  it('código 131042 como string também vale', () => {
    expect(
      readStatus({ status: 'failed', errors: [{ code: '131042' }] })
        .paymentBlocked
    ).toBe(true);
  });

  it('failed + 131026 → não', () => {
    expect(
      readStatus({ status: 'failed', errors: [{ code: 131026 }] })
        .paymentBlocked
    ).toBe(false);
  });

  it('131042 fora de status "failed" não liga o bloqueio', () => {
    expect(
      readStatus({ status: 'delivered', errors: [{ code: 131042 }] })
        .paymentBlocked
    ).toBe(false);
  });

  it('failed sem errors → não', () => {
    expect(readStatus({ status: 'failed' }).paymentBlocked).toBe(false);
  });

  it('delivered com pricing.billable true / false / ausente', () => {
    expect(
      readStatus({
        status: 'delivered',
        pricing: { billable: true, category: 'marketing' },
      })
    ).toEqual({ billable: true, category: 'MARKETING', paymentBlocked: false });

    expect(
      readStatus({
        status: 'delivered',
        pricing: { billable: false, category: 'service' },
      })
    ).toEqual({ billable: false, category: 'SERVICE', paymentBlocked: false });

    expect(readStatus({ status: 'delivered' })).toEqual({
      billable: null,
      category: null,
      paymentBlocked: false,
    });
  });

  it('billable que não é boolean vira nulo (não adivinha)', () => {
    expect(
      readStatus({
        status: 'sent',
        pricing: { billable: 'true' as unknown as boolean },
      }).billable
    ).toBeNull();
  });
});
