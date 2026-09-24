import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

import { createTaskifyPushServer } from '../src/server.js'
import { RelayStore } from '../src/store.js'

const taskBoardTag = createHash('sha256').update('private-board-id').digest('hex')

function nip98Header(secretKey, url, method, body) {
  const event = finalizeEvent({
    kind: 27_235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', method],
      ['payload', createHash('sha256').update(body).digest('hex')],
    ],
    content: '',
  }, secretKey)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function post(address, pathname, value, secretKey) {
  const body = Buffer.from(JSON.stringify(value))
  const publicURL = `https://push.solife.me${pathname}`
  return fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: nip98Header(secretKey, publicURL, 'POST', body),
      'content-type': 'application/json',
    },
    body,
  })
}

async function fixture(t, relayForwarder, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-watch-gateway-'))
  const store = new RelayStore({ dataDirectory: directory })
  await store.load()
  const server = createTaskifyPushServer({
    config: {
      port: 0,
      publicBaseURL: 'https://push.solife.me',
      publicRelayURL: 'wss://push.solife.me',
    },
    store,
    relayForwarder,
    apnsClient: { async send() { return { status: 200, reason: null } } },
    logger: { info() {} },
    ...options,
  })
  const address = await server.start(0)
  t.after(() => server.stop())
  return { store, address }
}

function wire(value) { return JSON.parse(JSON.stringify(value)) }

function preference(key, relays = ['wss://inbox.example'], createdAt = 123_000) {
  return wire(finalizeEvent({
    kind: 10_050, created_at: createdAt, tags: relays.map((relay) => ['relay', relay]), content: '',
  }, key))
}

test('Watch HTTPS lookup returns signed public preferences without persisting or enriching them', async (t) => {
  const recipientKey = generateSecretKey()
  const recipient = getPublicKey(recipientKey)
  const old = preference(recipientKey)
  const newest = preference(recipientKey, ['wss://new-inbox.example'], 456_000)
  const queries = []
  const { store, address } = await fixture(t, {
    async query(relay, filter, limit, options) {
      queries.push({ relay, filter, limit, requireEOSE: options.requireEOSE })
      return [newest, old]
    },
  })
  await store.putPreference(old)
  const before = JSON.stringify(store.state)
  const response = await post(address, '/v1/watch/inbox-preference/query', {
    recipientPublicKey: recipient, relays: ['wss://discovery.example', 'wss://push.solife.me'],
  }, generateSecretKey())
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.events, wire([newest, old]))
  assert.deepEqual(result.completedRelays, ['wss://discovery.example', 'wss://push.solife.me'])
  assert.deepEqual(queries, [{
    relay: 'wss://discovery.example', filter: { kinds: [10_050], authors: [recipient], limit: 4 },
    limit: 4, requireEOSE: true,
  }])
  assert.equal(JSON.stringify(store.state), before, 'Lookup must not create a preference cache or contact history')
})

test('Watch lookup keeps failed and invalid upstream replies distinct from completed empty queries', async (t) => {
  const recipientKey = generateSecretKey()
  const recipient = getPublicKey(recipientKey)
  const signed = preference(recipientKey)
  const forged = {
    ...preference(recipientKey, ['wss://original.example'], 123_001),
    tags: [['relay', 'wss://forged.example']],
  }
  const { address } = await fixture(t, {
    async query(relay) {
      if (relay === 'wss://failed.example') throw new Error('Private upstream diagnostic')
      if (relay === 'wss://invalid.example') return [forged, preference(generateSecretKey())]
      if (relay === 'wss://valid.example') return [signed]
      return []
    },
  })
  const response = await post(address, '/v1/watch/inbox-preference/query', {
    recipientPublicKey: recipient,
    relays: ['wss://failed.example', 'wss://invalid.example', 'wss://valid.example', 'wss://empty.example'],
  }, generateSecretKey())
  assert.deepEqual(await response.json(), {
    events: wire([signed]), completedRelays: ['wss://valid.example', 'wss://empty.example'],
  })
})

