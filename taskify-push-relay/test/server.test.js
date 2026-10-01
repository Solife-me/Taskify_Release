import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import WebSocket from 'ws'

import { createTaskifyPushServer } from '../src/server.js'
import { RelayStore } from '../src/store.js'

function nextFrame(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString())
      if (!predicate(frame)) return
      cleanup()
      resolve(frame)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

async function connectAndAuthenticate(port, secretKey) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  const challengeFrame = await nextFrame(socket, (frame) => frame[0] === 'AUTH')
  const authEvent = finalizeEvent(
    {
      kind: 22_242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['relay', 'wss://push.solife.me'],
        ['challenge', challengeFrame[1]],
      ],
      content: '',
    },
    secretKey,
  )
  socket.send(JSON.stringify(['AUTH', authEvent]))
  const acknowledgement = await nextFrame(socket, (frame) => frame[0] === 'OK' && frame[1] === authEvent.id)
  assert.equal(acknowledgement[2], true)
  return socket
}

test('authenticated NIP-17 delivery stores, wakes APNs, and is readable only by the recipient', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-push-server-'))
  const store = new RelayStore({ dataDirectory: directory })
  await store.load()
  const sentRegistrations = []
  const sentPreviews = []
  const server = createTaskifyPushServer({
    config: {
      port: 0,
      publicBaseURL: 'https://push.solife.me',
      publicRelayURL: 'wss://push.solife.me',
    },
    store,
    apnsClient: {
      async send(registration, previewURL) {
        sentRegistrations.push(registration)
        sentPreviews.push(previewURL)
        return { status: 200, reason: null }
      },
    },
    logger: { info() {} },
  })
  const address = await server.start(0)
  t.after(() => server.stop())

  const relayInfoResponse = await fetch(`http://127.0.0.1:${address.port}/`, {
    headers: { accept: 'application/nostr+json' },
  })
  assert.equal(relayInfoResponse.status, 200)
  assert.match(relayInfoResponse.headers.get('content-type'), /^application\/nostr\+json/)
  const relayInfo = await relayInfoResponse.json()
  assert.deepEqual(relayInfo.supported_nips, [1, 11, 17, 42, 59, 98])

  const senderKey = generateSecretKey()
  const recipientKey = generateSecretKey()
  const senderPubkey = getPublicKey(senderKey)
  const recipientPubkey = getPublicKey(recipientKey)
  await store.putRegistration(recipientPubkey, 'phone-1', {
    deviceToken: '12'.repeat(32),
    environment: 'production',
  })

  const senderSocket = await connectAndAuthenticate(address.port, senderKey)
  t.after(() => senderSocket.close())
  const giftWrap = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content: 'opaque-encrypted-gift-wrap',
    },
    generateSecretKey(),
  )
  senderSocket.send(JSON.stringify(['EVENT', giftWrap]))
  const saved = await nextFrame(senderSocket, (frame) => frame[0] === 'OK' && frame[1] === giftWrap.id)
  assert.deepEqual(saved.slice(2), [true, 'saved'])

  await server.processPushJobs()
  assert.equal(sentRegistrations.length, 1)
  assert.match(sentPreviews[0], /^https:\/\/push\.solife\.me\/v1\/previews\/[A-Za-z0-9_-]{43}$/)
  assert.equal(store.duePushJobs(Number.MAX_SAFE_INTEGER).length, 0)

  const previewResponse = await fetch(
    sentPreviews[0].replace('https://push.solife.me', `http://127.0.0.1:${address.port}`),
  )
  assert.equal(previewResponse.status, 200)
  assert.equal(previewResponse.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await previewResponse.json(), JSON.parse(JSON.stringify({ event: giftWrap })))

  const missingPreview = await fetch(
    `http://127.0.0.1:${address.port}/v1/previews/${'x'.repeat(43)}`,
  )
  assert.equal(missingPreview.status, 404)

  const recipientSocket = await connectAndAuthenticate(address.port, recipientKey)
  t.after(() => recipientSocket.close())
  recipientSocket.send(JSON.stringify(['REQ', 'recipient-inbox', { kinds: [1059], '#p': [recipientPubkey], limit: 10 }]))
  const delivered = await nextFrame(recipientSocket, (frame) => frame[0] === 'EVENT')
  assert.equal(delivered[1], 'recipient-inbox')
  assert.equal(delivered[2].id, giftWrap.id)

  senderSocket.send(JSON.stringify(['REQ', 'forbidden-inbox', { kinds: [1059], '#p': [recipientPubkey] }]))
  const closed = await nextFrame(senderSocket, (frame) => frame[0] === 'CLOSED' && frame[1] === 'forbidden-inbox')
  assert.match(closed[2], /recipient/i)
  assert.notEqual(senderPubkey, recipientPubkey)
})

