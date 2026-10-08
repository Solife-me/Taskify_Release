import { APNsClient } from './apns.js'
import { loadConfig } from './config.js'
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
const server = createTaskifyPushServer({ config, store, apnsClient })
await server.start()

async function shutdown() {
  await server.stop()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
