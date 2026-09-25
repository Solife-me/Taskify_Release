import { randomBytes } from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import { WebSocket } from 'ws'

const AUTH_KIND = 22_242

function isPrivateIPv4(address) {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return true
  const [a, b] = octets
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
}

function isPrivateIPv6(address) {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('ff')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized)) return true
  // Block reserved/documentation/transition ranges as forwarding targets. In particular, 6to4
  // and NAT64 literals can encode a private IPv4 destination that is not visible to net.isIP().
  if (normalized.startsWith('64:ff9b:')
      || normalized.startsWith('100:')
      || normalized.startsWith('2001:db8:')
      || normalized.startsWith('2002:')) return true
  if (/^::[0-9a-f]/.test(normalized)) return true
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    return net.isIP(mapped) !== 4 || isPrivateIPv4(mapped)
  }
  return false
}

export function isPublicIPAddress(address) {
  const family = net.isIP(address)
  if (family === 4) return !isPrivateIPv4(address)
  if (family === 6) return !isPrivateIPv6(address)
  return false
}

export function normalizeRelayTargets(values, maximum = 16) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('At least one relay target is required')
  }
  if (values.length > maximum) throw new Error('Relay target limit exceeded')
  const seen = new Set()
  return values.map((value) => {
    if (typeof value !== 'string') throw new Error('Relay target is invalid')
    let url
    try {
      url = new URL(value.trim())
    } catch {
      throw new Error('Relay target is invalid')
    }
    if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password) {
      throw new Error('Relay targets must be public wss URLs without credentials')
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new Error('Relay target host is not public')
    }
    if (net.isIP(hostname) && !isPublicIPAddress(hostname)) {
      throw new Error('Relay target host is not public')
    }
    url.hash = ''
    const normalized = url.toString().replace(/\/$/, '')
    if (seen.has(normalized)) throw new Error('Relay targets must be unique')
    seen.add(normalized)
    return normalized
  })
}

async function pinnedAddress(relayURL) {
  const url = new URL(relayURL)
  const literalFamily = net.isIP(url.hostname.replace(/^\[|\]$/g, ''))
  const addresses = literalFamily
    ? [{ address: url.hostname.replace(/^\[|\]$/g, ''), family: literalFamily }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIPAddress(address))) {
    throw new Error('Relay target resolved to a non-public address')
  }
  return addresses[0]
}

/// Node 20 and earlier generally used the legacy `dns.lookup` callback shape for WebSocket
/// connections, while Node 22 enables `autoSelectFamily` and requests `options.all`. Returning a
/// single address to that newer contract produces `ERR_INVALID_IP_ADDRESS` before the TLS socket
/// is opened. Keep the SSRF-safe, prevalidated DNS pin while honoring both callback shapes.
export function pinnedLookup(pinned) {
  return (_hostname, options, callback) => {
    if (options && typeof options === 'object' && options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }])
      return
    }
    callback(null, pinned.address, pinned.family)
  }
}



function frameEvent(socket, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const onMessage = (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!predicate(frame)) return
      cleanup()
      resolve(frame)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('Relay connection closed'))
    }
    const onError = () => {
      cleanup()
      reject(new Error('Relay connection failed'))
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
    timer = setTimeout(() => {
      cleanup()
      reject(new Error('Relay acknowledgement timed out'))
    }, timeoutMs)
  })
}

function waitForOpen(socket, timeoutMs) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay connection timed out')), timeoutMs)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', () => {
      clearTimeout(timer)
      reject(new Error('Relay connection failed'))
    })
  })
}

async function waitForInitialAuth(socket, milliseconds = 150) {
  return new Promise((resolve) => {
    const finish = (challenge = null) => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(challenge)
    }
    const onMessage = (data) => {
      try {
        const frame = JSON.parse(data.toString())
        if (frame[0] === 'AUTH' && typeof frame[1] === 'string' && frame[1].length <= 512) {
          finish(frame[1])
        }
      } catch {}
    }
    const timer = setTimeout(() => finish(), milliseconds)
    socket.on('message', onMessage)
  })
}

async function sendEventAndWait(socket, event, timeoutMs) {
  const acknowledgement = frameEvent(
    socket,
    (frame) => frame[0] === 'OK' && frame[1] === event.id,
    timeoutMs,
  )
  socket.send(JSON.stringify(['EVENT', event]))
  const frame = await acknowledgement
  return {
    // NIP-01 acceptance is the boolean, not the human-readable message.
    accepted: frame[2] === true,
    message: typeof frame[3] === 'string' ? frame[3].slice(0, 256) : null,
  }
}

