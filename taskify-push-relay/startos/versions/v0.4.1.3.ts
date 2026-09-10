import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v_0_4_1_3 = VersionInfo.of({
  version: '0.4.1:3',
  releaseNotes: {
    en_US:
      'Adds independent Apple Watch direct and group chat delivery, a Watch-supplied relay forwarding gateway, metadata-free Watch APNs wakes, and separate iPhone and Watch APNs topics.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
