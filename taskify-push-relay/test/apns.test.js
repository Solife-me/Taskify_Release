import assert from 'node:assert/strict'
import test from 'node:test'

import { genericDMPayload } from '../src/apns.js'

test('APNs payload launches the private preview extension without Nostr metadata', () => {
  const payload = genericDMPayload('https://push.solife.me/v1/previews/opaque-token')
  assert.deepEqual(payload, {
    aps: {
      alert: {
        title: 'New Message',
        body: 'Open Taskify to view it.',
      },
      'content-available': 1,
      'mutable-content': 1,
    },
    taskify: {
      type: 'dm-preview',
      previewURL: 'https://push.solife.me/v1/previews/opaque-token',
    },
  })
  const encoded = JSON.stringify(payload)
  for (const forbidden of ['payment', 'pubkey', 'sender', 'recipient', 'event', 'ciphertext']) {
    assert.equal(encoded.includes(forbidden), false)
  }
})
