import type { JsonSchemaObject } from '../types';
import { readString, stripControl, type Obj } from './input';
import type { ParseResult } from './types';

// ============================================================
// Input schema of an account-defined HTTP tool (SPEC 089 F6).
//
// The admin describes the fields the MODEL fills. It is a deliberately small
// subset of JSON Schema: a FLAT object of scalar fields. No nesting, no
// arrays, no `$ref`, `oneOf` or `pattern` (no regex to explode, nothing to
// recurse into), so a validator this size is enough and its limits are
// provable. What the model fills only ever becomes a JSON body field (POST)
// or a query-string pair (GET): never a host, a scheme, a port or a path.
// ============================================================

export type FieldType = 'string' | 'number' | 'integer' | 'boolean';

export interface FieldSpec {
  type: FieldType;
  description?: string;
  enum?: (string | number)[];
  minLength?: number;
  /** Strings: always set (default `DEFAULT_MAX_LENGTH`). */
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

/** The normalized schema stored in `ai_custom_tools.input_schema`. */
export interface HttpInputSchema {
  type: 'object';
  properties: Record<string, FieldSpec>;
  required: string[];
  additionalProperties: false;
}

export const MAX_FIELDS = 10;
export const MAX_FIELD_NAME = 40;
export const MAX_FIELD_DESCRIPTION = 200;
export const MAX_ENUM_VALUES = 20;
export const DEFAULT_MAX_LENGTH = 200;
export const MAX_STRING_LENGTH = 1000;
/** Serialized size of the schema (the DB CHECK is 4096 bytes). */
export const MAX_SCHEMA_BYTES = 3500;
/** Serialized size of the arguments the model sends. */
export const MAX_ARGUMENT_BYTES = 4096;

const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * The catalog invariant (SPEC 089 D-16): the model never supplies the id of
 * an account, contact, conversation or user. An admin's field of that shape
 * would invite exactly that, so it is refused.
 */
const IDENTITY_FIELD_RE = /^(account|contact|conversation|user|tenant)_?id$/i;

const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'number',
  'integer',
  'boolean',
];
const FIELD_KEYS = new Set([
  'type',
  'description',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
]);
const TOP_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'description',
]);

export type SchemaResult =
  { ok: true; schema: HttpInputSchema } | { ok: false; error: string };

const fail = (error: string): SchemaResult => ({ ok: false, error });

const isRecord = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

function parseField(name: string, raw: unknown): FieldSpec | string {
  if (!isRecord(raw)) return `invalid_field:${name}`;
  for (const k of Object.keys(raw)) {
    if (!FIELD_KEYS.has(k)) return `unsupported_keyword:${name}.${k}`;
  }
  const type = raw.type;
  if (typeof type !== 'string' || !FIELD_TYPES.includes(type as FieldType)) {
    return `invalid_type:${name}`;
  }
  const spec: FieldSpec = { type: type as FieldType };

  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string')
      return `invalid_description:${name}`;
    const d = stripControl(raw.description).trim();
    if (d.length > MAX_FIELD_DESCRIPTION) return `description_too_long:${name}`;
    if (d) spec.description = d;
  }

  if (spec.type === 'string') {
    let max = DEFAULT_MAX_LENGTH;
    if (raw.maxLength !== undefined) {
      if (
        !Number.isInteger(raw.maxLength) ||
        (raw.maxLength as number) < 1 ||
        (raw.maxLength as number) > MAX_STRING_LENGTH
      ) {
        return `invalid_maxLength:${name}`;
      }
      max = raw.maxLength as number;
    }
    spec.maxLength = max;
    if (raw.minLength !== undefined) {
      if (
        !Number.isInteger(raw.minLength) ||
        (raw.minLength as number) < 0 ||
        (raw.minLength as number) > max
      ) {
        return `invalid_minLength:${name}`;
      }
      spec.minLength = raw.minLength as number;
    }
  } else if (raw.minLength !== undefined || raw.maxLength !== undefined) {
    return `unsupported_keyword:${name}.length`;
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    for (const k of ['minimum', 'maximum'] as const) {
      if (raw[k] === undefined) continue;
      if (!isFiniteNumber(raw[k])) return `invalid_${k}:${name}`;
      spec[k] = raw[k] as number;
    }
    if (
      spec.minimum !== undefined &&
      spec.maximum !== undefined &&
      spec.minimum > spec.maximum
    ) {
      return `invalid_range:${name}`;
    }
  } else if (raw.minimum !== undefined || raw.maximum !== undefined) {
    return `unsupported_keyword:${name}.range`;
  }

  if (raw.enum !== undefined) {
    if (spec.type === 'boolean') return `unsupported_keyword:${name}.enum`;
    if (
      !Array.isArray(raw.enum) ||
      raw.enum.length === 0 ||
      raw.enum.length > MAX_ENUM_VALUES
    ) {
      return `invalid_enum:${name}`;
    }
    const values: (string | number)[] = [];
    for (const v of raw.enum) {
      if (spec.type === 'string') {
        if (
          typeof v !== 'string' ||
          v.length === 0 ||
          v.length > spec.maxLength!
        ) {
          return `invalid_enum:${name}`;
        }
        values.push(stripControl(v));
      } else {
        if (!isFiniteNumber(v)) return `invalid_enum:${name}`;
        if (spec.type === 'integer' && !Number.isInteger(v)) {
          return `invalid_enum:${name}`;
        }
        values.push(v);
      }
    }
    spec.enum = [...new Set(values)];
  }
  return spec;
}

