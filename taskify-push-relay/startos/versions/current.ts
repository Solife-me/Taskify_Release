import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.4.1:18',
  releaseNotes: {
    en_US:
      'Adds chat alerts for the Taskify web app through Web Push: set the Taskify Worker VAPID key pair with the new Configure Web Push action. Browsers registered here get a generic, encrypted "new message" alert naming no sender or conversation; only browser push services are accepted as endpoints. Adds Android push for Snapstr through Firebase Cloud Messaging: set it with the new Configure Android Push action. Android devices get a data-only wake carrying only the one-time preview link, and decrypt the alert on the phone. Accepts signed NIP-09 kind-5 deletion requests and removes only referenced events authored by the same key, including any pending alert or preview for a deleted gift wrap. Routes alerts by the sending app: when one account uses both Taskify and Snapstr, a Snapstr message alerts only Snapstr and a Taskify message only Taskify. Includes Snapstr notification delivery alongside Taskify with application-scoped registration, a separate APNs bundle topic, and opaque on-device rich previews; existing registrations remain Taskify-compatible. Several Snapstr profiles on one phone now all stay registered and are all alerted; registering one no longer unregisters the others, while Taskify keeps one account per installation. Also retains the relay hardening for bounded storage, traffic, Watch forwarding, preview access, and stale registrations. Repackages the service with StartOS SDK 3 for StartOS 0.4.0.2 and newer.' +
      ' Security update: pins the Node.js runtime to 22.23.4 and refreshes the container CA bundle for the October 2026 Node.js and eMudhra fixes.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