test('APNs provider-token rejection invalidates the cache and preserves the job for retry', async () => {
  let now = 1_700_000_000
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-push-server-'))
  const store = new RelayStore({ dataDirectory: directory, now: () => now })
  await store.load()
  const recipientKey = generateSecretKey()
  const recipientPubkey = getPublicKey(recipientKey)
  await store.putRegistration(recipientPubkey, 'watch-1', {
    deviceToken: '12'.repeat(32),
    environment: 'production',
    platform: 'watchos',
  })
  const giftWrap = finalizeEvent({
    kind: 1059,
    created_at: now,
    tags: [['p', recipientPubkey]],
    content: 'opaque-encrypted-gift-wrap',
  }, generateSecretKey())
  await store.putGiftWrap(giftWrap, { notify: true })

  let sends = 0
  let invalidations = 0
  const warnings = []
  const server = createTaskifyPushServer({
    config: {
      port: 0,
      publicBaseURL: 'https://push.solife.me',
      publicRelayURL: 'wss://push.solife.me',
    },
    store,
    apnsClient: {
      async send() {
        sends += 1
        return sends === 1
          ? { status: 403, reason: 'ExpiredProviderToken' }
          : { status: 200, reason: null }
      },
      invalidateProviderToken() { invalidations += 1 },
    },
    logger: {
      info() {},
      warn(message, details) { warnings.push({ message, details }) },
    },
  })

  await server.processPushJobs()
  assert.equal(invalidations, 1)
  assert.equal(store.duePushJobs(Number.MAX_SAFE_INTEGER).length, 1)
  assert.equal(warnings[0].details.reason, 'ExpiredProviderToken')
  assert.equal('deviceToken' in warnings[0].details, false)

  now += 5
  await server.processPushJobs()
  assert.equal(sends, 2)
  assert.equal(store.duePushJobs(Number.MAX_SAFE_INTEGER).length, 0)
})

test('history honors per-filter limits, newest-first ordering, and ignores limits for live events', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-sync-audit-'))
  const store = new RelayStore({ dataDirectory: directory })
  await store.load()
  const server = createTaskifyPushServer({
    config: { port: 0, publicBaseURL: 'https://push.solife.me', publicRelayURL: 'wss://push.solife.me' },
    store, apnsClient: { async send() { return { status: 200 } } }, logger: { info() {} },
  })
  const address = await server.start(0)
  t.after(() => server.stop())
  const key = generateSecretKey()
  const recipient = getPublicKey(key)
  await store.putPreference(finalizeEvent({ kind: 10_050, created_at: 1, tags: [['relay', 'wss://push.solife.me']], content: '' }, key))
  const now = Math.floor(Date.now() / 1000)
  const events = [now - 3, now - 2, now - 1, now - 1].map((created_at, index) => finalizeEvent({
    kind: 1059, created_at, tags: [['p', recipient]], content: `opaque-${index}`,
  }, generateSecretKey()))
  for (const event of events) await store.putGiftWrap(event, { notify: false })
  const socket = await connectAndAuthenticate(address.port, key)
  t.after(() => socket.close())
  const received = []
  socket.on('message', (data) => { const frame = JSON.parse(data); if (frame[0] === 'EVENT' && frame[1] === 'audit') received.push(frame[2]) })
  const eose = nextFrame(socket, (frame) => frame[0] === 'EOSE' && frame[1] === 'audit')
  socket.send(JSON.stringify(['REQ', 'audit',
    { kinds: [1059], '#p': [recipient], limit: 1 },
    { kinds: [1059], '#p': [recipient], until: now - 2, limit: 1 },
  ]))
  await eose
  const winner = events.slice(2).sort((a, b) => a.id.localeCompare(b.id))[0]
  assert.deepEqual(received.map((event) => event.id), [winner.id, events[1].id])
  const live = finalizeEvent({ kind: 1059, created_at: now, tags: [['p', recipient]], content: 'live' }, generateSecretKey())
  const incoming = nextFrame(socket, (frame) => frame[0] === 'EVENT' && frame[2]?.id === live.id)
  socket.send(JSON.stringify(['EVENT', live]))
  assert.equal((await incoming)[2].id, live.id)
})

