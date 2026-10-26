import { readFile } from 'node:fs/promises'

import { parseServiceAccount } from './fcm.js'
import { parseVAPIDKeys } from './webpush.js'

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value.trim()
}

export async function loadConfig(environment = process.env) {
  let fileConfig = {}
  if (environment.APNS_CONFIG_PATH) {
    fileConfig = JSON.parse(await readFile(environment.APNS_CONFIG_PATH, 'utf8'))
  }
  const apns = {
    teamID: required(environment.APNS_TEAM_ID ?? fileConfig.teamID, 'APNS_TEAM_ID'),
    keyID: required(environment.APNS_KEY_ID ?? fileConfig.keyID, 'APNS_KEY_ID'),
    privateKey: required(environment.APNS_PRIVATE_KEY ?? fileConfig.privateKey, 'APNS_PRIVATE_KEY'),
    topic: required(environment.APNS_TOPIC ?? fileConfig.topic ?? 'solife.me.Taskify.Native', 'APNS_TOPIC'),
    watchTopic: required(
      environment.APNS_WATCH_TOPIC
        ?? fileConfig.watchTopic
        ?? 'solife.me.Taskify.Native.watchkitapp',
      'APNS_WATCH_TOPIC',
    ),
    macTopic: required(
      environment.APNS_MAC_TOPIC
        ?? fileConfig.macTopic
        ?? 'solife.me.Taskify.Mac',
      'APNS_MAC_TOPIC',
    ),
    snapstrTopic: required(
      environment.APNS_SNAPSTR_TOPIC
        ?? fileConfig.snapstrTopic
        ?? 'app.snapstr.ios',
      'APNS_SNAPSTR_TOPIC',
    ),
  }
  if (!/^[A-Z0-9]{10}$/.test(apns.teamID)) throw new Error('APNS_TEAM_ID must be a 10-character Apple Team ID')
  if (!/^[A-Z0-9]{10}$/.test(apns.keyID)) throw new Error('APNS_KEY_ID must be a 10-character Apple Key ID')
  if (!apns.privateKey.includes('BEGIN PRIVATE KEY')) throw new Error('APNS_PRIVATE_KEY must contain the .p8 key')
  return {
    port: Number(environment.PORT ?? 8080),
    dataDirectory: environment.DATA_DIR ?? '/data',
    publicBaseURL: environment.PUBLIC_BASE_URL ?? 'https://push.solife.me',
    publicRelayURL: environment.PUBLIC_RELAY_URL ?? 'wss://push.solife.me',
    // iPhone builds from 2026-10 sign preview fetches; older ones do not. Set to "true" once
    // those are gone, so a leaked preview URL is useless without the recipient's key.
    requireSignedPreviews: environment.REQUIRE_SIGNED_PREVIEWS === 'true',
    // The header a trusted proxy puts the client's address in (Cloudflare: cf-connecting-ip).
    // Set it only when the proxy is the sole way in: a client that reaches the port directly
    // could otherwise choose its own address.
    clientAddressHeader: environment.CLIENT_ADDRESS_HEADER?.trim() || null,
    apns,
    // Optional: Android (Snapstr) push through Firebase Cloud Messaging.
    fcm: await loadFCMConfig(environment, fileConfig),
    // Optional: chat alerts for the Taskify web app. The key pair must be the Taskify Worker's,
    // since each browser holds one push subscription, made with that public key.
    webPush: loadWebPushConfig(environment, fileConfig),
  }
}

function loadWebPushConfig(environment, fileConfig) {
  const value = {
    publicKey: environment.WEB_PUSH_VAPID_PUBLIC_KEY ?? fileConfig.webPush?.publicKey,
    privateKey: environment.WEB_PUSH_VAPID_PRIVATE_KEY ?? fileConfig.webPush?.privateKey,
    subject: environment.WEB_PUSH_VAPID_SUBJECT ?? fileConfig.webPush?.subject,
  }
  if (!value.publicKey && !value.privateKey) return null
  return parseVAPIDKeys(value)
}

async function loadFCMConfig(environment, fileConfig) {
  let value = environment.FCM_SERVICE_ACCOUNT ?? fileConfig.fcmServiceAccount ?? null
  if (!value && environment.FCM_SERVICE_ACCOUNT_PATH) {
    value = await readFile(environment.FCM_SERVICE_ACCOUNT_PATH, 'utf8')
  }
  if (typeof value === 'string' && value.trim() === '') return null
  return value ? parseServiceAccount(value) : null
}