test('Watch lookup preserves a signed empty inbox list for client-side unusable-list handling', async (t) => {
  const recipientKey = generateSecretKey()
  const empty = preference(recipientKey, [])
  const { address } = await fixture(t, { async query() { return [empty] } })
  const response = await post(address, '/v1/watch/inbox-preference/query', {
    recipientPublicKey: getPublicKey(recipientKey), relays: ['wss://discovery.example'],
  }, generateSecretKey())
  assert.deepEqual(await response.json(), { events: wire([empty]), completedRelays: ['wss://discovery.example'] })
})

test('Watch lookup requires authentication, one recipient, and bounded public discovery targets', async (t) => {
  let queryCount = 0
  const { address } = await fixture(t, { async query() { queryCount += 1; return [] } })
  const endpoint = '/v1/watch/inbox-preference/query'
  const key = generateSecretKey()
  const recipientPublicKey = getPublicKey(generateSecretKey())
  const valid = { recipientPublicKey, relays: ['wss://discovery.example'] }
  const anonymous = await fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
    method: 'POST', body: JSON.stringify(valid),
  })
  assert.equal(anonymous.status, 401)
  for (const body of [
    { ...valid, recipientPublicKey: [recipientPublicKey] },
    { ...valid, recipientPublicKey: 'invalid' },
    { ...valid, authors: [recipientPublicKey] },
    { ...valid, relays: [] },
    { ...valid, relays: ['wss://127.0.0.1'] },
    { ...valid, relays: ['wss://user:password@relay.example'] },
    { ...valid, relays: ['wss://relay.example', 'wss://relay.example/'] },
    { ...valid, relays: Array.from({ length: 9 }, (_, i) => `wss://relay${i}.example`) },
  ]) {
    const response = await post(address, endpoint, body, key)
    assert.ok([400, 429].includes(response.status))
  }
  assert.equal(queryCount, 0)
  const body = Buffer.from(JSON.stringify(valid))
  const headers = { authorization: nip98Header(key, `https://push.solife.me${endpoint}`, 'POST', body) }
  const first = await fetch(`http://127.0.0.1:${address.port}${endpoint}`, { method: 'POST', headers, body })
  assert.equal(first.status, 200)
  const replay = await fetch(`http://127.0.0.1:${address.port}${endpoint}`, { method: 'POST', headers, body })
  assert.equal(replay.status, 401)
  assert.equal(queryCount, 1)
})

test('Watch lookup cancels stalled discovery and bounds concurrent sockets', async (t) => {
  let active = 0
  let maximumActive = 0
  let cancelled = 0
  const { address } = await fixture(t, {
    async query(_relay, _filter, _limit, { signal }) {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((_, reject) => signal.addEventListener('abort', () => {
        active -= 1
        cancelled += 1
        reject(new Error('cancelled'))
      }, { once: true }))
    },
  }, { watchPreferenceTimeoutMs: 30 })
  const response = await post(address, '/v1/watch/inbox-preference/query', {
    recipientPublicKey: getPublicKey(generateSecretKey()),
    relays: Array.from({ length: 8 }, (_, index) => `wss://slow${index}.example`),
  }, generateSecretKey())
  assert.deepEqual(await response.json(), { events: [], completedRelays: [] })
  assert.equal(maximumActive, 4)
  assert.equal(cancelled, 4)
  assert.equal(active, 0)
})

function giftWrap(recipientPubkey, content = 'opaque') {
  return finalizeEvent({
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey]],
    content,
  }, generateSecretKey())
}

function taskEvent(
  boardKey,
  taskID,
  createdAt,
  content = 'opaque-board-ciphertext',
  boardTag = taskBoardTag,
) {
  return finalizeEvent({
    kind: 30_301,
    created_at: createdAt,
    tags: [
      ['d', taskID],
      ['b', boardTag],
      ['col', 'inbox'],
      ['status', 'open'],
    ],
    content,
  }, boardKey)
}

function taskCacheProof(boardKey, accountPubkey) {
  return finalizeEvent({
    kind: 27_236,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', 'https://push.solife.me/v1/watch/tasks/query'],
      ['method', 'POST'],
      ['account', accountPubkey],
      ['b', taskBoardTag],
      ['purpose', 'taskify-watch-cache'],
    ],
    content: '',
  }, boardKey)
}

