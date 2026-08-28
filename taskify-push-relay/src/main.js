import { APNsClient } from './apns.js'
import { loadConfig } from './config.js'
import { createTaskifyPushServer } from './server.js'
import { RelayStore } from './store.js'

const config = await loadConfig()
const store = new RelayStore({ dataDirectory: config.dataDirectory })
await store.load()
const apnsClient = new APNsClient(config.apns)
const server = createTaskifyPushServer({ config, store, apnsClient })
await server.start()

async function shutdown() {
  await server.stop()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
