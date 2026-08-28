import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.4.1:2',
  releaseNotes: {
    en_US:
      'Adds privacy-preserving rich notification previews. Taskify decrypts messages and activity on the iPhone, while verified ecash receipts show their redeemed amount and open Wallet.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
