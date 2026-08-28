import { i18n } from './i18n'
import { sdk } from './sdk'
import { apnsConfigPath, dataDirectory, relayPort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Taskify Push Relay'))
  const subcontainer = await sdk.SubContainer.of(
    effects,
    { imageId: 'main' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'main',
      subpath: null,
      mountpoint: dataDirectory,
      readonly: false,
    }),
    'taskify-push-relay',
  )

  return sdk.Daemons.of(effects).addDaemon('relay', {
    subcontainer,
    exec: {
      command: ['node', 'src/main.js'],
      cwd: '/app',
      env: {
        NODE_ENV: 'production',
        PORT: String(relayPort),
        DATA_DIR: dataDirectory,
        APNS_CONFIG_PATH: apnsConfigPath,
        PUBLIC_BASE_URL: 'https://push.solife.me',
        PUBLIC_RELAY_URL: 'wss://push.solife.me',
      },
      sigtermTimeout: 30_000,
    },
    ready: {
      display: i18n('Push Relay'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, relayPort, {
          successMessage: i18n('Taskify Push Relay is listening'),
          errorMessage: i18n('Waiting for Taskify Push Relay'),
        }),
      gracePeriod: 15_000,
    },
    requires: [],
  })
})
