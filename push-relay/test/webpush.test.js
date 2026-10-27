import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

import { PushRouter } from '../src/fcm.js'
import { createTaskifyPushServer } from '../src/server.js'
import { RelayStore } from '../src/store.js'
import {
  WebPushClient,
  WEB_PUSH_MESSAGE_PAYLOAD,
  encryptWebPushPayload,
  isPushServiceEndpoint,
  parseVAPIDKeys,
  parseWebPushSubscription,
  vapidAuthorization,
} from '../src/webpush.js'

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc:APA91b-Mixed_Case'

function vapidKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
    subject: 'mailto:push@solife.me',
  }
}

/// A browser's side of a subscription: its key pair and auth secret.
function browserSubscription(endpoint = ENDPOINT) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    ecdh,
    auth,
    json: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  }
}

const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/// RFC 8291 decryption, as the browser does it.
function decrypt(browser, body) {
  const salt = body.subarray(0, 16)
  const keyLength = body.readUInt8(20)
  const senderKey = body.subarray(21, 21 + keyLength)
  const ciphertext = body.subarray(21 + keyLength)
  const shared = browser.ecdh.computeSecret(senderKey)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), senderKey, Buffer.from([1])])
  const ikm = hmac(hmac(browser.auth, shared), keyInfo)
  const prk = hmac(salt, ikm)
  const key = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(ciphertext.subarray(-16))
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
  assert.equal(record.at(-1), 2)
  return record.subarray(0, -1).toString()
}

test('only the browsers\' push services are accepted as endpoints', () => {
  for (const ok of [
    ENDPOINT,
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QOx',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ]) assert.equal(isPushServiceEndpoint(ok), true, ok)
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com:8443/x',
    'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x',
    'https://169.254.169.254/latest',
    'not a url',
  ]) assert.equal(isPushServiceEndpoint(bad), false, bad)
})

test('subscriptions are checked before they are stored', () => {
  const { json } = browserSubscription()
  assert.deepEqual(parseWebPushSubscription(json), json)
  assert.throws(() => parseWebPushSubscription({ ...json, endpoint: 'https://evil.example/x' }), /endpoint/)
  assert.throws(() => parseWebPushSubscription({ ...json, keys: { ...json.keys, auth: 'AAAA' } }), /auth/)
  assert.throws(() => parseWebPushSubscription({ ...json, keys: { ...json.keys, p256dh: 'AAAA' } }), /key/)
})

test('the payload decrypts in the browser to the generic message alert', () => {
  const browser = browserSubscription()
  const body = encryptWebPushPayload(browser.json, WEB_PUSH_MESSAGE_PAYLOAD)
  assert.equal(body.readUInt32BE(16), 4096)
  assert.equal(decrypt(browser, body), '{"type":"message"}')
})

test('VAPID keys must match, and the authorization verifies with the public key', () => {
  const keys = vapidKeys()
  const vapid = parseVAPIDKeys(keys)
  assert.throws(() => parseVAPIDKeys({ ...keys, privateKey: vapidKeys().privateKey }), /does not match/)
  assert.throws(() => parseVAPIDKeys({ ...keys, subject: 'push@solife.me' }), /subject/)

  const header = vapidAuthorization(vapid, ENDPOINT, 1_800_000_000)
  const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)
  assert.equal(k, keys.publicKey)
  const [h, c, s] = token.split('.')
  const claims = JSON.parse(Buffer.from(c, 'base64url'))
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43_200, sub: 'mailto:push@solife.me' })
  const publicKey = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(keys.publicKey, 'base64url').subarray(1, 33).toString('base64url'),
      y: Buffer.from(keys.publicKey, 'base64url').subarray(33).toString('base64url'),
    },
  })
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true)
})

