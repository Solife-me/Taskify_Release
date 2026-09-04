import { createPrivateKey, sign } from 'node:crypto'
import http2 from 'node:http2'

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

// Keep the phone and Watch payloads byte-for-byte equivalent (apart from their APNs topics).
// Apple can then route one generic notification to the best available device. The encrypted
// gift wrap remains on Taskify's relay and is decrypted only after the app refreshes locally.
export function genericDMPayload() {
  return {
    aps: {
      alert: {
        title: 'New Message',
        body: 'Open Taskify to view it.',
      },
      sound: 'default',
      'content-available': 1,
    },
    taskify: { type: 'dm-preview' },
  }
}

// Retain a named Watch builder so callers and tests make the platform intent explicit. A generic
// alert is substantially more reliable than a background-only wake, while content-available still
// gives watchOS an opportunity to refresh the encrypted inbox before the user opens the app.
export function genericWatchDMPayload() {
  return genericDMPayload()
}

export function apnsDeliveryProfile(registration, { topic, watchTopic }) {
  const isWatch = registration.platform === 'watchos'
  return {
    payload: isWatch ? genericWatchDMPayload() : genericDMPayload(),
    topic: isWatch ? watchTopic : topic,
    pushType: 'alert',
    priority: '10',
  }
}

export class APNsClient {
  constructor({
    teamID,
    keyID,
    privateKey,
    topic,
    watchTopic = 'solife.me.Taskify.Native.watchkitapp',
    requestTimeoutMs = 10_000,
    now = () => Date.now(),
  }) {
    this.teamID = teamID
    this.keyID = keyID
    this.privateKey = createPrivateKey(privateKey.replaceAll('\\n', '\n'))
    this.topic = topic
    this.watchTopic = watchTopic
    this.requestTimeoutMs = requestTimeoutMs
    this.now = now
    this.cachedToken = null
  }

  providerToken() {
    const nowSeconds = Math.floor(this.now() / 1000)
    if (this.cachedToken && nowSeconds - this.cachedToken.issuedAt < 50 * 60) {
      return this.cachedToken.value
    }
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.keyID }))
    const claims = base64url(JSON.stringify({ iss: this.teamID, iat: nowSeconds }))
    const signingInput = `${header}.${claims}`
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    const value = `${signingInput}.${signature}`
    this.cachedToken = { issuedAt: nowSeconds, value }
    return value
  }

  invalidateProviderToken() {
    this.cachedToken = null
  }

  async send(registration) {
    const authority = registration.environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com'
    const delivery = apnsDeliveryProfile(registration, {
      topic: this.topic,
      watchTopic: this.watchTopic,
    })
    const body = Buffer.from(JSON.stringify(delivery.payload))
    const client = http2.connect(authority)
    return new Promise((resolve, reject) => {
      let settled = false
      let status = 0
      let timeout = null
      const chunks = []
      const finish = (callback) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        client.close()
        callback()
      }
      client.once('error', (error) => finish(() => reject(error)))
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${registration.deviceToken}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': delivery.topic,
        'apns-push-type': delivery.pushType,
        'apns-priority': delivery.priority,
        'content-type': 'application/json',
        'content-length': String(body.length),
      })
      request.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0)
      })
      request.on('data', (chunk) => chunks.push(chunk))
      request.once('error', (error) => finish(() => reject(error)))
      request.once('end', () => {
        let reason = null
        try {
          reason = JSON.parse(Buffer.concat(chunks).toString('utf8')).reason ?? null
        } catch {}
        finish(() => resolve({ status, reason }))
      })
      timeout = setTimeout(() => {
        request.close(http2.constants.NGHTTP2_CANCEL)
        finish(() => reject(new Error('APNs request timed out')))
      }, this.requestTimeoutMs)
      request.end(body)
    })
  }
}
