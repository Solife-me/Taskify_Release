import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const configureActionURL = new URL(
  '../startos/actions/configureAPNs.ts',
  import.meta.url,
)

test('StartOS APNs action accepts PEM text without the broken file-upload value', async () => {
  const source = await readFile(configureActionURL, 'utf8')

  assert.match(source, /privateKey:\s*Value\.text\(\{/)
  assert.match(source, /masked:\s*true/)
  assert.doesNotMatch(source, /privateKeyFile:\s*Value\.file\(/)
  assert.doesNotMatch(source, /input\.privateKeyFile\.path/)
})

test('StartOS APNs action migrates old config to an independently editable Mac topic', async () => {
  const source = await readFile(configureActionURL, 'utf8')
  const model = await readFile(new URL('../startos/fileModels/apns.json.ts', import.meta.url), 'utf8')

  assert.match(model, /macTopic:\s*z\.string\(\)\.optional\(\)/)
  assert.match(source, /macTopic:\s*Value\.text\(\{/)
  assert.match(source, /current\.macTopic\s*\?\?\s*'solife\.me\.Taskify\.Mac'/)
  assert.match(source, /macTopic,\s*\n\s*snapstrTopic,/)
})
