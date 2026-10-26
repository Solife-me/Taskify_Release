import { APNsClient } from './apns.js'
import { loadConfig } from './config.js'
import { FCMClient, PushRouter } from './fcm.js'
import { WebPushClient } from './webpush.js'
import { createTaskifyPushServer } from './server.js'
import { RelayStore } from './store.js'

// Last line of defence: a stray rejection is logged by type only, never allowed to stop the relay.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason?.name ?? typeof reason)
})

const config = await loadConfig()
const store = new RelayStore({ dataDirectory: config.dataDirectory })
await store.load()
const apnsClient = new APNsClient(config.apns)
const fcmClient = config.fcm ? new FCMClient(config.fcm) : null
const webPushClient = config.webPush ? new WebPushClient(config.webPush) : null
const pushClient = new PushRouter({ apnsClient, fcmClient, webPushClient })
const server = createTaskifyPushServer({
  config,
  store,
  apnsClient,
  pushClient,
  androidPushEnabled: fcmClient !== null,
  webPushEnabled: webPushClient !== null,
})
await server.start()

async function shutdown() {
  await server.stop()
  // Folds the write-ahead log into the database, so the volume holds one complete file.
  store.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
