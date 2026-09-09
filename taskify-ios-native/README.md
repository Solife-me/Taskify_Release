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
- PWA-style completed-task presentation preferences, including a board-scoped newest-first Completed timeline with explicit restore/delete actions, optional in-list completed tasks, optional hiding of finished subtasks, and synced per-board Clear completed controls
- PWA-style per-weekday startup-board routing with a safe first-visible fallback and automatic cleanup when a destination is archived or deleted
- PWA-style board-scoped Upcoming timelines for week, list, and compound boards, with future tasks and Taskify events grouped by day and multi-day all-day events repeated across each future date
- PWA-compatible Saturday, Sunday, or Monday week starts across board ordering, quick-add dates, task moves, and current-week visibility, with later tasks kept in Upcoming until their week is active even when legacy payloads lack `hiddenUntilISO`
- PWA-compatible recurrence presets, custom intervals/weekdays, optional end dates, next-instance generation on completion, and series/date deduplication that prevents an incomplete legacy copy from reviving a completed occurrence
- Multiple relative reminders, exact custom reminder times, and local iOS notification scheduling
- PWA-familiar Upcoming list/calendar views with one-tap switching, native monthly task-day dots, search, add flow, persisted sorting, board grouping, and board filters
- Opt-in Apple Calendar integration in both Upcoming views with native full-access permission handling, event-day dots, dated list sections, calendar colors, search, and live EventKit refreshes
- Taskify event scheduling compatible with the PWA, including per-event time zones, reminder metadata and local notifications, native event cards inside week/list/compound board columns, mixed task-and-event bulk selection/move/delete, board/list placement with replay-safe cross-board moves, contact-based attendee selection, stable per-attendee invite tokens, encrypted outbound invitations, authenticated organizer-side RSVP summaries with latest-response reconciliation, and lossless recurrence/series preservation across native edits
- Native recurring Taskify events with PWA-compatible deterministic instance IDs, bounded rolling future windows, DST-safe generation, repeat presets/end dates, scoped single/future deletion, and logical-ID deduplication for newly published or previously saved events
- Independently selectable Apple Reminders integration in both Upcoming views with due-day dots, dated list sections, list colors, priority/notes display, search, and completion writes back to Apple Reminders
- PWA-familiar Add Board flow directly from the board selector, with weekly/list/compound creation, paste-or-scan joining, selection, synced rename, local archive/restore, and guarded deletion with task and compound-reference cleanup
- Native compound-board creation and management with ordered child list boards, aggregated task columns, optional child-board labels, and PWA-compatible linked-board sync
- Atomic JSON persistence in Application Support
- Keychain-backed Nostr identity creation and nsec import
- Embedded independent watchOS companion with explicit reachable-only account provisioning,
  passcode-required device-only Keychain protection, a protected bounded task cache, and native
  Today, Upcoming, and Boards browsing. Watch task creation, Taskify Dictation, completion, and
  relay refresh work over the Watch's own Wi-Fi or cellular connection. Because general-purpose
  relay WebSockets are not a supported watchOS data path, the Watch signs and encrypts
  task events locally and an authenticated HTTPS bridge only forwards the opaque Nostr events to
  the configured relays. The same bridge delivers NIP-17 chat gift wraps to each recipient's
  kind-10050 inbox relays, with NIP-42 relay authorization, normalization-tolerant relay
  acknowledgements, bounded relay discovery that falls back to the account's relays (like the
  iPhone) rather than staying queued, recorded submit failures surfaced on failed bubbles, and a
  foreground-rearming durable outbox. Watch chat bubbles render the same shared NostrChatMarkdown
  model as the iPhone (headings, lists, quotes, code blocks, thematic breaks, and inline
  bold/italic/strikethrough/code/links), on a compressed watchOS type ramp and without the
  phone's tap-to-copy affordance because watchOS has no pasteboard API. The paired-iPhone path remains the preferred fast path and an idempotent,
  protected 30-day command queue reconciles direct changes with local iPhone state later.