/**
 * Validate what the admin typed and return the normalized schema (explicit
 * `required`, `additionalProperties: false`, a default `maxLength` on every
 * string). An empty object (no fields) is valid: a tool that takes no input.
 */
export function validateInputSchema(raw: unknown): SchemaResult {
  if (!isRecord(raw)) return fail('invalid_schema');
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) return fail(`unsupported_keyword:${k}`);
  }
  if (raw.type !== 'object') return fail('invalid_schema');
  if (
    raw.additionalProperties !== undefined &&
    raw.additionalProperties !== false
  ) {
    return fail('invalid_additionalProperties');
  }
  const rawProps = raw.properties ?? {};
  if (!isRecord(rawProps)) return fail('invalid_schema');

  const names = Object.keys(rawProps);
  if (names.length > MAX_FIELDS) return fail('too_many_fields');

  const properties: Record<string, FieldSpec> = {};
  for (const name of names) {
    if (
      name.length > MAX_FIELD_NAME ||
      !FIELD_NAME_RE.test(name) ||
      RESERVED_NAMES.has(name)
    ) {
      return fail(`invalid_field_name:${name.slice(0, MAX_FIELD_NAME)}`);
    }
    if (IDENTITY_FIELD_RE.test(name)) return fail(`identity_field:${name}`);
    const spec = parseField(name, rawProps[name]);
    if (typeof spec === 'string') return fail(spec);
    properties[name] = spec;
  }

  const required: string[] = [];
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required)) return fail('invalid_required');
    for (const r of raw.required) {
      if (
        typeof r !== 'string' ||
        !Object.prototype.hasOwnProperty.call(properties, r)
      ) {
        return fail('invalid_required');
      }
      if (!required.includes(r)) required.push(r);
    }
  }

  const schema: HttpInputSchema = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
  if (
    new TextEncoder().encode(JSON.stringify(schema)).length > MAX_SCHEMA_BYTES
  ) {
    return fail('schema_too_large');
  }
  return { ok: true, schema };
}

/** A stored schema re-checked before use (never trust the column blindly). */
export function readStoredSchema(raw: unknown): HttpInputSchema | null {
  const r = validateInputSchema(raw);
  return r.ok ? r.schema : null;
}

export type HttpArgs = Record<string, string | number | boolean>;

/**
 * Parse what the model sent against the schema. Reads ONLY the declared
 * fields: a `url`, `host`, `path`, `account_id`… the model adds is dropped,
 * and a declared string is plain data (it is percent-encoded into a query
 * string or JSON-encoded into the body, never concatenated into the URL).
 */
export function parseHttpArgs(
  schema: HttpInputSchema,
  input: unknown
): ParseResult<HttpArgs> {
  if (input !== null && input !== undefined && !isRecord(input)) {
    return { ok: false, error: 'invalid_arguments' };
  }
  const obj: Obj = isRecord(input) ? input : {};
  const out: HttpArgs = {};

  for (const [name, spec] of Object.entries(schema.properties)) {
    // Own keys only: `Object.entries` ignores the prototype chain, and the
    // lookup below is guarded the same way.
    const present = Object.prototype.hasOwnProperty.call(obj, name);
    const raw = present ? obj[name] : undefined;
    if (raw === undefined || raw === null) {
      if (schema.required.includes(name)) {
        return { ok: false, error: `missing_${name}` };
      }
      continue;
    }

    if (spec.type === 'string') {
      const s = readString(obj, name, {
        required: true,
        min: spec.minLength ?? 0,
        max: spec.maxLength ?? DEFAULT_MAX_LENGTH,
      });
      if (!s.ok) return { ok: false, error: s.error };
      const v = s.value ?? '';
      // An empty (or blank) string is "not filled": a required field is then
      // missing, an optional one is simply left out of the call.
      if (v === '') {
        if (schema.required.includes(name)) {
          return { ok: false, error: `missing_${name}` };
        }
        continue;
      }
      if (spec.enum && !spec.enum.includes(v)) {
        return { ok: false, error: `invalid_${name}` };
      }
      out[name] = v;
      continue;
    }

    if (spec.type === 'boolean') {
      if (typeof raw !== 'boolean')
        return { ok: false, error: `invalid_${name}` };
      out[name] = raw;
      continue;
    }

    if (!isFiniteNumber(raw)) return { ok: false, error: `invalid_${name}` };
    if (spec.type === 'integer' && !Number.isInteger(raw)) {
      return { ok: false, error: `invalid_${name}` };
    }
    if (spec.minimum !== undefined && raw < spec.minimum) {
      return { ok: false, error: `invalid_${name}` };
    }
    if (spec.maximum !== undefined && raw > spec.maximum) {
      return { ok: false, error: `invalid_${name}` };
    }
    if (spec.enum && !spec.enum.includes(raw)) {
      return { ok: false, error: `invalid_${name}` };
    }
    out[name] = raw;
  }

  if (
    new TextEncoder().encode(JSON.stringify(out)).length > MAX_ARGUMENT_BYTES
  ) {
    return { ok: false, error: 'arguments_too_large' };
  }
  return { ok: true, value: out };
}

/** The schema as the model sees it (`ToolSpec.parameters`). */
export function toModelSchema(schema: HttpInputSchema): JsonSchemaObject {
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema.properties)) {
    properties[name] = { ...spec };
  }
  return {
    type: 'object',
    properties,
    required: [...schema.required],
    additionalProperties: false,
  };
}
