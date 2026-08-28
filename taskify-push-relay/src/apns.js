import { createPrivateKey, sign } from 'node:crypto'
import http2 from 'node:http2'

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

export function genericDMPayload(previewURL) {
  return {
    aps: {
      alert: {
        title: 'New Message',
        body: 'Open Taskify to view it.',
      },
      'content-available': 1,
      'mutable-content': 1,
    },
    taskify: { type: 'dm-preview', previewURL },
  }
}

export class APNsClient {
  constructor({ teamID, keyID, privateKey, topic, requestTimeoutMs = 10_000, now = () => Date.now() }) {
    this.teamID = teamID
    this.keyID = keyID
    this.privateKey = createPrivateKey(privateKey.replaceAll('\\n', '\n'))
    this.topic = topic
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

  async send(registration, previewURL) {
    const authority = registration.environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com'
    const body = Buffer.from(JSON.stringify(genericDMPayload(previewURL)))
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
        'apns-topic': this.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
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
