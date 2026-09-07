import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import { isRecord } from './boundary.js';
import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How long a refused credential is remembered and answered from memory.
 *
 * Not politeness, and not this server's own rate limit. ntfy keeps a
 * **per-visitor** limiter for failed authentication — `authLimiter` in
 * `server/visitor.go`, sized by `VisitorAuthFailureLimitBurst` (30) and
 * `-Replenish` (one per minute) — and `maybeAuthenticate` in
 * `server/server_auth.go` spends a token on every 401 it answers. When the
 * bucket runs dry, `AuthAllowed()` is false and the instance answers
 * `42909` to **every** request from that address, not only the authenticated
 * ones: a retry loop does not lock the account, it takes the whole host off the
 * instance, healthy traffic included.
 *
 * What makes a retry loop likely is this server's own shape: every read tool is
 * annotated read-only, idempotent and cheap, and the answer to a wrong
 * credential is a sentence that says "Check NTFY_TOKEN" — which is exactly what
 * a model tries again. `check_topic_access` alone can spend ten of the thirty
 * tokens in one call.
 *
 * Only a 401 is remembered. A 403 is ntfy answering that the account exists and
 * may not have this topic, which costs the limiter nothing and is a per-topic
 * answer `check_topic_access` reports rather than a credential to stop using.
 */
const AUTH_COOLDOWN_MS = 10_000;

/** Ceiling on an error body, which is read for its sentence, not its data. */
const MAX_ERROR_BODY_BYTES = 65_536;

/**
 * Refuses a header value the HTTP layer would refuse, before it reaches the
 * HTTP layer.
 *
 * undici's message for a bad header value **quotes the value**, and the value
 * here is `Bearer <the ntfy token>` or `Basic <base64 of the password>`. That
 * message becomes an ordinary rejected promise, which the tool handler's generic
 * catch turns into a tool result — so a token with a line break in the middle of
 * it, which is what a wrapped paste or a `$(cat token)` of a wrapped file looks
 * like, puts the whole credential in the model's context. Verified on undici
 * 8.10 and on Node's global fetch, which share the implementation.
 *
 * `loadConfig` checks the same shape at startup and says so without echoing;
 * this is the half that also holds for a `Config` built by hand, which is what
 * every test in this repository does.
 */
export function assertHeaderValue(name: string, value: string): void {
  // Visible ASCII and the space, which is what an HTTP field value may carry.
  if (!/^[\x20-\x7e]*$/.test(value)) {
    const index = [...value].findIndex(
      (character) => character < '\x20' || character > '\x7e'
    );
    throw new Error(
      `the ${name} header this server would send contains a character that ` +
        `is not allowed in one, at position ${index + 1} of ${value.length}. ` +
        'This is the configured credential — check NTFY_TOKEN or ' +
        'NTFY_PASSWORD for a line break from a wrapped paste. The value is ' +
        'not shown.'
    );
  }
}

/**
 * Hard ceiling on a response body.
 *
 * `await response.text()` is unbounded, and `content-length` is both absent on
 * the chunked NDJSON stream and attacker-influenced everywhere else, so the only
 * honest limit is one counted while reading.
 */
const MAX_RESPONSE_BYTES = 2_000_000;

/** Ceiling on a non-JSON success body, which no endpoint here should return. */
const MAX_TEXT_BODY = 2000;

/** How long a `GET /v1/account` answer is reused. */
const ACCOUNT_CACHE_MS = 60_000;

/** ntfy's own error envelope: `{"code":40301,"http":403,"error":"forbidden"}`. */
export interface NtfyErrorBody {
  code?: number;
  http?: number;
  error?: string;
  link?: string;
}

export class NtfyApiError extends Error {
  /** ntfy's five-digit code, when the body carried one. */
  public readonly code: number | undefined;

  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly method: string,
    public readonly path: string
  ) {
    super(`ntfy API ${method} ${path} failed with HTTP ${status}`);
    this.name = 'NtfyApiError';
    this.code = parseErrorCode(body);
  }
}

