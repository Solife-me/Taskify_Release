import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { verifyEvent } from 'nostr-tools'
import { WebSocket, WebSocketServer } from 'ws'

import { NIP98ReplayGuard, verifyNip98Request } from './auth.js'
import {
  assertAuthorizedGiftWrapFilters,
  giftWrapRecipient,
  matchesFilter,
  shouldNotifyRecipient,
} from './relay-policy.js'
import { NostrRelayForwarder, normalizeRelayTargets } from './relay-forwarder.js'

const MAX_HTTP_BODY_BYTES = 256 * 1024
const INSTALLATION_ID = /^[A-Za-z0-9._:-]{1,128}$/
const DEVICE_TOKEN = /^[0-9a-fA-F]{32,200}$/
const PUBLIC_KEY = /^[0-9a-f]{64}$/
const WATCH_PAGE_LIMIT = 200
const WATCH_FORWARD_CONCURRENCY = 4
const WATCH_PREFERENCE_RELAY_LIMIT = 8
const WATCH_PREFERENCE_EVENT_LIMIT = 4
/// The Watch answers each auth-required relay with a sequential series of signed authorize
/// POSTs; with several restricted relays in one submit the later sessions are only reached
/// after the earlier ones complete. The TTL must cover that whole loop, not one hop.
const WATCH_SESSION_TTL_MS = 120_000
const WATCH_TASK_ACCESS_KIND = 27_236
const WATCH_TASK_EVENT_KINDS = new Set([30_300, 30_301])
const WATCH_TASK_AUTHOR_LIMIT = 64
const WATCH_TASK_EVENT_LIMIT = 1_000

function sendJSON(response, status, value, contentType = 'application/json') {
  const data = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    'cache-control': 'no-store',
  })
  response.end(data)
}

async function requestBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_HTTP_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function singleTag(event, name) {
  const matches = event.tags.filter((tag) => tag[0] === name && tag.length >= 2)
  return matches.length === 1 ? matches[0][1] : null
}

function encodeCursor(sequence) {
  return Buffer.from(`v1:${sequence}`).toString('base64url')
}

function decodeCursor(value) {
  if (value == null || value === '') return 0
  if (typeof value !== 'string' || value.length > 64) throw new Error('Invalid inbox cursor')
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  const match = /^v1:(\d+)$/.exec(decoded)
  const sequence = match ? Number(match[1]) : Number.NaN
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid inbox cursor')
  return sequence
}

