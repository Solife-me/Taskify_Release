import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RelayStore } from '../src/store.js'

const alice = 'a'.repeat(64)
const bob = 'b'.repeat(64)
const carol = 'c'.repeat(64)

async function storeForTest(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-push-store-'))
  const store = new RelayStore({ dataDirectory: directory, ...options })
  await store.load()
  return { directory, store }
}

function giftWrap(id, recipient, createdAt = 1_700_000_000) {
  return {
    id,
    pubkey: 'c'.repeat(64),
    created_at: createdAt,
    kind: 1059,
    tags: [['p', recipient]],
    content: 'encrypted-gift-wrap',
    sig: 'd'.repeat(128),
  }
}

function taskEvent(id, author, taskID, createdAt) {
  return {
    id,
    pubkey: author,
    created_at: createdAt,
    kind: 30_301,
    tags: [['d', taskID], ['b', 'f'.repeat(64)], ['col', 'inbox'], ['status', 'open']],
    content: 'opaque-board-ciphertext',
    sig: 'e'.repeat(128),
  }
}

function preferenceEvent(id, author, createdAt, relay) {
  return {
    id,
    pubkey: author,
    created_at: createdAt,
    kind: 10_050,
    tags: [['relay', relay]],
    content: '',
    sig: 'f'.repeat(128),
  }
}

test('registrations are namespaced by the authenticated Nostr pubkey', async () => {
  const { store } = await storeForTest()
  await store.putRegistration(alice, 'phone-1', { deviceToken: '12'.repeat(32), environment: 'production' })
  await store.putRegistration(bob, 'phone-2', { deviceToken: '34'.repeat(32), environment: 'sandbox' })

  assert.equal(store.registrationsFor(alice).length, 1)
  assert.equal(store.registrationsFor(bob).length, 1)
  assert.notEqual(store.registrationsFor(alice)[0].deviceToken, store.registrationsFor(bob)[0].deviceToken)
})

test('moving one installation to another identity removes the stale registration', async () => {
  const { store } = await storeForTest()
  const deviceToken = '12'.repeat(32)
  await store.putRegistration(alice, 'phone-1', { deviceToken, environment: 'production' })
  await store.putRegistration(bob, 'phone-1', { deviceToken, environment: 'production' })

  assert.equal(store.registrationsFor(alice).length, 0)
  assert.equal(store.registrationsFor(bob).length, 1)
})

test('device registration is bounded without preventing token rotation', async () => {
  const { store } = await storeForTest({
    maxRegistrationsPerPubkey: 1,
    maxRegistrationsTotal: 2,
  })
  await store.putRegistration(alice, 'phone-1', {
    deviceToken: '12'.repeat(32),
    environment: 'production',
  })
  await store.putRegistration(alice, 'phone-1', {
    deviceToken: '34'.repeat(32),
    environment: 'production',
  })
  assert.equal(store.registrationsFor(alice)[0].deviceToken, '34'.repeat(32))
  await assert.rejects(
    store.putRegistration(alice, 'phone-2', {
      deviceToken: '56'.repeat(32),
      environment: 'production',
    }),
    /registration limit/i,
  )
  await store.putRegistration(bob, 'phone-2', {
    deviceToken: '78'.repeat(32),
    environment: 'production',
  })
  await assert.rejects(
    store.putRegistration(carol, 'phone-3', {
      deviceToken: '90'.repeat(32),
      environment: 'production',
    }),
    /registration limit/i,
  )
})

test('accepted gift wraps are durable, deduplicated, and enqueue one job per device', async () => {
  const { directory, store } = await storeForTest()
  await store.putRegistration(bob, 'phone-1', { deviceToken: '12'.repeat(32), environment: 'production' })
  await store.putRegistration(bob, 'tablet-1', { deviceToken: '34'.repeat(32), environment: 'sandbox' })

  assert.equal(await store.putGiftWrap(giftWrap('1'.repeat(64), bob), { notify: true }), true)
  assert.equal(await store.putGiftWrap(giftWrap('1'.repeat(64), bob), { notify: true }), false)
  assert.equal(store.eventsFor(bob).length, 1)
  assert.equal(store.duePushJobs(Number.MAX_SAFE_INTEGER).length, 2)

  const onDisk = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'))
  assert.equal(onDisk.events.length, 1)
  assert.equal(onDisk.pushJobs.length, 2)
})