- Review-before-apply PWA account bootstrap and ongoing native board-index publishing through signed kind-30078 Nostr backups, using interoperable NIP-44 v2 encryption, bounded multi-relay discovery, fetch-before-patch conflict protection, offline outbox delivery, and lossless wallet/PWA-only/future-field preservation
- PWA-compatible deterministic board keys, AES-256-GCM task payloads, and signed Nostr events
- Lossless preservation of assignments, bounties, inbox metadata, streaks, scripture state, and future encrypted PWA task fields across native edits, moves, completion, persistence, and relay merges
- Shared-board join flow, default relay subscriptions, configuration-aware replay coalescing, EOSE startup batching, and clock-based merges
- Encrypted PWA-compatible list-board metadata sync, including conversion of joined boards to their remote type and columns
- Disk-backed offline publish outbox with per-relay acknowledgements, latest-version coalescing, fresh-first/starvation-safe scheduling, four-event acknowledgement windows, adaptive NIP-01 rate-limit backoff, acknowledgement-timeout recovery, and a seven-day retry window for lagging replicas after another relay safely accepts the change; never-published changes are retained without an age limit
- Aggregate Nostr health reporting with per-relay status, queued-change visibility, and manual/foreground retry
- iOS background app refresh with an immediate background handoff, atomic persistence, bounded relay listening, durable-outbox delivery, automatic rescheduling, and expiration-safe completion
- Native NIP-17 shared-task and assignment inbox with encrypted gift-wrap verification, multi-relay deduplication, review-before-add, persisted delivery state, rich task-field import, and queued Accept/Decline/Maybe responses wrapped so PWA chat cannot misclassify them as eCash
- Native outbound task/contact/board/calendar sharing and assignments with npub/hex validation, kind-10050 inbox routing with compatibility fallbacks, independent recipient and sender gift wraps, persisted recent recipients, durable encrypted delivery, PWA-readable assignment messages, assignee-state badges, and authenticated response updates on the source task
- Native Nostr contact directory with encrypted PWA-compatible NIP-51 private-list sync, signed kind-0 profile names/photos, automatic inbox-relay discovery, add/edit/delete controls, and contact selection for task shares and assignments
- Native one-to-one Nostr Chat with PWA-compatible kind-14 NIP-17 text messages, separate recipient/self gift wraps sharing a canonical rumor ID, delivery to usable kind-10050 relays with fallback delivery when no usable list is resolved, a signed native kind-10050 preference publisher, a durable offline outbox, 30-day inbox recovery, multi-relay deduplication, persisted conversation history, unread state, contact-based compose, tappable contact headers, shared Photos/Files/Links contact tabs with photo URLs excluded from Links and non-photo attachments in Files, Markdown-formatted encrypted message bubbles, and tap-to-copy inline or fenced code
- Privacy-isolated NIP-17 relay sessions that may connect to recipient relays for outbound publishing but send the user's `#p` inbox subscription only to the user's own advertised inbox relays
- Opt-in native DM push through `push.solife.me`: NIP-98-authenticated APNs token registration, automatic signed kind-10050 inbox updates, NIP-42 relay authentication, generic-alert APNs delivery with background-wake enrichment, and verified redeemed-amount payment notifications with separate message/payment/both controls (rich decrypted previews are deferred until the Notification Service Extension ships)
- Interoperable Chat replies and emoji reactions with canonical rumor references, PWA-style kind-7 reaction rumors, long-press actions, quoted reply previews, optimistic offline delivery, replacement/removal ordering, and out-of-order reaction recovery
- PWA-compatible encrypted group conversations with deterministic member-derived threads, synced group names, participant details, media/file/link tabs, encrypted photo/document attachments, newest-message opening, global individual-message results, and searchable conversation history with stable result navigation
- PWA-familiar Chat organization and presentation with a separate unknown-sender inbox, add/block safety actions, native archive/delete gestures, replay-safe local deletion, configurable local history retention and clearing, group mute/leave/rejoin controls, day and sender message grouping, compact link cards, and Liquid Glass composer/search controls
- Per-board Nostr relay management with ws/wss validation, normalization, default restoration, immediate connection reconfiguration, share-metadata publishing, and queued-event retargeting
- PWA-compatible task image/document metadata sync that survives native edits and recurrence
- Native decryption and display of current and legacy PWA encrypted attachments, with image zoom, Quick Look document viewing, and a persistent size-bounded disk cache of decrypted chat attachments so previously viewed images and files redisplay instantly
- PWA-familiar stacked image and document previews with media overflow labels, retry states, and readable file metadata
- Behavior-preserving performance hardening for startup, populated boards, Upcoming filters, long Chat histories, wallet history, and attachment previews, with an interactive first-frame handoff, visible-board-only task grouping, single-pass task/count indexing, off-main relay merges and Watch projections, staggered relay/contact/wallet recovery, off-main wallet/media and NIP-17 replay decryption, deduplicated inbox batching, cached model projections, bounded media caches, and deterministic populated-screen UI regressions
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
companion build on a paired, passcode-protected Watch, open Taskify on the Watch, then open Taskify
on the iPhone when prompted. The app automatically
opens **Settings → Nostr & Sync → Apple Watch** for **Enable Watch sync**. The raw
Nostr key is sent only through an immediate paired-device message and stored with
`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`; it is not put in the task cache, transfer queue,
backup, iCloud Keychain, logs, or UI. Wallet seeds, Cashu proofs, and tokens are never transferred.
After provisioning, the Watch can create and complete tasks and refresh already-authorized boards
without a reachable iPhone. Task plaintext, the account private key, board sync identifiers, board
signing material, and board encryption keys stay on the Watch. The HTTPS bridge receives the
account public key used for request authentication, configured relay URLs, signed event metadata,
and encrypted event content—the same public/opaque envelope delivered to Nostr relays. New board
membership or changed relay configuration still comes from the iPhone's protected snapshot during
a later companion sync.

