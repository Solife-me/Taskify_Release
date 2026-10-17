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

test('an account signer answers AUTH without the secret key being handed over', async () => {
  const { finalizeEvent, getPublicKey, verifyEvent } = await import('nostr-tools');
  const secret = new Uint8Array(32).fill(3);
  const pubkey = getPublicKey(secret);
  const signed: unknown[] = [];
  const auth = new RelayAuthManager({} as NDK, {
    loadAccountSigner: () => ({
      pubkey,
      sign: async (template) => {
        signed.push(template);
        return finalizeEvent(template, secret);
      },
    }),
  });
  const event = await auth.buildAuthEvent('wss://auth.example/', 'abc');
  assert.ok(event);
  assert.equal(signed.length, 1);
  assert.equal(event.pubkey, pubkey);
  assert.deepEqual(event.tags, [['relay', 'wss://auth.example/'], ['challenge', 'abc']]);
  assert.ok(verifyEvent(event.rawEvent() as never));
});

test('a signed-out account signer falls back to the configured key or nothing', async () => {
  const auth = new RelayAuthManager({} as NDK, { loadAccountSigner: () => null });
  assert.equal(await auth.buildAuthEvent('wss://auth.example/', 'abc'), null);
  assert.equal(auth.outcome('wss://auth.example/')?.state, 'no-key');
});
