import { describe, expect, it } from 'vitest';

import {
  ConfirmationStore,
  setResourceKey,
  tupleResourceKey,
} from '../src/confirm.js';

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

  it('does not let a positional key be reordered', () => {
    // setResourceKey sorts, which is right for a set of message ids and wrong
    // for an argument list. manage_user_access is confirmed on
    // (username, topic, action) and those vocabularies overlap almost
    // entirely, so under a sort "grant alice read_only on deploy" and "grant
    // deploy read_only on alice" would share a key.
    const store = new ConfirmationStore();
    const approved = tupleResourceKey('manage_user_access', [
      'alice',
      'deploy',
      'read_only',
    ]);
    const swapped = tupleResourceKey('manage_user_access', [
      'deploy',
      'alice',
      'read_only',
    ]);
    expect(approved).not.toBe(swapped);
    const token = store.issue(approved);
    expect(store.consume(swapped, token)).toBe(false);

    // And the same swap under the set key would have succeeded, which is the
    // bug this replaces.
    expect(setResourceKey('x', ['alice', 'deploy', 'read_only'])).toBe(
      setResourceKey('x', ['deploy', 'alice', 'read_only'])
    );
  });

  it('still treats a genuine set as unordered', () => {
    expect(setResourceKey('delete_messages', ['a', 'b'])).toBe(
      setResourceKey('delete_messages', ['b', 'a'])
    );
  });

  it('forgets an expired entry instead of holding its slot', async () => {
    const store = new ConfirmationStore(1);
    const resource = setResourceKey('delete_messages', ['a']);
    const token = store.issue(resource);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.consume(resource, token)).toBe(false);
    // A fresh token for the same target must still work afterwards.
    const second = store.issue(resource);
    expect(store.consume(resource, second)).toBe(true);
  });
});
