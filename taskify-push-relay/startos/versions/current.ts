import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.5.0:0',
  releaseNotes: {
    en_US: `**Storage**

- The relay now keeps its data in a SQLite database instead of one JSON file it rewrote after every message. Each message costs about the same however much is stored, and memory no longer grows with the stored data.
- The first start after updating imports the existing data. With a full relay this can take a minute or more on slower hardware, and the relay shows as starting until it is done. The old file is kept beside the database as \`state.json.imported\`.
- This update cannot be undone by installing an older version.

**Alerts**

- The relay keeps one connection open to Apple's push service instead of opening one per alert.
- Alerts that all read the same now replace one another on the device instead of piling up. An iPhone alert with a message preview still shows each message.
- An alert that cannot be delivered within a day is dropped instead of arriving late.

**Security**

- The relay now runs as an unprivileged user instead of root.
- Pins the Node.js runtime to 22.23.4 for the October 2026 Node.js and eMudhra certificate fixes, if 0.4.1:18 was not installed.
- Built with StartOS SDK 3.1.0.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
