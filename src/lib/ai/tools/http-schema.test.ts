import { describe, expect, it } from 'vitest';
import {
  MAX_ARGUMENT_BYTES,
  parseHttpArgs,
  toModelSchema,
  validateInputSchema,
  type HttpInputSchema,
} from './http-schema';
import {
  mergeHeaders,
  parseHeaderInputs,
  validateHeaders,
} from './http-headers';

function schemaOf(raw: unknown): HttpInputSchema {
  const r = validateInputSchema(raw);
  if (!r.ok) throw new Error(`schema rejected: ${r.error}`);
  return r.schema;
}

const STOCK = {
  type: 'object',
  properties: {
    sku: { type: 'string', description: 'Product code', maxLength: 30 },
    qty: { type: 'integer', minimum: 1, maximum: 100 },
    size: { type: 'string', enum: ['P', 'M', 'G'] },
    express: { type: 'boolean' },
    price: { type: 'number', minimum: 0 },
  },
  required: ['sku'],
};

describe('validateInputSchema', () => {
  it('normalizes: explicit required, additionalProperties false, default maxLength', () => {
    const s = schemaOf(STOCK);
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['sku']);
    expect(s.properties.size.maxLength).toBe(200);
    expect(s.properties.sku.maxLength).toBe(30);
  });

  it('accepts a tool that takes no input', () => {
    expect(schemaOf({ type: 'object' }).properties).toEqual({});
    expect(schemaOf({ type: 'object', properties: {} }).required).toEqual([]);
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['wrong type', { type: 'array' }],
    [
      'additionalProperties true',
      { type: 'object', additionalProperties: true },
    ],
    ['$ref', { type: 'object', properties: {}, $ref: '#/x' }],
    ['oneOf', { type: 'object', oneOf: [] }],
    [
      'nested object field',
      { type: 'object', properties: { a: { type: 'object' } } },
    ],
    ['array field', { type: 'object', properties: { a: { type: 'array' } } }],
    [
      'pattern',
      {
        type: 'object',
        properties: { a: { type: 'string', pattern: '(a+)+$' } },
      },
    ],
    [
      'format',
      { type: 'object', properties: { a: { type: 'string', format: 'uri' } } },
    ],
    [
      'default',
      { type: 'object', properties: { a: { type: 'string', default: 'x' } } },
    ],
    [
      'required names an inherited key',
      { type: 'object', properties: {}, required: ['toString'] },
    ],
    [
      'required not declared',
      { type: 'object', properties: {}, required: ['x'] },
    ],
    [
      'maxLength over the cap',
      {
        type: 'object',
        properties: { a: { type: 'string', maxLength: 5000 } },
      },
    ],
    [
      'min > max',
      {
        type: 'object',
        properties: { a: { type: 'number', minimum: 5, maximum: 1 } },
      },
    ],
    [
      'enum on boolean',
      { type: 'object', properties: { a: { type: 'boolean', enum: [true] } } },
    ],
    [
      'mixed enum',
      { type: 'object', properties: { a: { type: 'string', enum: ['x', 2] } } },
    ],
    [
      'huge enum',
      {
        type: 'object',
        properties: {
          a: {
            type: 'string',
            enum: Array.from({ length: 21 }, (_, i) => `v${i}`),
          },
        },
      },
    ],
    [
      'field name with a space',
      { type: 'object', properties: { 'a b': { type: 'string' } } },
    ],
    [
      'field name starting with a digit',
      { type: 'object', properties: { '1a': { type: 'string' } } },
    ],
    [
      '__proto__',
      JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"}}}'
      ),
    ],
    [
      'constructor',
      { type: 'object', properties: { constructor: { type: 'string' } } },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(validateInputSchema(raw).ok).toBe(false);
  });

  it('rejects more than 10 fields', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`f${i}`, { type: 'string' }])
    );
    const r = validateInputSchema({ type: 'object', properties });
    expect(r).toEqual({ ok: false, error: 'too_many_fields' });
  });

  it.each([
    'account_id',
    'accountId',
    'contact_id',
    'contactId',
    'conversation_id',
    'user_id',
    'tenantId',
  ])(
    'rejects an identity field (%s): the model never picks an id (D-16)',
    (name) => {
      const r = validateInputSchema({
        type: 'object',
        properties: { [name]: { type: 'string' } },
      });
      expect(r.ok).toBe(false);
    }
  );

  it('allows an order id (not an identity of the CRM)', () => {
    expect(
      validateInputSchema({
        type: 'object',
        properties: { order_id: { type: 'string' } },
      }).ok
    ).toBe(true);
  });

  it('limits the size of the schema', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `f${i}`,
        {
          type: 'string',
          description: 'x'.repeat(200),
          enum: Array.from({ length: 20 }, (_, j) =>
            `value-${i}-${j}-`.padEnd(60, 'z')
          ),
        },
      ])
    );
    const r = validateInputSchema({ type: 'object', properties });
    expect(r.ok).toBe(false);
  });

  it('the model schema forbids extra properties and keeps the fields', () => {
    const model = toModelSchema(schemaOf(STOCK));
    expect(model.additionalProperties).toBe(false);
    expect(Object.keys(model.properties)).toEqual([
      'sku',
      'qty',
      'size',
      'express',
      'price',
    ]);
    expect(model.required).toEqual(['sku']);
  });
});

