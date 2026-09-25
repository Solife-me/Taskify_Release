# Cross-Device App State Sync

Per-account state that isn't board or task data syncs between every client signed in with the
same key (PWA, iOS, macOS) as encrypted, self-addressed events. Tasks, including scripture
memory review tasks, sync separately as board events.

| Record | d-tag | Contents |
|---|---|---|
| Bible reading tracker | `taskify-bible-tracker` | `{version: 1, timestamp, baseTimestamp, bibleTracker}` |
| Scripture memory list | `taskify-scripture-memory` | `{version: 1, timestamp, baseTimestamp, scriptureMemory}` |
| Chat state | `taskify-chat-state` | `{version: 1, timestamp, readThrough, inboxResponses}` |

Every record is a kind-30078 replaceable event authored by the user, tagged
`["d", <d-tag>]` and `["client", "taskify.app"]`, with content NIP-44 v2 encrypted to the author's
own key. Relays keep only the latest event per d-tag, so relay storage stays at three events per
account.

## Merge rules

The rules live in `taskify-core/src/appStateSync.ts` (PWA) and
`taskify-ios-native/Sources/TaskifyCore/State/AppStateSync.swift` (native). They must stay
identical: `AppStateSyncTests.testScriptureMergeMatchesPWA` and `testBibleMergeMatchesPWA`
compare the Swift output with the TypeScript output for the same fixture.

**Bible tracker and scripture memory** merge three ways against the last state this device
agreed on with the others (its *base*). Neither device's edits are lost, and a removal is
honored rather than undone:

- Chapters, verse selections, archive entries and passages added on either side are kept.
  Ones removed on one side while unchanged on the other are dropped.
- A passage edited on both sides keeps the copy with more reviews (then the latest review,
  higher stage, latest scheduling). A passage edited on one side and deleted on the other keeps
  the edit.
- If one device reset the tracker, the newer reading cycle wins and the older cycle survives in
  the merged archive.
- Tie-breaks are symmetric, so two devices merging each other's copies converge.
- `baseTimestamp` is the timestamp of the synced state the sender last merged with, or `0` if
  the sender has never synced (a fresh install, or relays unreachable on its first pull). A `0`
  payload merges without a base, so gaps in a fresh device's copy are never read as deletions.
  Older PWA builds omit the field and merge as before.
- The PWA's `expandedBooks` is a per-device UI flag. It is not published, compared or merged,
  so expanding a book never publishes and each device keeps its own.

**Chat state** only moves forward, so it merges without a base:

- `readThrough` maps a conversation key (lowercased peer pubkey or group id) to the Unix second
  it has been read through. The higher value wins.
- `inboxResponses` maps a shared item's gift-wrap event id to `{status, at}` with status
  `accepted | declined | tentative | deleted` (Dismiss is `deleted`). The later response wins.
  Applying one only marks the local item answered. The accepting device already added the
  task, contact or board, and that reaches other devices through its own sync.
- Published state keeps the newest 1,000 entries of each map, from the last 180 days.
- Shared tasks, contacts, boards and calendar invites all key their response by wrap id. The
  PWA stores a calendar invite once per calendar address and remembers every wrap it arrived
  in, so it publishes the response under each of those ids and matches a remote one on any.
  Invites received before this existed have no stored wrap id and don't sync.
- An invite accepted (or marked maybe) on another device is added to this device's calendar
  too, locally, as accepting here would. The RSVP itself was already sent by the device that
  answered.

## Cadence

- **PWA**: live subscription per d-tag. Bible tracker and scripture memory publish 1.5 s after
  the last change. Chat state publishes 15 s after the first unpublished change, and early when
  the tab is hidden.
- **Native**: one REQ per relay fetches all three records on launch and on foreground, at most
  every 30 s. Publishes go through the durable outbox (scope `__taskify-app-state__`), which
  replaces a pending publish for the same record. Bible tracker and scripture memory publish
  2 s after the last change. Chat state publishes 15 s after the first unpublished change, and
  immediately on backgrounding.
- Neither client publishes when the relays already hold everything it has. For chat state this
  check is cheap enough to run on every read marker.

## Scripture memory review tasks

Review tasks are ordinary recurring tasks in series `scripture-memory`. Every occurrence,
including the first one a device creates when none is active, has id
`recurrence:scripture-memory:<local YYYY-MM-DD>`, so two devices never create duplicates. Native
reads and writes the PWA's `scriptureMemoryEnabled`, `scriptureMemoryBoardId` and
`scriptureMemoryFrequency` through the encrypted account backup. Both clients then place and
schedule review tasks the same way instead of repeatedly moving each other's tasks.
