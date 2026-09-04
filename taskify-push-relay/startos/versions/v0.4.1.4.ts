import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v_0_4_1_4 = VersionInfo.of({
  version: '0.4.1:4',
  releaseNotes: {
    en_US:
      'Adds a privacy-scoped Apple Watch task and board gateway. The relay gathers and deduplicates only explicitly subscribed encrypted board events, while verification and decryption remain on-device and Taskify remains the availability fallback.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
