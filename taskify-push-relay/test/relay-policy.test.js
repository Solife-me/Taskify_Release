import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertAuthorizedGiftWrapFilters,
  giftWrapRecipient,
  shouldNotifyRecipient,
} from '../src/relay-policy.js'

const alice = 'a'.repeat(64)
const bob = 'b'.repeat(64)

test('recipient-only subscriptions require NIP-42 identity and the matching p filter', () => {
  assert.doesNotThrow(() =>
    assertAuthorizedGiftWrapFilters([{ kinds: [1059], '#p': [alice], since: 1, limit: 100 }], alice),
  )
  assert.throws(() => assertAuthorizedGiftWrapFilters([{ kinds: [1059], '#p': [alice] }], null), /auth/i)
  assert.throws(() => assertAuthorizedGiftWrapFilters([{ kinds: [1059], '#p': [bob] }], alice), /recipient/i)
  assert.throws(() => assertAuthorizedGiftWrapFilters([{ kinds: [1059] }], alice), /recipient/i)
})

test('gift wraps must have exactly one valid recipient p tag', () => {
  assert.equal(giftWrapRecipient({ kind: 1059, tags: [['p', bob]] }), bob)
  assert.throws(() => giftWrapRecipient({ kind: 1059, tags: [] }), /one recipient/i)
  assert.throws(
    () => giftWrapRecipient({ kind: 1059, tags: [['p', alice], ['p', bob]] }),
    /one recipient/i,
  )
})

test('sender copies are stored but do not trigger APNs', () => {
  assert.equal(shouldNotifyRecipient({ authenticatedPubkey: alice, recipientPubkey: alice }), false)
  assert.equal(shouldNotifyRecipient({ authenticatedPubkey: alice, recipientPubkey: bob }), true)
})
