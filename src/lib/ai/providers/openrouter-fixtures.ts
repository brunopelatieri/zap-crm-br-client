// Test helper: loads the REAL OpenRouter payloads captured in SPEC 089 F0
// (docs/spec-089-f0-fixtures/). Fixtures must stay real captures — never
// hand-invented — so the tests cannot just repeat an author's assumption.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface OpenRouterFixture {
  request: {
    model?: string;
    messages?: unknown[];
    provider?: unknown;
    input?: unknown;
  } | null;
  response: { status: number; body: unknown };
}

export function loadFixture(name: string): OpenRouterFixture {
  const path = resolve(process.cwd(), 'docs/spec-089-f0-fixtures', name);
  return JSON.parse(readFileSync(path, 'utf8')) as OpenRouterFixture;
}

/** A `Response` carrying the fixture's captured status and body. */
export function fixtureResponse(name: string): Response {
  const { response } = loadFixture(name);
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
