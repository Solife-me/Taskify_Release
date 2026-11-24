# iOS app performance audit — 2026-11-23

## Scope and method

Reviewed `taskify-ios-native` (the `TaskifyNative` app and the `TaskifyCore` package it links):
SwiftUI render paths, the snapshot/store layer, relay sync ingestion, the NIP-17 shared inbox,
media handling, and launch. Findings come from reading the code in full, cross-checked against
the app's own instrumentation (`TaskifyPerfMonitor`, the UI-test probes) and against targeted
package benchmarks run for this audit. Nothing was changed in the app at the time of writing;
findings 1 and 2 were fixed the next day (see below). Line references are from commit
`842f767c`, the audited revision, so they shift after that fix.

What this audit does **not** establish:

- No physical device, no production account, no live relay traffic. Per the September 3 audit,
  simulator metrics are regression baselines, not device evidence, and this app's cost is
  driven by real relay traffic merging into the snapshot.
- No Instruments capture. A Debug simulator launch with the 1,140-task fixture was used only to
  confirm the build runs; its resident size (~370 MB) is debug-runtime overhead, identical with
  an empty store, and is not reported as a finding.
- Benchmarks were taken on this Mac against the package's value types, not through the UI. They
  size individual operations (tables below), not whole-app frame times.

## What is already healthy

Performance work from the August–October passes is real and should not be redone:

- **Area-scoped observation.** `AppModel` keeps the snapshot out of observation and exposes
  `tasksSnapshot` / `chatSnapshot` / `inboxSnapshot`, each depending on its own revision
  (`AppModel.swift:54-145`). A chat tick does not redraw boards.
- **Derived-data caching.** `SnapshotLookupCache` holds the task index, column groupings,
  Upcoming/Completed projections, event slices and thread lists, with build counters for tests.
- **Coalesced writes.** Relay backlogs merge on a detached task and assign the snapshot once
  (`AppModel.swift:6086-6139`); saves are debounced and split per store area
  (`AppModel.swift:7248-7280`, `JSONTaskStore` is an actor); the October improvement review
  recorded that split at 41 ms/2.22 MB → 18 ms/0.57 MB.
- **Bounded ingress and side effects.** Relay reads cap at 64 decoded messages per connection,
  widget reloads, Spotlight indexing and Watch snapshot encoding are debounced, and attachment
  images are downsampled off-main into bounded caches (64 MB chat, 96 MB media).
- **Coverage.** `ScrollPerformanceUITests` measures scrolling, paging, secondary views and chat
  idle CPU/memory; `BoardRenderUITests`/`ChatRenderUITests` count card and timeline rebuilds.

The findings below are what remains.

## Measurements

Temporary `TaskifyCoreTests` benchmarks (Release, macOS arm64, SwiftPM), 5,000 tasks and 5,000
direct messages unless noted. A phone is slower, so treat these as lower bounds; they size
individual operations, not frame times.

| Operation | Release | Debug |
| --- | ---: | ---: |
| `Array ==`, same copy-on-write buffer, 5k tasks | 0.0 µs | 0.3 µs |
| `Array ==`, equal values, separate buffers, 5k tasks | 774 µs | 4,247 µs |
| `changedAreas`, chat write with tasks unchanged | 0.5 µs | 2.1 µs |
| `changedAreas`, one task edited mid-array | 369 µs | 2,114 µs |
| `changedAreas`, rebuilt-but-equal tasks array | 779 µs | 13,631 µs |
| `changedAreas`, DM delivery-state edit | 188 µs | 670 µs |
| `directMessages ==`, equal values, separate buffers | 376 µs | 1,294 µs |
| Copy-on-write of the 5k-task array (one element written) | 756 µs | 795 µs |
| Build id→index dictionary from 5k tasks | 1,088 µs | 4,436 µs |
| `publishFingerprint`, one task | 50 µs | 61 µs |
| `mergeRemoteTask`, unchanged echo (5k tasks) | 1,093 µs | 5,109 µs |
| `mergeRemoteTask`, winning update (5k tasks) | 1,911 µs | 5,806 µs |
| `mergeRemoteTasks`, batch of 100 new tasks into 5k | 5,896 µs | 10,816 µs |
| JSON encode tasks area (5k) | 39.6 ms | 68.7 ms |
| JSON encode chat area (5k DMs) | 16.1 ms | 33.0 ms |
| JSON decode tasks area (5k) | 79.0 ms | 137 ms |
| `ingestDirectMessage`, one new message, 2,000 history | 420 µs | 3,985 µs |
| `ingestDirectMessage`, one new message, 5,000 history | 995 µs | 7,363 µs |
| Backfill 500 messages into 2,000, no replies | 240 ms total, 1.0 ms worst | 2,579 ms, 29–42 ms worst |
| Backfill 500 into 2,000, one same-second reply in the thread | 493 ms total, 8.2 ms worst | 4,918 ms, 21–625 ms worst |

