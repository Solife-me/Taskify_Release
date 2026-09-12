import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.4.1:10',
  releaseNotes: {
    en_US:
      'Restores rich iPhone notification previews: iPhone alerts again carry a short-lived, opaque preview link so the Taskify notification extension can fetch and decrypt the message on the device. Apple Watch alerts are unchanged.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
