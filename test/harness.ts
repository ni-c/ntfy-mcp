import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

/**
 * A configuration mirroring the real defaults — note `readOnly: false`, which is
 * this server's default because ntfy exists to publish.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: 'https://ntfy.example.net',
    credentials: { kind: 'token', token: 'tk_testtokentesttokentesttoken' },
    topics: [],
    insecureTls: false,
    readOnly: false,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Stubs the global fetch and records every request.
 *
 * `respond` returns either a Response or a plain object, which is serialized as
 * JSON. Returning undefined yields `{}`.
 */
export function stubFetch(
  respond: (request: Recorded) => unknown = () => ({})
): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const record: Recorded = {
        url: String(url),
        method: init?.method ?? 'GET',
        headers: headers ?? {},
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(record);
      const result = respond(record);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result ?? {}), {
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  return calls;
}

/** An NDJSON response, as `/{topic}/json?poll=1` produces. */
export function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n'), {
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

export interface Harness {
  client: Client;
  calls: Recorded[];
  call: (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<CallToolResult>;
  text: (result: CallToolResult) => string;
}

/** Connects an SDK client to an in-process server. */
export async function connect(
  overrides: Partial<Config> = {},
  respond?: (request: Recorded) => unknown
): Promise<Harness> {
  const calls = stubFetch(respond);
  const server = createServer(testConfig(overrides));
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    calls,
    call: (name, args = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    text: (result) =>
      (result.content as { type: string; text?: string }[])
        .map((part) => part.text ?? '')
        .join('\n'),
  };
}

/** The tools a server built with this configuration actually offers. */
export async function toolNames(
  overrides: Partial<Config> = {}
): Promise<string[]> {
  const { client } = await connect(overrides);
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}