describe('parseHttpArgs', () => {
  const schema = schemaOf(STOCK);

  it('parses valid arguments and keeps their types', () => {
    const r = parseHttpArgs(schema, {
      sku: ' A-1 ',
      qty: 3,
      size: 'M',
      express: true,
      price: 9.5,
    });
    expect(r).toEqual({
      ok: true,
      value: { sku: 'A-1', qty: 3, size: 'M', express: true, price: 9.5 },
    });
  });

  it('INJECTION: a url / host / path / port / method the model adds is dropped', () => {
    const r = parseHttpArgs(schema, {
      sku: 'A1',
      url: 'http://169.254.169.254/latest/meta-data',
      host: 'evil.test',
      path: '/admin',
      port: 22,
      method: 'DELETE',
      headers: { Authorization: 'x' },
      account_id: 'other-account',
      contact_id: 'other-contact',
    });
    expect(r).toEqual({ ok: true, value: { sku: 'A1' } });
  });

  it('a declared string that looks like a URL is plain data, kept verbatim', () => {
    const r = parseHttpArgs(schema, { sku: 'http://evil.test/x?a=b' });
    expect(r).toEqual({ ok: true, value: { sku: 'http://evil.test/x?a=b' } });
  });

  it.each([
    [{}, 'missing_sku'],
    [{ sku: 5 }, 'invalid_sku'],
    [{ sku: '' }, 'missing_sku'],
    [{ sku: 'x'.repeat(31) }, 'sku_too_long'],
    [{ sku: 'a', qty: 0 }, 'invalid_qty'],
    [{ sku: 'a', qty: 101 }, 'invalid_qty'],
    [{ sku: 'a', qty: 1.5 }, 'invalid_qty'],
    [{ sku: 'a', qty: '3' }, 'invalid_qty'],
    [{ sku: 'a', size: 'XL' }, 'invalid_size'],
    [{ sku: 'a', express: 'yes' }, 'invalid_express'],
    [{ sku: 'a', price: Infinity }, 'invalid_price'],
    [{ sku: 'a', price: -1 }, 'invalid_price'],
  ])('rejects %j with %s', (input, error) => {
    const r = parseHttpArgs(schema, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  });

  it('rejects non-object arguments, treats null as {}', () => {
    expect(parseHttpArgs(schema, 'x').ok).toBe(false);
    expect(parseHttpArgs(schema, [1]).ok).toBe(false);
    expect(parseHttpArgs(schemaOf({ type: 'object' }), null)).toEqual({
      ok: true,
      value: {},
    });
  });

  it('strips control characters (NUL included) from strings', () => {
    const r = parseHttpArgs(schema, { sku: 'A\u0000B\u0007C' });
    expect(r).toEqual({ ok: true, value: { sku: 'ABC' } });
  });

  it('ignores an inherited key: only own properties count', () => {
    const polluted = Object.create({ sku: 'from-prototype' });
    expect(parseHttpArgs(schema, polluted).ok).toBe(false);
  });

  it('limits the serialized size of the arguments', () => {
    const big = schemaOf({
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `f${i}`,
          { type: 'string', maxLength: 1000 },
        ])
      ),
    });
    const input = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`f${i}`, 'x'.repeat(900)])
    );
    expect(JSON.stringify(input).length).toBeGreaterThan(MAX_ARGUMENT_BYTES);
    expect(parseHttpArgs(big, input)).toEqual({
      ok: false,
      error: 'arguments_too_large',
    });
  });
});