/// Some NIP-42 relays advertise AUTH immediately after WebSocket connection, while others wait
/// until the first restricted EVENT and then send an `auth-required` rejection followed by the
/// challenge. The initial short grace period handles the first form; this race handles the
/// second without losing the live socket needed to complete authorization.
export function sendEventOrAuthAndWait(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer
    let authRejectionMessage = null
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const succeed = (value) => {
      cleanup()
      resolve(value)
    }
    const fail = (message) => {
      cleanup()
      reject(new Error(message))
    }
    const onMessage = (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!Array.isArray(frame)) return
      if (frame[0] === 'AUTH'
          && typeof frame[1] === 'string'
          && frame[1].length <= 512) {
        succeed({ authRequired: true, challenge: frame[1] })
        return
      }
      if (frame[0] !== 'OK' || frame[1] !== event.id) return
      const accepted = frame[2] === true
      const message = typeof frame[3] === 'string' ? frame[3].slice(0, 256) : null
      if (!accepted && /auth-required/i.test(message ?? '')) {
        // Keep listening for the corresponding AUTH frame instead of closing the only socket on
        // which the challenge is valid.
        authRejectionMessage = message
        return
      }
      succeed({ authRequired: false, accepted, message })
    }
    const onClose = () => fail(authRejectionMessage ?? 'Relay connection closed')
    const onError = () => fail('Relay connection failed')
    socket.on('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
    timer = setTimeout(
      () => fail(authRejectionMessage ?? 'Relay acknowledgement timed out'),
      timeoutMs,
    )
    socket.send(JSON.stringify(['EVENT', event]))
  })
}

function authorizationSession(socket, event, challenge, timeoutMs) {
  return {
    outcome: 'auth-required',
    challenge,
    authorize: async (authEvent) => {
      if (authEvent?.kind !== AUTH_KIND) throw new Error('Invalid NIP-42 authorization event')
      const authAcknowledgement = frameEvent(
        socket,
        (frame) => frame[0] === 'OK' && frame[1] === authEvent.id,
        timeoutMs,
      )
      socket.send(JSON.stringify(['AUTH', authEvent]))
      const authFrame = await authAcknowledgement
      if (authFrame[2] !== true) {
        throw new Error(typeof authFrame[3] === 'string' ? authFrame[3] : 'Relay authentication failed')
      }
      const result = await sendEventAndWait(socket, event, timeoutMs)
      socket.close()
      return result
    },
    close: () => socket.close(),
  }
}

function queryAuthorizationSession(socket, filter, maximumEvents, challenge, timeoutMs, requireEOSE) {
  return {
    outcome: 'auth-required', challenge,
    authorize: async authEvent => {
      const acknowledgement = frameEvent(socket,
        frame => frame[0] === 'OK' && frame[1] === authEvent.id, timeoutMs)
      socket.send(JSON.stringify(['AUTH', authEvent]))
      const frame = await acknowledgement
      if (frame[2] !== true) throw new Error('Relay authentication rejected')
      const events = await queryEventsAndWait(socket, filter, maximumEvents, timeoutMs, requireEOSE)
      return { accepted: true, events }
    },
    close: () => socket.close(),
  }
}

export function queryEventsAndWait(socket, filter, maximumEvents, timeoutMs, requireEOSE = false, allowAuth = false) {
  const subscriptionID = `taskify-cache-${randomBytes(12).toString('hex')}`
  return new Promise((resolve, reject) => {
    const events = new Map()
    let finished = false
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const finish = () => {
      if (finished) return
      finished = true
      cleanup()
      try { socket.send(JSON.stringify(['CLOSE', subscriptionID])) } catch {}
      resolve(Array.from(events.values()))
    }
    const fail = (message) => {
      if (finished) return
      finished = true
      cleanup()
      reject(new Error(message))
    }
    const onMessage = (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!Array.isArray(frame)) return
      if (allowAuth && frame[0] === 'AUTH' && typeof frame[1] === 'string' && frame[1].length <= 512) {
        if (finished) return
        finished = true
        cleanup()
        try { socket.send(JSON.stringify(['CLOSE', subscriptionID])) } catch {}
        resolve(queryAuthorizationSession(socket, filter, maximumEvents, frame[1], timeoutMs, requireEOSE))
        return
      }
      if (frame[0] === 'EVENT' && frame[1] === subscriptionID && frame[2]?.id) {
        events.set(frame[2].id, frame[2])
        if (requireEOSE && events.size > maximumEvents) {
          fail('Relay query result limit exceeded')
        } else if (!requireEOSE && events.size >= maximumEvents) {
          finish()
        }
        return
      }
      if (frame[0] === 'EOSE' && frame[1] === subscriptionID) {
        finish()
        return
      }
      if (frame[0] === 'CLOSED' && frame[1] === subscriptionID) {
        if (allowAuth && String(frame[2]).startsWith('auth-required:')) return
        fail(typeof frame[2] === 'string' ? frame[2] : 'Relay query was closed')
      }
    }
    const onClose = () => fail('Relay connection closed')
    const onError = () => fail('Relay connection failed')
    socket.on('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
    timer = setTimeout(() => fail('Relay query timed out'), timeoutMs)
    socket.send(JSON.stringify(['REQ', subscriptionID, filter]))
  })
}