What the numbers say:

- **The identity fast path is real.** An untouched area costs 0.5 µs to detect, so
  `changedAreas` is not the problem; a full elementwise walk (0.8 ms at 5k) happens only after
  that area actually changed. Do not remove the "compare by identity" assumption, but note it
  only holds while the buffers are shared — a rebuilt equal array (JSON load, `filter`/`map`
  reassigned to the same property) turns the next comparison into a full walk.
- **A chat write compares the DM array three times** — `changedAreas`, the
  `snapshotDidChange` bookkeeping and `SnapshotLookupCache.invalidate` — at ~0.2–0.4 ms per
  pass at this size. Small next to the ingest, but it is redundant work on the main actor for
  every message.
- **One live task event costs 1.1–1.9 ms of main-thread work** at 5k tasks, mostly rebuilding
  the id→index dictionary; a burst of 100 is 0.1–0.2 s of dropped frames.
- **Chat ingest is quadratic.** One message costs ~1 ms at 5,000 stored messages (7.4 ms in
  Debug), and a 500-message backfill into 2,000 costs 240 ms — 493 ms when the thread has one
  same-second reply. Extrapolating the measured per-append growth: roughly 2.5–3 s for a full
  5,000-message history from empty, ~10 s at 10,000, doubled with replies, before any device
  slowdown.
- **Store encode/decode is tens of milliseconds.** 39.6 ms to encode the tasks area and 79 ms
  to decode it at 5k tasks. Both are off-main inside the store actor, but the triple decode in
  finding 6 is ~237 ms of actor CPU per absorption, and a save is ~40 ms of CPU every debounce
  window while sync is running.

### Reproducing these runs

The package benchmarks are ordinary `TaskifyCoreTests` measurements run in Release; they are
not kept in the repository. The app-side probes are built in:

- Build for a simulator (Xcode 27):
  `xcodebuild -project taskify-ios-native/TaskifyNative.xcodeproj -scheme TaskifyNative -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build`
- Launch with `SIMCTL_CHILD_TASKIFY_UI_TEST_FRESH_STORE=1`,
  `SIMCTL_CHILD_TASKIFY_UI_TEST_PERFORMANCE_FIXTURE=1`,
  `SIMCTL_CHILD_TASKIFY_UI_TEST_BOARD_SECONDARY_FIXTURE=1` and
  `SIMCTL_CHILD_TASKIFY_PERF=1` for the 1,140-task fixture with the live overlay.
- `ScrollPerformanceUITests` runs the scripted scroll, paging, secondary-view and chat-idle
  measurements; `BoardRenderUITests` / `ChatRenderUITests` report the card-body and
  timeline-build counters for one interaction.
- For real numbers, run a device build with `TASKIFY_PERF=1` on an account with live relay
  traffic, as the September 3 audit did.

## Fixed 2026-11-24 (findings 1 and 2)

Both chat findings were fixed after this audit was written. Release measurements from the same
Mac and fixtures:

| Operation | Before | After |
| --- | ---: | ---: |
| `latestMessage` / `latestActivityTimestamp` read (50×200 fixture) | re-projected per read | 0.08 µs |
| Build all threads, 50 threads × 200 messages | 96 ms | 10 ms |
| Rebuild threads after one arriving message | 96 ms | 5.7 ms (49 projections reused) |
| Backfill 500 messages into 2,000 | 283 ms | 19 ms |

What changed:

- `NostrDirectMessageThread` now resolves the Hermes projection once, at construction, and
  stores `hiddenMessageIDs` and `latestVisibleMessage`; the row accessors no longer project.
- `HermesModelPickerProjection` gained an ordered-input form, which thread construction uses
  because it already holds relay order.
- `SnapshotLookupCache` memoizes each peer's projection by message count and first/last rumor
  id, so a chat write re-parses only the conversation that changed.
- The per-message guards in both listing parsers use a byte scan instead of Foundation's
  case-insensitive `range(of:)` (measured at 6.9 µs per call), and the menu-id check no longer
  compiles a regular expression. This alone cut the projection from 88 ms to 3.7 ms per 10,000
  messages.
- `TaskifySnapshot.ingestDirectMessages` batches history: one copy, one sort, one retention cap.
  The NIP-17 inbox batch, local multi-attachment sends and share-receipt reconciliation use it;
  the single-message path is unchanged. Per-message push-category side effects now run only for
  messages the batch accepted.

Regression coverage: `testBatchIngestMatchesOneMessageAtATime`,
`testBatchIngestHonorsDeletionSuppressionLikeSingleIngest`,
`testBatchIngestAppliesTheRetentionLimitOnce`,
`testThreadResolvesHermesTrafficOnceAtConstruction`, `testOrderedProjectionMatchesTheSortedProjection`
and `testOrdinaryMessagesRejectListingsWithoutParsingLines`, plus
`testChatWritesReuseUnchangedThreadProjections` (which uses a build counter to prove one arriving
message re-projects only its own conversation) and the existing DM, Hermes, chat-list and
lookup-cache suites. Verified on the package (all tests pass), by a Debug iOS simulator build,
and by the six `ChatRenderUITests` (including the Hermes menu, session-resume and retry flows)
passing on the simulator. Not verified on a device; findings 3–16 remain open.

## Findings, ranked by expected impact

### 1. Every chat-list row re-runs the Hermes menu projection — including for threads that have no bot (high) — **fixed 2026-11-24**

`NostrDirectMessageThread.visibleMessages` runs
`HermesModelPickerProjection.project(messages:enabled: true)` on **every read**
(`NostrDirectMessage.swift:606-610`), and `latestMessage` / `latestActivityTimestamp` both go
through it (`:611-624`). `project` sorts the whole thread and, for every incoming message,
splits the text into lines and scans them with regular expressions to see whether the message
is a bot menu (`HermesModelMenu.swift:545-600`; `HermesSessionMenuParser.parseListing` at
`:96-105` runs a regex `range(of:)` per line before rejecting an ordinary message).

It is not only rendered rows: `NostrChatListItem.rows` reads `latestActivityTimestamp` for
every thread to place the stranger inbox (`NostrChatListItem.swift:20-28`), so each `ChatView`
body pass projects every conversation once before any row is laid out. A rendered row's body
then reads `latestMessage` or `latestActivityTimestamp` three more times — the timestamp, the
structured-preview comparison, and the preview itself (`ChatListViews.swift:174,203,219`) — and
`AppModel` reads it again once per thread for the Watch projection (`AppModel.swift:4837`).
Default retention is **forever** (`TaskOrderingSettings.swift:69-71`), so with 50 threads and a
few hundred messages each, one body pass pays dozens of full thread sorts and thousands of
line-by-line regex scans. The conversation view already gates this correctly on a known-bot
predicate (`ChatConversationView.swift:590-593`).

