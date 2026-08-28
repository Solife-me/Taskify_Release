import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v_0_4_1_1 = VersionInfo.of({
  version: '0.4.1:1',
  releaseNotes: {
    en_US:
      'Fixes APNs key configuration on StartOS 0.4.1 by accepting the private key through a masked text field instead of the incompatible file-upload control.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