test('send maps push service answers to the relay\'s vocabulary', async () => {
  const browser = browserSubscription()
  const requests = []
  let status = 201
  const client = new WebPushClient(parseVAPIDKeys(vapidKeys()), {
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return { status, statusText: '', arrayBuffer: async () => new ArrayBuffer(0) }
    },
  })
  const registration = { platform: 'web', webPush: browser.json }
  assert.deepEqual(await client.send(registration), { status: 200 })
  assert.equal(requests[0].url, ENDPOINT)
  assert.equal(requests[0].init.headers['Content-Encoding'], 'aes128gcm')
  assert.equal(decrypt(browser, requests[0].init.body), WEB_PUSH_MESSAGE_PAYLOAD)
  status = 404
  assert.equal((await client.send(registration)).status, 410)
  status = 429
  assert.equal((await client.send(registration)).status, 429)
})

test('the router sends web registrations through Web Push', async () => {
  const sent = []
  const router = new PushRouter({
    apnsClient: { send: async () => { sent.push('apns'); return { status: 200 } } },
    webPushClient: { send: async () => { sent.push('web'); return { status: 200 } } },
  })
  await router.send({ platform: 'web' })
  await router.send({ platform: 'ios' })
  assert.deepEqual(sent, ['web', 'apns'])
  await assert.rejects(new PushRouter({ apnsClient: {} }).send({ platform: 'web' }), /No push service/)
})

function signedRequest(secretKey, urlPath, body, method = 'PUT') {
  const event = finalizeEvent({
    kind: 27_235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', `https://push.solife.me${urlPath}`], ['method', method], ['payload', createHash('sha256').update(body).digest('hex')]],
    content: '',
  }, secretKey)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function startServer(t, webPushEnabled) {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-push-web-'))
  const store = new RelayStore({ dataDirectory: directory })
  await store.load()
  const sent = []
  const server = createTaskifyPushServer({
    config: { port: 0, publicBaseURL: 'https://push.solife.me', publicRelayURL: 'wss://push.solife.me' },
    store,
    apnsClient: { send: async () => ({ status: 200 }) },
    pushClient: { send: async (registration, previewURL) => { sent.push({ registration, previewURL }); return { status: 200 } } },
    webPushEnabled,
    logger: { info() {}, warn() {} },
  })
  const address = await server.start(0)
  t.after(() => server.stop())
  return { store, server, port: address.port, sent }
}

async function registerWeb(port, secretKey, subscription) {
  const urlPath = '/v1/registrations/web-0b7d1c2e'
  const body = JSON.stringify({ platform: 'web', application: 'taskify', subscription })
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'PUT',
    headers: { authorization: signedRequest(secretKey, urlPath, body), 'content-type': 'application/json' },
    body,
  })
}

test('web registrations are refused until Web Push is configured', async (t) => {
  const { port } = await startServer(t, false)
  const response = await registerWeb(port, generateSecretKey(), browserSubscription().json)
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /not configured/)
})

test('a web registration stores its subscription and gets a generic alert without a preview', async (t) => {
  const { store, server, port, sent } = await startServer(t, true)
  const recipientKey = generateSecretKey()
  const recipient = getPublicKey(recipientKey)
  const { json } = browserSubscription()
  const response = await registerWeb(port, recipientKey, json)
  assert.equal(response.status, 200)
  const [registration] = store.registrationsFor(recipient)
  assert.equal(registration.platform, 'web')
  assert.equal(registration.deviceToken, ENDPOINT)
  assert.deepEqual(registration.webPush, json)

  const wrap = finalizeEvent({
    kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', recipient]], content: 'opaque',
  }, generateSecretKey())
  await store.putGiftWrap(wrap, { notify: true })
  await server.processPushJobs()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].registration.platform, 'web')
  assert.equal(sent[0].previewURL, null)
})

test('a web registration must point at a push service', async (t) => {
  const { port } = await startServer(t, true)
  const response = await registerWeb(port, generateSecretKey(), browserSubscription('https://evil.example/x').json)
  assert.equal(response.status, 400)
})
