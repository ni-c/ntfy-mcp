import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { connect, type Recorded } from './harness.js';

/**
 * Every read tool, against whatever the instance might have sent.
 *
 * The unit tests beside this one try the shapes a reviewer thought of. This one
 * tries the shapes nobody did: `fc.jsonValue()` for the whole body, and
 * envelopes of the right form with random leaves — plus the values `JSON.parse`
 * produces that `fc.jsonValue()` never reaches, `1e999` spliced into the
 * serialised text being the important one, because it parses to `Infinity`,
 * is `typeof "number"`, and is refused by `z.number()`.
 *
 * Three sentences are the assertion. `Output validation error` means the result
 * broke the tool's own output schema, which fails the whole call; `Cannot read
 * properties` and `is not a function` mean the projection threw. Any of them
 * from any of these inputs is a boundary that is not there.
 *
 * `SHAPE_RUNS` makes one deep local pass cheap while CI stays quick.
 */
const RUNS = {
  numRuns: Number(process.env.SHAPE_RUNS ?? '120'),
};

/**
 * Scaled with the run count, so `SHAPE_RUNS=800` is a deep pass rather than six
 * timeouts that read exactly like six counterexamples.
 */
const TIMEOUT_MS = Math.max(20_000, RUNS.numRuns * 60);

const FAULTS = [
  'Output validation error',
  'Cannot read properties',
  'is not a function',
  'Invalid time value',
  'ERR_INVALID_ARG_TYPE',
];

/** The odd leaves, per what they are odd *for*. */
const leaf = fc.oneof(
  fc.jsonValue({ maxDepth: 3 }),
  fc.constantFrom(
    null,
    true,
    0,
    -0,
    1.5,
    1e300,
    -(2 ** 53),
    Number.MAX_SAFE_INTEGER,
    8.64e12 + 1,
    '',
    'x'.repeat(700),
    String.fromCharCode(0xd800),
    { nested: { deep: true } },
    []
  )
);

const messageShape = fc.record(
  {
    id: leaf,
    sequence_id: leaf,
    event: leaf,
    topic: leaf,
    time: leaf,
    title: leaf,
    message: leaf,
    priority: leaf,
    tags: leaf,
    click: leaf,
    icon: leaf,
    actions: leaf,
    attachment: leaf,
    content_type: leaf,
  },
  { requiredKeys: [] }
);

const userShape = fc.record(
  { username: leaf, role: leaf, tier: leaf, grants: leaf },
  { requiredKeys: [] }
);

const accountShape = fc.record(
  {
    username: leaf,
    role: leaf,
    tier: leaf,
    limits: leaf,
    stats: leaf,
    language: leaf,
    tokens: leaf,
  },
  { requiredKeys: [] }
);

/**
 * Serialises a body, and sometimes splices in a value no generator produces.
 *
 * `1e999` is legal JSON that `JSON.parse` turns into `Infinity`. It cannot be
 * generated as a JavaScript value and then stringified — `JSON.stringify`
 * writes `Infinity` as `null` — so it has to be put into the text.
 */
function serialise(value: unknown, splice: boolean): string {
  const text = JSON.stringify(value) ?? 'null';
  return splice ? text.replace(/:\s*0(?=[,}\]])/, ': 1e999') : text;
}

function ndjsonBody(entries: unknown[], splice: boolean): string {
  return entries.map((entry) => serialise(entry, splice)).join('\n');
}

interface Probe {
  tool: string;
  args?: Record<string, unknown>;
  body: fc.Arbitrary<unknown>;
  ndjson?: true;
}

const PROBES: Probe[] = [
  {
    tool: 'list_messages',
    body: fc.oneof(
      fc.array(messageShape, { maxLength: 4 }),
      fc.array(fc.jsonValue({ maxDepth: 3 }), { maxLength: 4 })
    ),
    ndjson: true,
  },
  {
    tool: 'get_message',
    args: { id: 'XGe5RN8RdcGO' },
    body: fc.array(messageShape, { maxLength: 3 }),
    ndjson: true,
  },
  { tool: 'get_account', body: fc.oneof(accountShape, fc.jsonValue()) },
  {
    tool: 'list_users',
    body: fc.oneof(
      fc.array(userShape, { maxLength: 4 }),
      fc.jsonValue({ maxDepth: 3 })
    ),
  },
  { tool: 'get_server_info', body: fc.jsonValue({ maxDepth: 3 }) },
  { tool: 'check_topic_access', body: fc.jsonValue({ maxDepth: 3 }) },
];

describe('no shape from the instance turns a tool into an error', () => {
  for (const probe of PROBES) {
    it(
      `${probe.tool} answers whatever ntfy sent`,
      async () => {
        await fc.assert(
          fc.asyncProperty(probe.body, fc.boolean(), async (body, splice) => {
            const harness = await connect(
              { topics: ['alerts'] },
              (_r: Recorded) =>
                probe.ndjson === true
                  ? new Response(ndjsonBody(body as unknown[], splice), {
                      headers: { 'content-type': 'application/x-ndjson' },
                    })
                  : new Response(serialise(body, splice), {
                      headers: { 'content-type': 'application/json' },
                    })
            );
            const result = await harness.call(probe.tool, probe.args ?? {});
            const text = harness.text(result);
            for (const fault of FAULTS) {
              expect(
                text,
                `${probe.tool}: ${text.slice(0, 300)}`
              ).not.toContain(fault);
            }
            // Both channels still describe the same document, whatever arrived.
            if (result.structuredContent !== undefined) {
              expect(typeof result.structuredContent).toBe('object');
            }
          }),
          RUNS
        );
      },
      TIMEOUT_MS
    );
  }
});
