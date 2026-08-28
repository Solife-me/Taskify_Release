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

const MAX_HTTP_BODY_BYTES = 32 * 1024
const INSTALLATION_ID = /^[A-Za-z0-9._:-]{1,128}$/
const DEVICE_TOKEN = /^[0-9a-fA-F]{32,200}$/
const PUBLIC_KEY = /^[0-9a-f]{64}$/

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

export function createTaskifyPushServer({ config, store, apnsClient, logger = console }) {
  const replayGuard = new NIP98ReplayGuard()
  const publishLimiter = new SlidingWindowRateLimiter()
  const sockets = new Set()
  let pushTimer = null
  let pushWorkerActive = false

  async function handleRegistrationRequest(request, response, url) {
    const match = /^\/v1\/registrations\/([^/]+)$/.exec(url.pathname)
    if (!match || !['PUT', 'DELETE'].includes(request.method)) return false
    const installationID = decodeURIComponent(match[1])
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
      await store.putRegistration(auth.pubkey, installationID, payload)
      sendJSON(response, 200, {
        enabled: true,
        remainingRegistrations: store.registrationsFor(auth.pubkey).length,
      })
    } catch (error) {
      const status = /authorization|NIP-98|replay/i.test(error.message) ? 401 : 400
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
    if (request.method === 'GET' && url.pathname === '/') {
      sendJSON(response, 200, {
        name: 'Taskify Push Relay',
        description: 'NIP-17 inbox relay with privacy-preserving APNs wake delivery',
        pubkey: '',
        contact: 'https://solife.me',
        supported_nips: [1, 9, 11, 17, 42, 59, 98],
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
    const matching = events.filter((event) => filters.some((filter) => matchesFilter(event, filter)))
    for (const event of matching.slice(-boundedLimit(filters))) relaySend(state.socket, ['EVENT', subscriptionID, event])
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

  async function processPushJobs() {
    if (pushWorkerActive) return
    pushWorkerActive = true
    try {
      for (const job of store.duePushJobs()) {
        const registration = store.registrationByKey(job.registrationKey)
        if (!registration) {
          await store.completePushJob(job.id)
          continue
        }
        try {
          const previewURL = new URL(`/v1/previews/${job.previewToken}`, config.publicBaseURL).toString()
          const result = await apnsClient.send(registration, previewURL)
          if (result.status === 200) {
            await store.completePushJob(job.id, { retainPreview: true })
            continue
          }
          if (result.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason)) {
            await store.removeRegistrationByKey(registration.key)
            continue
          }
          if ([429, 500, 503].includes(result.status) && job.attempts < 8) {
            await store.retryPushJob(job.id, { delaySeconds: Math.min(2 ** job.attempts * 5, 15 * 60) })
            continue
          }
          await store.completePushJob(job.id)
        } catch {
          if (job.attempts < 8) {
            await store.retryPushJob(job.id, { delaySeconds: Math.min(2 ** job.attempts * 5, 15 * 60) })
          } else {
            await store.completePushJob(job.id)
          }
        }
      }
    } finally {
      pushWorkerActive = false
    }
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
      if (pushTimer) clearInterval(pushTimer)
      for (const state of sockets) state.socket.close()
      await new Promise((resolve) => httpServer.close(resolve))
    },
    processPushJobs,
  }
}
