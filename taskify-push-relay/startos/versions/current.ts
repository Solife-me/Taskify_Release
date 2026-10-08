import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.4.1:15',
  releaseNotes: {
    en_US:
      'Accepts signed NIP-09 kind-5 deletion requests and removes only referenced events authored by the same key, including any pending alert or preview for a deleted gift wrap. Routes alerts by the sending app: when one account uses both Taskify and Snapstr, a Snapstr message alerts only Snapstr and a Taskify message only Taskify. Includes Snapstr notification delivery alongside Taskify with application-scoped registration, a separate APNs bundle topic, and opaque on-device rich previews; existing registrations remain Taskify-compatible. Several Snapstr profiles on one phone now all stay registered and are all alerted; registering one no longer unregisters the others, while Taskify keeps one account per installation. Also retains the relay hardening for bounded storage, traffic, Watch forwarding, preview access, and stale registrations. Repackages the service with StartOS SDK 3 for StartOS 0.4.0.2 and newer.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
