import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadConfig } from '../src/config.js'

const credentials = {
  APNS_TEAM_ID: 'ABCDEFGHIJ',
  APNS_KEY_ID: 'KLMNOPQRST',
  APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
}

test('hosted APNs config has a backward-compatible independent Mac topic', async () => {
  const defaultConfig = await loadConfig(credentials)
  assert.equal(defaultConfig.apns.macTopic, 'solife.me.Taskify.Mac')

  const overridden = await loadConfig({
    ...credentials,
    APNS_MAC_TOPIC: 'me.example.Taskify.Mac',
  })
  assert.equal(overridden.apns.macTopic, 'me.example.Taskify.Mac')
})

test('an existing APNs config file gains the Mac default and can override it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskify-apns-config-'))
  const file = path.join(directory, 'apns.json')
  const base = {
    teamID: credentials.APNS_TEAM_ID,
    keyID: credentials.APNS_KEY_ID,
    privateKey: credentials.APNS_PRIVATE_KEY,
    topic: 'me.example.Taskify.Native',
  }
  await writeFile(file, JSON.stringify(base))
  assert.equal((await loadConfig({ APNS_CONFIG_PATH: file })).apns.macTopic, 'solife.me.Taskify.Mac')

  await writeFile(file, JSON.stringify({ ...base, macTopic: 'me.example.Taskify.Mac' }))
  assert.equal((await loadConfig({ APNS_CONFIG_PATH: file })).apns.macTopic, 'me.example.Taskify.Mac')
})
