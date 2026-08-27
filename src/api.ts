import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';

const REQUEST_TIMEOUT_MS = 15_000;

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
    const parsed = JSON.parse(body) as NtfyErrorBody;
    return typeof parsed.code === 'number' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

/** One message or event as ntfy returns it. */
export interface NtfyMessage {
  id: string;
  /**
   * Present only on follow-up events; on the original publish the message's own
   * `id` *is* its sequence id. Verified against 2.27.0.
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
    if (allowed.length > 0 && !allowed.includes(topic)) {
      // Deliberately does not echo the configured list: naming the other topics
      // would hand out exactly the secret the allowlist exists to protect.
      throw new Error(
        `topic "${topic}" is not in NTFY_TOPICS, which restricts this server ` +
          `to ${allowed.length} topic(s)`
      );
    }
    return topic;
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

    const headers: Record<string, string> = { Accept: init.accept };
    const auth = this.authHeader();
    if (auth !== undefined) headers.Authorization = auth;

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

  async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const response = await this.send(method, path, {
      ...(body !== undefined ? { body } : {}),
      accept: 'application/json',
    });
    const text = await NtfyApi.readCapped(response);

    if (!response.ok) {
      throw new NtfyApiError(response.status, text, method, path);
    }

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
    const response = await this.send('GET', path, {
      accept: 'application/x-ndjson',
    });
    const text = await NtfyApi.readCapped(response);
    if (!response.ok) {
      throw new NtfyApiError(response.status, text, 'GET', path);
    }

    const messages: NtfyMessage[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: NtfyMessage;
      try {
        parsed = JSON.parse(trimmed) as NtfyMessage;
      } catch {
        // A truncated final line is the expected shape of a cut-off stream.
        continue;
      }
      // Stream bookkeeping, not content.
      if (parsed.event === 'open' || parsed.event === 'keepalive') continue;
      messages.push(parsed);
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
   * a first attempt against 2.27.0 actually did.
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