**Fix (durable):** compute the projection once, when the thread is built — `directMessageThreads()`
already projects per peer (`NostrDirectMessage.swift:795-815`), so store
`hiddenMessageIDs`, `latestVisibleMessage` and the activity timestamp on the thread and make the
accessors O(1). Make it incremental: keep the projection's per-message state and parse only
messages appended since the last build, so a new message costs O(1) rather than a re-parse of the
thread. Compile the parser regexes once as `static let` (both listing parsers construct or
compile one per call, `HermesModelMenu.swift:96-110`), and key the row's memo on the thread's
last rumor id. Do not gate this on a bot-directory check: a menu listing can arrive from a
public key that is not in the bot list, and skipping the parse would surface internal traffic.

### 2. Chat history ingest copies and sorts the whole message array once per message (high) — **fixed 2026-11-24**

`ingestDirectMessage` copies the DM array, appends, then sorts all messages
(`NostrDirectMessage.swift:1149-1169`, sort at `:1270-1300`), every call. No caller passes a cap,
so `maximumCount` stays `.max` (`:1135-1138`). The relay backfill path calls it once per
decrypted message (`AppModel.swift:6316-6322`), and the live path once per message
(`:6483`). With replies present, the sort is followed by a second O(n) pass that builds a
dictionary of every message (`:1279-1281`).

Total work for a backfill of M receipts into N stored messages is Θ(M·N log N) on the main
actor; quadratic behaviour is why a long chat history makes first sign-in and reinstall slow
rather than merely heavy. Measured (Release, this Mac): one message costs 0.42 ms against
2,000 stored messages and 1.0 ms against 5,000; a 500-message backfill into 2,000 costs 240 ms,
and 493 ms once one same-second reply turns on the ordering pass. The same array copy also runs
once per element in `ingestLocalDirectMessages` (`AppModelDirectMessages.swift:506-516`).

**Fix:** add a batch ingest that copies once, appends all, sorts once and caps once; keep the
single-message path for live traffic using insertion into the already-sorted array (binary
search by `(createdAt, observed order)`) instead of a full sort. Enforce the retention cap at
ingest as well as at load (see finding 11).

### 3. Each *live* task event rebuilds an O(tasks) index and re-encodes a fingerprint on the main actor (medium-high)

The batched backlog path is detached, but a single live task event goes through
`mergeRemoteTask` → `mergeRemoteTasks` on `AppModel`'s actor (`AppModel.swift:6005-6018`), which
builds an id→index dictionary over every task and a board dictionary
(`TaskifySnapshot.swift:1988-1996`), then computes
`TaskEventCodec.publishFingerprint` — a fresh `JSONEncoder` plus SHA-256 over the task payload —
for the applied record (`TaskifySnapshot.swift:2032,2039`, `TaskEventCodec.swift:388-398`).
Measured at 5,000 tasks, `mergeRemoteTask` costs 1.09 ms for an echo that changes nothing and
1.91 ms for a winning update (Release, this Mac). A burst of a few hundred live events (another
device completing or moving many tasks) is a few hundred full index builds and encodes on the
main thread — roughly 0.1–0.2 s per hundred events before any device slowdown.

**Fix:** keep the id→index map in `SnapshotLookupCache`, maintained incrementally on insert and
invalidated only on a tasks-area change; take the fingerprint of the received version from the
event/content that carried it rather than re-encoding the local model; and coalesce live
events for ~50–100 ms onto the existing detached batch path so bursts pay one merge, not one
per event.

### 4. Reconciliation passes run per merged event with no debounce (medium-high, conditional)

After each merged task the app calls `reconcileScriptureMemory()` and, when full-week recurrence
is on, `ensureFullWeekTaskRecurrences()` (`AppModel.swift:6010-6016`). Scripture Memory walks
every task twice when it is enabled and has entries (`:3707-3800`), and the recurrence pass
rebuilds the week and compares whole snapshots (`:5326-5340`). Neither is debounced; both already
have debounced siblings (`refreshNotifications` 400 ms, `scheduleSave` 300 ms) to model on.