test('Watch gateway forwards only to Watch-supplied targets and directly ingests the local target', async (t) => {
  const forwarded = []
  const relayForwarder = {
    async publish(relay, event) {
      forwarded.push({ relay, eventID: event.id })
      return { outcome: 'accepted', message: 'saved' }
    },
  }
  const { store, address } = await fixture(t, relayForwarder)
  const accountKey = generateSecretKey()
  const recipient = getPublicKey(generateSecretKey())
  const event = giftWrap(recipient)

  const response = await post(address, '/v1/watch/outbox/submit', {
    event,
    relays: ['wss://push.solife.me', 'wss://recipient.example'],
  }, accountKey)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.accepted, 2)
  assert.deepEqual(payload.results.map((result) => result.relay), [
    'wss://push.solife.me',
    'wss://recipient.example',
  ])
  assert.deepEqual(forwarded, [{ relay: 'wss://recipient.example', eventID: event.id }])
  assert.equal(store.eventsFor(recipient)[0].id, event.id)
})

test('fast Watch submit acknowledges local storage before slow replicas and still attempts every target', async (t) => {
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const forwarded = []
  const { store, address } = await fixture(t, {
    async publish(relay) {
      forwarded.push(relay)
      await blocked
      return { outcome: 'accepted' }
    },
  })
  const recipient = getPublicKey(generateSecretKey())
  const event = giftWrap(recipient)
  const remotes = Array.from({ length: 5 }, (_, index) => `wss://slow-${index}.example`)
  const responsePromise = post(address, '/v1/watch/outbox/submit', {
    event, relays: [...remotes, 'wss://push.solife.me'], returnAfterFirstAccepted: true,
  }, generateSecretKey())
  let timer
  try {
    const response = await Promise.race([
      responsePromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Acknowledgement waited for blocked replicas')), 2_000)
      }),
    ])
    assert.equal(response.status, 202)
    const payload = await response.json()
    assert.equal(payload.accepted, 1)
    assert.equal(payload.results.at(-1).status, 'accepted')
    assert.ok(payload.results.slice(0, -1).every((result) => result.status === 'pending'))
    assert.equal(store.eventsFor(recipient)[0].id, event.id)
  } finally {
    clearTimeout(timer)
    release()
    await responsePromise
  }
  // Drain the background workers, including targets beyond the concurrency window.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual([...forwarded].sort(), remotes.sort())
})

test('fast Watch submit requires a real acceptance and returns rejection details otherwise', async (t) => {
  const { address } = await fixture(t, {
    async publish() { return { outcome: 'rejected', message: 'blocked' } },
  })
  const response = await post(address, '/v1/watch/outbox/submit', {
    event: giftWrap(getPublicKey(generateSecretKey())),
    relays: ['wss://recipient.example'],
    returnAfterFirstAccepted: true,
  }, generateSecretKey())
  const payload = await response.json()
  assert.equal(payload.accepted, 0)
  assert.equal(payload.results[0].status, 'rejected')
})

test('Watch inbox cursor follows ingestion order rather than randomized event timestamps', async (t) => {
  const { store, address } = await fixture(t, { async publish() { throw new Error('unused') } })
  const recipientKey = generateSecretKey()
  const recipient = getPublicKey(recipientKey)
  const newerTimestamp = giftWrap(recipient, 'first-ingested')
  const olderTimestamp = finalizeEvent({
    kind: 1059,
    created_at: newerTimestamp.created_at - 100_000,
    tags: [['p', recipient]],
    content: 'second-ingested',
  }, generateSecretKey())
  await store.putGiftWrap(newerTimestamp, { notify: false })
  await store.putGiftWrap(olderTimestamp, { notify: false })

  const firstResponse = await post(address, '/v1/watch/inbox/query', { limit: 1 }, recipientKey)
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json()
  assert.equal(first.events[0].id, newerTimestamp.id)
  assert.equal(first.hasMore, true)

  const secondResponse = await post(address, '/v1/watch/inbox/query', {
    cursor: first.cursor,
    limit: 1,
  }, recipientKey)
  const second = await secondResponse.json()
  assert.equal(second.events[0].id, olderTimestamp.id)
  assert.equal(second.hasMore, false)
})

