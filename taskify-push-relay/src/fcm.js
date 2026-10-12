import { createPrivateKey, sign } from 'node:crypto'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

/// The service account JSON Firebase issues, from the environment or the config file.
export function parseServiceAccount(value) {
  const account = typeof value === 'string' ? JSON.parse(value) : value
  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (typeof account?.[field] !== 'string' || account[field].trim() === '') {
      throw new Error(`The Firebase service account is missing ${field}`)
    }
  }
  if (!account.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('The Firebase service account private key is invalid')
  }
  return {
    projectID: account.project_id,
    clientEmail: account.client_email,
    privateKey: account.private_key,
  }
}

// Android gets a data-only, high-priority message: Snapstr's messaging service wakes, fetches the
// preview with the recipient's own signature, decrypts it on the phone, and shows the alert
// itself. Like the iPhone alert, it names no sender, recipient, event, or category. Without a
// preview the app shows a generic alert and syncs.
export function fcmMessage(registration, previewURL = null) {
  const data = { type: 'message-preview' }
  if (previewURL) data.previewURL = previewURL
  return {
    message: {
      token: registration.deviceToken,
      data,
      android: {
        priority: 'HIGH',
        // A preview lasts about as long as the gift wrap is worth alerting for.
        ttl: '86400s',
      },
    },
  }
}

/// Sends through FCM's HTTP v1 API. Answers are reported the way APNs reports them, so the push
/// worker treats both alike: 410 for a token that no longer exists, 403 with an expired provider
/// token when the OAuth token must be fetched again, and 429 or 5xx to retry.
export class FCMClient {
  constructor({
    projectID,
    clientEmail,
    privateKey,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 10_000,
    now = () => Date.now(),
  }) {
    this.projectID = projectID
    this.clientEmail = clientEmail
    this.privateKey = createPrivateKey(privateKey.replaceAll('\\n', '\n'))
    this.fetch = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.now = now
    this.cachedToken = null
  }

  assertion() {
    const issuedAt = Math.floor(this.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64url(JSON.stringify({
      iss: this.clientEmail,
      scope: MESSAGING_SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    }))
    const signingInput = `${header}.${claims}`
    const signature = sign('sha256', Buffer.from(signingInput), this.privateKey).toString('base64url')
    return `${signingInput}.${signature}`
  }

  async accessToken() {
    const nowSeconds = Math.floor(this.now() / 1000)
    if (this.cachedToken && this.cachedToken.expiresAt - nowSeconds > 5 * 60) return this.cachedToken.value
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.assertion(),
      }).toString(),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new Error(`Firebase sign-in failed (${response.status})`)
    }
    this.cachedToken = { value: body.access_token, expiresAt: nowSeconds + Number(body.expires_in ?? 3_600) }
    return this.cachedToken.value
  }

  invalidateProviderToken() {
    this.cachedToken = null
  }

  async send(registration, previewURL = null) {
    const token = await this.accessToken()
    const response = await this.fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectID)}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(fcmMessage(registration, previewURL)),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      },
    )
    if (response.ok) return { status: 200, reason: null }
    const body = await response.json().catch(() => ({}))
    const errorCode = body?.error?.details?.find?.((detail) => detail?.errorCode)?.errorCode
      ?? body?.error?.status
      ?? null
    if (response.status === 404 || errorCode === 'UNREGISTERED') return { status: 410, reason: 'Unregistered' }
    if (errorCode === 'INVALID_ARGUMENT' && response.status === 400) return { status: 400, reason: 'BadDeviceToken' }
    if (errorCode === 'SENDER_ID_MISMATCH') return { status: 400, reason: 'DeviceTokenNotForTopic' }
    if (response.status === 401) return { status: 403, reason: 'ExpiredProviderToken' }
    return { status: response.status, reason: errorCode }
  }
}

/// Picks the push service for a registration.
export class PushRouter {
  constructor({ apnsClient, fcmClient = null }) {
    this.apnsClient = apnsClient
    this.fcmClient = fcmClient
  }

  clientFor(registration) {
    return registration.platform === 'android' ? this.fcmClient : this.apnsClient
  }

  async send(registration, previewURL = null) {
    const client = this.clientFor(registration)
    if (!client) throw new Error('No push service is configured for this platform')
    return client.send(registration, previewURL)
  }

  invalidateProviderToken(registration) {
    this.clientFor(registration)?.invalidateProviderToken?.()
  }
}
