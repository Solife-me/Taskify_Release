import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.4.1:9',
  releaseNotes: {
    en_US:
      'Speeds up Watch chat delivery: the gateway now resolves recipient inbox-relay preferences for the Watch, can respond before all relay forwards complete while continuing them in the background, and no longer delays publishes with a fixed authentication grace period.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
