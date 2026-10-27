import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

import { FCMClient, PushRouter, fcmMessage, parseServiceAccount } from '../src/fcm.js'
import { createTaskifyPushServer } from '../src/server.js'
import { RelayStore } from '../src/store.js'

const FCM_TOKEN = 'dQw4w9WgXcQ:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqx_Mixed-Case_Token-Value'

function serviceAccount() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    project_id: 'snapstr-test',
    client_email: 'push@snapstr-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('the service account is read from Firebase JSON', () => {
  const parsed = parseServiceAccount(JSON.stringify(serviceAccount()))
  assert.equal(parsed.projectID, 'snapstr-test')
  assert.throws(() => parseServiceAccount({ project_id: 'x' }), /client_email/)
})

test('an Android message is data only and names nothing but the preview', () => {
  const message = fcmMessage({ deviceToken: FCM_TOKEN }, 'https://push.solife.me/v1/previews/abc')
  assert.deepEqual(message.message.data, { type: 'message-preview', previewURL: 'https://push.solife.me/v1/previews/abc' })
  assert.equal(message.message.notification, undefined)
  assert.equal(message.message.android.priority, 'HIGH')
  assert.equal(message.message.token, FCM_TOKEN)
})

test('FCM signs in once, sends, and reports answers the way APNs does', async () => {
  const calls = []
  const answers = [
    jsonResponse(200, { access_token: 'token-1', expires_in: 3600 }),
    jsonResponse(200, { name: 'projects/snapstr-test/messages/1' }),
    jsonResponse(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
    jsonResponse(401, { error: { status: 'UNAUTHENTICATED' } }),
    jsonResponse(503, { error: { status: 'UNAVAILABLE' } }),
  ]
  const account = parseServiceAccount(serviceAccount())
  const client = new FCMClient({
    ...account,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return answers.shift()
    },
  })
  const registration = { deviceToken: FCM_TOKEN, platform: 'android' }
  assert.deepEqual(await client.send(registration, null), { status: 200, reason: null })
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token')
  assert.match(calls[1].url, /\/v1\/projects\/snapstr-test\/messages:send$/)
  assert.equal(calls[1].options.headers.authorization, 'Bearer token-1')
  assert.deepEqual(await client.send(registration, null), { status: 410, reason: 'Unregistered' })
  assert.equal(calls.length, 3, 'the access token is reused')
  assert.deepEqual(await client.send(registration, null), { status: 403, reason: 'ExpiredProviderToken' })
  assert.equal((await client.send(registration, null)).status, 503)
})

test('the router sends Android through FCM and everything else through APNs', async () => {
  const sent = []
  const router = new PushRouter({
    apnsClient: { send: async (registration) => { sent.push(['apns', registration.platform]); return { status: 200 } } },
    fcmClient: { send: async (registration) => { sent.push(['fcm', registration.platform]); return { status: 200 } } },
  })
  await router.send({ platform: 'ios' })
  await router.send({ platform: 'android' })
  await router.send({})
  assert.deepEqual(sent, [['apns', 'ios'], ['fcm', 'android'], ['apns', undefined]])
  await assert.rejects(new PushRouter({ apnsClient: {} }).send({ platform: 'android' }), /No push service/)
})

function signedRequest(secretKey, path, body, method = 'PUT') {
  const url = `https://push.solife.me${path}`
  const event = finalizeEvent({
    kind: 27_235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method], ['payload', createHash('sha256').update(body).digest('hex')]],
    content: '',
  }, secretKey)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function startServer(t, androidPushEnabled) {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-push-fcm-'))
  const store = new RelayStore({ dataDirectory: directory })
  await store.load()
  const sent = []
  const server = createTaskifyPushServer({
    config: { port: 0, publicBaseURL: 'https://push.solife.me', publicRelayURL: 'wss://push.solife.me' },
    store,
    apnsClient: { send: async () => ({ status: 200 }) },
    pushClient: { send: async (registration, previewURL) => { sent.push({ registration, previewURL }); return { status: 200 } } },
    androidPushEnabled,
    logger: { info() {}, warn() {} },
  })
  const address = await server.start(0)
  t.after(() => server.stop())
  return { store, server, port: address.port, sent }
}

async function registerAndroid(port, secretKey, token = FCM_TOKEN) {
  const path = '/v1/registrations/android-install-1'
  const body = JSON.stringify({ deviceToken: token, platform: 'android', application: 'snapstr' })
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: { authorization: signedRequest(secretKey, path, body), 'content-type': 'application/json' },
    body,
  })
}

test('Android registrations are refused until FCM is configured', async (t) => {
  const { port } = await startServer(t, false)
  const response = await registerAndroid(port, generateSecretKey())
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /not configured/)
})

test('an Android registration keeps its token exactly and is pushed through the router', async (t) => {
  const { store, server, port, sent } = await startServer(t, true)
  const recipientKey = generateSecretKey()
  const recipient = getPublicKey(recipientKey)
  const response = await registerAndroid(port, recipientKey)
  assert.equal(response.status, 200)
  const [registration] = store.registrationsFor(recipient)
  assert.equal(registration.deviceToken, FCM_TOKEN)
  assert.equal(registration.platform, 'android')
  assert.equal(registration.application, 'snapstr')

  const wrap = finalizeEvent({
    kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', recipient]], content: 'opaque',
  }, generateSecretKey())
  await store.putGiftWrap(wrap, { notify: true, application: 'snapstr' })
  await server.processPushJobs()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].registration.platform, 'android')
  assert.match(sent[0].previewURL, /^https:\/\/push\.solife\.me\/v1\/previews\//)
})

test('Android registrations must be Snapstr and carry a valid FCM token', async (t) => {
  const { port } = await startServer(t, true)
  const response = await registerAndroid(port, generateSecretKey(), 'not a token!')
  assert.equal(response.status, 400)
})
