import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apnsDeliveryProfile,
  genericDMPayload,
  genericWatchDMPayload,
} from '../src/apns.js'

test('APNs payload is a generic alert without Nostr metadata', () => {
  const payload = genericDMPayload()
  assert.deepEqual(payload, {
    aps: {
      alert: {
        title: 'New Message',
        body: 'Open Taskify to view it.',
      },
      sound: 'default',
      'content-available': 1,
    },
    taskify: { type: 'dm-preview' },
  })
  const encoded = JSON.stringify(payload)
  for (const forbidden of ['payment', 'pubkey', 'sender', 'recipient', 'event', 'ciphertext']) {
    assert.equal(encoded.includes(forbidden), false)
  }
})

test('Watch and iPhone APNs payloads are identical metadata-free alerts', () => {
  const payload = genericWatchDMPayload()
  assert.deepEqual(payload, genericDMPayload())
  const encoded = JSON.stringify(payload)
  assert.doesNotMatch(encoded, /previewURL|sender|recipient|pubkey|ciphertext|groupID/i)
  assert.doesNotMatch(encoded, /https?:\/\//i)
})

test('Watch APNs delivery uses its own topic with alert priority', () => {
  const profile = apnsDeliveryProfile(
    { platform: 'watchos' },
    { topic: 'solife.me.Taskify.Native', watchTopic: 'solife.me.Taskify.Native.watchkitapp' },
  )
  assert.deepEqual(profile, {
    payload: genericDMPayload(),
    topic: 'solife.me.Taskify.Native.watchkitapp',
    pushType: 'alert',
    priority: '10',
  })
})
