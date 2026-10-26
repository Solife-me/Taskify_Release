import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto'

// Web Push (RFC 8030) for the Taskify web app, with an RFC 8291 encrypted payload and RFC 8292
// VAPID authentication. A browser keeps one push subscription per app, created with the Taskify
// Worker's VAPID public key for reminders, so this relay signs with the same key pair.

const RECORD_SIZE = 4096
const REQUEST_TIMEOUT_MS = 10_000
const JWT_LIFETIME_SECONDS = 12 * 60 * 60

// The browsers' push services. Endpoints anywhere else are refused, so a registration cannot
// make the relay send requests to an arbitrary host.
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
]

function base64urlDecode(value) {
  return Buffer.from(value, 'base64url')
}

export function isPushServiceEndpoint(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/// The subscription a browser hands the app (`PushSubscription.toJSON()`), checked.
export function parseWebPushSubscription(value) {
  const endpoint = value?.endpoint
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !isPushServiceEndpoint(endpoint)) {
    throw new Error('Invalid Web Push endpoint')
  }
  const p256dh = typeof value?.keys?.p256dh === 'string' ? base64urlDecode(value.keys.p256dh) : null
  const auth = typeof value?.keys?.auth === 'string' ? base64urlDecode(value.keys.auth) : null
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04) throw new Error('Invalid Web Push key')
  if (!auth || auth.length !== 16) throw new Error('Invalid Web Push auth secret')
  return { endpoint, keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') } }
}

/// VAPID keys as `web-push generate-vapid-keys` prints them: base64url public point and private scalar.
export function parseVAPIDKeys({ publicKey, privateKey, subject }) {
  const publicBytes = base64urlDecode(String(publicKey ?? '').trim())
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error('The Web Push VAPID public key must be an uncompressed P-256 point (base64url)')
  }
  const privateText = String(privateKey ?? '').trim()
  let key
  if (privateText.includes('BEGIN')) {
    key = createPrivateKey(privateText)
  } else {
    const scalar = base64urlDecode(privateText)
    if (scalar.length !== 32) throw new Error('The Web Push VAPID private key must be 32 bytes (base64url)')
    key = createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: scalar.toString('base64url'),
        x: publicBytes.subarray(1, 33).toString('base64url'),
        y: publicBytes.subarray(33, 65).toString('base64url'),
      },
    })
  }
  // The private key must belong to the public key the browsers subscribed with. Derive it from
  // the private scalar: a JWK's own x and y are not checked against d.
  const scalar = base64urlDecode(key.export({ format: 'jwk' }).d)
  const derived = createECDH('prime256v1')
  derived.setPrivateKey(scalar)
  if (!derived.getPublicKey().equals(publicBytes)) {
    throw new Error('The Web Push VAPID private key does not match the public key')
  }
  const normalizedSubject = String(subject ?? '').trim()
  if (!/^(mailto:|https:\/\/)/.test(normalizedSubject)) {
    throw new Error('The Web Push VAPID subject must be a mailto: or https:// URL')
  }
  return { publicKey: publicBytes.toString('base64url'), privateKey: key, subject: normalizedSubject }
}

export function vapidAuthorization(vapid, endpoint, now = Math.floor(Date.now() / 1000)) {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: now + JWT_LIFETIME_SECONDS,
    sub: vapid.subject,
  })).toString('base64url')
  const signingInput = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(signingInput), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${signingInput}.${signature.toString('base64url')}, k=${vapid.publicKey}`
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

/// RFC 8291 `aes128gcm` encryption of `plaintext` for one subscription, as a single record.
export function encryptWebPushPayload(subscription, plaintext, { salt = randomBytes(16), ecdh = null } = {}) {
  const receiverKey = base64urlDecode(subscription.keys.p256dh)
  const authSecret = base64urlDecode(subscription.keys.auth)
  const sender = ecdh ?? createECDH('prime256v1')
  if (!ecdh) sender.generateKeys()
  const senderKey = sender.getPublicKey()
  const sharedSecret = sender.computeSecret(receiverKey)

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverKey, senderKey, Buffer.from([1])])
  const ikm = hmac(hmac(authSecret, sharedSecret), keyInfo)
  const prk = hmac(salt, ikm)
  const contentKey = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)

  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])
  if (record.length + 16 > RECORD_SIZE) throw new Error('Web Push payload is too large')
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(senderKey.length, 20)
  return Buffer.concat([header, senderKey, ciphertext])
}

/// The alert names no sender, conversation, or event: the web app shows a generic "new message"
/// notification and reads the inbox itself once opened.
export const WEB_PUSH_MESSAGE_PAYLOAD = JSON.stringify({ type: 'message' })

export class WebPushClient {
  constructor(vapid, { fetchImpl = globalThis.fetch } = {}) {
    this.vapid = vapid
    this.fetch = fetchImpl
  }

  /// Returns `{ status, reason }` in the relay's push vocabulary: 200 when accepted, 410 when the
  /// subscription is gone (the registration is then removed), otherwise the push service status.
  async send(registration) {
    const subscription = registration.webPush
    if (!subscription?.endpoint) return { status: 410, reason: 'Unregistered' }
    const response = await this.fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(this.vapid, subscription.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 60 * 60),
        Urgency: 'high',
      },
      body: encryptWebPushPayload(subscription, WEB_PUSH_MESSAGE_PAYLOAD),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    await response.arrayBuffer().catch(() => {})
    if (response.status >= 200 && response.status < 300) return { status: 200 }
    if (response.status === 404 || response.status === 410) return { status: 410, reason: 'Unregistered' }
    return { status: response.status, reason: response.statusText || undefined }
  }
}
