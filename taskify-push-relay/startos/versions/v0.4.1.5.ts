import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v_0_4_1_5 = VersionInfo.of({
  version: '0.4.1:5',
  releaseNotes: {
    en_US:
      'Fixes Apple Watch direct and group messages appearing locally without reaching recipients by restoring upstream relay forwarding on the StartOS Node runtime.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
