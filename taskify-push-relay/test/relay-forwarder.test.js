import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  isPublicIPAddress,
  pinnedLookup,
  sendEventOrAuthAndWait,
  queryEventsAndWait,
} from '../src/relay-forwarder.js'

test('pinned relay lookup supports Node single-address and all-address callback contracts', async () => {
  const pinned = { address: '203.0.113.10', family: 4 }
  const lookup = pinnedLookup(pinned)

  const single = await new Promise((resolve, reject) => {
    lookup('relay.example', { all: false }, (error, address, family) => {
      if (error) reject(error)
      else resolve({ address, family })
    })
  })
  assert.deepEqual(single, pinned)

  const all = await new Promise((resolve, reject) => {
    lookup('relay.example', { all: true }, (error, addresses) => {
      if (error) reject(error)
      else resolve(addresses)
    })
  })
  assert.deepEqual(all, [pinned])
})

test('preference discovery requires EOSE even after reaching its event limit', async () => {
  const socket = new EventEmitter()
  let subscription
  socket.send = (text) => {
    const frame = JSON.parse(text)
    if (frame[0] !== 'REQ') return
    subscription = frame[1]
    queueMicrotask(() => socket.emit('message', JSON.stringify(['EVENT', subscription, { id: 'one' }])))
  }
  let completed = false
  const query = queryEventsAndWait(socket, { kinds: [10_050] }, 1, 200, true)
    .then((events) => { completed = true; return events })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  socket.emit('message', JSON.stringify(['EOSE', subscription]))
  assert.deepEqual(await query, [{ id: 'one' }])
})

test('preference discovery rejects truncation and a socket closed before EOSE', async () => {
  for (const overflow of [true, false]) {
    const socket = new EventEmitter()
    socket.send = (text) => {
      const [type, subscription] = JSON.parse(text)
      if (type !== 'REQ') return
      queueMicrotask(() => {
        socket.emit('message', JSON.stringify(['EVENT', subscription, { id: 'one' }]))
        if (overflow) socket.emit('message', JSON.stringify(['EVENT', subscription, { id: 'two' }]))
        else socket.emit('close')
      })
    }
    await assert.rejects(queryEventsAndWait(socket, {}, 1, 200, true), /limit exceeded|connection closed/)
  }
})

test('relay forwarding rejects private and transition IPv6 address ranges', () => {
  for (const address of [
    '::1',
    'ff02::1',
    'fc00::1',
    'fe80::1',
    '64:ff9b::c0a8:101',
    '2001:db8::1',
    '2002:c0a8:101::1',
  ]) {
    assert.equal(isPublicIPAddress(address), false, address)
  }
  assert.equal(isPublicIPAddress('2606:4700:4700::1111'), true)
})

test('publish keeps the socket open for an AUTH challenge sent after rejection', async () => {
  const socket = new EventEmitter()
  const event = { id: 'event-id' }
  socket.send = () => {
    queueMicrotask(() => {
      socket.emit('message', JSON.stringify(['OK', event.id, false, 'auth-required: sign in']))
      setTimeout(() => socket.emit('message', JSON.stringify(['AUTH', 'late-challenge'])), 5)
    })
  }

  const result = await sendEventOrAuthAndWait(socket, event, 250)
  assert.deepEqual(result, { authRequired: true, challenge: 'late-challenge' })
})

test('publish still returns ordinary relay acknowledgements without AUTH', async () => {
  const socket = new EventEmitter()
  const event = { id: 'event-id' }
  socket.send = () => {
    queueMicrotask(() => socket.emit('message', JSON.stringify(['OK', event.id, true, 'saved'])))
  }

  const result = await sendEventOrAuthAndWait(socket, event, 250)
  assert.deepEqual(result, { authRequired: false, accepted: true, message: 'saved' })
})

test('a false OK remains rejected even when its message says duplicate', async () => {
  const socket = new EventEmitter()
  const event = { id: 'event-id' }
  socket.send = () => {
    queueMicrotask(() => {
      socket.emit('message', JSON.stringify(['OK', event.id, false, 'duplicate: event already exists']))
    })
  }

  const result = await sendEventOrAuthAndWait(socket, event, 250)
  assert.deepEqual(result, {
    authRequired: false,
    accepted: false,
    message: 'duplicate: event already exists',
  })
})
