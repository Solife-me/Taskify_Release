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
test('pow: rejections yield the target difficulty they name', async () => {
  const { parseProofOfWorkRejection } = await import('../dist/ProofOfWork.js');
  assert.equal(parseProofOfWorkRejection('pow: difficulty 8 is less than 20'), 20);
  assert.equal(parseProofOfWorkRejection('POW: required difficulty 24'), 24);
  assert.equal(parseProofOfWorkRejection('pow: insufficient proof of work'), null);
  assert.equal(parseProofOfWorkRejection('blocked: difficulty 30'), null);
  assert.equal(parseProofOfWorkRejection(undefined), null);
});
test('mining verifies against the NIP-01 hash for non-ASCII content and a custom hasher', async () => {
  const { createHash } = await import('node:crypto');
  const key = generateSecretKey();
  let calls = 0;
  const hashFactory = (prefix: string, suffix: string) => {
    const head = createHash('sha256').update(prefix, 'utf8');
    const tail = Buffer.from(suffix, 'utf8');
    return (nonce: string) => { calls += 1; return head.copy().update(nonce).update(tail).digest(); };
  };
  const unicode = { ...template, content: 'Grüße 👋 "quoted" \\ back\nslash', tags: [['p', 'ünïcode']] };
  const mined = await mineEventTemplate(unicode, key, 10, { hashFactory });
  assert.ok(calls > 0);
  assert.ok(countLeadingZeroBits(getEventHash({ ...mined, pubkey: getPublicKey(key) })) >= 10);
  assert.equal(mined.content, unicode.content);
});
test('mining replaces an existing nonce tag rather than adding a second', async () => {
  const key = generateSecretKey();
  const mined = await mineEventTemplate({ ...template, tags: [['nonce', '5', '4'], ['p', 'x']] }, key, 6);
  assert.equal(mined.tags.filter(t => t[0] === 'nonce').length, 1);
  assert.equal(mined.tags.find(t => t[0] === 'nonce')?.[2], '6');
});
