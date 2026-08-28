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
  assert.deepEqual(relayInfo.supported_nips, [1, 9, 11, 17, 42, 59, 98])

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
