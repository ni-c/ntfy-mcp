import { internalHostKind } from 'mcp-internal-hosts';

/** How the server authenticates against ntfy. */
export type Credentials =
  | { kind: 'token'; token: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'anonymous' };

export interface Config {
  /**
   * Base URL of the ntfy instance, e.g. `https://ntfy.example.net`. May be
   * undefined: the server still starts and lists its tools, every API call then
   * fails with {@link missingConfigMessage}.
   *
   * Deliberately has no default. `https://ntfy.sh` would be the obvious one and
   * the worst possible one — a misconfigured server would publish to the public
   * internet rather than failing.
   */
  url: string | undefined;
  /**
   * Anonymous is a supported state, not an error: an open ntfy instance allows
   * publishing and subscribing without credentials, so refusing to work without
   * them would be wrong for a large share of deployments.
   */
  credentials: Credentials;
  /**
   * Topics the server may touch, first entry being the default when a tool
   * omits one. Empty means no default and no restriction.
   *
   * One variable rather than a separate `NTFY_DEFAULT_TOPIC` and allowlist: a
   * topic name is a bearer secret on a public instance, and someone who sets a
   * default without a restriction has bought no safety while believing they
   * have. Coupling the two makes both properties arrive together.
   */
  topics: readonly string[];
  insecureTls: boolean;
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;

