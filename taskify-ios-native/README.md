# Taskify Native iOS

This is the clean native SwiftUI replacement for the current `taskify-ios/` WebView release app. The PWA is the behavior and visual reference. The WebView app remains untouched until the native parity gates are complete.

## Current runnable slice

- Native SwiftUI shell matching the PWA's dark glass appearance
- Boards, Upcoming, Wallet, Chat, and Settings navigation with native Liquid Glass tab and floating controls on iOS 26+
- Weekly board columns that open on today, with a shared floating Liquid Glass quick-entry control where Return adds continuously and Plus adds then dismisses the keyboard
- List-board creation, custom list columns, focus-aware quick task entry, free multi-column flick navigation, and proximity-accelerated edge scrolling while dragging tasks
- Advanced list management with synced rename/reorder controls and guarded deletion that can preserve tasks by moving them to a neighboring list
- Long-press task dragging and insertion feedback across weekly days and list columns, including synced reordering and cross-child movement within compound boards
- Immediate task completion with native success haptics and concurrent PWA-style checkmarks flying to the completed control
- Local task completion and PWA-style recurring deletion choices, with synced durable series
  cutoffs that prevent deleted future task/event occurrences from reappearing after relay replay
- Rich native task editing for title, notes, priority, due date/time, list placement, and subtasks, with PWA-familiar interactive inline checklists on task cards
- PWA-style completed-task presentation preferences, including a dedicated completed view or in-list completed tasks, optional hiding of finished subtasks, and synced per-board Clear completed controls
- PWA-style per-weekday startup-board routing with a safe first-visible fallback and automatic cleanup when a destination is archived or deleted
- PWA-compatible Saturday, Sunday, or Monday week starts across board ordering, quick-add dates, task moves, and recurring-task visibility
- PWA-compatible recurrence presets, custom intervals/weekdays, optional end dates, and next-instance generation on completion
- Multiple relative reminders, exact custom reminder times, and local iOS notification scheduling
- PWA-familiar Upcoming list/calendar views with one-tap switching, native monthly task-day dots, search, add flow, persisted sorting, board grouping, and board filters
- Opt-in Apple Calendar integration in both Upcoming views with native full-access permission handling, event-day dots, dated list sections, calendar colors, search, and live EventKit refreshes
- Taskify event scheduling compatible with the PWA, including per-event time zones, reminder metadata and local notifications, board/list placement with replay-safe cross-board moves, contact-based attendee selection, stable per-attendee invite tokens, encrypted outbound invitations, authenticated organizer-side RSVP summaries with latest-response reconciliation, and lossless recurrence/series preservation across native edits
- Native recurring Taskify events with PWA-compatible deterministic instance IDs, bounded rolling future windows, DST-safe generation, repeat presets/end dates, scoped single/future deletion, and logical-ID deduplication for newly published or previously saved events
- Independently selectable Apple Reminders integration in both Upcoming views with due-day dots, dated list sections, list colors, priority/notes display, search, and completion writes back to Apple Reminders
- PWA-familiar Add Board flow directly from the board selector, with weekly/list/compound creation, paste-or-scan joining, selection, synced rename, local archive/restore, and guarded deletion with task and compound-reference cleanup
- Native compound-board creation and management with ordered child list boards, aggregated task columns, optional child-board labels, and PWA-compatible linked-board sync
- Atomic JSON persistence in Application Support
- Keychain-backed Nostr identity creation and nsec import
- Embedded native watchOS companion foundation with explicit reachable-only account provisioning,
  passcode-required device-only Keychain protection, a non-secret bounded task cache, and native
  Today, Upcoming, and Boards browsing. Watch task completion is optimistic and haptic, with
  idempotent immediate delivery or a protected 30-day offline queue; direct Watch-to-relay
  synchronization is the next slice