// DNS itself may outlive cancellation, but its result must never open a late socket.
function untilAborted(operation, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Relay query cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
    if (signal.aborted) onAbort()
  })
}

export class NostrRelayForwarder {
  constructor({ connectionTimeoutMs = 5_000, acknowledgementTimeoutMs = 8_000 } = {}) {
    this.connectionTimeoutMs = connectionTimeoutMs
    this.acknowledgementTimeoutMs = acknowledgementTimeoutMs
  }

  async publish(relayURL, event) {
    const pinned = await pinnedAddress(relayURL)
    const socket = new WebSocket(relayURL, {
      handshakeTimeout: this.connectionTimeoutMs,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
      lookup: pinnedLookup(pinned),
    })
    // Capture challenges even if they arrive in the same read as the upgrade response.
    // Ordinary relays no longer pay a fixed 150 ms AUTH grace period before every EVENT.
    let initialChallenge = null
    const captureChallenge = (data) => {
      try {
        const frame = JSON.parse(data.toString())
        if (frame[0] === 'AUTH' && typeof frame[1] === 'string' && frame[1].length <= 512) {
          initialChallenge = frame[1]
        }
      } catch {}
    }
    socket.on('message', captureChallenge)
    try {
      await waitForOpen(socket, this.connectionTimeoutMs)
      socket.off('message', captureChallenge)
      if (initialChallenge) {
        return authorizationSession(socket, event, initialChallenge, this.acknowledgementTimeoutMs)
      }
      const result = await sendEventOrAuthAndWait(
        socket,
        event,
        this.acknowledgementTimeoutMs,
      )
      if (result.authRequired) {
        return authorizationSession(
          socket,
          event,
          result.challenge,
          this.acknowledgementTimeoutMs,
        )
      }
      socket.close()
      return { outcome: result.accepted ? 'accepted' : 'rejected', message: result.message }
    } catch (error) {
      socket.off('message', captureChallenge)
      socket.close()
      throw error
    }
  }

  /// Performs a bounded public Nostr read on behalf of the Watch cache. The caller constructs
  /// the filter; this transport still applies the same DNS pinning and private-address rejection
  /// as publishing so a supplied relay URL cannot turn the service into an SSRF primitive.
  async query(relayURL, filter, maximumEvents = 1_000, options = {}) {
    const boundedMaximum = Math.max(1, Math.min(1_000, maximumEvents))
    const signals = [options.signal, options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : null]
      .filter(Boolean)
    const signal = signals.length ? AbortSignal.any(signals) : null
    signal?.throwIfAborted()
    const pinned = signal
      ? await untilAborted(pinnedAddress(relayURL), signal)
      : await pinnedAddress(relayURL)
    signal?.throwIfAborted()
    const socket = new WebSocket(relayURL, {
      handshakeTimeout: this.connectionTimeoutMs,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
      lookup: pinnedLookup(pinned),
    })
    let initialChallenge = null
    const captureChallenge = data => {
      try {
        const frame = JSON.parse(data.toString())
        if (frame[0] === 'AUTH' && typeof frame[1] === 'string' && frame[1].length <= 512) initialChallenge = frame[1]
      } catch {}
    }
    if (options.allowAuth) socket.on('message', captureChallenge)
    const onAbort = () => socket.terminate()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await waitForOpen(socket, this.connectionTimeoutMs)
      socket.off('message', captureChallenge)
      if (options.allowAuth && initialChallenge) {
        return queryAuthorizationSession(socket, filter, boundedMaximum, initialChallenge,
          this.acknowledgementTimeoutMs, options.requireEOSE === true)
      }
      const events = await queryEventsAndWait(
        socket,
        filter,
        boundedMaximum,
        this.acknowledgementTimeoutMs,
        options.requireEOSE === true,
        options.allowAuth === true,
      )
      if (events?.outcome !== 'auth-required') socket.close()
      return events
    } catch (error) {
      socket.close()
      throw error
    } finally {
      socket.off('message', captureChallenge)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