**Fix:** mark these dirty and run them once after a short trailing settle (or at
`relayHistorySettled`), the way notifications and saves already coalesce.

### 5. A sync batch restarts from scratch whenever anything writes the snapshot (medium)

`applySyncBatch` captures `snapshotRevision`, merges the whole backlog detached, and on any
concurrent write re-copies the snapshot and re-merges the entire batch
(`AppModel.swift:6106-6139`). Chat, app-state and shared-inbox traffic all write the snapshot
during initial backfill, so one large backlog can be merged and discarded several times.

**Fix:** merge in chunks (say 200 records) and commit between chunks, or re-apply only the
delta since `baseSnapshot`. A long-lived account replay then costs one pass plus at most one
chunk of rework.

### 6. Absorbing a widget or App Intent write decodes `tasks.json` three times (medium)

`absorbExternalStoreChanges` calls `readTasksWrittenElsewhere`,
`readBoardsWrittenElsewhere` and `readTaskifyEventsWrittenElsewhere`
(`AppModel.swift:2535-2537`); each independently reads and `JSONDecoder`s the same tasks area
(`JSONTaskStore.swift:166-200`), and the first also inlines every attachment file it
references. This runs before a save whenever the file is newer, and on every foreground. At
5,000 tasks a decode measures ~79 ms in Release on this Mac, so the triple read is ~237 ms of
store-actor CPU per absorption.

**Fix:** one read returning `TaskifyTasksArea`, decoded once; inline attachments only when the
task list is actually going to be merged.

### 7. Every save re-hashes every large attachment value (medium)

`TaskifyAttachmentFiles.known` is keyed by the full inline string; `externalize` looks the value
up and inserts it again for each candidate (`TaskifyStoreAreas.swift:145-161`), and
`mapAttachmentValues` visits every image/document value in a changed area
(`:195-232`, called from `JSONTaskStore.swift:240-246`). String hashing is O(length), so a board
holding a few hundred megabytes of legacy inline photos re-hashes all of it on each save — and
saves fire on a 300 ms debounce while sync is running. New iOS uploads use remote documents, so
this mostly hits imported PWA/legacy data, but it is exactly the data a migrating user has.

**Fix:** carry the content hash with the value rather than re-deriving it from the string (the
reference already names the SHA-256), or memoize `value → name` by a cheap digest
(length + prefix/suffix) and verify the full hash only on a candidate hit.

### 8. Calendar-event merge is linear per record inside a per-record loop (medium)

`mergeRemoteTaskifyEvent` scans the events array, then rebuilds it with `compactMap` on update
(`NostrSharedInbox.swift:2741-2768`), and `applySyncBatch` calls it once per calendar record
(`AppModel.swift:6120-6127`). Off-main, but O(records × events) and it also re-runs the
recurrence-cutoff pass each time.

**Fix:** a batched `mergeRemoteTaskifyEvents` with one id→index map, mirroring the task merge.

### 9. Avatars are full-size `AsyncImage`s with no memory cache or downsampling (medium)

`NostrContactAvatar` renders `AsyncImage(url:)` at the requested point size
(`ContactsView.swift:202-218`) — 22 pt on task cards (`BoardContentViews.swift:851`), 46 pt in
chat rows (`ChatListViews.swift:376`), plus message bubbles and group lists. `AsyncImage` keeps
no decoded-image cache and does not downsample: every appearance decodes the full profile image
again. A populated board with creator avatars decodes one full-size image per card while
scrolling. The app already has the right primitive for received photos — an actor plus `NSCache`
plus an ImageIO thumbnail (`ChatMessageViews.swift:1717-1760`) — and the Watch target already
has `TaskifyWatchAvatarLoader`, a URL-keyed, disk-backed thumbnail loader with
ETag/Last-Modified revalidation (`TaskifyWatchAvatarLoader.swift:1-30`); iOS uses neither.

**Fix:** one shared avatar loader keyed by `(url, pointSize, scale)`, downsampling to the display
size, used everywhere.