- Review-before-apply PWA account bootstrap and ongoing native board-index publishing through signed kind-30078 Nostr backups, using interoperable NIP-44 v2 encryption, bounded multi-relay discovery, fetch-before-patch conflict protection, offline outbox delivery, and lossless wallet/PWA-only/future-field preservation
- PWA-compatible deterministic board keys, AES-256-GCM task payloads, and signed Nostr events
- Lossless preservation of assignments, bounties, inbox metadata, streaks, scripture state, and future encrypted PWA task fields across native edits, moves, completion, persistence, and relay merges
- Shared-board join flow, default relay subscriptions, configuration-aware replay coalescing, EOSE startup batching, and clock-based merges
- Encrypted PWA-compatible list-board metadata sync, including conversion of joined boards to their remote type and columns
- Disk-backed offline publish outbox with per-relay acknowledgements, stale-event suppression, independent healthy-relay publish lanes, adaptive NIP-01 rate-limit backoff, and reconnect retries
- Aggregate Nostr health reporting with per-relay status, queued-change visibility, and manual/foreground retry
- iOS background app refresh with an immediate background handoff, atomic persistence, bounded relay listening, durable-outbox delivery, automatic rescheduling, and expiration-safe completion
- Native NIP-17 shared-task and assignment inbox with encrypted gift-wrap verification, multi-relay deduplication, review-before-add, persisted delivery state, rich task-field import, and queued Accept/Decline/Maybe responses wrapped so PWA chat cannot misclassify them as eCash
- Native outbound task sharing and assignments with npub/hex validation, NIP-17 inbox-relay preference discovery, persisted recent recipients, durable encrypted delivery, PWA-readable assignment messages, assignee-state badges, and authenticated response updates on the source task
- Native Nostr contact directory with encrypted PWA-compatible NIP-51 private-list sync, signed kind-0 profile names/photos, automatic inbox-relay discovery, add/edit/delete controls, and contact selection for task shares and assignments
- Native one-to-one Nostr Chat with PWA-compatible kind-14 NIP-17 text messages, separate recipient/self gift wraps sharing a canonical rumor ID, preferred inbox-relay discovery, a durable offline outbox, 30-day inbox recovery, multi-relay deduplication, persisted conversation history, unread state, contact-based compose, and encrypted message bubbles
- Interoperable Chat replies and emoji reactions with canonical rumor references, PWA-style kind-7 reaction rumors, long-press actions, quoted reply previews, optimistic offline delivery, replacement/removal ordering, and out-of-order reaction recovery
- PWA-compatible encrypted group conversations with deterministic member-derived threads, synced group names, participant details, media/link tabs, encrypted photo/document attachments, newest-message opening, global individual-message results, and searchable conversation history with stable result navigation
- PWA-familiar Chat organization and presentation with a separate unknown-sender inbox, add/block safety actions, native archive/delete gestures, replay-safe local deletion, configurable local history retention and clearing, group mute/leave/rejoin controls, day and sender message grouping, compact link cards, and Liquid Glass composer/search controls
- Per-board Nostr relay management with ws/wss validation, normalization, default restoration, immediate connection reconfiguration, share-metadata publishing, and queued-event retargeting
- PWA-compatible task image/document metadata sync that survives native edits and recurrence
- Native decryption and display of current and legacy PWA encrypted attachments, with image zoom and Quick Look document viewing
- PWA-familiar stacked image and document previews with media overflow labels, retry states, and readable file metadata
- Behavior-preserving performance hardening for startup, populated boards, Upcoming filters, long Chat histories, wallet history, and attachment previews, with an interactive first-frame handoff, off-main wallet/media and NIP-17 replay decryption, deduplicated inbox batching, cached model projections, bounded media caches, and deterministic populated-screen UI regressions
- Native Photos and Files attachment controls with PWA-compatible AES-GCM encryption, remote-first Originless uploads, and task-level removal
- Cached native rich link cards generated from URLs in task titles and notes, with duplicate inline URLs suppressed in task-card presentation
- Native live-board and independent template sharing with PWA-compatible QR payloads, board-ID copy, the iOS share sheet, camera scanning, review-before-join, automatic board-name/relay import, and complete task plus Taskify-event template snapshots
- Native multi-mint Cashu wallet with ecash and Lightning send/receive, persistent invoice recovery and notifications, detailed payment history, seed backup/transfer recovery, outgoing-token redemption tracking, NUT-16 animated QR support, NUT-18/NUT-26 Cashu payment requests in both directions, recoverable Lightning transfers between configured mints, and durable offline ecash/payment-request inboxes with automatic retry and spent-token cleanup
- Core unit and interoperability tests for state, persistence, list movement, recurrence, reminder timing, PWA task/attachment/account-backup/share-envelope cryptography fixtures, NIP-17 gift wraps, signing, merge clocks, and outbox behavior