function parseErrorCode(body: string): number | undefined {
  try {
    // `isRecord` before the field: an error body of `null` or `42` is legal
    // JSON, and reading `.code` off it throws from a constructor.
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;
    const code = (parsed as NtfyErrorBody).code;
    return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** One message or event as ntfy returns it. */
export interface NtfyMessage {
  id: string;
  /**
   * Present only on follow-up events; on the original publish the message's own
   * `id` *is* its sequence id. Verified against 2.19.2.
   */
  sequence_id?: string;
  time: number;
  expires?: number;
  event: 'open' | 'keepalive' | 'message' | 'message_delete' | 'message_clear';
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  icon?: string;
  actions?: unknown[];
  attachment?: {
    name: string;
    type?: string;
    size?: number;
    expires?: number;
    url: string;
  };
  content_type?: string;
  encoding?: string;
}

/** Minimal client for the ntfy REST API. */
export class NtfyApi {
  private readonly config: Config;
  private readonly baseUrl: string;
  /**
   * Only set when NTFY_INSECURE_TLS is enabled. Scopes the relaxed certificate
   * validation to requests against the configured host instead of disabling it
   * process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher?: Agent;
  private accountCache?: { at: number; value: unknown };
  /**
   * The last refused authentication, kept for {@link AUTH_COOLDOWN_MS}.
   *
   * Deliberately not cleared anywhere: a retry that happens to be the second
   * failed login inside the same second is exactly what the cooldown is for.
   */
  private authRefusal?: { at: number; status: number; body: string };

  constructor(config: Config) {
    this.config = config;
    this.baseUrl = config.url ?? '';
    if (config.insecureTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  /**
   * The topics this server may touch, or an empty list when unrestricted.
   * Handlers consult it through {@link resolveTopic}.
   */
  get allowedTopics(): readonly string[] {
    return this.config.topics;
  }

  /**
   * Resolves a topic argument against `NTFY_TOPICS`.
   *
   * Omitting the argument selects the first configured topic, which keeps a
   * topic name — a bearer secret on a public instance — out of the model's
   * context on the way in. When the allowlist is set it also bounds every tool,
   * read and write: without it, an injected instruction could publish what it
   * just polled to a topic of the attacker's choosing on the same instance.
   *
   * "Every tool" includes the account tools, which do not go through here:
   * `manage_user_access` takes a pattern rather than a name and so uses
   * {@link resolveTopicPattern}, and `list_users` returns grants rather than
   * taking a topic, so it projects them onto {@link allowedTopics} on the way
   * out.
   */
  resolveTopic(topic: string | undefined): string {
    const allowed = this.config.topics;
    if (topic === undefined) {
      const fallback = allowed[0];
      if (fallback === undefined) {
        throw new Error(
          'no topic given and no default configured — pass "topic", or set ' +
            'NTFY_TOPICS to make one the default'
        );
      }
      return fallback;
    }
    // Checked here as well as in `topicParam` at every tool boundary. This is
    // the function that owns the concept, and it is the last thing between a
    // caller-supplied string and a URL path — a new tool that forgets the zod
    // schema should not also lose the guard against "../" and "?".
    if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
      throw new Error(
        `"${topic}" is not a valid ntfy topic — 1 to 64 characters of ` +
          'letters, digits, "-" and "_"'
      );
    }
    if (allowed.length > 0 && !allowed.includes(topic)) {
      // Names the count, not the topics. `get_server_info` does report the
      // whole list, and the difference is the destination rather than the
      // secrecy of the value: a tool result goes to the model, which needs to
      // know which topics it may use and already holds the default one, while
      // an error string ends up in the host's log file.
      throw new Error(
        `topic "${topic}" is not in NTFY_TOPICS, which restricts this server ` +
          `to ${allowed.length} topic(s)`
      );
    }
    return topic;
  }

  /**
   * Resolves the topic *pattern* of an access grant against `NTFY_TOPICS`.
   *
   * A grant is not a request for one topic: `deploy*` hands an account every
   * topic on the instance whose name starts with "deploy", and `*` hands it all
   * of them, including the ones that will only exist tomorrow. So the test
   * cannot be "does the pattern match something allowed" — it has to be "is
   * everything this pattern can ever cover allowed", and no finite `NTFY_TOPICS`
   * is a superset of any wildcard. With the allowlist set, a wildcard is
   * therefore always refused and a plain name goes through {@link resolveTopic}
   * like any other topic.
   *
   * Without an allowlist nothing is bounded and the pattern passes untouched —
   * the same shape as {@link resolveTopic}, where an unset `NTFY_TOPICS` means
   * no restriction rather than no access.
   */
  resolveTopicPattern(pattern: string): string {
    // Re-checked here for the same reason resolveTopic re-checks its argument:
    // this is the last thing between a caller-supplied string and a request
    // body, and a new tool that forgets the zod schema should not also lose the
    // bound below.
    if (!/^[-_A-Za-z0-9*]{1,64}$/.test(pattern)) {
      throw new Error(
        `"${pattern}" is not a valid ntfy topic pattern — 1 to 64 characters ` +
          'of letters, digits, "-", "_" and "*"'
      );
    }
    const allowed = this.config.topics;
    if (allowed.length === 0) return pattern;
    if (pattern.includes('*')) {
      // Names the count rather than the topics, like resolveTopic: this string
      // ends up in the host's log file.
      throw new Error(
        `topic pattern "${pattern}" would grant access beyond NTFY_TOPICS, ` +
          `which restricts this server to ${allowed.length} topic(s) — a ` +
          'wildcard covers topics that are not on that list, including ones ' +
          'that do not exist yet. Name a single topic instead.'
      );
    }
    return this.resolveTopic(pattern);
  }

  private authHeader(): string | undefined {
    const credentials = this.config.credentials;
    if (credentials.kind === 'token') return `Bearer ${credentials.token}`;
    if (credentials.kind === 'basic') {
      const encoded = Buffer.from(
        `${credentials.username}:${credentials.password}`,
        'utf8'
      ).toString('base64');
      return `Basic ${encoded}`;
    }
    return undefined;
  }

  private async send(
    method: string,
    path: string,
    init: { body?: unknown; accept: string }
  ): Promise<Response> {
    // The URL is only required here, not at startup, so the server can still be
    // started and introspected without it.
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) {
      throw new Error(missingConfigMessage(missing));
    }

    // Before the request rather than after it fails: the runtime's own refusal
    // quotes the header value, and this header value is the credential.
    const headers: Record<string, string> = { Accept: init.accept };
    const auth = this.authHeader();
    if (auth !== undefined) {
      assertHeaderValue('Authorization', auth);
      headers.Authorization = auth;
    }

    const request: RequestInit = {
      method,
      headers,
      // Never follow a redirect: it would resend the Authorization header to
      // whatever host the upstream points at.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(init.body);
    }

    const url = `${this.baseUrl}${path}`;
    // The insecure dispatcher requires undici's own fetch; the default path uses
    // the (stubbable) global fetch so tests can intercept it.
    return this.insecureDispatcher
      ? ((await undiciFetch(url, {
          ...request,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)) as unknown as Response)
      : await fetch(url, request);
  }

  /**
   * Reads a body while counting bytes, so a large or endless response cannot
   * exhaust memory. Falls back to `text()` when the runtime gives no stream,
   * which is what a stubbed `fetch` in the tests usually returns.
   */
  private static async readCapped(response: Response): Promise<string> {
    const body = response.body;
    if (!body) return await response.text();

    const reader = body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          throw new Error(
            `ntfy returned more than ${MAX_RESPONSE_BYTES} bytes — narrow the ` +
              'request with "since", a filter, or fewer topics'
          );
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      // Abort the transfer instead of leaving the socket for the collector —
      // the over-limit case is exactly when the far end is still sending.
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  }

  /**
   * Reads an error body under its own, much smaller ceiling — and cuts rather
   * than refusing.
   *
   * The success ceiling must not decide what an error says. A reverse proxy
   * answering a 401 with a two-megabyte login page used to surface as "ntfy
   * returned more than 2000000 bytes", thrown as a plain `Error` from inside the
   * reader: no status, so no {@link NtfyApiError}, so no hint, no admin note,
   * and nothing for `check_topic_access` to report per topic — one oversized
   * page was the whole answer to a call about ten topics.
   */
  private static async readErrorBody(response: Response): Promise<string> {
    try {
      const body = response.body;
      if (!body) return (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let total = 0;
      try {
        while (total < MAX_ERROR_BODY_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      chunks.push(decoder.decode());
      return chunks.join('').slice(0, MAX_ERROR_BODY_BYTES);
    } catch {
      // The status is the answer; a body that could not be read is not a
      // reason to lose it.
      return '(the error body could not be read)';
    }
  }

  /**
   * The remembered refusal, if it is still inside the cooldown.
   *
   * Repeated rather than suppressed: the caller asked a question and gets the
   * same answer it would have got, with a sentence saying it did not travel.
   */
  private cachedAuthRefusal(
    method: string,
    path: string
  ): NtfyApiError | undefined {
    const refusal = this.authRefusal;
    if (!refusal) return undefined;
    const elapsed = Date.now() - refusal.at;
    if (elapsed >= AUTH_COOLDOWN_MS) return undefined;
    const seconds = Math.ceil((AUTH_COOLDOWN_MS - elapsed) / 1000);
    return new NtfyApiError(
      refusal.status,
      `${refusal.body}\n(repeated from memory — this credential was refused ` +
        `less than ${AUTH_COOLDOWN_MS / 1000} seconds ago and was not sent ` +
        `again. ntfy counts failed logins per address and answers 42909 to ` +
        `every request from it once the budget is spent. Next real attempt ` +
        `possible in ${seconds} second(s).)`,
      method,
      path
    );
  }

  /**
   * Turns a non-2xx response into the error the callers understand.
   *
   * Status first, body second — see {@link readErrorBody}.
   */
  private async failure(
    response: Response,
    method: string,
    path: string
  ): Promise<NtfyApiError> {
    const body = await NtfyApi.readErrorBody(response);
    if (response.status === 401) {
      this.authRefusal = { at: Date.now(), status: response.status, body };
    }
    return new NtfyApiError(response.status, body, method, path);
  }

  async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const remembered = this.cachedAuthRefusal(method, path);
    if (remembered) throw remembered;

    const response = await this.send(method, path, {
      ...(body !== undefined ? { body } : {}),
      accept: 'application/json',
    });

    // The status decides before a byte of the body is read. Reading first means
    // the success ceiling can turn a 401 into a size complaint.
    if (!response.ok) {
      throw await this.failure(response, method, path);
    }

    const text = await NtfyApi.readCapped(response);

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    // A 200 whose body is not JSON is not a success this client understands.
    // ntfy answers a path that matches no API route by serving its web app —
    // status 200, content-type text/html — so returning the body verbatim
    // would hand a whole HTML page to the caller as if it were data. Some
    // endpoints legitimately answer with a short plain-text body, so those
    // still pass through, bounded.
    if (contentType.includes('text/html')) {
      throw new NtfyApiError(
        response.status,
        '(HTML page omitted — this path did not reach an ntfy API route)',
        method,
        path
      );
    }
    return text.length > MAX_TEXT_BODY
      ? `${text.slice(0, MAX_TEXT_BODY)}… (truncated)`
      : text;
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  post(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  put(path: string, body?: unknown): Promise<unknown> {
    return this.request('PUT', path, body);
  }

  delete(path: string, body?: unknown): Promise<unknown> {
    return this.request('DELETE', path, body);
  }

  /**
   * Polls one or more topics.
   *
   * `/json` answers with newline-delimited JSON — one object per line, not a
   * JSON array — so it needs its own path rather than {@link request}, which
   * would hand back an unparsed blob.
   *
   * Note the shape of `topics` versus {@link publish}: here they are joined with
   * a comma into a single request, which is the *only* endpoint family where
   * ntfy accepts that. Publishing has no multi-topic form at all. Same argument,
   * opposite mechanics — do not unify them.
   */
  async poll(
    topics: readonly string[],
    query: Record<string, string>
  ): Promise<NtfyMessage[]> {
    const search = new URLSearchParams({ poll: '1', ...query });
    const path = `/${topics.join(',')}/json?${search.toString()}`;

    const remembered = this.cachedAuthRefusal('GET', path);
    if (remembered) throw remembered;

    const response = await this.send('GET', path, {
      accept: 'application/x-ndjson',
    });
    if (!response.ok) {
      throw await this.failure(response, 'GET', path);
    }
    const text = await NtfyApi.readCapped(response);

    const messages: NtfyMessage[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // A truncated final line is the expected shape of a cut-off stream.
        continue;
      }
      // `null`, `42` and `[1,2]` are all valid JSON and all valid lines of an
      // NDJSON stream. Reading `.event` off one of them throws out of the poll,
      // which is the whole listing rather than the line.
      if (!isRecord(parsed)) continue;
      // Stream bookkeeping, not content.
      if (parsed.event === 'open' || parsed.event === 'keepalive') continue;
      messages.push(parsed as unknown as NtfyMessage);
    }
    return messages;
  }

  /**
   * Publishes to a single topic, or updates an existing notification when
   * `sequence_id` is present in `body`.
   *
   * `POST /` with the JSON body is used for both. The other documented update
   * route, `POST /{topic}/{sequence_id}`, follows the raw-body convention: it
   * would publish the JSON document as the literal message text, which is what
   * a first attempt against 2.19.2 actually did.
   */
  publish(body: Record<string, unknown>): Promise<unknown> {
    return this.post('/', body);
  }

  /**
   * `GET /v1/account`, cached briefly.
   *
   * Cached because the role it reports is also what tells a failing admin call
   * whether the credentials were simply not an admin, and that question comes up
   * once per error rather than once per session.
   */
  async account(): Promise<unknown> {
    const cached = this.accountCache;
    if (cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) {
      return cached.value;
    }
    const value = await this.get('/v1/account');
    this.accountCache = { at: Date.now(), value };
    return value;
  }
}