### 10. The outbox rewrites its whole file on most mutations (low-medium)

`NostrOutboxStore.persist` re-encodes and atomically writes the entire entries array
(`NostrOutboxStore.swift:508-541`). A 150 ms deferred path exists (`:519-528`) but most
mutations persist immediately. Flushing N acknowledgements is O(N²) bytes written. It is an
actor, so this costs IO and battery rather than frames.

**Fix:** coalesce every ack-level mutation through the deferred persist (flush on background),
or move to an append-only journal with periodic compaction.

### 11. In-session chat history is unbounded even when retention is set (low-medium)

Retention is pruned only at load, on a settings change, and on backgrounding
(`AppModel.swift:1008,5230,8001`); ingest has no cap (finding 2). A long-lived session therefore
grows without limit, and every cost that is linear in message count (findings 1, 2) degrades
with it.

**Fix:** pass the retention-derived maximum into ingest, and prune on a coarse schedule
(hourly or on foreground), not only at launch.

### 12. Link-preview caches are unbounded and do not account memory (low-medium)

`TaskLinkPreviewModel` holds three static `NSCache`s with no `countLimit`/`totalCostLimit`, and
inserts with no cost (`TaskMediaView.swift:524-526,547,560,569`). Entries are keyed by URL and
kept for the session; each holds an `LPLinkMetadata` and a full-size artwork image. Every link
preview a user opens accumulates.

**Fix:** set count and byte limits, insert with `cost:` (decoded byte size), downsample the
artwork, and clear on memory warning.

### 13. Attaching a photo encodes the full-resolution image on the main actor (low-medium)

`TaskEditorView.uploadPhoto` is `@MainActor` and calls `image.jpegData(compressionQuality: 0.88)`
on the image straight from the picker/camera (`TaskEditorView.swift:1160-1165`), then uploads
the full-size JPEG unchanged (`TaskAttachmentUploadService.swift:189-220`). A 12 MP encode at
0.88 takes hundreds of milliseconds on the main thread — a visible hitch on the capture path —
and sends/stores a much larger file than the UI ever displays.

**Fix:** downsample with ImageIO to a documented maximum (the app already uses 2,048 px for the
background image) and encode on a detached task, showing the existing upload status while it
runs.

### 14. Load does main-actor O(tasks) work before the first frame (low-medium)

`isLoading` gates the UI (`RootTabView.swift:200-215`), and after the store loads `load()`
performs legacy share routing, join-date recovery, a retention prune, pending-publish
readback, external-mutation replay, notification rescheduling, fasting reconciliation, Scripture
Memory reconciliation and calendar-window maintenance before clearing it
(`AppModel.swift:5203-5299`). The JSON decode is correctly off-main; these passes are not.

**Fix:** move the reconciles into the existing `deferredStartupTask` grace block
(`AppModel.swift:5303-5323`), leaving only what the first board needs.

### 15. The background image is read and decoded from disk in `body` (low)

`TaskifyAppearanceSettings.backgroundImage` does `UIImage(contentsOfFile:)` on each access
(`TaskifyTheme.swift:116-119`), and `TaskifyAppBackground` calls it in `body` inside a
`GeometryReader` (`:389-397`). The body re-runs on layout changes (rotation, keyboard, split
view) and on the appearance revision, each time hitting the file system and decoding up to a
2,048 px JPEG. The blurred variant additionally runs a full-screen 18 pt blur.

**Fix:** cache the decoded (and blurred, if used) image, keyed by the appearance revision,
produced off-main at the screen size.

### 16. Smaller items