test('each device gets a short-lived opaque preview token for the encrypted gift wrap', async () => {
  let now = 1_700_000_000
  const { store } = await storeForTest({ now: () => now, previewTTLSeconds: 600 })
  await store.putRegistration(bob, 'phone-1', {
    deviceToken: '12'.repeat(32),
    environment: 'production',
  })
  const event = giftWrap('7'.repeat(64), bob, now)
  await store.putGiftWrap(event, { notify: true })

  const [job] = store.duePushJobs()
  assert.match(job.previewToken, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(store.previewForToken(job.previewToken), event)

  await store.completePushJob(job.id, { retainPreview: true })
  assert.deepEqual(store.previewForToken(job.previewToken), event)
  now += 601
  assert.equal(store.previewForToken(job.previewToken), null)
})

test('Watch wake jobs do not allocate unnecessary preview tokens', async () => {
  const { store } = await storeForTest()
  await store.putRegistration(bob, 'watch-1', {
    deviceToken: '12'.repeat(32),
    environment: 'production',
    platform: 'watchos',
  })
  await store.putGiftWrap(giftWrap('9'.repeat(64), bob), { notify: true })

  const [job] = store.duePushJobs(Number.MAX_SAFE_INTEGER)
  assert.equal(job.previewToken, undefined)
  assert.equal(store.state.previews.length, 0)
})

test('loading an older pending push job creates a usable preview token', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-push-store-'))
  const event = giftWrap('8'.repeat(64), bob, 1_700_000_000)
  const registration = {
    key: `${bob}:phone-1`,
    pubkey: bob,
    installationID: 'phone-1',
    deviceToken: '12'.repeat(32),
    environment: 'production',
    updatedAt: 1_700_000_000,
  }
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({
    version: 1,
    registrations: [registration],
    events: [{ event, recipient: bob, storedAt: 1_700_000_000 }],
    preferences: [],
    pushJobs: [{
      id: `${event.id}:${registration.key}`,
      eventID: event.id,
      pubkey: bob,
      registrationKey: registration.key,
      attempts: 0,
      nextAttemptAt: 1_700_000_000,
      createdAt: 1_700_000_000,
    }],
  }))

  const store = new RelayStore({
    dataDirectory: directory,
    now: () => 1_700_000_100,
  })
  await store.load()

  const [job] = store.duePushJobs()
  assert.match(job.previewToken, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(store.previewForToken(job.previewToken), event)
})

test('sender copies remain retrievable without generating push jobs', async () => {
  const { store } = await storeForTest()
  await store.putRegistration(alice, 'phone-1', { deviceToken: '12'.repeat(32), environment: 'production' })
  await store.putGiftWrap(giftWrap('2'.repeat(64), alice), { notify: false })

  assert.equal(store.eventsFor(alice).length, 1)
  assert.equal(store.duePushJobs(Number.MAX_SAFE_INTEGER).length, 0)
})

test('replaceable inbox preferences use the NIP-01 event-id tie break', async () => {
  const { store } = await storeForTest()
  const timestamp = 1_700_000_000
  const higherID = preferenceEvent('f'.repeat(64), alice, timestamp, 'wss://old.example.com')
  const lowerID = preferenceEvent('0'.repeat(64), alice, timestamp, 'wss://new.example.com')

  assert.equal(await store.putPreference(higherID), true)
  assert.equal(await store.putPreference(lowerID), true)
  assert.deepEqual(store.preferencesFor([alice]), [lowerID])
  assert.equal(await store.putPreference(higherID), false)
})

test('events expire and per-recipient storage is bounded', async () => {
  let now = 2_000_000_000
  const { store } = await storeForTest({ eventTTLSeconds: 100, maxEventsPerRecipient: 2, now: () => now })
  await store.putGiftWrap(giftWrap('1'.repeat(64), bob, now), { notify: false })
  now += 101
  await store.putGiftWrap(giftWrap('2'.repeat(64), bob, now - 2), { notify: false })
  await store.putGiftWrap(giftWrap('3'.repeat(64), bob, now - 1), { notify: false })
  await store.putGiftWrap(giftWrap('4'.repeat(64), bob, now), { notify: false })

  assert.deepEqual(store.eventsFor(bob).map((event) => event.id), ['3'.repeat(64), '4'.repeat(64)])
})

test('global event eviction also removes orphaned APNs jobs', async () => {
  let now = 1_700_000_000
  const { store } = await storeForTest({
    maxEventsTotal: 1,
    now: () => now,
  })
  await store.putRegistration(bob, 'phone', {
    deviceToken: '99'.repeat(32),
    environment: 'production',
  })

  const first = giftWrap('5'.repeat(64), bob, now)
  await store.putGiftWrap(first, { notify: true })
  now += 1
  const second = giftWrap('6'.repeat(64), bob, now)
  await store.putGiftWrap(second, { notify: true })

  assert.deepEqual(store.duePushJobs().map((job) => job.eventID), [second.id])
  assert.deepEqual(store.eventsFor(bob).map((event) => event.id), [second.id])
})

test('task cache keeps only the latest replaceable ciphertext without account metadata', async () => {
  let now = 1_800_000_000
  const { directory, store } = await storeForTest({
    taskEventTTLSeconds: 100,
    now: () => now,
  })
  const older = taskEvent('8'.repeat(64), alice, 'task-1', now - 2)
  const newer = taskEvent('7'.repeat(64), alice, 'task-1', now - 1)
  const other = taskEvent('6'.repeat(64), alice, 'task-2', now)

  assert.equal(await store.putTaskEvents([older, newer, other]), true)
  assert.deepEqual(store.taskEventsFor([alice]).map((event) => event.id), [newer.id, other.id])
  assert.deepEqual(store.taskEventsFor([bob]), [])

  const onDisk = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'))
  assert.equal(onDisk.version, 3)
  assert.deepEqual(
    Object.keys(onDisk.taskEvents[0]).sort(),
    ['coordinate', 'event', 'lastSeenAt'],
  )

  now += 101
  assert.deepEqual(store.taskEventsFor([alice]), [])
})
