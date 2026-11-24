import { describe, expect, it } from 'vitest';
import { META_WEBHOOK_MAX_BODY_BYTES, readTextWithLimit } from './webhook-body';

function post(
  body: BodyInit | null,
  headers: Record<string, string> = {}
): Request {
  return new Request('https://crm.example/api/whatsapp/webhook', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  } as RequestInit);
}

/** Um chunk por leitura (sem buffer), contando leituras e cancelamento. */
function chunked(chunks: Uint8Array[], { hangOnCancel = false } = {}) {
  const seen = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[seen.pulls++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        seen.cancelled = true;
        return hangOnCancel ? new Promise<void>(() => {}) : undefined;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, seen };
}

const bytes = (...values: number[]) => Uint8Array.from(values);
const BOM = [0xef, 0xbb, 0xbf];

describe('readTextWithLimit', () => {
  it('o teto tem folga sobre os 3 MB que a Meta documenta', () => {
    expect(META_WEBHOOK_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
  });

  it('exatamente o teto passa; um byte a mais não', async () => {
    await expect(readTextWithLimit(post('abcd'), 4)).resolves.toBe('abcd');
    await expect(readTextWithLimit(post('abcde'), 4)).resolves.toBeNull();
  });

  it('o teto é em BYTES, não em caracteres', async () => {
    // "ç" = 2 bytes em UTF-8.
    await expect(readTextWithLimit(post('ççç'), 5)).resolves.toBeNull();
    await expect(readTextWithLimit(post('ççç'), 6)).resolves.toBe('ççç');
  });

  it('content-length declarado acima do teto: nada é lido', async () => {
    const { stream, seen } = chunked([bytes(0x61)]);
    await expect(
      readTextWithLimit(post(stream, { 'content-length': '5' }), 4)
    ).resolves.toBeNull();
    expect(seen.pulls).toBe(0);
  });

  it.each([
    ['ausente', {}],
    ['mentiroso', { 'content-length': '1' }],
    ['ilegível', { 'content-length': 'abc' }],
  ])(
    'content-length %s não burla: aborta no chunk que estoura, sem ler o resto',
    async (_label, headers) => {
      const chunk = new Uint8Array(3);
      const { stream, seen } = chunked(Array(100).fill(chunk));
      await expect(
        readTextWithLimit(post(stream, headers as Record<string, string>), 4)
      ).resolves.toBeNull();
      expect(seen.pulls).toBe(2);
      expect(seen.cancelled).toBe(true);
    }
  );

  it('cancelamento que nunca termina não segura a resposta', async () => {
    const { stream } = chunked([new Uint8Array(9)], { hangOnCancel: true });
    await expect(readTextWithLimit(post(stream), 4)).resolves.toBeNull();
  });

  it('corpo ausente vira string vazia, como em request.text()', async () => {
    await expect(readTextWithLimit(post(null), 4)).resolves.toBe('');
  });

  it('conexão que cai no meio: o erro é lançado, como em request.text()', async () => {
    const broken = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('aborted'));
        },
      });
    await expect(post(broken()).text()).rejects.toThrow('aborted');
    await expect(readTextWithLimit(post(broken()), 4)).rejects.toThrow(
      'aborted'
    );
  });

  it('corpo grande em vários chunks: nada se perde quando o buffer cresce', async () => {
    // Cada chunk com um conteúdo, em tamanhos que não dividem 64 KiB.
    const chunks = Array.from({ length: 40 }, (_, i) =>
      new Uint8Array(25_001).fill(0x41 + (i % 26))
    );
    const total = 40 * 25_001;
    const expected = await post(Buffer.concat(chunks)).text();
    const { stream } = chunked(chunks);
    const text = await readTextWithLimit(post(stream), total);
    expect(text === expected).toBe(true);
  });

  it('caractere partido entre dois chunks não se corrompe', async () => {
    const { stream } = chunked([bytes(0xc3), bytes(0xa7)]);
    await expect(readTextWithLimit(post(stream), 4)).resolves.toBe('ç');
  });

  it('mesmo texto que request.text(): BOM, BOM duplo, UTF-8 inválido e bytes quaisquer', async () => {
    const cases = [
      bytes(...BOM, 0x7b, 0x7d),
      bytes(...BOM, ...BOM, 0x7b, 0x7d),
      bytes(0x7b, 0xff, 0xfe, 0xc3, 0x28, 0xe2, 0x82, 0x7d),
      bytes(0x7b, 0xf0, 0x9f),
      bytes(...BOM),
      bytes(),
    ];
    for (let seed = 1; seed <= 300; seed++) {
      // Determinístico: a falha se repete com o mesmo `seed`.
      const n = 1 + (seed % 37);
      cases.push(
        Uint8Array.from(
          { length: n },
          (_, i) => (seed * 73 + i * i * 151) % 256
        )
      );
    }
    for (const body of cases) {
      const expected = await post(body.slice()).text();
      const { stream } = chunked(
        Array.from(body, (b) => bytes(b)) // um byte por chunk: o pior caso
      );
      await expect(readTextWithLimit(post(stream), 1000)).resolves.toBe(
        expected
      );
    }
  });
});