  /**
   * Raw value of `NTFY_ALLOW_TOOLS` — comma-separated tool names, `list_*`
   * prefixes, or `essential`. Kept unparsed on purpose: this file is a mirror of
   * the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `NTFY_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every API call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: NTFY_URL (e.g. https://ntfy.example.net)\n' +
    'Credentials (optional, an open instance needs none): NTFY_TOKEN, or ' +
    'NTFY_USERNAME together with NTFY_PASSWORD\n' +
    'Optional: NTFY_TOPICS to set a default topic and restrict the server to it, ' +
    'NTFY_READ_ONLY=true (also 1 or yes) to expose only read tools, ' +
    'NTFY_INSECURE_TLS=true to accept self-signed certificates, ' +
    'NTFY_ALLOW_TOOLS / NTFY_DENY_TOOLS to narrow the tool list ' +
    '(comma-separated names, "list_*" prefixes, or "essential")'
  );
}

/**
 * Names of the required environment variables that are unset in `config`.
 *
 * Only the URL. Credentials are genuinely optional here — see
 * {@link Config.credentials}.
 */
export function missingConfigKeys(config: Config): string[] {
  return config.url ? [] : ['NTFY_URL'];
}

const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/;

/**
 * Ceiling on how many topics `NTFY_TOPICS` may name.
 *
 * The list is walked once per grant in `list_users`, so it is one half of a
 * product the operator would not expect to be quadratic; and a list of thousands
 * is a paste accident rather than a configuration.
 */
const MAX_TOPICS_CONFIGURED = 256;

/**
 * What a credential may look like: visible ASCII, no leading or trailing space,
 * a plausible length.
 *
 * The check exists because of what happens without it. A credential goes into an
 * `Authorization` header, and the HTTP layer's refusal of a bad header value
 * **quotes the value** — so a token with a line break in the middle, which is
 * what a wrapped paste or a `$(cat token)` of a wrapped file produces, reaches
 * the model's context in full through a tool result. `assertHeaderValue` in
 * `api.ts` is the other half of that guarantee, for a `Config` built without
 * this function.
 *
 * A trailing newline is trimmed rather than refused: `$(cat token)` leaves one,
 * and that is a formatting accident with an obvious correct reading.
 */
const CREDENTIAL_PATTERN =
  /^[\x21-\x7e][\x20-\x7e]{0,510}[\x21-\x7e]$|^[\x21-\x7e]$/;

/**
 * Complains about a credential's shape without ever printing it.
 *
 * Names the variable, the length and the *position* of the first character that
 * cannot travel in a header — enough to find a line break in a pasted secret,
 * and nothing that could be the secret.
 */
function credentialProblem(name: string, value: string): string | undefined {
  if (value.length === 0) return `${name} is set but empty.`;
  if (CREDENTIAL_PATTERN.test(value)) return undefined;
  const characters = [...value];
  const index = characters.findIndex(
    (character) => character < '\x21' || character > '\x7e'
  );
  if (index === -1) {
    return (
      `${name} is ${value.length} characters long; this server accepts up to ` +
      '512. The value is not shown.'
    );
  }
  return (
    `${name} contains a character that cannot travel in an HTTP header (or a ` +
    `leading or trailing space), at position ${index + 1} of ` +
    `${characters.length}. A line break there is usually a paste that wrapped. ` +
    'The value is not shown.'
  );
}

/**
 * Quotes a configuration value only when its shape makes that safe.
 *
 * The variable next to a secret is where a secret lands, and a value that fails
 * the parser is the one most likely to *be* the secret — so the branch that
 * explains a typo may only quote something short and word-shaped, and describes
 * everything else by its length.
 */
function quotable(raw: string): string {
  return /^[A-Za-z0-9_.:/-]{1,24}$/.test(raw)
    ? `"${raw}"`
    : `a ${raw.length}-character value (not shown)`;
}

/**
 * Removes trailing slashes by walking an index.
 *
 * `url.replace(/\/+$/, '')` is quadratic on a run that is not at the end: the
 * pattern is retried from every position of the run and consumes it each time.
 * Measured on the string an operator can set: 122 ms, 577 ms and 2233 ms for
 * 20 000, 40 000 and 80 000 slashes followed by one more character.
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the first variable of the family that defaults to *on*. The
 * others fail open on a typo, which is the safe direction for them — including
 * `NTFY_READ_ONLY`, which is deliberately generous about what it accepts. Here a
 * typo would leave the dialog running while the operator believes it is off —
 * and an operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  // Describes rather than echoes past a short, word-shaped value. ELICITATION
  // is unprefixed and sits in the same block as every other variable of every
  // server in the environment, which includes the ones holding secrets.
  console.error(
    `ntfy-mcp: ELICITATION must be "true" or "false" — got ${quotable(raw ?? '')}. ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
}

/**
 * Reads the configuration from environment variables.
 *
 * A missing URL is only a warning, not a fatal error: the server must be able to
 * complete the MCP handshake and answer `tools/list` without it, so registries
 * and sandbox inspectors can introspect it. A malformed URL still exits — that
 * one could send the credentials to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.NTFY_URL;
  // Trimmed before anything looks at them: `$(cat token)` leaves a trailing
  // newline, and reading that as "a token with a bad character in it" would be
  // pedantic about the one case with an obvious correct reading.
  const token = env.NTFY_TOKEN?.trim();
  const username = env.NTFY_USERNAME?.trim();
  const password = env.NTFY_PASSWORD?.trim();
  const rawTopics = env.NTFY_TOPICS;
  // Strict on purpose, and the opposite of NTFY_READ_ONLY below. This one
  // *removes* a protection, so the direction that fails safe is refusing
  // anything but the exact word: an operator who writes NTFY_INSECURE_TLS=1 and
  // gets certificate validation keeps a working guard, which is the harmless
  // half of being wrong.
  const insecureTls = env.NTFY_INSECURE_TLS === 'true';
  // Generous on purpose. This one *adds* a protection, so a value the parser
  // does not recognise has to mean "on": `NTFY_READ_ONLY=1`, `=yes` or `=TRUE`
  // is unmistakably somebody asking for read-only, and an equality check
  // against "true" would leave the write tools registered while the operator
  // believed they were gone — silently, because nothing prints for a variable
  // that parsed to false.
  //
  // Trimmed for the same reason it is generous: a compose file that yields
  // `NTFY_READ_ONLY=true ` with a trailing space is a formatting accident, and
  // reading it as "off" is the failure this whole branch exists to prevent.
  //
  // Note what this does not fix: the default is still false, so a real typo
  // (`=ture`) fails open, unlike imap-mcp where the same variable defaults to
  // true. ntfy exists to publish; a read-only default would ship a notification
  // server that cannot notify.
  const readOnly = /^(1|true|yes)$/i.test(env.NTFY_READ_ONLY?.trim() ?? '');
  const allowTools = env.NTFY_ALLOW_TOOLS;
  const denyTools = env.NTFY_DENY_TOOLS;

  // Before any branch below, so no early return can leave a secret behind: the
  // environment is visible to child processes and in /proc/<pid>/environ.
  delete env.NTFY_TOKEN;
  delete env.NTFY_PASSWORD;

  // After the delete, deliberately: this one can exit the process, and an exit
  // above would leave the credential in the environment for whatever runs next.
  const elicitation = parseElicitation(env.ELICITATION);

  if (token && (username || password)) {
    // Not a precedence rule. Which credential is in force must never be
    // ambiguous, so this is fatal rather than "the token wins".
    console.error(
      'ntfy-mcp: NTFY_TOKEN and NTFY_USERNAME/NTFY_PASSWORD are both set — ' +
        'pick one. Set NTFY_TOKEN for an access token, or NTFY_USERNAME and ' +
        'NTFY_PASSWORD for basic auth.'
    );
    process.exit(1);
  }
  if (Boolean(username) !== Boolean(password)) {
    console.error(
      'ntfy-mcp: NTFY_USERNAME and NTFY_PASSWORD must be set together.'
    );
    process.exit(1);
  }

  // Before a request can quote it. The credential travels in an Authorization
  // header, and the HTTP layer's refusal of a bad header value quotes the value
  // in an ordinary error — which a tool handler turns into a tool result.
  for (const [name, value] of [
    ['NTFY_TOKEN', token],
    ['NTFY_USERNAME', username],
    ['NTFY_PASSWORD', password],
  ] as const) {
    if (value === undefined) continue;
    const problem = credentialProblem(name, value);
    if (problem !== undefined) {
      console.error(`ntfy-mcp: ${problem}`);
      process.exit(1);
    }
  }

  let credentials: Credentials = { kind: 'anonymous' };
  if (token) {
    credentials = { kind: 'token', token };
  } else if (username && password) {
    credentials = { kind: 'basic', username, password };
  }

  const topics = parseTopics(rawTopics);

  if (!url) {
    console.error(`ntfy-mcp: ${missingConfigMessage(['NTFY_URL'])}`);
    return {
      url: undefined,
      credentials,
      topics,
      insecureTls,
      readOnly,
      elicitation,
      allowTools,
      denyTools,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Deliberately not echoing the value: a mis-pasted token is exactly the
    // kind of thing that lands in NTFY_URL, and this line is a log line.
    console.error('ntfy-mcp: NTFY_URL is not a valid URL');
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // The scheme is not safe to print either. A 56-character hexadecimal key
    // with a colon after it is a valid URL whose scheme is the key, so this
    // branch — the one written for an operator's typo — is reached by exactly
    // the value that must not be echoed.
    console.error(
      `ntfy-mcp: NTFY_URL must use http:// or https:// (got a ` +
        `${parsed.protocol.length - 1}-character scheme, not shown)`
    );
    process.exit(1);
  }
  // Credentials embedded in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error(
      'ntfy-mcp: NTFY_URL must not contain credentials — use NTFY_TOKEN or ' +
        'NTFY_USERNAME/NTFY_PASSWORD'
    );
    process.exit(1);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    console.error(
      'ntfy-mcp: WARNING: NTFY_URL uses plain http to a non-local host — the ' +
        'credentials will be sent unencrypted (basic auth is base64, not ' +
        'encryption). Use https:// instead.'
    );
  }
  // The one shape where writes have a genuinely unbounded blast radius:
  // anonymous publishing to the public instance, where knowing a topic name is
  // the whole of the access control.
  if (
    !readOnly &&
    credentials.kind === 'anonymous' &&
    /(^|\.)ntfy\.sh$/i.test(parsed.hostname)
  ) {
    console.error(
      'ntfy-mcp: WARNING: write tools are enabled against the public ntfy.sh ' +
        'without credentials. Anyone who learns a topic name can read along. ' +
        'Set NTFY_TOPICS to restrict the server, or NTFY_READ_ONLY=true.'
    );
  }

  // The parsed form, not the environment string. Everything a URL can carry
  // that a base cannot use — a query, a fragment, embedded credentials — would
  // otherwise be glued in front of every path this server builds. What was
  // dropped is named, because silently ignoring half of what somebody typed is
  // how a request ends up somewhere they did not mean.
  const base = withoutTrailingSlashes(parsed.origin + parsed.pathname);
  const droppedParts = [
    parsed.search ? 'a query string' : '',
    parsed.hash ? 'a fragment' : '',
  ].filter((part) => part.length > 0);
  if (droppedParts.length > 0) {
    console.error(
      `ntfy-mcp: NTFY_URL carried ${droppedParts.join(' and ')}, which a base ` +
        'URL cannot use. It was dropped.'
    );
  }

  return {
    url: base,
    credentials,
    topics,
    insecureTls,
    readOnly,
    elicitation,
    allowTools,
    denyTools,
  };
}

function parseTopics(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length > MAX_TOPICS_CONFIGURED) {
    console.error(
      `ntfy-mcp: NTFY_TOPICS names ${entries.length} topics; this server ` +
        `accepts up to ${MAX_TOPICS_CONFIGURED}. The list is walked once per ` +
        'access grant when list_users projects them, so a list this long is a ' +
        'cost on every call rather than a restriction.'
    );
    process.exit(1);
  }
  for (const [index, entry] of entries.entries()) {
    if (!TOPIC_PATTERN.test(entry)) {
      // Position, not value. NTFY_TOPICS is the variable a misplaced line in a
      // compose file lands in, and for a stdio server stderr is the host's log
      // file. Note which values reach here: a real ntfy token (tk_ plus 29
      // alphanumerics) *passes* this pattern and is accepted as a topic, so the
      // only strings that fail it are the ones with punctuation — passwords.
      console.error(
        `ntfy-mcp: entry ${index + 1} of NTFY_TOPICS is not a valid ntfy ` +
          'topic — 1 to 64 characters of letters, digits, "-" and "_".'
      );
      process.exit(1);
    }
  }
  return entries;
}

function isLoopbackHost(hostname: string): boolean {
  // The same classifier the SSRF guard uses, so a loopback URL written as
  // http://[::1]:3000 or http://[::ffff:127.0.0.1]:3000 is recognised here too
  // and the plain-http warning does not fire on it.
  return internalHostKind(hostname) === 'loopback';
}