The migration bundle identifier is `solife.me.Taskify.Native`, which allows the native build to coexist with the release WebView app during parity testing.

The native target includes an App Store-ready app-icon catalog based on the release app's Taskify artwork.

DM push requires the Push Notifications capability on the `solife.me.Taskify.Native` App ID and
signing profile. Install the StartOS package from `taskify-push-relay/`, configure its APNs Team ID,
Key ID, and `.p8` provider key, expose its interface as `https://push.solife.me` /
`wss://push.solife.me`, then enable the desired categories under Taskify Settings (first-run
onboarding's "Enable notifications" also opts in with the default categories). Until the
Notification Service Extension ships, APNs shows a generic alert and the app enriches it after the
background wake (local message notifications and verified redeemed-amount payment notifications).
Payment redemption is a best-effort background operation and completes on the next app run if iOS
withholds background time.

The native target and its Swift package tests are validated with Xcode 27 beta, the iOS 27 SDK, and an iOS 26.4 simulator runtime.

## Watch background chat refresh

Direct Watch APNs wakes and SwiftUI `.appRefresh` fallback tasks share an inbox-only path.
It stops starting network work after an 18-second monotonic budget, caps each request at
eight seconds with cancellation, requests 20 envelopes per page, and saves each background
page immediately. At most ten pages run per wake; the saved cursor resumes unfinished work
on the next wake or foreground refresh. The remaining notification window is reserved for
bounded decryption, protected-file writes, and completion. Foreground refresh retains larger
batches, but saves fetched pages when a later request fails. Chat catch-up runs alongside,
rather than behind, task-board sync.

The fallback requests a refresh about 30 minutes later and re-arms after delivery. This is
an opportunity, not a polling guarantee: watchOS controls delivery and budgets, including
complication eligibility. Background inbox refresh does not start enrollment, phone-directory
requests, or outbox retries. Passcode-required device-only Keychain storage and complete file
protection remain unchanged. Unreadable caches are not treated as empty, and failed page
writes roll back the in-memory cursor so messages can be retried after unlocking.

In Console, filter subsystem `solife.me.Taskify.Native.watchkitapp` and category
`ChatBackgroundSync` for wake start/completion, busy/key-unavailable deferrals, timeout,
storage/transport failures, and scheduling/registration failures. Logs contain no message
content, sender IDs, keys, tokens, URLs, or raw server errors. A missing wake-start entry
does not by itself prove why watchOS withheld execution.

Physical-device acceptance checks (not established by simulator/unit tests):

1. Provision and open chat once, then background the app on an unlocked, worn Watch.
   Send a message, confirm a background completion log, and reopen without network to verify
   the message is already cached. Repeat with iPhone off and Watch Wi-Fi/cellular available.
2. Lock/remove the Watch, send messages, then unlock/reopen. Verify protected-data deferral
   and catch-up without losing previously cached messages or pending sends.
3. Delay/disconnect the network mid-refresh. Verify completed pages survive relaunch and
   catch-up neither skips nor duplicates messages.
4. With an active complication and Background App Refresh enabled, verify an eligible
   scheduled refresh updates the cache without replaying message alerts. Repeat with refresh
   disabled/Low Power Mode and confirm foreground catch-up remains usable.

Run deterministic transport/cache regression tests with:

```sh
xcrun swift test --package-path taskify-ios-native --build-system native \
  --scratch-path /tmp/taskify-native-swiftpm-native --filter TaskifyWatchChatRuntimeTests
```

## Validate

The Watch caches parsed Markdown by exact text and reuses chat/task indexes until their source
data changes. Pending completions, delivery expiry, midnight, and timezone changes remain live.
Verified received-photo thumbnails are encrypted on disk in a bounded 16 MB / 64-image cache;
legacy attachments without a content hash are not cached. Backgrounding drops decoded images
and Markdown from memory, while deleting chats, blocking a sender, clearing chat data, or replacing
the account clears received-photo and Markdown caches. Profile thumbnails remain available offline
and are conditionally revalidated with ETag/Last-Modified on foreground (with a five-minute check
interval within a session), replacing the former seven-day wait for same-URL photo updates.

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

Idle chat checks in `ScrollPerformanceUITests` measure CPU and memory for 30 seconds each on
the populated inbox and conversation, then verify navigation/search still respond. Relay retries
back off until an actual response, and rejected subscriptions retry independently so healthy
histories are not replayed. Unchanged read/delivery updates do not invalidate the app snapshot;
chat projections are cached per snapshot and Watch projections are built after debouncing.
These simulator checks do not establish device temperature or long-session stability: validate
on iPhone by leaving Chat open for at least 20 minutes with no new messages, then repeat while
a configured relay is unavailable or rejecting a subscription.

A September 3, 2026 Solife device capture found bulk task publication competing with Chat:
date formatting plus task encryption/signing occupied the main thread, and per-task outbox
saves caused an iOS excessive-writes report (4,295 MB in 341 seconds). Task publication now
prepares ordered batches off the main thread, reuses locked ISO-8601 formatters, and durably
enqueues each batch with one outbox save before independent relay delivery. Backgrounding
waits for pending task preparation before flushing. `CryptoSyncTests` checks concurrent date
wire-format compatibility and durable reload of a 102-event batch, including a deletion.
The fixed build passed 69 targeted core tests and a temporary physical-device conversation
check: 0.081 seconds of CPU during a 30-second idle measurement, stable memory (about 120 MB),
and a successful scroll afterward. A separate two-minute chat-list capture used 0.80 seconds
of CPU with no additional disk writes. These are short follow-up checks, not a controlled
replay of the original task backlog or a long thermal soak.

For paired iPhone/Watch profiling, use the `Local` configuration with normal signing on both
simulators. `CODE_SIGNING_ALLOWED=NO` is suitable for a compile check, but it omits the simulated
Keychain entitlements needed to initialize the account and exercise configured Watch sync.
Install and authorize the Watch app through the phone's Watch setup, then set
`TASKIFY_INITIAL_TAB=chat` in each app's debug launch environment to open both on Chat. Include
an open Watch conversation in the idle check (`TASKIFY_INITIAL_CONVERSATION=<conversation ID>`
on Watch). `TASKIFY_UI_TEST_ONBOARDING=skip` suppresses the Watch's notification permission
request during that diagnostic; it does not grant access. Unchanged read positions and equivalent phone
projections must not advance the Watch cache timestamp, and phone replies to read updates
must not build or send another snapshot.

Incoming DMs are forwarded before the relay's history-complete signal and decrypted in groups
of at most eight, with live arrivals prioritized over recovery. Saved ordinary messages skip
repeat decryption; payment-bearing messages remain eligible for wallet recovery. Relay event
streams retain arrivals while consumers are busy, and outgoing publish pacing never blocks
the relay listener. Push wakes refresh only inbox subscriptions on healthy sockets, repairing
failed sockets individually. `NIP17InboxLatencyTests` covers delayed/missing history completion,
slow consumers, replay deduplication, and live arrivals during recovery. Verify delivery on
iPhone both with a conversation already open and after resuming from the background.

Inbox refresh/reconnect cursors retain a two-day overlap plus clock slack: NIP-17 deliberately
backdates new gift wraps, so using only the newest envelope minus one minute can exclude live
messages. The overlap is deduplicated before decryption, rather than narrowing away valid arrivals.
`RelayOutboxLatencyTests` checks 100 messages replayed across three relays, a newly sent backdated
message, and future-dated envelopes. Conversation rows keep their divider and bubble in one stable
container, and superseded automatic scroll tasks are cancelled. The 100-message UI regression
uses current timestamps, injects encrypted plain-text arrivals in triplicate, measures 30 seconds
of idle CPU/memory, and verifies search still responds. Set `TASKIFY_UI_TEST_CHAT_COUNT=100` and
`TASKIFY_UI_TEST_CHAT_ARRIVALS=1` alongside `TASKIFY_UI_TEST_CHAT_FIXTURE=1` to run this fixture;
fixture mode skips contact/account discovery and relay startup so remote data cannot replace it.

Watch chat saves the encrypted outbox and displays the queued bubble before discovery or
delivery, without decrypting its own newly constructed sender copy. Retries start immediately
when due and share one coordinator flush. Successful relay lookups are cached for six hours
from the lookup time, rather than the age of the published preference; failed lookups do not
erase an existing signed preference. DM submissions opt into the gateway's first-acceptance
response while retaining pending replicas for retry. The relay no longer waits a fixed 150 ms
before each remote publish.

`TaskifyWatchChatRuntimeTests` exercises the production store and HTTPS client with a controlled
URL session: durable enqueue before networking, coalesced retries with immutable event IDs,
pending replica retention, and cancellation when clearing the account. HTTPS lookup tests cover
authenticated public-only requests, signature/author/kind validation, completion evidence, cold
sends, routing-cache reuse across sends, and gateway failure. Routing-cache tests
cover lookup freshness, seed replacement, unusable results, and bounded storage.

Recipient discovery now uses NIP-98-authenticated HTTPS at
`/v1/watch/inbox-preference/query`, replacing direct Watch relay WebSockets. The request contains
one recipient public key and the bounded discovery-relay list. The gateway returns signed events
and completed-relay evidence; the Watch validates signatures, selects the newest preference,
and applies its own routing policy. Failed requests remain incomplete, and usable cached signed
preferences survive lookup failure. No contact-directory scan or gateway preference cache is
introduced. The gateway can observe lookup metadata, a tradeoff approved on 2026-09-02; message
encryption and signing remain on the Watch. Deploy the updated relay before the Watch build.

Physical Watch validation remains required. HTTPS is a supported watchOS networking path; see
[Apple TN3135](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos).
Measure queued-bubble and first-recipient-acceptance times separately on paired Bluetooth,
Wi-Fi without the phone, and cellular, including a slow secondary relay.

## Nostr sync audit

The September 3, 2026 [pipeline audit](../docs/nostr-sync-audit-2026-09-03.md) covers native,
Watch, shared web runtime, and gateway behavior, including fixes, tests, and remaining limits.
Taskify deliberately retains fallback DM delivery for recipients without a published inbox list,
as requested by the user. The phone also listens on configured app relays while its own list is
unavailable. Usable signed lists take precedence; the Watch's bounded degraded fallback policy
remains enabled. This compatibility behavior differs from strict NIP-17 routing.

Relay rejection never automatically suppresses an entire event kind or declares its queued
changes sent. The acceptance boolean controls delivery. Verified partial board history flushes
within 200 ms and before reconnect cleanup; incomplete history does not advance resume cursors.
Repeated copies avoid decryption, and malformed frames do not tear down healthy sockets.
Bulk task clocks advance per record instead of adding a second for each unrelated task.

The [Solife performance audit](../docs/solife-performance-audit-2026-09-03.md) records physical-device
CPU, memory, thermal-state and hang measurements across navigation. Upcoming's calendar event
date parser now reuses synchronized formatters after repeated formatter construction appeared
in the device CPU stacks.

## Migration order

1. Native shell and offline task vertical slice (complete)
2. Nostr identity, Keychain, two-way encrypted PWA account-backup continuity, relay session, offline outbox, PWA-compatible task events, relay health UI, and two-way board/task interop (complete for the current slice)
3. Rich task editing, advanced list-board management, compound boards, recurrence, native reminders, polished link/media previews, encrypted attachment read/write, live-board sharing/scanning, independent template sharing, two-way NIP-17 task/assignment delivery, and NIP-51 contact directory (complete); remaining calendar parity remains
4. Encrypted Chat text, groups, replies, reactions, attachments, group details, search, conversation lifecycle controls, stranger separation, and refined PWA-familiar presentation (complete for the current slice); richer shared task/contact/calendar/payment cards and Wallet remain
5. Background sync (complete); widgets, App Intents, and accessibility/performance soak remain
6. Switch the production target only after PWA/native interop and parity sign-off


## iOS share sheet and large attachments

Taskify's Share extension accepts up to ten photos, videos, files, links or text
items, lets the sender choose a DM, group or Note to Self, and queues encrypted file
uploads in an iOS background URL session. Native app launches retry interrupted
message delivery and reconcile sent receipts into chat history. Each gift wrap is
saved before publication so retries keep the same message identity. Files expire
from the share queue after 48 hours; incomplete private previews expire after 24 hours.

Chat accepts up to ten attachments per send from Photos, Files, pasted images,
camera captures, or document scans. Previews can be removed independently.
Every file uploads before the batch is queued; interrupted uploads retain the
staged files and reuse completed uploads on retry. Each recipient's deliveries
form an ordered chain, with an optional comment replying to the last file.

Chat attachments stay in a removable preview until the sender presses Send. Both
the chat composer and share extension accept an optional comment. Following
[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md), the attachment is
a kind-15 file message and its comment is a separate kind-14 reply whose `e` tag
references the file's canonical rumor ID. The comment preserves the conversation's
recipients and group subject. Empty comments produce no extra message. A selection
of multiple shared files has one comment, replying to the last selected file.

Each recipient's comment waits for that recipient's attachment wrap to be
acknowledged. Both messages and their dependencies are persisted before delivery;
retries reuse the existing IDs and only resend unacknowledged copies. A failed
in-app upload or queue operation preserves the preview and comment. Chat history
uses reply relationships to keep parents first when timestamps tie, including
after history replay or restart.

Conversation suggestions are automatic, with no Taskify opt-in setting. The app
donates actual message interactions with display names and account-scoped opaque
identifiers. Message bodies, attachment filenames, keys and the contact directory
are not donated. iOS decides which conversations appear and how they rank.

The extension uses `group.solife.me.Taskify.Share` and a separate
`$(AppIdentifierPrefix)solife.me.Taskify.share` Keychain group containing only the
messaging identity. It does not receive the existing application storage/Keychain
groups or wallet data. Keep the existing Keychain group first in the app entitlement.
Register/provision the new Share extension bundle ID (`solife.me.Taskify.Native.Share`)
and App Group when preparing a signed device/TestFlight build.

Native task and chat attachments support 500 MiB (shown as 500 MB), subject to the
configured host's own limits. File import, AES-GCM, hashing, multipart creation and
download verification use bounded buffers and protected temporary files. Existing
PWA/0xchat DM and current/legacy task formats remain readable; other clients may
still have their own memory limits. CryptoSwift 1.10.0, by Marcin Krzyżanowski and
contributors, supplies incremental AES-GCM through the isolated TaskifyFileCipher
module. See the bundled ThirdPartyNotices.txt for its license.

The shared Xcode scheme runs the `Local` configuration. It copies the app targets'
Debug settings, including development signing, push environment, `DEBUG` and
debugger support, while Xcode builds Swift package dependencies with Release
optimization. Keep this configuration's name free of `debug` or `development`:
Xcode uses those substrings to choose SwiftPM's slow Debug configuration. A local
benchmark of the same incremental cipher took 5.39 seconds per MiB in Debug versus
0.047 seconds in Release; an 83 MiB attachment could otherwise appear stalled for
several minutes before the upload even starts. Test/Analyze still use Debug, and
Archive/Profile still use Release. This changes no file format or encryption key.

Both composers show encryption progress before queueing or uploading. In-app
sends also show transmitted bytes and distinguish waiting for the host from
sending the DM. Cancel stops preparation/upload and retains the preview and
comment for retry; it is disabled once message queueing starts. Upload failures
stay beside the attachment, including the rejecting host and HTTP status.

From `taskify-ios-native`, run focused validation:

```sh
swift test --build-system native --scratch-path /tmp/taskify-media-tests -c release \
  --filter 'AttachmentFileCryptoTests|ShareContractTests|NostrDirectMessageTests|BlossomClientTests'
swift test --build-system native --scratch-path /tmp/taskify-media-tests -c release \
  --filter 'AttachmentCommentTests|NostrDirectMessageTests|CryptoSyncTests|ShareContractTests'
TASKIFY_TEST_LARGE_FILES=1 swift test --build-system native \
  --scratch-path /tmp/taskify-media-tests -c release --filter AttachmentFileCryptoTests/test500MiBFileRoundTrip
```

For bounded-download and cancellation checks, run `python3 Scripts/attachment-test-server.py`
and use its printed port in `TASKIFY_DOWNLOAD_TEST_BASE_URL=http://127.0.0.1:PORT`
when running `swift test --filter AttachmentDownloadTests`. The fixture binds only
loopback and uses synthetic bytes.

For actual file-body transmission, start `python3 Scripts/attachment-upload-test-server.py`
and use its printed port:

```sh
TASKIFY_UPLOAD_TEST_BASE_URL=http://127.0.0.1:PORT TASKIFY_TEST_LARGE_FILES=1 \
  swift test --build-system native --scratch-path /tmp/taskify-media-tests -c release \
  --filter AttachmentUploadTests
```

This sends synthetic 83 MiB ciphertext through both Originless multipart and
authenticated Blossom PUT, downloads/decrypts it, checks hashes and progress, and
exercises rejection/cancellation. The HTTP endpoint is substituted only in the
test request; production uploads still require HTTPS. Device share-sheet behavior
and a full upload to the configured remote host still need release QA; local
integration tests do not establish remote-host capacity.
