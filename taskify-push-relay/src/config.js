import { readFile } from 'node:fs/promises'

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
  }
  if (!/^[A-Z0-9]{10}$/.test(apns.teamID)) throw new Error('APNS_TEAM_ID must be a 10-character Apple Team ID')
  if (!/^[A-Z0-9]{10}$/.test(apns.keyID)) throw new Error('APNS_KEY_ID must be a 10-character Apple Key ID')
  if (!apns.privateKey.includes('BEGIN PRIVATE KEY')) throw new Error('APNS_PRIVATE_KEY must contain the .p8 key')
  return {
    port: Number(environment.PORT ?? 8080),
    dataDirectory: environment.DATA_DIR ?? '/data',
    publicBaseURL: environment.PUBLIC_BASE_URL ?? 'https://push.solife.me',
    publicRelayURL: environment.PUBLIC_RELAY_URL ?? 'wss://push.solife.me',
    apns,
  }
}