describe('validateHeaders', () => {
  it('accepts a normal set', () => {
    const r = validateHeaders({
      Authorization: 'Bearer abc.def',
      'X-Api-Key': 'k_123',
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['Host', 'evil.test'],
    ['Content-Length', '0'],
    ['Content-Type', 'text/plain'],
    ['Transfer-Encoding', 'chunked'],
    ['Connection', 'upgrade'],
    ['X-Forwarded-For', '127.0.0.1'],
    ['Proxy-Authorization', 'x'],
    ['Sec-Fetch-Mode', 'cors'],
  ])('refuses the header %s (the code owns it)', (name, value) => {
    expect(validateHeaders({ [name]: value })).toEqual({
      ok: false,
      error: 'forbidden_header',
    });
  });

  it.each([
    ['name with a space', { 'X Key': 'v' }],
    ['name with a colon', { 'X:Key': 'v' }],
    ['value with CRLF (header smuggling)', { 'X-Key': 'a\r\nX-Evil: 1' }],
    ['value with LF', { 'X-Key': 'a\nb' }],
    ['value with NUL', { 'X-Key': 'a\u0000b' }],
    ['non-ASCII value', { 'X-Key': 'não' }],
    ['empty value', { 'X-Key': '' }],
    ['non-string value', { 'X-Key': 5 }],
    ['an array', [['a', 'b']]],
  ])('rejects %s', (_l, raw) => {
    expect(validateHeaders(raw).ok).toBe(false);
  });

  it('rejects duplicates ignoring case and more than 10 headers', () => {
    expect(validateHeaders({ 'X-A': '1', 'x-a': '2' })).toEqual({
      ok: false,
      error: 'duplicate_header',
    });
    const many = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`X-H${i}`, 'v'])
    );
    expect(validateHeaders(many)).toEqual({
      ok: false,
      error: 'too_many_headers',
    });
  });

  it('rejects a value over 2000 characters', () => {
    expect(validateHeaders({ 'X-Key': 'a'.repeat(2001) }).ok).toBe(false);
  });
});

describe('header inputs and merge (write-only values)', () => {
  it('a value left out keeps the stored value; a name left out is removed', () => {
    const items = parseHeaderInputs([
      { name: 'Authorization' },
      { name: 'X-New', value: 'n' },
    ]);
    if (!items.ok) throw new Error('rejected');
    const merged = mergeHeaders(
      { Authorization: 'Bearer keep-me', 'X-Old': 'gone' },
      items.items
    );
    expect(merged).toEqual({
      ok: true,
      headers: { Authorization: 'Bearer keep-me', 'X-New': 'n' },
    });
  });

  it('keeping the value of a name that is not stored is refused', () => {
    const items = parseHeaderInputs([{ name: 'X-Missing' }]);
    if (!items.ok) throw new Error('rejected');
    expect(mergeHeaders({}, items.items)).toEqual({
      ok: false,
      error: 'header_value_required',
    });
  });

  it('a blank value means keep, a forbidden name is still refused', () => {
    const items = parseHeaderInputs([{ name: 'Authorization', value: '' }]);
    if (!items.ok) throw new Error('rejected');
    expect(items.items[0]).toEqual({ name: 'Authorization' });
    const bad = parseHeaderInputs([{ name: 'Host', value: 'x' }]);
    if (!bad.ok) throw new Error('rejected');
    expect(mergeHeaders({}, bad.items).ok).toBe(false);
  });

  it('matches names ignoring case when keeping', () => {
    const items = parseHeaderInputs([{ name: 'authorization' }]);
    if (!items.ok) throw new Error('rejected');
    expect(mergeHeaders({ Authorization: 'Bearer z' }, items.items)).toEqual({
      ok: true,
      headers: { authorization: 'Bearer z' },
    });
  });
});
