import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.5.1:0',
  releaseNotes: {
    en_US: `**Web app chat alerts**

- The Taskify web app can now turn on chat alerts with this relay. Browsers were refused before the request was sent, because the relay did not answer their cross-origin checks.
- The relay's public information document can now be read from web pages, as the Nostr relay information standard requires.
- Chat alerts in the web app also need the Configure Web Push action, run with the same key pair as the Taskify Worker.

**Updating from before 0.5.0**

- The first start imports the relay's data into its SQLite database, which can take a minute or more. This cannot be undone by installing an older version.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