async function mapWithConcurrency(values, maximum, operation, onResult = () => {}) {
  const results = new Array(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(maximum, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index], index)
      onResult(results[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

class SlidingWindowRateLimiter {
  constructor({ maximum = 120, windowSeconds = 60, now = () => Math.floor(Date.now() / 1000) } = {}) {
    this.maximum = maximum
    this.windowSeconds = windowSeconds
    this.now = now
    this.entries = new Map()
  }

  consume(key) {
    const now = this.now()
    const cutoff = now - this.windowSeconds
    const recent = (this.entries.get(key) ?? []).filter((timestamp) => timestamp > cutoff)
    if (recent.length >= this.maximum) return false
    recent.push(now)
    this.entries.set(key, recent)
    return true
  }
}

function isPublicPreferenceQuery(filters) {
  return Array.isArray(filters)
    && filters.length > 0
    && filters.length <= 5
    && filters.every((filter) =>
      Array.isArray(filter?.kinds)
      && filter.kinds.length === 1
      && filter.kinds[0] === 10_050
      && (!filter.authors || (Array.isArray(filter.authors) && filter.authors.length <= 100)),
    )
}

function boundedLimit(filters, maximum = 500) {
  return Math.min(
    maximum,
    Math.max(1, ...filters.map((filter) => Number.isInteger(filter.limit) ? filter.limit : maximum)),
  )
}

function assertCacheableTaskEvent(event, allowedSources = null) {
  if (!WATCH_TASK_EVENT_KINDS.has(event?.kind) || !verifyEvent(event)) {
    throw new Error('Invalid signed Taskify board event')
  }
  const author = event.pubkey?.toLowerCase()
  if (!PUBLIC_KEY.test(author ?? '') || (allowedSources && !allowedSources.has(author))) {
    throw new Error('Taskify board event author is not authorized')
  }
  const identifier = singleTag(event, 'd')
  const boardTag = singleTag(event, 'b')?.toLowerCase()
  if (typeof identifier !== 'string' || identifier.length === 0 || identifier.length > 256) {
    throw new Error('Taskify board event identifier is invalid')
  }
  if (!PUBLIC_KEY.test(boardTag ?? '')) throw new Error('Taskify board tag is invalid')
  if (allowedSources && allowedSources.get(author) !== boardTag) {
    throw new Error('Taskify board event is outside the requested subscription')
  }
  if (typeof event.content !== 'string' || Buffer.byteLength(event.content) > 128 * 1024) {
    throw new Error('Taskify board ciphertext is too large')
  }
  if (event.created_at > Math.floor(Date.now() / 1_000) + 10 * 60) {
    throw new Error('Taskify board event timestamp is too far in the future')
  }
  return event
}

function taskCacheSources(payload, authenticatedPubkey, expectedURL) {
  if (!Array.isArray(payload.sources)
      || payload.sources.length === 0
      || payload.sources.length > WATCH_TASK_AUTHOR_LIMIT) {
    throw new Error('Task cache source limit exceeded')
  }
  const sources = new Map()
  const now = Math.floor(Date.now() / 1_000)
  for (const source of payload.sources) {
    const author = source?.author?.toLowerCase()
    const boardTag = source?.boardTag?.toLowerCase()
    const proof = source?.proof
    if (!PUBLIC_KEY.test(author ?? '')
        || !PUBLIC_KEY.test(boardTag ?? '')
        || sources.has(author)) {
      throw new Error('Task cache source is invalid or duplicated')
    }
    if (proof?.kind !== WATCH_TASK_ACCESS_KIND
        || !verifyEvent(proof)
        || proof.pubkey?.toLowerCase() !== author
        || Math.abs(now - proof.created_at) > 2 * 60
        || singleTag(proof, 'u') !== expectedURL
        || singleTag(proof, 'method')?.toUpperCase() !== 'POST'
        || singleTag(proof, 'account')?.toLowerCase() !== authenticatedPubkey
        || singleTag(proof, 'b')?.toLowerCase() !== boardTag
        || singleTag(proof, 'purpose') !== 'taskify-watch-cache') {
      throw new Error('Task cache access proof is invalid')
    }
    sources.set(author, boardTag)
  }
  return sources
}

export function createTaskifyPushServer({
  config,
  store,
  apnsClient,
  relayForwarder = new NostrRelayForwarder(),
  logger = console,
  watchPreferenceTimeoutMs = 5_000,
}) {
  const replayGuard = new NIP98ReplayGuard()
  const publishLimiter = new SlidingWindowRateLimiter()
  const privateRequestLimiter = new SlidingWindowRateLimiter({ maximum: 300 })
  const privateIPLimiter = new SlidingWindowRateLimiter({ maximum: 1_200 })
  const sockets = new Set()
  const watchAuthSessions = new Map()
  const watchForwardingTasks = new Set()
  const watchPreferenceLookups = new Set()
  let pushTimer = null
  let pushWorkerPromise = null

  function enforcePrivateRequestLimit(request, pubkey) {
    const address = request.socket.remoteAddress ?? 'unknown'
    if (!privateRequestLimiter.consume(pubkey) || !privateIPLimiter.consume(address)) {
      throw new Error('Private request limit exceeded')
    }
  }

  function discardExpiredWatchSessions() {
    const now = Date.now()
    for (const [token, session] of watchAuthSessions) {
      if (session.expiresAt > now) continue
      session.close?.()
      watchAuthSessions.delete(token)
    }
  }

  async function handleRegistrationRequest(request, response, url) {
    const match = /^\/v1\/registrations\/([^/]+)$/.exec(url.pathname)
    if (!match || !['PUT', 'DELETE'].includes(request.method)) return false
    let installationID
    try {
      installationID = decodeURIComponent(match[1])
    } catch {
      sendJSON(response, 400, { error: 'Invalid installation ID' })
      return true
    }
    if (!INSTALLATION_ID.test(installationID)) {
      sendJSON(response, 400, { error: 'Invalid installation ID' })
      return true
    }
    try {
      const body = await requestBody(request)
      const expectedURL = new URL(`${url.pathname}${url.search}`, config.publicBaseURL).toString()
      const auth = verifyNip98Request({
        authorization: request.headers.authorization,
        method: request.method,
        expectedURL,
        body,
        replayGuard,
      })
      enforcePrivateRequestLimit(request, auth.pubkey)
      if (request.method === 'DELETE') {
        await store.removeRegistration(auth.pubkey, installationID)
        sendJSON(response, 200, {
          enabled: false,
          remainingRegistrations: store.registrationsFor(auth.pubkey).length,
        })
        return true
      }
      const payload = JSON.parse(body.toString('utf8'))
      if (!DEVICE_TOKEN.test(payload.deviceToken ?? '')) throw new Error('Invalid APNs device token')
      if (!['production', 'sandbox'].includes(payload.environment)) throw new Error('Invalid APNs environment')
      if (payload.platform != null && !['ios', 'watchos'].includes(payload.platform)) {
        throw new Error('Invalid APNs platform')
      }
      await store.putRegistration(auth.pubkey, installationID, payload)
      sendJSON(response, 200, {
        enabled: true,
        remainingRegistrations: store.registrationsFor(auth.pubkey).length,
      })
    } catch (error) {
      const status = /limit exceeded/i.test(error.message)
        ? 429
        : /authorization|NIP-98|replay/i.test(error.message) ? 401 : 400
      sendJSON(response, status, { error: error.message })
    }
    return true
  }

  async function authenticateWatchRequest(request, url, body) {
    const expectedURL = new URL(`${url.pathname}${url.search}`, config.publicBaseURL).toString()
    return verifyNip98Request({
      authorization: request.headers.authorization,
      method: request.method,
      expectedURL,
      body,
      replayGuard,
    })
  }

  async function ingestLocalWatchEvent(event, authenticatedPubkey) {
    if (event.kind === 1059) {
      const recipient = giftWrapRecipient(event)
      const stored = await store.putGiftWrap(event, {
        notify: shouldNotifyRecipient({
          authenticatedPubkey,
          recipientPubkey: recipient,
        }),
      })
      if (stored) broadcastEvent(event)
      return { accepted: true, message: stored ? 'saved' : 'duplicate: event already stored' }
    }
    if (event.kind === 10_050) {
      if (event.pubkey.toLowerCase() !== authenticatedPubkey) {
        throw new Error('Kind 10050 author must match the authenticated account')
      }
      const stored = await store.putPreference(event)
      if (stored) broadcastEvent(event)
      return { accepted: true, message: stored ? 'saved' : 'duplicate: older replaceable event' }
    }
    if (WATCH_TASK_EVENT_KINDS.has(event.kind)) {
      assertCacheableTaskEvent(event)
      const stored = await store.putTaskEvents([event])
      return { accepted: true, message: stored ? 'cached' : 'duplicate: latest event already cached' }
    }
    throw new Error('Unsupported Watch event kind')
  }

  function registerReadAuthorization(result, relayURL, accountPubkey, maximumEvents, accept, onEvents) {
    if (watchAuthSessions.size >= 256) {
      result.close?.()
      throw new Error('Relay authorization capacity exceeded')
    }
    const token = randomBytes(32).toString('base64url')
    const expiry = setTimeout(() => {
      const session = watchAuthSessions.get(token)
      session?.close?.()
      watchAuthSessions.delete(token)
    }, WATCH_SESSION_TTL_MS)
    expiry.unref?.()
    watchAuthSessions.set(token, {
      accountPubkey, authorizationPubkey: accountPubkey, relayURL,
      eventID: `query:${token}`, challenge: result.challenge,
      expiresAt: Date.now() + WATCH_SESSION_TTL_MS,
      authorize: async event => {
        const authorized = await result.authorize(event)
        if (!authorized.accepted || !Array.isArray(authorized.events) || authorized.events.length > maximumEvents) {
          throw new Error('Invalid authorized query response')
        }
        const events = authorized.events.filter(accept)
        if (events.length !== authorized.events.length) throw new Error("Invalid authorized query events")
        await onEvents?.(events)
        return { accepted: true, events }
      },
      close: () => { clearTimeout(expiry); result.close?.() },
    })
    return { relay: relayURL, status: 'auth-required', session: token, challenge: result.challenge }
  }

  async function forwardWatchEvent(event, relayURLs, authenticatedPubkey, returnAfterFirstAccepted = false) {
    const localRelayURL = normalizeRelayTargets([config.publicRelayURL])[0]
    const completed = new Map()
    const snapshot = () => relayURLs.map((relay) => completed.get(relay) ?? { relay, status: 'pending' })
    let acknowledgeFirst
    const firstAccepted = new Promise((resolve) => { acknowledgeFirst = resolve })
    // Local ingestion must not sit behind a queue of slow remote handshakes. This changes
    // scheduling only; results retain the supplied order and no targets are added.
    const targets = returnAfterFirstAccepted
      ? [...relayURLs.filter((relay) => relay === localRelayURL), ...relayURLs.filter((relay) => relay !== localRelayURL)]
      : relayURLs
    const forwarding = mapWithConcurrency(
      targets,
      WATCH_FORWARD_CONCURRENCY,
      async (relayURL) => {
        try {
          if (relayURL === localRelayURL) {
            const local = await ingestLocalWatchEvent(event, authenticatedPubkey)
            return { relay: relayURL, status: 'accepted', message: local.message }
          }
          const result = await relayForwarder.publish(relayURL, event)
          if (result.outcome === 'auth-required') {
            const token = randomBytes(32).toString('base64url')
            watchAuthSessions.set(token, {
              accountPubkey: authenticatedPubkey,
              authorizationPubkey: WATCH_TASK_EVENT_KINDS.has(event.kind)
                ? event.pubkey.toLowerCase()
                : authenticatedPubkey,
              relayURL,
              eventID: event.id,
              challenge: result.challenge,
              authorize: result.authorize,
              close: result.close,
              expiresAt: Date.now() + WATCH_SESSION_TTL_MS,
            })
            return {
              relay: relayURL,
              status: 'auth-required',
              session: token,
              challenge: result.challenge,
            }
          }
          return {
            relay: relayURL,
            status: result.outcome === 'accepted' ? 'accepted' : 'rejected',
            message: result.message ?? null,
          }
        } catch (error) {
          return { relay: relayURL, status: 'failed', message: error.message }
        }
      },
      (result) => {
        completed.set(result.relay, result)
        if (result.status === 'accepted') acknowledgeFirst(snapshot())
      },
    ).then(snapshot)
    // Work continues after the early HTTP response. The Watch retains every pending target
    // in its durable outbox, so a service restart cannot silently lose those replicas.
    watchForwardingTasks.add(forwarding)
    forwarding.then(
      () => watchForwardingTasks.delete(forwarding),
      () => watchForwardingTasks.delete(forwarding),
    )
    return returnAfterFirstAccepted ? Promise.race([firstAccepted, forwarding]) : forwarding
  }

  async function handleWatchRequest(request, response, url) {
    if (request.method !== 'POST' || !url.pathname.startsWith('/v1/watch/')) return false
    discardExpiredWatchSessions()
    try {
      const body = await requestBody(request)
      const auth = await authenticateWatchRequest(request, url, body)
      enforcePrivateRequestLimit(request, auth.pubkey)
      const payload = JSON.parse(body.toString('utf8'))

      if (url.pathname === '/v1/watch/inbox-preference/query') {
        if (!payload || Object.keys(payload).some((key) => !['recipientPublicKey', 'relays'].includes(key))
            || typeof payload.recipientPublicKey !== 'string'
            || !PUBLIC_KEY.test(payload.recipientPublicKey)) {
          throw new Error('A single recipient public key is required')
        }
        const recipient = payload.recipientPublicKey
        const relayURLs = normalizeRelayTargets(payload.relays, WATCH_PREFERENCE_RELAY_LIMIT)
        const localRelayURL = normalizeRelayTargets([config.publicRelayURL])[0]
        const controller = new AbortController()
        const cancel = () => controller.abort()
        const timer = setTimeout(cancel, watchPreferenceTimeoutMs)
        response.once('close', cancel)
        watchPreferenceLookups.add(controller)
        try {
          // Lookups are request-scoped. Never persist results, recipient associations, or
          // upstream errors, and never pass the Watch's authentication to a discovery relay.
          const gathered = await mapWithConcurrency(relayURLs, WATCH_FORWARD_CONCURRENCY, async (relay) => {
            try {
              controller.signal.throwIfAborted()
              const events = relay === localRelayURL
                ? store.preferencesFor([recipient])
                : await relayForwarder.query(relay, {
                  kinds: [10_050], authors: [recipient], limit: WATCH_PREFERENCE_EVENT_LIMIT,
                }, WATCH_PREFERENCE_EVENT_LIMIT, {
                  signal: controller.signal, timeoutMs: 2_000, requireEOSE: true, allowAuth: true,
                })
              if (events?.outcome === 'auth-required') {
                const authorization = registerReadAuthorization(events, relay, auth.pubkey,
                  WATCH_PREFERENCE_EVENT_LIMIT, event => {
                    try { return event?.kind === 10_050 && event.pubkey === recipient
                      && Buffer.byteLength(JSON.stringify(event)) <= 8 * 1024 && verifyEvent(event) }
                    catch { return false }
                  })
                return { relay, events: [], completed: false, authorization }
              }
              if (!Array.isArray(events) || events.length > WATCH_PREFERENCE_EVENT_LIMIT) {
                throw new Error('Invalid preference response')
              }
              const valid = events.filter((event) => {
                try {
                  return event?.kind === 10_050 && event.pubkey === recipient
                    && Buffer.byteLength(JSON.stringify(event)) <= 8 * 1024 && verifyEvent(event)
                } catch { return false }
              })
              return { relay, events: valid, completed: valid.length === events.length }
            } catch {
              return { relay, events: [], completed: false }
            }
          })
          const events = new Map()
          for (const result of gathered) {
            for (const event of result.events) events.set(event.id, event)
          }
          sendJSON(response, 200, {
            events: Array.from(events.values()),
            ...(gathered.some(result => result.authorization)
              ? { authorizations: gathered.flatMap(result => result.authorization ? [result.authorization] : []) } : {}),
            completedRelays: gathered.filter((result) => result.completed).map((result) => result.relay),
          })
        } finally {
          clearTimeout(timer)
          response.off('close', cancel)
          watchPreferenceLookups.delete(controller)
          controller.abort()
        }
        return true
      }

      if (url.pathname === '/v1/watch/inbox/query') {
        const sequence = decodeCursor(payload.cursor)
        const limit = Math.max(1, Math.min(WATCH_PAGE_LIMIT, Number(payload.limit) || 100))
        const page = store.eventsAfter(auth.pubkey, sequence, limit)
        sendJSON(response, 200, {
          events: page.events,
          cursor: encodeCursor(page.nextSequence),
          hasMore: page.hasMore,
        })
        return true
      }

      if (url.pathname === '/v1/watch/tasks/query') {
        const expectedURL = new URL(`${url.pathname}${url.search}`, config.publicBaseURL).toString()
        const sources = taskCacheSources(payload, auth.pubkey, expectedURL)
        const authors = Array.from(sources.keys())
        const boardTags = Array.from(sources.values())
        const relayURLs = normalizeRelayTargets(payload.relays)
        const limit = Math.max(
          1,
          Math.min(WATCH_TASK_EVENT_LIMIT, Number(payload.limit) || WATCH_TASK_EVENT_LIMIT),
        )
        const gathered = typeof relayForwarder.query === 'function'
          ? await mapWithConcurrency(
            relayURLs,
            WATCH_FORWARD_CONCURRENCY,
            async (relayURL) => {
              try {
                const events = await relayForwarder.query(relayURL, {
                  kinds: Array.from(WATCH_TASK_EVENT_KINDS),
                  authors,
                  '#b': boardTags,
                  limit,
                }, limit, { allowAuth: true })
                if (events?.outcome === 'auth-required') {
                  const authorization = registerReadAuthorization(events, relayURL, auth.pubkey, limit,
                    event => { try { assertCacheableTaskEvent(event, sources); return true } catch { return false } },
                    events => store.putTaskEvents(events))
                  return { completed: false, events: [], authorization }
                }
                return {
                  completed: true,
                  events: events.filter((event) => {
                    try {
                      assertCacheableTaskEvent(event, sources)
                      return true
                    } catch {
                      return false
                    }
                  }),
                }
              } catch {
                return { completed: false, events: [] }
              }
            },
          )
          : []
        const uniqueEvents = new Map()
        for (const result of gathered) {
          for (const event of result.events) uniqueEvents.set(event.id, event)
        }
        if (uniqueEvents.size > 0) await store.putTaskEvents(Array.from(uniqueEvents.values()))
        const events = store.taskEventsFor(authors, limit, sources)
        sendJSON(response, 200, {
          events,
          ...(gathered.some(result => result.authorization)
              ? { authorizations: gathered.flatMap(result => result.authorization ? [result.authorization] : []) } : {}),
          refreshed: gathered.some((result) => result.completed),
          cacheHit: events.length > 0,
        })
        return true
      }

      const authorizationMatch = /^\/v1\/watch\/outbox\/([A-Za-z0-9_-]{43})\/authorize$/.exec(url.pathname)
      if (authorizationMatch) {
        const token = authorizationMatch[1]
        const session = watchAuthSessions.get(token)
        if (!session || session.expiresAt <= Date.now()) throw new Error('Relay authorization session expired')
        if (session.accountPubkey !== auth.pubkey) throw new Error('Relay authorization account mismatch')
        const event = payload.event
        if (event?.kind !== 22_242
            || !verifyEvent(event)
            || event.pubkey.toLowerCase() !== session.authorizationPubkey) {
          throw new Error('Invalid NIP-42 authorization event')
        }
        if (singleTag(event, 'relay') !== session.relayURL
            || singleTag(event, 'challenge') !== session.challenge) {
          throw new Error('NIP-42 authorization does not match the relay session')
        }
        if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > 10 * 60) {
          throw new Error('NIP-42 authorization is stale')
        }
        watchAuthSessions.delete(token)
        try {
          const result = await session.authorize(event)
          sendJSON(response, result.accepted ? 200 : 422, {
            eventID: session.eventID,
            ...(result.events ? { events: result.events } : {}),
            result: {
              relay: session.relayURL,
              status: result.accepted ? 'accepted' : 'rejected',
              message: result.message ?? null,
            },
          })
        } finally {
          session.close?.()
        }
        return true
      }

      const isOutbox = url.pathname === '/v1/watch/outbox/submit'
      const isPreference = url.pathname === '/v1/watch/inbox-preference/publish'
      const isTaskPublish = url.pathname === '/v1/watch/task-events/publish'
      if (!isOutbox && !isPreference && !isTaskPublish) return false
      const event = payload.event
      if (isTaskPublish) {
        assertCacheableTaskEvent(event)
      } else {
        const expectedKind = isOutbox ? 1059 : 10_050
        if (event?.kind !== expectedKind || !verifyEvent(event)) throw new Error('Invalid signed Watch event')
      }
      if (isOutbox) {
        giftWrapRecipient(event)
        if (event.content.length > 128 * 1024) throw new Error('Gift wrap is too large')
      } else if (event.pubkey.toLowerCase() !== auth.pubkey) {
        if (!isTaskPublish) throw new Error('Kind 10050 author must match the authenticated account')
      }
      if (!publishLimiter.consume(auth.pubkey)) throw new Error('Watch publish limit exceeded')
      const relayURLs = normalizeRelayTargets(payload.relays)
      if (isTaskPublish) await store.putTaskEvents([event])
      const results = await forwardWatchEvent(
        event, relayURLs, auth.pubkey, isOutbox && payload.returnAfterFirstAccepted === true,
      )
      const accepted = results.filter((result) => result.status === 'accepted').length
      const pendingAuthorization = results.some((result) => ['auth-required', 'pending'].includes(result.status))
      sendJSON(response, pendingAuthorization ? 202 : 200, {
        eventID: event.id,
        accepted,
        results,
      })
    } catch (error) {
      const status = /limit exceeded/i.test(error.message)
        ? 429
        : /authorization|NIP-98|replay|account mismatch/i.test(error.message) ? 401 : 400
      sendJSON(response, status, { error: error.message })
    }
    return true
  }

  const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', config.publicBaseURL)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJSON(response, 200, { status: 'ok' })
      return
    }
    const previewMatch = /^\/v1\/previews\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)
    if (request.method === 'GET' && previewMatch) {
      const event = store.previewForToken(previewMatch[1])
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Pragma', 'no-cache')
      sendJSON(response, event ? 200 : 404, event ? { event } : { error: 'Preview not found' })
      return
    }
    if (await handleRegistrationRequest(request, response, url)) return
    if (await handleWatchRequest(request, response, url)) return
    if (request.method === 'GET' && url.pathname === '/') {
      sendJSON(response, 200, {
        name: 'Taskify Push Relay',
        description: 'NIP-17 inbox relay with privacy-preserving APNs wake delivery',
        pubkey: '',
        contact: 'https://solife.me',
        supported_nips: [1, 11, 17, 42, 59, 98],
        software: 'https://github.com/nathanhughes/Taskify_Release',
        version: '0.4.1',
        limitation: {
          auth_required: true,
          payment_required: false,
          restricted_writes: true,
          max_message_length: 131072,
          max_subscriptions: 20,
        },
      }, 'application/nostr+json')
      return
    }
    sendJSON(response, 404, { error: 'Not found' })
  })

  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  httpServer.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request)
    })
  })

  function relaySend(socket, value) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
  }

  function broadcastEvent(event) {
    for (const state of sockets) {
      for (const [subscriptionID, filters] of state.subscriptions) {
        if (filters.some((filter) => matchesFilter(event, filter))) {
          relaySend(state.socket, ['EVENT', subscriptionID, event])
        }
      }
    }
  }

  function authenticateSocket(state, event) {
    if (event?.kind !== 22_242 || !verifyEvent(event)) throw new Error('auth-required: invalid NIP-42 event')
    if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > 10 * 60) {
      throw new Error('auth-required: stale NIP-42 event')
    }
    if (singleTag(event, 'challenge') !== state.challenge) {
      throw new Error('auth-required: challenge does not match')
    }
    if (singleTag(event, 'relay') !== config.publicRelayURL) {
      throw new Error('auth-required: relay URL does not match')
    }
    state.authenticatedPubkey = event.pubkey.toLowerCase()
  }

  async function handleRelayEvent(state, event) {
    if (!verifyEvent(event)) throw new Error('invalid: event signature is invalid')
    if (!state.authenticatedPubkey) throw new Error('auth-required: authenticate before publishing')
    if (!publishLimiter.consume(state.authenticatedPubkey)) throw new Error('rate-limited: publish limit exceeded')
    if (event.kind === 10_050) {
      if (event.pubkey.toLowerCase() !== state.authenticatedPubkey) {
        throw new Error('restricted: kind 10050 author must match authenticated pubkey')
      }
      const stored = await store.putPreference(event)
      if (stored) broadcastEvent(event)
      return stored ? 'saved' : 'duplicate: older replaceable event'
    }
    if (event.kind !== 1059) throw new Error('restricted: only kinds 1059 and 10050 are accepted')
    const recipient = giftWrapRecipient(event)
    if (event.content.length > 128 * 1024) throw new Error('invalid: gift wrap is too large')
    const stored = await store.putGiftWrap(event, {
      notify: shouldNotifyRecipient({
        authenticatedPubkey: state.authenticatedPubkey,
        recipientPubkey: recipient,
      }),
    })
    if (stored) broadcastEvent(event)
    return stored ? 'saved' : 'duplicate: event already stored'
  }

  async function handleSubscription(state, subscriptionID, filters) {
    if (typeof subscriptionID !== 'string' || subscriptionID.length === 0 || subscriptionID.length > 64) {
      throw new Error('restricted: invalid subscription ID')
    }
    if (state.subscriptions.size >= 20 && !state.subscriptions.has(subscriptionID)) {
      throw new Error('restricted: subscription limit exceeded')
    }
    let events
    if (isPublicPreferenceQuery(filters)) {
      const authors = filters.flatMap((filter) => filter.authors ?? []).filter((author) => PUBLIC_KEY.test(author))
      events = store.preferencesFor(authors)
    } else {
      assertAuthorizedGiftWrapFilters(filters, state.authenticatedPubkey)
      events = store.eventsFor(state.authenticatedPubkey)
    }
    state.subscriptions.set(subscriptionID, filters)
    const newestFirst = (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
    const matching = new Map()
    for (const filter of filters) {
      for (const event of events.filter((event) => matchesFilter(event, filter))
        .sort(newestFirst).slice(0, boundedLimit([filter]))) {
        matching.set(event.id, event)
      }
    }
    for (const event of [...matching.values()].sort(newestFirst).slice(0, 500)) {
      relaySend(state.socket, ['EVENT', subscriptionID, event])
    }
    relaySend(state.socket, ['EOSE', subscriptionID])
  }

  webSocketServer.on('connection', (socket) => {
    const state = {
      socket,
      challenge: randomBytes(32).toString('base64url'),
      authenticatedPubkey: null,
      subscriptions: new Map(),
    }
    sockets.add(state)
    relaySend(socket, ['AUTH', state.challenge])
    socket.on('close', () => sockets.delete(state))
    socket.on('error', () => {})
    socket.on('message', async (data) => {
      let message
      try {
        message = JSON.parse(data.toString())
        if (!Array.isArray(message) || typeof message[0] !== 'string') throw new Error('invalid: malformed relay message')
        switch (message[0]) {
        case 'AUTH':
          authenticateSocket(state, message[1])
          relaySend(socket, ['OK', message[1]?.id ?? '', true, 'authenticated'])
          break
        case 'EVENT': {
          const event = message[1]
          const result = await handleRelayEvent(state, event)
          relaySend(socket, ['OK', event?.id ?? '', true, result])
          break
        }
        case 'REQ':
          await handleSubscription(state, message[1], message.slice(2))
          break
        case 'CLOSE':
          state.subscriptions.delete(message[1])
          break
        default:
          relaySend(socket, ['NOTICE', 'unsupported: relay message type'])
        }
      } catch (error) {
        const type = message?.[0]
        if (type === 'REQ') relaySend(socket, ['CLOSED', message?.[1] ?? '', error.message])
        else if (type === 'EVENT' || type === 'AUTH') {
          relaySend(socket, ['OK', message?.[1]?.id ?? '', false, error.message])
        } else relaySend(socket, ['NOTICE', error.message])
      }
    })
  })

  function processPushJobs() {
    if (pushWorkerPromise) return pushWorkerPromise
    pushWorkerPromise = (async () => {
      for (const job of store.duePushJobs()) {
        const registration = store.registrationByKey(job.registrationKey)
        if (!registration) {
          await store.completePushJob(job.id)
          continue
        }
        try {
          const previewURL = job.previewToken
            ? new URL(`/v1/previews/${job.previewToken}`, config.publicBaseURL).toString()
            : null
          const result = await apnsClient.send(registration, previewURL)
          if (result.status === 200) {
            await store.completePushJob(job.id, { retainPreview: true })
            continue
          }
          if (result.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason)) {
            logger.warn?.('APNs rejected a device registration; removing it', {
              status: result.status,
              reason: result.reason,
              platform: registration.platform ?? 'ios',
              environment: registration.environment,
            })
            await store.removeRegistrationByKey(registration.key)
            continue
          }
          if (result.status === 403
              && ['ExpiredProviderToken', 'InvalidProviderToken'].includes(result.reason)
              && job.attempts < 8) {
            apnsClient.invalidateProviderToken?.()
            logger.warn?.('APNs provider authentication failed; refreshing and retrying', {
              status: result.status,
              reason: result.reason,
              platform: registration.platform ?? 'ios',
              environment: registration.environment,
            })
            await store.retryPushJob(job.id, { delaySeconds: 5 })
            continue
          }
          if ([429, 500, 503].includes(result.status) && job.attempts < 8) {
            logger.warn?.('APNs temporarily rejected a notification; retrying', {
              status: result.status,
              reason: result.reason,
              platform: registration.platform ?? 'ios',
              environment: registration.environment,
            })
            await store.retryPushJob(job.id, { delaySeconds: Math.min(2 ** job.attempts * 5, 15 * 60) })
            continue
          }
          logger.warn?.('APNs permanently rejected a notification', {
            status: result.status,
            reason: result.reason,
            platform: registration.platform ?? 'ios',
            environment: registration.environment,
          })
          await store.completePushJob(job.id)
        } catch (error) {
          logger.warn?.('APNs request failed', {
            error: error?.name ?? 'Error',
            retrying: job.attempts < 8,
            platform: registration.platform ?? 'ios',
            environment: registration.environment,
          })
          if (job.attempts < 8) {
            await store.retryPushJob(job.id, { delaySeconds: Math.min(2 ** job.attempts * 5, 15 * 60) })
          } else {
            await store.completePushJob(job.id)
          }
        }
      }
    })().catch((error) => {
      logger.error?.('APNs worker failed', { error: error?.name ?? 'Error' })
    }).finally(() => {
      pushWorkerPromise = null
    })
    return pushWorkerPromise
  }

  return {
    httpServer,
    async start(port = config.port) {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, '0.0.0.0', resolve)
      })
      pushTimer = setInterval(() => void processPushJobs(), 5_000)
      pushTimer.unref()
      void processPushJobs()
      logger.info('Taskify Push Relay is listening')
      return httpServer.address()
    },
    async stop() {
      for (const controller of watchPreferenceLookups) controller.abort()
      if (pushTimer) clearInterval(pushTimer)
      if (pushWorkerPromise) await pushWorkerPromise
      await Promise.allSettled([...watchForwardingTasks])
      for (const session of watchAuthSessions.values()) session.close?.()
      watchAuthSessions.clear()
      for (const state of sockets) state.socket.close()
      await new Promise((resolve) => httpServer.close(resolve))
      await store.flush?.()
    },
    processPushJobs,
  }
}
