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
    'NTFY_READ_ONLY=true to expose only read tools, ' +
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
 * Reads the configuration from environment variables.
 *
 * A missing URL is only a warning, not a fatal error: the server must be able to
 * complete the MCP handshake and answer `tools/list` without it, so registries
 * and sandbox inspectors can introspect it. A malformed URL still exits — that
 * one could send the credentials to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.NTFY_URL;
  const token = env.NTFY_TOKEN;
  const username = env.NTFY_USERNAME;
  const password = env.NTFY_PASSWORD;
  const rawTopics = env.NTFY_TOPICS;
  const insecureTls = env.NTFY_INSECURE_TLS === 'true';
  // Defaults to false, unlike imap-mcp. ntfy exists to publish; a read-only
  // default would ship a notification server that cannot notify. Note the
  // consequence: only the literal string "true" disables writes, so a typo
  // leaves them *on* here, where in imap-mcp it left them off.
  const readOnly = env.NTFY_READ_ONLY === 'true';
  const allowTools = env.NTFY_ALLOW_TOOLS;
  const denyTools = env.NTFY_DENY_TOOLS;

  // Before any branch below, so no early return can leave a secret behind: the
  // environment is visible to child processes and in /proc/<pid>/environ.
  delete env.NTFY_TOKEN;
  delete env.NTFY_PASSWORD;

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
    console.error(
      `ntfy-mcp: NTFY_URL must use http:// or https:// (got ${parsed.protocol})`
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

  return {
    url: url.replace(/\/+$/, ''),
    credentials,
    topics,
    insecureTls,
    readOnly,
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
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('127.') ||
    hostname === '::1'
  );
}
