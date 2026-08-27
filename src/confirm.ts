import { createHash, randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 5 * 60 * 1000;
/** Bounds the map so a loop of refused calls cannot grow it without limit. */
const MAX_PENDING = 100;

/**
 * Issues short-lived confirmation tokens for irreversible operations.
 *
 * A plain boolean `confirm` parameter could be set by the model on the very
 * first call — or be talked into it by instructions hidden in upstream content —
 * whereas a random token that only ever appears in a *previous* tool result
 * cannot be guessed. The token is bound to a resource key, so a confirmation for
 * one target cannot be replayed for another.
 */
export class ConfirmationStore {
  private readonly pending = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = TOKEN_TTL_MS) {}

  /** Creates (or replaces) the pending token for `resource`. */
  issue(resource: string): string {
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const token = randomBytes(16).toString('hex');
    this.pending.set(resource, { token, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /**
   * Returns true and consumes the token when it matches the pending one for
   * `resource` and has not expired. Tokens are single-use.
   */
  consume(resource: string, token: string | undefined): boolean {
    const entry = this.pending.get(resource);
    if (entry === undefined || token === undefined) return false;
    if (Date.now() >= entry.expiresAt) {
      // Drop it rather than leaving it to occupy a MAX_PENDING slot until FIFO
      // pressure evicts it — expired entries crowding out live ones is the only
      // way this map costs anything.
      this.pending.delete(resource);
      return false;
    }
    if (token !== entry.token) return false;
    this.pending.delete(resource);
    return true;
  }

  /** Minutes the issued tokens stay valid, for use in messages. */
  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }
}

function fingerprint(operation: string, parts: string[]): string {
  return `${operation}:${createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 16)}`;
}

/**
 * Resource key for an operation on an unordered *set* of targets. Without the
 * fingerprint a confirmation for ["a.txt"] would also execute
 * ["a.txt", "secrets.env"] — the model chooses the second list, and only the id
 * would have been checked.
 *
 * Sorting is what makes it a set: ["a","b"] and ["b","a"] name the same targets
 * and must share a key. Only use this where that is true. For an *ordered*
 * argument list use {@link tupleResourceKey}.
 */
export function setResourceKey(operation: string, targets: string[]): string {
  return fingerprint(operation, [...targets].sort());
}

/**
 * Resource key for an operation whose arguments are positional.
 *
 * Separate from {@link setResourceKey} because sorting would be a security bug
 * here, not a convenience. `manage_user_access` is confirmed on
 * (username, topic, action), and those three vocabularies overlap almost
 * entirely — a username is a legal topic, and every action name is a legal
 * value for either. Under a sort, confirming "grant alice read_only on topic
 * deploy" produces the same key as "grant deploy read_only on topic alice", so
 * a token approved for one account and topic would execute a grant on a
 * different pair that was never shown to anyone.
 */
export function tupleResourceKey(operation: string, parts: string[]): string {
  return fingerprint(operation, parts);
}

/**
 * Builds the text returned by the first call of a destructive tool.
 *
 * Note what is NOT in here: no title, description or filename coming from the
 * API. Those are attacker-controllable and this string is read by a model.
 */
export function confirmationPrompt(
  what: string,
  token: string,
  ttlMinutes: number
): string {
  return (
    `This will ${what}. The operation is irreversible.\n\n` +
    `To proceed, call this tool again with confirm_token="${token}".\n` +
    `The token is valid for ${ttlMinutes} minutes and can be used once.`
  );
}
