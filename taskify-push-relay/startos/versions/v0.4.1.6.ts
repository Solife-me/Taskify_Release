import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v_0_4_1_6 = VersionInfo.of({
  version: '0.4.1:6',
  releaseNotes: {
    en_US:
      'Improves Apple Watch message delivery to recipient inbox relays that issue NIP-42 authentication challenges only after the first publish attempt.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