Nostr Cashu payment requests now work in both directions; advanced NWC, P2PK/contact payment fields, and external account calendar sync remain migration work instead of being backed by the abandoned native implementation. Native and PWA clients can exchange encrypted one-to-one/group messages, attachments, replies, and reactions as well as task shares and assignments, including Accept/Decline/Maybe status updates on the originating task, and both clients share the same encrypted private Nostr contact list. The current calendar slice reads calendars already available through Apple EventKit; PWA-managed Google account connection remains future work. Board and task relay sync has been manually confirmed in both directions between the native app and PWA. Compound boards retain their PWA child-board references and ordering, including hidden linked-board placeholders that continue syncing without cluttering the visible board picker. Synced PWA attachments are readable on iOS, native additions/removals use the PWA's encrypted remote attachment contract and configurable encrypted file server, and template shares publish a separate board, task, and Taskify-event snapshot that does not follow later live-board changes.

## Open and build

1. Open `TaskifyNative.xcodeproj` in Xcode 27 beta or newer.
2. Select the `TaskifyNative` scheme.
3. Run on an iOS 17.5 or newer simulator/device.

The `TaskifyWatch` watchOS 10 target is embedded in the iPhone app. To provision it, install the
companion build on a paired, passcode-protected Watch, keep Taskify open on the Watch, then open
**Settings → Nostr & Sync → Apple Watch** on the iPhone and confirm **Enable Watch sync**. The raw
Nostr key is sent only through an immediate paired-device message and stored with
`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`; it is not put in the task cache, transfer queue,
backup, iCloud Keychain, logs, or UI. Wallet seeds, Cashu proofs, and tokens are never transferred.

The migration bundle identifier is `solife.me.Taskify.Native`, which allows the native build to coexist with the release WebView app during parity testing.

The native target includes an App Store-ready app-icon catalog based on the release app's Taskify artwork.

The native target and its Swift package tests are validated with Xcode 27 beta, the iOS 27 SDK, and an iOS 26.4 simulator runtime.

## Validate

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcrun swift test --package-path taskify-ios-native \
  --build-system native \
  --scratch-path /tmp/taskify-native-swiftpm-native

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild -project taskify-ios-native/TaskifyNative.xcodeproj \
  -scheme TaskifyNative \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/taskify-native-derived \
  -skipPackagePluginValidation \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Migration order

1. Native shell and offline task vertical slice (complete)
2. Nostr identity, Keychain, two-way encrypted PWA account-backup continuity, relay session, offline outbox, PWA-compatible task events, relay health UI, and two-way board/task interop (complete for the current slice)
3. Rich task editing, advanced list-board management, compound boards, recurrence, native reminders, polished link/media previews, encrypted attachment read/write, live-board sharing/scanning, independent template sharing, two-way NIP-17 task/assignment delivery, and NIP-51 contact directory (complete); remaining calendar parity remains
4. Encrypted Chat text, groups, replies, reactions, attachments, group details, search, conversation lifecycle controls, stranger separation, and refined PWA-familiar presentation (complete for the current slice); richer shared task/contact/calendar/payment cards and Wallet remain
5. Background sync (complete); widgets, App Intents, and accessibility/performance soak remain
6. Switch the production target only after PWA/native interop and parity sign-off
