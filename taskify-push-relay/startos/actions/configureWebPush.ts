import { createECDH, createPrivateKey } from 'node:crypto'
import { chmod } from 'node:fs/promises'

import { apnsConfigJson } from '../fileModels/apns.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  publicKey: Value.text({
    name: i18n('VAPID Public Key'),
    description: i18n(
      'The Worker VAPID_PUBLIC_KEY (base64url). Browsers subscribe with this key, so it must be the same one.',
    ),
    default: null,
    required: false,
    maxLength: 256,
  }),
  privateKey: Value.text({
    name: i18n('VAPID Private Key'),
    description: i18n('The Worker VAPID_PRIVATE_KEY: base64url or PEM.'),
    default: null,
    required: false,
    masked: true,
    maxLength: 4096,
  }),
  subject: Value.text({
    name: i18n('VAPID Subject'),
    description: i18n(
      'A mailto: or https:// contact for push services, usually the Worker VAPID_SUBJECT.',
    ),
    default: null,
    required: false,
    maxLength: 256,
    placeholder: 'mailto:you@example.com',
  }),
})

function base64url(value: string): Buffer {
  return Buffer.from(value.trim(), 'base64url')
}

/// Stored beside the APNs credentials, which the relay already reads at start. The relay checks
/// the pair again when it starts; this catches a mismatched paste before then.
export const configureWebPush = sdk.Action.withInput(
  'configure-web-push',
  {
    name: i18n('Configure Web Push'),
    description: i18n(
      'Store the Taskify Worker VAPID key pair so the Taskify web app gets chat alerts. Leave the private key blank to turn web push off.',
    ),
    warning: i18n(
      'The pasted private key is sensitive. Keep your StartOS account and backups secure.',
    ),
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  },
  inputSpec,
  async () => ({}),
  async ({ effects, input }) => {
    const current = await apnsConfigJson.read().once()
    if (!current) {
      throw new Error('Configure Apple Push first; web push is stored with it.')
    }
    const privateKey = input.privateKey?.trim() ?? ''
    if (privateKey === '') {
      const { webPush: _removed, ...rest } = current as typeof current & {
        webPush?: unknown
      }
      await apnsConfigJson.write(effects, rest)
    } else {
      const publicKey = input.publicKey?.trim() ?? ''
      const subject = input.subject?.trim() ?? ''
      const publicBytes = base64url(publicKey)
      if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
        throw new Error(
          'The VAPID public key must be an uncompressed P-256 point.',
        )
      }
      const scalar = privateKey.includes('BEGIN')
        ? Buffer.from(
            createPrivateKey(privateKey).export({ format: 'jwk' }).d ?? '',
            'base64url',
          )
        : base64url(privateKey)
      const derived = createECDH('prime256v1')
      derived.setPrivateKey(scalar)
      if (!derived.getPublicKey().equals(publicBytes)) {
        throw new Error('The VAPID private key does not match the public key.')
      }
      if (!/^(mailto:|https:\/\/)/.test(subject)) {
        throw new Error(
          'The VAPID subject must start with mailto: or https://.',
        )
      }
      await apnsConfigJson.write(effects, {
        ...current,
        webPush: { publicKey, privateKey, subject },
      })
    }
    await chmod(apnsConfigJson.path, 0o600)
  },
)
