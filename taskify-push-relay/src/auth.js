import { createHash } from 'node:crypto'
import { verifyEvent } from 'nostr-tools'

const NIP98_KIND = 27_235
const DEFAULT_MAX_AGE_SECONDS = 60

function tagValue(event, name) {
  const matches = event.tags.filter((tag) => Array.isArray(tag) && tag.length >= 2 && tag[0] === name)
  if (matches.length !== 1) throw new Error(`NIP-98 ${name} tag is missing or duplicated`)
  return matches[0][1]
}

function decodeAuthorization(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Nostr ')) {
    throw new Error('NIP-98 authorization is required')
  }
  let event
  try {
    event = JSON.parse(Buffer.from(authorization.slice('Nostr '.length), 'base64').toString('utf8'))
  } catch {
    throw new Error('NIP-98 authorization is malformed')
  }
  return event
}

function sha256Hex(body) {
  return createHash('sha256').update(body).digest('hex')
}

export class NIP98ReplayGuard {
  constructor({ maxEntries = 10_000 } = {}) {
    this.maxEntries = maxEntries
    this.entries = new Map()
  }

  consume(eventID, expiresAt, nowSeconds) {
    for (const [id, expiry] of this.entries) {
      if (expiry < nowSeconds) this.entries.delete(id)
    }
    if (this.entries.has(eventID)) throw new Error('NIP-98 replay rejected')
    this.entries.set(eventID, expiresAt)
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value)
    }
  }
}

export function verifyNip98Request({
  authorization,
  method,
  expectedURL,
  body = Buffer.alloc(0),
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  replayGuard,
}) {
  const event = decodeAuthorization(authorization)
  if (event.kind !== NIP98_KIND || !verifyEvent(event)) {
    throw new Error('NIP-98 signature is invalid')
  }
  if (!Number.isInteger(event.created_at) || Math.abs(nowSeconds - event.created_at) > maxAgeSeconds) {
    throw new Error('NIP-98 authorization is not fresh')
  }
  if (tagValue(event, 'u') !== expectedURL) throw new Error('NIP-98 URL does not match this request')
  if (tagValue(event, 'method').toUpperCase() !== method.toUpperCase()) {
    throw new Error('NIP-98 method does not match this request')
  }
  if (tagValue(event, 'payload').toLowerCase() !== sha256Hex(body)) {
    throw new Error('NIP-98 payload does not match this request')
  }
  replayGuard?.consume(event.id, event.created_at + maxAgeSeconds, nowSeconds)
  return { event, pubkey: event.pubkey.toLowerCase() }
}
