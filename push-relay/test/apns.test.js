import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import http2 from 'node:http2'
import test from 'node:test'

import {
  APNsClient,
  apnsDeliveryProfile,
  genericDMPayload,
  genericSnapstrPayload,
  genericWatchDMPayload,
} from '../src/apns.js'

const previewURL = `https://push.solife.me/v1/previews/${'A'.repeat(43)}`
const topics = {
  topic: 'solife.me.Taskify.Native',
  watchTopic: 'solife.me.Taskify.Native.watchkitapp',
  macTopic: 'solife.me.Taskify.Mac',
  snapstrTopic: 'app.snapstr.ios',
}

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
    collapseID: null,
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
    collapseID: 'taskify-new-message',
  })
})

test('Mac APNs delivery uses its own topic and the metadata-free generic alert', () => {
  assert.deepEqual(apnsDeliveryProfile({ platform: 'macos' }, { ...topics, previewURL }), {
    payload: genericWatchDMPayload(),
    topic: 'solife.me.Taskify.Mac',
    pushType: 'alert',
    priority: '10',
    collapseID: 'taskify-new-message',
  })
})

test('Snapstr APNs delivery uses its own topic and opaque preview namespace', () => {
  const registration = { platform: 'ios', application: 'snapstr' }
  assert.deepEqual(apnsDeliveryProfile(registration, { ...topics, previewURL }), {
    payload: genericSnapstrPayload(previewURL),
    topic: 'app.snapstr.ios',
    pushType: 'alert',
    priority: '10',
    collapseID: null,
  })
  assert.equal(apnsDeliveryProfile(registration, topics).collapseID, 'snapstr-new-snap', 'a Snapstr alert without a preview collapses')
  assert.deepEqual(genericSnapstrPayload(previewURL), {
    aps: {
      alert: { title: 'New Snap', body: 'Open Snapstr to view it.' },
      sound: 'default',
      'content-available': 1,
      'mutable-content': 1,
    },
    snapstr: { type: 'message-preview', previewURL },
  })
  const encoded = JSON.stringify(genericSnapstrPayload(previewURL))
  assert.doesNotMatch(encoded, /sender|recipient|pubkey|event|ciphertext/i)
})

/// A local HTTP/2 (h2c) stand-in for APNs that records every connection and request.
async function fakeAPNs(t, respond = () => ({ status: 200 })) {
  const sessions = []
  const requests = []
  const server = http2.createServer()
  server.on('session', (session) => sessions.push(session))
  server.on('stream', (stream, headers) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      requests.push({ headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      const { status, reason } = respond(headers)
      stream.respond({ ':status': status })
      stream.end(reason ? JSON.stringify({ reason }) : '')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  // server.close() waits for every open session, so the fake ends its own first.
  t.after(() => new Promise((resolve) => {
    for (const session of sessions) session.destroy()
    server.close(resolve)
  }))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { sessions, requests, origin }
}

function clientFor(origin, now = () => 1_800_000_000_000) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return new APNsClient({
    teamID: 'ABCDE12345',
    keyID: 'ABCDE12345',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    topic: 'solife.me.Taskify.Native',
    authorities: { production: origin, sandbox: origin },
    now,
  })
}

const phone = { platform: 'ios', application: 'taskify', environment: 'production', deviceToken: 'ab'.repeat(32) }
const watch = { platform: 'watchos', application: 'taskify', environment: 'production', deviceToken: 'cd'.repeat(32) }

test('alerts reuse one connection to APNs', async (t) => {
  const apns = await fakeAPNs(t)
  const client = clientFor(apns.origin)
  t.after(() => client.close())
  assert.deepEqual(await client.send(phone), { status: 200, reason: null })
  assert.deepEqual(await client.send(watch), { status: 200, reason: null })
  await client.send(phone, 'https://push.solife.me/v1/previews/x')
  assert.equal(apns.requests.length, 3)
  assert.equal(apns.sessions.length, 1, 'one HTTP/2 session for every alert')
})

test('a connection APNs closed is replaced on the next alert', async (t) => {
  const apns = await fakeAPNs(t)
  const client = clientFor(apns.origin)
  t.after(() => client.close())
  await client.send(phone)
  apns.sessions[0].close()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(await client.send(phone), { status: 200, reason: null })
  assert.equal(apns.sessions.length, 2)
})

test('identical alerts collapse, preview alerts do not, and every alert expires after a day', async (t) => {
  const apns = await fakeAPNs(t)
  const client = clientFor(apns.origin, () => 1_800_000_000_000)
  t.after(() => client.close())
  await client.send(watch)
  await client.send(phone)
  await client.send(phone, 'https://push.solife.me/v1/previews/x')
  const [watchAlert, plainAlert, previewAlert] = apns.requests.map((request) => request.headers)
  assert.equal(watchAlert['apns-collapse-id'], 'taskify-new-message')
  assert.equal(plainAlert['apns-collapse-id'], 'taskify-new-message')
  assert.equal(previewAlert['apns-collapse-id'], undefined, "each preview becomes that message's own alert")
  for (const headers of [watchAlert, plainAlert, previewAlert]) {
    assert.equal(headers['apns-expiration'], String(1_800_000_000 + 24 * 60 * 60))
  }
})

test('closing the client closes its connection', async (t) => {
  const apns = await fakeAPNs(t)
  const client = clientFor(apns.origin)
  await client.send(phone)
  const closed = new Promise((resolve) => apns.sessions[0].once('close', resolve))
  client.close()
  await closed
})
