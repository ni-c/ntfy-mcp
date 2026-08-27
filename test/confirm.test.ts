import { describe, expect, it } from 'vitest';

import { ConfirmationStore, setResourceKey } from '../src/confirm.js';

describe('ConfirmationStore', () => {
  it('rejects a call without a token and accepts the issued one once', () => {
    const store = new ConfirmationStore();
    const resource = setResourceKey('delete_messages', ['a']);

    expect(store.consume(resource, undefined)).toBe(false);
    const token = store.issue(resource);
    expect(store.consume(resource, token)).toBe(true);
    // Single use: a replay must not work.
    expect(store.consume(resource, token)).toBe(false);
  });

  it('does not accept a token issued for a different target', () => {
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_messages', ['a']));
    expect(store.consume(setResourceKey('delete_messages', ['b']), token)).toBe(
      false
    );
  });

  it('does not accept a token issued for a smaller set of targets', () => {
    // The regression this guards: confirming ["a"] must not execute
    // ["a", "secrets"] — the model picks the second list.
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_messages', ['a']));
    expect(
      store.consume(setResourceKey('delete_messages', ['a', 'secrets']), token)
    ).toBe(false);
  });

  it('treats the target set as unordered', () => {
    const store = new ConfirmationStore();
    const token = store.issue(setResourceKey('delete_messages', ['a', 'b']));
    expect(
      store.consume(setResourceKey('delete_messages', ['b', 'a']), token)
    ).toBe(true);
  });

  it('expires tokens', async () => {
    const store = new ConfirmationStore(1);
    const resource = setResourceKey('delete_messages', ['a']);
    const token = store.issue(resource);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.consume(resource, token)).toBe(false);
  });

  it('bounds the pending map so refused calls cannot grow it forever', () => {
    // A loop of unconfirmed calls is the cheap way to make a long-running
    // server accumulate state; the oldest entry is evicted instead.
    const store = new ConfirmationStore();
    const first = setResourceKey('delete_messages', ['first']);
    const firstToken = store.issue(first);
    for (let i = 0; i < 100; i += 1) {
      store.issue(setResourceKey('delete_messages', [`filler-${i}`]));
    }
    expect(store.consume(first, firstToken)).toBe(false);
  });

  it('reports the TTL it actually uses', () => {
    expect(new ConfirmationStore().ttlMinutes).toBe(5);
  });
});
