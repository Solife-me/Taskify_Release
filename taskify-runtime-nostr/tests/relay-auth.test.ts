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
