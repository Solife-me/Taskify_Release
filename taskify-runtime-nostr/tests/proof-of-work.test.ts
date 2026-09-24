import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools';
import { mineEventTemplate, countLeadingZeroBits } from '../dist/ProofOfWork.js';

const template = { kind: 1059, created_at: 12345, content: 'encrypted', tags: [['p', 'recipient']] };
test('mining commits target, preserves timestamp and yields to the event loop', async () => {
  const key = generateSecretKey();
  let yielded = false;
  setTimeout(() => { yielded = true; }, 0);
  const mined = await mineEventTemplate(template, key, 8);
  assert.equal(yielded, true);
  assert.equal(mined.created_at, template.created_at);
  assert.deepEqual(template.tags, [['p', 'recipient']]);
  assert.equal(mined.tags.find(t => t[0] === 'nonce')?.[2], '8');
  assert.ok(countLeadingZeroBits(getEventHash({ ...mined, pubkey: getPublicKey(key) })) >= 8);
});
test('mining rejects excessive requirements instead of silently lowering them', async () => {
  await assert.rejects(async () => mineEventTemplate(template, generateSecretKey(), 33), /difficulty/i);
});
test('mining can be cancelled before starting', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => mineEventTemplate(template, generateSecretKey(), 20, { signal: controller.signal }), /abort/i);
});
