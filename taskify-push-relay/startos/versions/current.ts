import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.4.1:11',
  releaseNotes: {
    en_US:
      'Hardens the relay: a malformed request can no longer stop the service; alerts to a device are merged and spaced at least 10 seconds apart so a burst of messages cannot flood it; unauthenticated connections are refused before any signature work; inbox-preference lookups must name the accounts they want; and a failed save no longer blocks later ones.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
