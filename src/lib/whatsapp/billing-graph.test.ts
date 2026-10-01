import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from './meta-api';
import {
  BillingGraphError,
  getMonthSpend,
  getSendStatus,
  META_BILLING_API_VERSION,
} from './billing-graph';
import { classifyGraphError } from './billing-monitor';

const WABA = '100000000004821';
const TOKEN = 'EAAGtest0123456789abcdefghijklmnop';
const OCT_1_LOCAL = 1_790_823_600;

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function stubFetch(response: Response | (() => Promise<Response>)) {
  const fn = vi.fn(
    typeof response === 'function' ? response : async () => response
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** URL e opções da primeira chamada ao fetch simulado. */
function firstCall(fn: ReturnType<typeof stubFetch>) {
  const [input, init] = fn.mock.calls[0] as unknown as [
    URL | string,
    RequestInit,
  ];
  return { url: new URL(String(input)), init };
}

describe('billing-graph', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('getSendStatus', () => {
    it('chama a v26.0, pede currency,health_status e interpreta a resposta', async () => {
      const fetchFn = stubFetch(
        jsonResponse({
          id: WABA,
          currency: 'USD',
          health_status: {
            can_send_message: 'AVAILABLE',
            entities: [{ entity_type: 'WABA', can_send_message: 'AVAILABLE' }],
          },
        })
      );

      const { data } = await getSendStatus({
        wabaId: WABA,
        accessToken: TOKEN,
      });
      const { url } = firstCall(fetchFn);

      expect(META_BILLING_API_VERSION).toBe('v26.0');
      expect(url.origin + url.pathname).toBe(
        `https://graph.facebook.com/v26.0/${WABA}`
      );
      expect(url.searchParams.get('fields')).toBe('currency,health_status');
      expect(data.overall).toBe('AVAILABLE');
      expect(data.currency).toBe('USD');
    });

    it('o token vai só no header Authorization, nunca na URL (§12)', async () => {
      const fetchFn = stubFetch(jsonResponse({}));
      await getSendStatus({ wabaId: WABA, accessToken: TOKEN });
      const { url, init } = firstCall(fetchFn);

      expect(url.toString()).not.toContain(TOKEN);
      expect(url.toString()).not.toContain('access_token');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`
      );
    });

    it('aplica timeout de 10 s via AbortSignal', async () => {
      const fetchFn = stubFetch(jsonResponse({}));
      await getSendStatus({ wabaId: WABA, accessToken: TOKEN });
      expect(firstCall(fetchFn).init.signal).toBeInstanceOf(AbortSignal);
    });

    it('devolve a folga de taxa lida do cabeçalho', async () => {
      stubFetch(
        jsonResponse(
          {},
          {
            headers: {
              'X-Business-Use-Case-Usage': JSON.stringify({
                [WABA]: [
                  {
                    call_count: 12,
                    estimated_time_to_regain_access: 0,
                  },
                ],
              }),
            },
          }
        )
      );
      const { usage } = await getSendStatus({
        wabaId: WABA,
        accessToken: TOKEN,
      });
      expect(usage).toEqual({
        callCount: 12,
        estimatedMinutesToRegainAccess: 0,
      });
    });

    it('rejeita wabaId que não é só dígitos SEM chamar a Meta', async () => {
      const fetchFn = stubFetch(jsonResponse({}));
      await expect(
        getSendStatus({ wabaId: '123/../456', accessToken: TOKEN })
      ).rejects.toBeInstanceOf(MetaApiError);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('erros', () => {
    it('401 vira BillingGraphError (ainda um MetaApiError) com status e código', async () => {
      stubFetch(
        jsonResponse(
          { error: { message: 'Invalid OAuth access token.', code: 190 } },
          { status: 401 }
        )
      );

      const err = await getSendStatus({
        wabaId: WABA,
        accessToken: TOKEN,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BillingGraphError);
      expect(err).toBeInstanceOf(MetaApiError);
      expect(err).toMatchObject({ status: 401, code: 190 });
      expect((err as Error).message).toContain('(#190)');
      expect(classifyGraphError(err).kind).toBe('auth');
    });

    it('429 carrega o tempo de espera do cabeçalho para o recuo', async () => {
      stubFetch(
        jsonResponse(
          { error: { message: 'Too many calls', code: 80008 } },
          {
            status: 429,
            headers: {
              'X-Business-Use-Case-Usage': JSON.stringify({
                [WABA]: [
                  { call_count: 100, estimated_time_to_regain_access: 17 },
                ],
              }),
            },
          }
        )
      );

      const err = (await getMonthSpend({
        wabaId: WABA,
        accessToken: TOKEN,
        start: 1,
        end: 2,
      }).catch((e: unknown) => e)) as BillingGraphError;

      expect(err).toBeInstanceOf(BillingGraphError);
      expect(err.usage?.estimatedMinutesToRegainAccess).toBe(17);
      expect(classifyGraphError(err).kind).toBe('rate_limit');
    });

    it('corpo de erro que não é JSON cai no texto padrão com o status', async () => {
      stubFetch(new Response('<html>bad gateway</html>', { status: 502 }));
      const err = await getSendStatus({
        wabaId: WABA,
        accessToken: TOKEN,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BillingGraphError);
      expect((err as Error).message).toBe('Meta API error: 502');
      expect(classifyGraphError(err).kind).toBe('transient');
    });

    it('falha de rede propaga como está (classificada como transitória)', async () => {
      stubFetch(async () => {
        throw new TypeError('fetch failed');
      });
      const err = await getSendStatus({
        wabaId: WABA,
        accessToken: TOKEN,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TypeError);
      expect(classifyGraphError(err).kind).toBe('transient');
    });

    it('200 com corpo que não é JSON vira erro transitório', async () => {
      stubFetch(new Response('nope', { status: 200 }));
      const err = await getSendStatus({
        wabaId: WABA,
        accessToken: TOKEN,
      }).catch((e: unknown) => e);
      expect(classifyGraphError(err).kind).toBe('transient');
    });
  });

  describe('getMonthSpend', () => {
    it('monta pricing_analytics DAILY por PRICING_CATEGORY e soma o mês local', async () => {
      const fetchFn = stubFetch(
        jsonResponse({
          pricing_analytics: {
            data: [
              {
                data_points: [
                  {
                    start: OCT_1_LOCAL,
                    end: OCT_1_LOCAL + 86_400,
                    pricing_category: 'MARKETING',
                    volume: 113,
                    cost: 7.0625,
                  },
                ],
              },
            ],
          },
        })
      );

      const { data } = await getMonthSpend({
        wabaId: WABA,
        accessToken: TOKEN,
        start: 1_790_726_400,
        end: 1_791_000_000,
        now: new Date('2026-10-05T15:00:00Z'),
      });
      const { url } = firstCall(fetchFn);

      expect(url.pathname).toBe(`/v26.0/${WABA}`);
      expect(url.searchParams.get('fields')).toBe(
        'pricing_analytics.start(1790726400).end(1791000000)' +
          '.granularity(DAILY).dimensions(["PRICING_CATEGORY"])'
      );
      expect(url.toString()).not.toContain(TOKEN);
      expect(data.total).toBe(7.0625);
      expect(data.tzOffsetSeconds).toBe(-10_800);
    });

    it('janela não inteira é recusada sem chamar a Meta', async () => {
      const fetchFn = stubFetch(jsonResponse({}));
      await expect(
        getMonthSpend({
          wabaId: WABA,
          accessToken: TOKEN,
          start: Number.NaN,
          end: 2,
        })
      ).rejects.toBeInstanceOf(MetaApiError);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('log (§13.1)', () => {
    it('uma linha por chamada, com WABA mascarado e sem token', async () => {
      stubFetch(jsonResponse({}));
      await getSendStatus({
        wabaId: WABA,
        accessToken: TOKEN,
        accountId: 'acc-1',
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = String(logSpy.mock.calls[0][0]);
      expect(line).toContain('[billing-monitor]');
      expect(line).toContain('account=acc-1');
      expect(line).toContain('waba=****4821');
      expect(line).toContain('field=health_status');
      expect(line).toContain('http=200');
      expect(line).toContain('outcome=ok');
      expect(line).not.toContain(WABA);
      expect(line).not.toContain(TOKEN);
    });

    it('registra a falha com o código, também sem token', async () => {
      stubFetch(
        jsonResponse(
          { error: { message: `bad token ${TOKEN}`, code: 190 } },
          { status: 401 }
        )
      );
      await getSendStatus({ wabaId: WABA, accessToken: TOKEN }).catch(
        () => undefined
      );

      const line = String(logSpy.mock.calls[0][0]);
      expect(line).toContain('http=401');
      expect(line).toContain('code=190');
      expect(line).toContain('outcome=error');
      expect(line).not.toContain(TOKEN);
    });
  });
});