test('Watch completes a short-lived relay AUTH challenge with its own NIP-42 signature', async (t) => {
  const challenge = 'relay-challenge'
  let authorizedEvent = null
  const relayForwarder = {
    async publish() {
      return {
        outcome: 'auth-required',
        challenge,
        close() {},
        async authorize(event) {
          authorizedEvent = event
          return { accepted: true, message: 'saved' }
        },
      }
    },
  }
  const { address } = await fixture(t, relayForwarder)
  const accountKey = generateSecretKey()
  const accountPubkey = getPublicKey(accountKey)
  const event = giftWrap(getPublicKey(generateSecretKey()))
  const submitResponse = await post(address, '/v1/watch/outbox/submit', {
    event,
    relays: ['wss://auth-required.example'],
    returnAfterFirstAccepted: true,
  }, accountKey)
  assert.equal(submitResponse.status, 202)
  const submit = await submitResponse.json()
  const pending = submit.results[0]
  assert.equal(pending.status, 'auth-required')
  assert.equal(pending.challenge, challenge)

  const authEvent = finalizeEvent({
    kind: 22_242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', pending.relay],
      ['challenge', pending.challenge],
    ],
    content: '',
  }, accountKey)
  const authorizeResponse = await post(
    address,
    `/v1/watch/outbox/${pending.session}/authorize`,
    { event: authEvent },
    accountKey,
  )
  assert.equal(authorizeResponse.status, 200)
  assert.equal(authorizedEvent.pubkey, accountPubkey)
})

test('Watch gateway rejects absent, private, and duplicate supplied targets', async (t) => {
  const { address } = await fixture(t, {
    async publish() { return { outcome: 'accepted' } },
  })
  const accountKey = generateSecretKey()
  const event = giftWrap(getPublicKey(generateSecretKey()))
  for (const relays of [
    [],
    ['wss://127.0.0.1'],
    ['wss://relay.example', 'wss://relay.example/'],
  ]) {
    const response = await post(address, '/v1/watch/outbox/submit', { event, relays }, accountKey)
    assert.equal(response.status, 400)
  }
})

test('Watch task cache gathers and deduplicates opaque replaceable events', async (t) => {
  const accountKey = generateSecretKey()
  const accountPubkey = getPublicKey(accountKey)
  const boardKey = generateSecretKey()
  const boardPubkey = getPublicKey(boardKey)
  const now = Math.floor(Date.now() / 1000)
  const older = taskEvent(boardKey, 'task-1', now - 2, 'older-ciphertext')
  const newer = taskEvent(boardKey, 'task-1', now - 1, 'newer-ciphertext')
  const unrelated = taskEvent(boardKey, 'other-board-task', now, 'unrelated', 'e'.repeat(64))
  const unrelatedBoardKey = generateSecretKey()
  const unrelatedAuthor = getPublicKey(unrelatedBoardKey)
  const unrelatedAuthorEvent = taskEvent(
    unrelatedBoardKey,
    'other-author-task',
    now,
    'unrelated-author',
  )
  let queryShouldFail = false
  const relayForwarder = {
    async query(_relay, filter) {
      assert.deepEqual(filter.kinds, [30_300, 30_301])
      assert.deepEqual(filter.authors, [boardPubkey])
      assert.deepEqual(filter['#b'], [taskBoardTag])
      if (queryShouldFail) throw new Error('relay offline')
      // A misbehaving upstream relay may ignore the REQ filter. Neither an event under another
      // board tag nor one from an entirely unrequested author may enter the cache.
      return [older, newer, newer, unrelated, unrelatedAuthorEvent]
    },
  }
  const { store, address } = await fixture(t, relayForwarder)
  const request = {
    relays: ['wss://tasks.example'],
    sources: [{
      author: boardPubkey,
      boardTag: taskBoardTag,
      proof: taskCacheProof(boardKey, accountPubkey),
    }],
    limit: 100,
  }

  const response = await post(address, '/v1/watch/tasks/query', request, accountKey)
  const responseText = await response.text()
  assert.equal(response.status, 200, responseText)
  const payload = JSON.parse(responseText)
  assert.equal(payload.refreshed, true)
  assert.equal(payload.cacheHit, true)
  assert.deepEqual(payload.events.map((event) => event.id), [newer.id])
  assert.deepEqual(store.taskEventsFor([boardPubkey]).map((event) => event.id), [newer.id])
  assert.deepEqual(store.taskEventsFor([unrelatedAuthor]), [])

  queryShouldFail = true
  const cachedResponse = await post(
    address,
    '/v1/watch/tasks/query',
    { ...request, limit: 99 },
    accountKey,
  )
  assert.equal(cachedResponse.status, 200)
  const cached = await cachedResponse.json()
  assert.equal(cached.refreshed, false)
  assert.equal(cached.cacheHit, true)
  assert.deepEqual(cached.events.map((event) => event.id), [newer.id])
})