async function serverForTest(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-push-server-'))
  const store = new RelayStore({ dataDirectory: directory })
  await store.load()
  const server = createTaskifyPushServer({
    config: { port: 0, publicBaseURL: 'https://push.solife.me', publicRelayURL: 'wss://push.solife.me' },
    store,
    apnsClient: { async send() { return { status: 200, reason: null } } },
    logger: { info() {}, warn() {} },
  })
  const address = await server.start(0)
  t.after(() => server.stop())
  return { store, port: address.port }
}

test('a request target that URL parsing rejects gets 400 and the server keeps running', async (t) => {
  const { port } = await serverForTest(t)
  const net = await import('node:net')
  for (const target of ['//', '///', '//:', '//?x']) {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: push.solife.me\r\nConnection: close\r\n\r\n`)
      })
      let data = ''
      socket.on('data', (chunk) => { data += chunk })
      socket.on('end', () => resolve(data))
      socket.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 400 /, `target ${target}`)
  }
  const health = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(health.status, 200)
})

test('an unauthenticated socket is refused before its signature is checked', async (t) => {
  const { port } = await serverForTest(t)
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  t.after(() => socket.close())
  await nextFrame(socket, (frame) => frame[0] === 'AUTH')
  const forged = { ...finalizeEvent({ kind: 1059, created_at: 1, tags: [['p', 'a'.repeat(64)]], content: 'x' }, generateSecretKey()), sig: '00'.repeat(64) }
  socket.send(JSON.stringify(['EVENT', forged]))
  const reply = await nextFrame(socket, (frame) => frame[0] === 'OK' && frame[1] === forged.id)
  assert.equal(reply[2], false)
  assert.match(reply[3], /^auth-required:/)
})

test('public inbox-preference queries must name the accounts they want', async (t) => {
  const { store, port } = await serverForTest(t)
  const owner = generateSecretKey()
  const preference = finalizeEvent({ kind: 10_050, created_at: 1_700_000_000, tags: [['relay', 'wss://push.solife.me']], content: '' }, owner)
  await store.putPreference(preference)

  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  t.after(() => socket.close())
  await nextFrame(socket, (frame) => frame[0] === 'AUTH')
  socket.send(JSON.stringify(['REQ', 'everyone', { kinds: [10_050] }]))
  const refused = await nextFrame(socket, (frame) => frame[1] === 'everyone')
  assert.equal(refused[0], 'CLOSED')

  socket.send(JSON.stringify(['REQ', 'named', { kinds: [10_050], authors: [getPublicKey(owner)] }]))
  const found = await nextFrame(socket, (frame) => frame[1] === 'named')
  assert.equal(found[0], 'EVENT')
  assert.equal(found[2].id, preference.id)
})

test('gift wraps are stored only for accounts that use this relay', async (t) => {
  const { store, port } = await serverForTest(t)
  const sender = await connectAndAuthenticate(port, generateSecretKey())
  t.after(() => sender.close())
  const publish = async (event) => {
    sender.send(JSON.stringify(['EVENT', event]))
    return nextFrame(sender, (frame) => frame[0] === 'OK' && frame[1] === event.id)
  }
  const stranger = getPublicKey(generateSecretKey())
  const refused = await publish(finalizeEvent({ kind: 1059, created_at: 1, tags: [['p', stranger]], content: 'x' }, generateSecretKey()))
  assert.equal(refused[2], false)
  assert.match(refused[3], /^restricted:/)
  assert.equal(store.eventsFor(stranger).length, 0)

  const userKey = generateSecretKey()
  await store.putPreference(finalizeEvent({ kind: 10_050, created_at: 1, tags: [['relay', 'wss://push.solife.me']], content: '' }, userKey))
  const accepted = await publish(finalizeEvent({ kind: 1059, created_at: 1, tags: [['p', getPublicKey(userKey)]], content: 'x' }, generateSecretKey()))
  assert.deepEqual(accepted.slice(2), [true, 'saved'])
})
