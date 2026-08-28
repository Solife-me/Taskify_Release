import { createPrivateKey } from 'node:crypto'
import { chmod } from 'node:fs/promises'

import { apnsConfigJson } from '../fileModels/apns.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

const { InputSpec, Value } = sdk
const tenCharacterAppleID = [
  {
    regex: '^[A-Z0-9]{10}$',
    description:
      'Must be the 10-character identifier shown by Apple Developer.',
  },
]

const inputSpec = InputSpec.of({
  teamID: Value.text({
    name: i18n('Apple Team ID'),
    description: i18n(
      'The 10-character Team ID from Apple Developer membership details.',
    ),
    default: null,
    required: true,
    patterns: tenCharacterAppleID,
  }),
  keyID: Value.text({
    name: i18n('APNs Key ID'),
    description: i18n(
      'The 10-character Key ID for the uploaded APNs authentication key.',
    ),
    default: null,
    required: true,
    patterns: tenCharacterAppleID,
  }),
  privateKey: Value.text({
    name: i18n('APNs .p8 Private Key'),
    description: i18n(
      'Open the downloaded .p8 file in a text editor and paste its complete contents.',
    ),
    default: null,
    required: true,
    masked: true,
    minLength: 100,
    maxLength: 4096,
    placeholder: 'Paste the complete AuthKey_XXXXXXXXXX.p8 contents',
  }),
  topic: Value.text({
    name: i18n('App Bundle ID'),
    description: i18n(
      'The APNs topic. It must match the signed Taskify app bundle identifier.',
    ),
    default: 'solife.me.Taskify.Native',
    required: true,
    patterns: [
      {
        regex: '^[A-Za-z0-9.-]+$',
        description: 'Must be a valid Apple bundle identifier.',
      },
    ],
  }),
})

export const configureAPNs = sdk.Action.withInput(
  'configure-apns',
  {
    name: i18n('Configure Apple Push'),
    description: i18n(
      'Store the APNs provider credentials used for content-free wake delivery.',
    ),
    warning: i18n(
      'The pasted private key is sensitive. Keep your StartOS account and backups secure.',
    ),
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  },
  inputSpec,
  async () => {
    const current = await apnsConfigJson.read().once()
    if (!current) return { topic: 'solife.me.Taskify.Native' }
    return {
      teamID: current.teamID,
      keyID: current.keyID,
      topic: current.topic,
    }
  },
  async ({ effects, input }) => {
    const teamID = input.teamID.trim().toUpperCase()
    const keyID = input.keyID.trim().toUpperCase()
    const topic = input.topic.trim()
    const privateKey = normalizePrivateKey(input.privateKey)
    createPrivateKey(privateKey)
    await apnsConfigJson.write(effects, { teamID, keyID, privateKey, topic })
    await chmod(apnsConfigJson.path, 0o600)
  },
)

function normalizePrivateKey(value: string): string {
  const match = value
    .trim()
    .match(
      /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PRIVATE KEY-----$/,
    )
  if (!match) {
    throw new Error(
      'Paste the complete APNs .p8 key, including its BEGIN and END PRIVATE KEY lines.',
    )
  }

  const body = match[1].replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g)
  if (!lines?.length) {
    throw new Error('The pasted APNs .p8 private key is empty.')
  }

  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}