| Item | Where | Note |
| --- | --- | --- |
| Per-card `GeometryReader` for the complete button's flight origin | `BoardContentViews.swift:812` | one layout container per materialized card; a preference or the button style could supply it |
| Card `Equatable` compares whole `TaskItem`s | `BoardContentViews.swift:1373-1377` | note/title string compares per card per parent pass; a version/`nostrUpdatedAt` key is enough |
| Card material blur per card | `BoardContentViews.swift:1058` | correctly gated by `TASKIFY_DISABLE_CARD_MATERIAL` and only over photos; keep the A/B flag |
| Note markdown parsed in `body` | `TaskNoteViews.swift:34-39` | viewer is fine; the editor's inline preview re-parses on each pass |
| Bible tracker formats an ISO date per row and encodes state synchronously per toggle | `BibleTrackerStore.swift:49-52,190-193` | reuse the existing shared formatter; debounce the encode |
| Scroll geometry projected as the full `ScrollGeometry` | `ChatMessageViews.swift:1800` | deliberate (comment explains the threshold cache); the action still runs each frame — a boolean projection would be cheaper |
| Board tag SHA-256 per board per incoming event | `TaskSyncEngine.swift:1822-1826` | build a tag→board map at `configure` |
| Fixed-size ID arrays `removeFirst(overflow)` once at cap | `TaskSyncEngine.swift:2091-2094,2106-2110` | 5,000-element shift per event; chunks or a ring |
| Wallet view model built and two Keychain stores read at launch even when the wallet is removed | `TaskifyNativeApp.swift:40-44`, `WalletView.swift:229-234` | with the December 1 phase-out, construction can be skipped entirely |
| Account-backup projection rebuilds and deep-compares the whole payload per settle | `AppModel.swift:7869-7944` | O(boards + tasks) on the main actor after each change burst once encrypted account sync is set up; build it off-main and reuse it while the boards/tasks revision is unchanged |
| Chat timeline allocations per pass (`enumerated()` array, suffix copy, search `Set`) | `ChatConversationView.swift:748,568-576,709` | derivable once per revision in the existing presentation cache |

## Instrumentation and regression gaps

- **No production measurement.** Nothing in the app links MetricKit, so hang rate, launch
  time, peak memory and termination reasons are invisible. MetricKit's `MXMetricManager` daily
  payloads would turn "sluggish on my account" into a measured regression signal; it is a
  subscriber plus a few `MXMetricPayload` fields.
- **No signposts on the hot paths.** `os_signpost` exists only for DM publishing
  (`AppModelDirectMessages.swift:206-288`). Instrumenting snapshot apply, thread projection and
  timeline build (the monitor already times the last one) makes Instruments captures directly
  comparable.
- **No iOS perf gate in CI.** `.github/workflows/ci.yml` builds and tests the Mac app only. The
  iOS perf UI tests exist but run manually, so regressions like finding 1 or 2 land silently.
  At minimum, build the iOS scheme in CI; ideally run the deterministic count-based probes
  (`BoardRenderUITests`, `ChatRenderUITests`) rather than timing assertions.
- **Simulator-only baselines.** The prior audit's note stands: use `TASKIFY_PERF=1` on a device
  with a real account to correlate hitches, snapshot writes and card bodies. The overlay is
  debug-only, which is right for shipping but means no field data reaches the team.

## Suggested order

Findings 1 and 2 are fixed (see the section above). For the rest, first land the MetricKit
subscriber and the two signposts from the section above. They are small, and without them the
remaining fixes can only be checked on the simulator — the same gap that made this audit rely on
static reading for most of its ranking.

1. Finding 1 and finding 2 — both are structural (O(threads × messages log messages) per list
   pass for rendering, O(M·N log N) for backfill) and both affect every chat user. Fixing them
   also makes finding 11 safe to defer.
2. Finding 3 and finding 5 — sync bursts; one index and one coalescing window.
3. Findings 4, 6, 7, 8 — per-event and per-save overhead; mostly mechanical.
4. Findings 9, 12, 13 — media memory and capture hitch.
5. Findings 10, 11, 14, 15, 16 — cleanup with the instrumentation work.

Each fix should keep the existing invariant that the store, the snapshot areas and the lookup
cache agree on what changed; the tests that count builds (`SnapshotLookupCacheTests`) and
rebuilds (`ChatRenderUITests`) are the right place to lock each one in.
