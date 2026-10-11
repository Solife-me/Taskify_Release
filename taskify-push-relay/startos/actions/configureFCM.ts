import { createPrivateKey } from 'node:crypto'
import { chmod } from 'node:fs/promises'

import { apnsConfigJson } from '../fileModels/apns.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  serviceAccount: Value.text({
    name: i18n('Firebase Service Account JSON'),
    description: i18n(
      'In the Firebase console, open Project settings, Service accounts, and Generate new private key. Paste the complete downloaded JSON file.',
    ),
    default: null,
    required: false,
    masked: true,
    maxLength: 16384,
    placeholder: '{ "type": "service_account", "project_id": … }',
  }),
})

/// Stored beside the APNs credentials, which the relay already reads at start.
export const configureFCM = sdk.Action.withInput(
  'configure-fcm',
  {
    name: i18n('Configure Android Push'),
    description: i18n(
      'Store the Firebase service account used to wake Snapstr on Android. Leave blank to turn Android push off.',
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
      throw new Error(
        'Configure Apple Push first; Android push is stored with it.',
      )
    }
    const text = input.serviceAccount?.trim() ?? ''
    if (text === '') {
      const { fcmServiceAccount: _removed, ...rest } =
        current as typeof current & { fcmServiceAccount?: unknown }
      await apnsConfigJson.write(effects, rest)
    } else {
      const account = JSON.parse(text)
      for (const field of ['project_id', 'client_email', 'private_key']) {
        if (
          typeof account[field] !== 'string' ||
          account[field].trim() === ''
        ) {
          throw new Error(`The service account JSON is missing ${field}.`)
        }
      }
      createPrivateKey(account.private_key)
      await apnsConfigJson.write(effects, {
        ...current,
        fcmServiceAccount: {
          type: 'service_account',
          project_id: account.project_id,
          client_email: account.client_email,
          private_key: account.private_key,
        },
      })
    }
    await chmod(apnsConfigJson.path, 0o600)
  },
)