test('Watch task cache requires fresh board-key access proof bound to the account', async (t) => {
  const accountKey = generateSecretKey()
  const boardKey = generateSecretKey()
  const boardPubkey = getPublicKey(boardKey)
  const otherAccount = getPublicKey(generateSecretKey())
  const { address } = await fixture(t, { async query() { return [] } })

  const response = await post(address, '/v1/watch/tasks/query', {
    relays: ['wss://tasks.example'],
    sources: [{
      author: boardPubkey,
      boardTag: taskBoardTag,
      proof: taskCacheProof(boardKey, otherAccount),
    }],
  }, accountKey)
  assert.equal(response.status, 400)
})

test('Watch task publishing caches ciphertext and authenticates relays with the board key', async (t) => {
  const accountKey = generateSecretKey()
  const boardKey = generateSecretKey()
  const boardPubkey = getPublicKey(boardKey)
  const event = taskEvent(boardKey, 'task-1', Math.floor(Date.now() / 1000))
  let authorizedEvent = null
  const relayForwarder = {
    async publish() {
      return {
        outcome: 'auth-required',
        challenge: 'board-relay-challenge',
        close() {},
        async authorize(authEvent) {
          authorizedEvent = authEvent
          return { accepted: true, message: 'saved' }
        },
      }
    },
  }
  const { store, address } = await fixture(t, relayForwarder)
  const submitResponse = await post(address, '/v1/watch/task-events/publish', {
    event,
    relays: ['wss://tasks.example'],
  }, accountKey)
  assert.equal(submitResponse.status, 202)
  const submit = await submitResponse.json()
  assert.deepEqual(store.taskEventsFor([boardPubkey]).map((candidate) => candidate.id), [event.id])

  const pending = submit.results[0]
  const boardAuthorization = finalizeEvent({
    kind: 22_242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', pending.relay],
      ['challenge', pending.challenge],
    ],
    content: '',
  }, boardKey)
  const authorizeResponse = await post(
    address,
    `/v1/watch/outbox/${pending.session}/authorize`,
    { event: boardAuthorization },
    accountKey,
  )
  assert.equal(authorizeResponse.status, 200)
  assert.equal(authorizedEvent.pubkey, boardPubkey)
})

test('Watch authenticated preference query binds challenge to account and returns validated events', async t => {
  const account = generateSecretKey()
  const recipientKey = generateSecretKey()
  const expected = preference(recipientKey)
  let authorizations = 0
  const { address } = await fixture(t, {
    async query(_relay, _filter, _limit, options) {
      assert.equal(options.allowAuth, true)
      return {
        outcome: 'auth-required', challenge: 'private-read', close() {},
        async authorize() { authorizations++; return { accepted: true, events: [expected] } },
      }
    },
  })
  const initial = await post(address, '/v1/watch/inbox-preference/query', {
    recipientPublicKey: getPublicKey(recipientKey), relays: ['wss://private.example'],
  }, account)
  const pending = (await initial.json()).authorizations[0]
  assert.equal(authorizations, 0)
  const makeAuth = key => finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000),
    tags: [['relay', pending.relay], ['challenge', pending.challenge]], content: '' }, key)
  const endpoint = `/v1/watch/outbox/${pending.session}/authorize`
  const wrong = await post(address, endpoint, { event: makeAuth(generateSecretKey()) }, account)
  assert.notEqual(wrong.status, 200)
  assert.equal(authorizations, 0)
  const accepted = await post(address, endpoint, { event: makeAuth(account) }, account)
  assert.equal(accepted.status, 200)
  assert.deepEqual((await accepted.json()).events, wire([expected]))
  assert.equal(authorizations, 1)
  const replay = await post(address, endpoint, { event: makeAuth(account) }, account)
  assert.notEqual(replay.status, 200)
  assert.equal(authorizations, 1)
})
