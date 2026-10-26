import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

import { NIP98ReplayGuard, verifyNip98Request } from '../src/auth.js'

function bodyHash(body) {
  return createHash('sha256').update(body).digest('hex')
}

function authHeader({ body, method = 'PUT', now = 1_700_000_000, path = '/v1/registrations/device-1' }) {
  const secretKey = generateSecretKey()
  const url = `https://push.solife.me${path}`
  const event = finalizeEvent(
    {
      kind: 27_235,
      created_at: now,
      tags: [
        ['u', url],
        ['method', method],
        ['payload', bodyHash(body)],
      ],
      content: '',
    },
    secretKey,
  )
  return {
    event,
    header: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
    pubkey: getPublicKey(secretKey),
    url,
  }
}

test('accepts a fresh NIP-98 request bound to method, URL, and payload', () => {
  const body = Buffer.from('{"deviceToken":"aa"}')
  const auth = authHeader({ body })
  const result = verifyNip98Request({
    authorization: auth.header,
    method: 'PUT',
    expectedURL: auth.url,
    body,
    nowSeconds: 1_700_000_010,
    replayGuard: new NIP98ReplayGuard(),
  })

  assert.equal(result.pubkey, auth.pubkey)
  assert.equal(result.event.id, auth.event.id)
})

test('rejects payload substitution and replay', () => {
  const body = Buffer.from('{"deviceToken":"aa"}')
  const auth = authHeader({ body })
  const replayGuard = new NIP98ReplayGuard()
  const verify = (requestBody) =>
    verifyNip98Request({
      authorization: auth.header,
      method: 'PUT',
      expectedURL: auth.url,
      body: requestBody,
      nowSeconds: 1_700_000_010,
      replayGuard,
    })

  assert.throws(() => verify(Buffer.from('{"deviceToken":"bb"}')), /payload/i)
  verify(body)
  assert.throws(() => verify(body), /replay/i)
})

test('rejects stale, wrong-method, and wrong-origin NIP-98 events', () => {
  const body = Buffer.from('{}')
  const auth = authHeader({ body })
  const base = {
    authorization: auth.header,
    body,
    replayGuard: new NIP98ReplayGuard(),
  }

  assert.throws(
    () => verifyNip98Request({ ...base, method: 'DELETE', expectedURL: auth.url, nowSeconds: 1_700_000_010 }),
    /method/i,
  )
  assert.throws(
    () => verifyNip98Request({ ...base, method: 'PUT', expectedURL: 'https://evil.example/v1/registrations/device-1', nowSeconds: 1_700_000_010 }),
    /url/i,
  )
  assert.throws(
    () => verifyNip98Request({ ...base, method: 'PUT', expectedURL: auth.url, nowSeconds: 1_700_000_500 }),
    /fresh/i,
  )
})
