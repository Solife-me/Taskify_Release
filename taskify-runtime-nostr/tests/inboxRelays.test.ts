import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { inboxReadRelays } from '../dist/inboxRelays.js';

const key = new Uint8Array(32).fill(3);
const pubkey = getPublicKey(key);
const event = (timestamp: number, relay: string) => finalizeEvent({ kind: 10050, created_at: timestamp, content: '', tags: [['relay', relay]] }, key);

test('reads the current iOS inbox along with historical PWA relays', () => {
  const older = event(100, 'wss://old.test');
  const newer = event(200, 'wss://ios.test');
  assert.deepEqual(inboxReadRelays([older, newer], pubkey, ['wss://pwa.test']), ['wss://ios.test', 'wss://pwa.test']);
});

test('ignores forged and foreign preferences and resolves equal-time events consistently', () => {
  const a = event(100, 'wss://a.test');
  const b = event(100, 'wss://b.test');
  const winner = [a, b].sort((a, b) => a.id.localeCompare(b.id))[0];
  const forged = JSON.parse(JSON.stringify(event(500, 'wss://forged.test')));
  forged.content = 'tampered';
  const foreign = finalizeEvent({ kind: 10050, created_at: 900, content: '', tags: [['relay', 'wss://foreign.test']] }, new Uint8Array(32).fill(4));
  assert.deepEqual(inboxReadRelays([b, forged, a, foreign], pubkey, []), [winner.tags[0][1]]);
});
