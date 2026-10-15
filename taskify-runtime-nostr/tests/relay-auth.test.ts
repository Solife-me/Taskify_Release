import test from 'node:test';
import assert from 'node:assert/strict';
import NDK from '@nostr-dev-kit/ndk';
import { RelayAuthManager } from '../dist/RelayAuth.js';
const relay = { url: 'wss://auth.example/', connectionStats: { connectedAt: 1 } };
test('only one AUTH is signed for simultaneous duplicate challenges', async () => {
  const auth = new RelayAuthManager({} as NDK, { loadSecretKeyHex: () => '1'.repeat(64) });
  const replies = await Promise.all([auth.respond(relay, 'challenge'), auth.respond(relay, 'challenge')]);
  assert.equal(replies.filter(Boolean).length, 1);
  const event = replies.find(Boolean);
  assert.equal(event.kind, 22242);
  assert.deepEqual(event.tags, [['relay', relay.url], ['challenge', 'challenge']]);
  auth.reset(relay.url);
  assert.ok(await auth.respond(relay, 'challenge'));
});

test('the auth policy keeps a refused AUTH from escaping and restores the relay', async () => {
  const { createRelayAuthPolicy } = await import('../dist/RelayAuth.js');
  const auth = new RelayAuthManager({} as NDK, { loadSecretKeyHex: () => '2'.repeat(64) });
  const calls: string[] = [];
  const connectivity = {
    _status: 7,
    auth: async () => { throw new Error('restricted: not allowed'); },
    rejectPendingAuthPublishes: (error: Error) => calls.push(`reject:${error.message}`),
    retryPendingAuthPublishes: () => calls.push('retry'),
  };
  const fakeRelay = { url: 'wss://strict.example/', connectionStats: { connectedAt: 2 }, connectivity, emit: (name: string) => calls.push(`emit:${name}`) };
  const policy = createRelayAuthPolicy(auth, { timeoutMs: 1_000 });
  assert.equal(await policy(fakeRelay as never, 'c1'), false);
  assert.equal(connectivity._status, 5);
  assert.deepEqual(calls, ['reject:restricted: not allowed', 'emit:auth:failed']);
  assert.equal(auth.outcome('wss://strict.example')?.state, 'failed');

  // A later challenge is answered again and success resends held writes.
  calls.length = 0;
  connectivity.auth = async () => undefined;
  connectivity._status = 7;
  assert.equal(await policy(fakeRelay as never, 'c2'), false);
  assert.equal(connectivity._status, 8);
  assert.deepEqual(calls, ['retry', 'emit:authed']);
  assert.equal(auth.outcome('wss://strict.example/')?.state, 'authenticated');

  // A repeated challenge on the same connection isn't signed again, and the status is kept.
  connectivity._status = 7;
  assert.equal(await policy(fakeRelay as never, 'c2'), false);
  assert.equal(connectivity._status, 8);
});

test('without a key the policy declines and records why', async () => {
  const { createRelayAuthPolicy } = await import('../dist/RelayAuth.js');
  const auth = new RelayAuthManager({} as NDK, { loadSecretKeyHex: () => null });
  const connectivity = { _status: 7, auth: async () => undefined };
  const policy = createRelayAuthPolicy(auth);
  assert.equal(await policy({ url: 'wss://k.example/', connectionStats: {}, connectivity, emit() {} } as never, 'c'), false);
  assert.equal(connectivity._status, 5);
  assert.equal(auth.outcome('wss://k.example/')?.state, 'no-key');
});
