import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apnsDeliveryProfile,
  genericDMPayload,
  genericWatchDMPayload,
} from '../src/apns.js'

const previewURL = `https://push.solife.me/v1/previews/${'A'.repeat(43)}`
const topics = { topic: 'solife.me.Taskify.Native', watchTopic: 'solife.me.Taskify.Native.watchkitapp' }

test('iPhone APNs payload is a generic alert carrying only an opaque preview URL', () => {
  const payload = genericDMPayload(previewURL)
  assert.deepEqual(payload, {
    aps: {
      alert: {
        title: 'New Message',
        body: 'Open Taskify to view it.',
      },
      sound: 'default',
      'content-available': 1,
      'mutable-content': 1,
    },
    taskify: { type: 'dm-preview', previewURL },
  })
  const encoded = JSON.stringify(payload)
  for (const forbidden of ['payment', 'pubkey', 'sender', 'recipient', 'event', 'ciphertext']) {
    assert.equal(encoded.includes(forbidden), false)
  }
})

test('iPhone APNs payload without a preview token is the plain generic alert', () => {
  assert.deepEqual(genericDMPayload(), genericWatchDMPayload())
  assert.deepEqual(genericDMPayload(null), genericWatchDMPayload())
})

test('Watch APNs payload is a metadata-free generic alert', () => {
  const encoded = JSON.stringify(genericWatchDMPayload())
  assert.doesNotMatch(encoded, /previewURL|mutable-content|sender|recipient|pubkey|ciphertext|groupID/i)
  assert.doesNotMatch(encoded, /https?:\/\//i)
})

test('iPhone APNs delivery carries the preview URL for the notification service extension', () => {
  assert.deepEqual(apnsDeliveryProfile({ platform: 'ios' }, { ...topics, previewURL }), {
    payload: genericDMPayload(previewURL),
    topic: 'solife.me.Taskify.Native',
    pushType: 'alert',
    priority: '10',
  })
  assert.deepEqual(
    apnsDeliveryProfile({}, { ...topics, previewURL }).payload,
    genericDMPayload(previewURL),
  )
})

test('Watch APNs delivery uses its own topic and never carries a preview URL', () => {
  assert.deepEqual(apnsDeliveryProfile({ platform: 'watchos' }, { ...topics, previewURL }), {
    payload: genericWatchDMPayload(),
    topic: 'solife.me.Taskify.Native.watchkitapp',
    pushType: 'alert',
    priority: '10',
  })
})
