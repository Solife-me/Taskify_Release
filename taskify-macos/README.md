# Taskify for macOS

Native SwiftUI/AppKit application for macOS 14 and later. This target shares the
existing iOS `AppModel`, wallet controller, TaskifyCore, calendar store and
notification scheduling. It is an active port, not yet complete iOS parity.

## Build

Open `TaskifyMac.xcodeproj`, choose `TaskifyMac` and My Mac. Configure your own
signing team for a signed sandboxed build. No Catalyst runtime is used.

```sh
python3 taskify-macos/Scripts/generate-project.py
xcodebuild -project taskify-macos/TaskifyMac.xcodeproj -scheme TaskifyMac \
  -configuration Local -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath /tmp/taskify-macos CODE_SIGNING_ALLOWED=NO build
swift test --package-path taskify-macos --build-system native
```

Commands run from the repository root. Project generation is deterministic and
requires Python 3 only. Regenerate after adding Swift sources. `Local` retains
app debugging while Swift package dependencies use their release configuration;
use it for attachment performance work. Debug is useful for dependency debugging,
but unoptimized cryptography can make large attachments very slow. Release is
intended for distribution builds. Unsigned command-line builds verify compilation;
they do not verify sandbox, Keychain provisioning or distribution signing.

The files `generate-project.py` compiles into this target — `App/AppModel.swift`,
`Features/Wallet/WalletView.swift` and the rest of the whitelist at the top of
that script — are also compiled into the iOS app, and iOS-only work regularly
lands in them without anyone rebuilding Mac. An iOS-only symbol used outside an
`#if os(iOS)` (or `#if canImport(UIKit)`) guard there breaks this target
silently until the next Mac build. This session found and fixed several
(an unused `import UIKit`, `UIBackgroundFetchResult`, `TaskifyPerfMonitor`,
`TaskifyWatchBridge`, `TaskifyTheme.watchAccent`, and the Share-extension
runtime types), plus a genuinely missing `AppModel.persistBeforeTermination()`
that this target's quit path had been calling without an implementation. Run
the build above after pulling upstream changes to `AppModel.swift` or the other
shared files, not only after editing Mac-specific sources.

## Current desktop implementation

- Persistent sidebar, independent windows sharing one account runtime, native
  menus, search, resizable task inspector, and Settings window.
- Week/list/compound boards, board settings (including column rename/delete,
  with a required destination or explicit deletion for that column's tasks),
  archives, sharing/joining, task cards and sortable native table with
  multiple selection and batch actions.
- Quick entry, task editor, notes, subtasks, priorities, scheduling, recurrence
  (daily, multi-day weekly, monthly with an interval, or a custom every-N-units
  interval), reminders, encrypted file attachments and task sharing.
- Today/Upcoming agenda, Taskify event editing with the same recurrence
  controls, participant add/remove with per-participant RSVP status, EventKit
  calendars/reminders, and invitation responses. Shared-inbox rows (tasks,
  boards, calendar invites, contact cards) show who sent them. "Today" rolls
  over at midnight even if the Mac stays open and active straight through it
  (`AppModel.currentCalendarDay`, refreshed on `NSCalendarDayChanged`/
  `NSSystemTimeZoneDidChange` and on wake).
- DM/group conversation layouts, replies, reactions, history search, unread
  state, archive/block controls and encrypted attachments. Per-conversation
  drafts and scroll position persist while navigating between conversations
  (not across leaving the Chat destination and back). Drag-and-drop and
  clipboard paste (a `PasteButton`, since Cmd-V while the composer is focused
  goes to the text field first) for file attachments, also available in the
  task editor's Attachments section; a bot "/" slash-command menu. Inline
  image previews for image attachments; other attachments keep the
  save-to-disk button. An in-flight attachment encrypt/upload (chat send or
  task save) can be cancelled mid-flight rather than only waited out.
- Rich message content: shared tasks/contacts/events/boards render inline as
  interactive cards with the real accept/decline/tentative/join/dismiss
  actions (the same conversation-correlated `SharedInboxItem`-family arrays
  the Inbox tab reads, filtered by peer instead of by pending status, so a
  responded-to item still shows with its resulting status where it was
  actually shared — matches iOS's `ChatTimelineItem` merge exactly, including
  which messages get excluded from the plain-text history in favor of their
  card). Plain-text Cashu tokens render as a tappable card that opens a
  focused redeem sheet; HTTP(S) links render as link-preview cards. All
  detection reuses the same TaskifyCore parsers the iOS app uses.
- Basic Bible reading tracker plus Scripture Memory (add a passage, spaced-review
  list sorted by due/canonical/added date, remove) and Fasting Reminders
  (weekly-weekday or random-per-month pattern) — both reuse AppModel's existing
  entry/settings management and task reconciliation; there is no separate Mac
  scheduling logic.
- Mint balances/activity, ecash receive/send, Lightning invoice/address (LNURL)
  pay, pending receive retries/discard, saved outgoing tokens with check-status
  and reclaim, mint add/remove and mint-to-mint transfer, authenticated wallet
  backup and seed recovery. Payment preparation/confirmation and recovery use
  the existing wallet service; pending results are not reported as settled
  payments. An NWC wallet mode (connect, move or leave the ecash balance,
  switch back) is also available, on the same shared view model and
  `NWCWalletService` as iOS — see `MacNWCWallet.swift`.
- Contact payments: pay a contact's Lightning address (falling back to
  `npub@solife.me`) or send them locked ecash as an encrypted message, using
  the same wire format as the PWA. P2PK key generation/import/removal for
  advanced locking. Cashu payment requests: create (with optional P2PK lock),
  cancel, and pay an incoming request. Static QR codes for invoices, tokens,
  requests and the receiving Lightning address.
- Print Checklist (toolbar on week/list boards; "Print & Scan…" in the Bible
  tracker's Reading tab): renders tasks grouped by column, or all 66 books'
  chapters grouped by book, through the shared `PhysicalChecklistLayout`
  geometry and the exact marker/page-ID drawing `PhysicalChecklistPDFRenderer`
  uses on iOS, so a page printed from Mac stays readable by the iPhone
  scan-back-in flow. Goes through the standard macOS print panel, so "Save as
  PDF" works without separate export code. The scan-back-in side (reading a
  filled-in page's checkmarks) stays iOS-only — it needs a camera.
- Account import/export, profile publishing, task backup/restore, relay controls,
  file-server selection and notification permission.

Shortcuts: New Window `⌘N`, New Task `⇧⌘N`, New Board `⇧⌘B`, Sync `⇧⌘R`,
Send Message `⌘Return`, Settings `⌘,`.

## Data and platform boundaries

Mac identity and wallet Keychain services use the Mac bundle identifier, separate
from iOS. Import the same Nostr identity for account continuity; wallet recovery
is a separate explicit operation. Do not assume signing an existing ad-hoc
installation will migrate its storage or Keychain automatically.

Quit awaits task publication preparation and durable local snapshot saving,
without waiting for relay acknowledgement. A failed local save cancels quitting.
Window selection is local to each window; stores and network coordination are
shared. Watch provisioning stays in iOS.

Local reminders are supported. Closed-app DM push requires a provisioned Mac APNs
topic and matching backend registration contract. The Mac coordinator currently
rejects device registration rather than submitting a Mac token to the iOS topic.

## Remaining parity and release checks

- Pasting raw image data with no backing file (e.g. a browser "Copy Image"
  that never touched disk) — `PasteButton(payloadType: URL.self)` only
  receives file URLs; a `Transferable` path for arbitrary image data needs
  more investigation. Cross-navigation draft/scroll persistence does not yet
  survive leaving the Chat destination entirely (Wallet, Boards, …) and back.
- npub.cash Lightning-address provider selection and claim UI (the always-on
  `npub@solife.me` forwarding address is exposed; npub.cash is not), animated
  multi-frame QR for transfers too large for one code, and camera-based QR
  scanning (no camera-driven scan UI on Mac yet — paste remains the only input).
- Voice entry, widgets, App Intents and share extension integration.
- Account changes with open editors in multiple windows, complete
  preferences and accessibility QA.
- Signed sandbox testing, quit/relaunch and offline/reconnect stress tests,
  cross-client relay sync and wallet recovery with controlled test funds.

## Validation recorded during implementation

macOS and iOS Simulator builds succeeded. The selected shared-core regression
suite executed 200 tests with one opt-in large-file test skipped and no failures.
Five Mac presentation tests pass, covering week placement across DST, list draft
placement, pending/duplicate wallet outcomes and recovery consent across async
authentication.

A separate Debug validation bundle uses synthetic task/chat fixtures, an injected
snapshot/outbox and its own Keychain namespace. UI checks exercised quick entry,
table selection, inspector display and task edits. Validation must not operate the
user's running app or execute live financial transactions.

Navigation regression: open a board, switch to table, select a task, edit/save,
then click Chat while the inspector is visible. The original SwiftUI `.inspector`
crashed during AppKit collapse/layout. The workspace now uses a resizable split
pane; rerun this sequence as part of desktop QA.

See [the port inventory](../docs/plans/native-macos.md) for acceptance scope.

## Save-error fix (September 17, 2026)

macOS can return an App Group URL for an executable that has no corresponding
signed entitlement. Shared storage now checks the running process entitlement
before selecting or migrating to that directory. Unentitled Mac builds save to
`Application Support/TaskifyNative/taskify.json` inside their own container (or
the user Library for an unsandboxed development build). iOS group resolution is
unchanged. Nine storage regression tests cover authorization, migration and
repeated save/reload behavior.

If an older running build reports “Taskify could not save the latest change”,
export Settings → Account → Export Task Backup before quitting. The export reads
the in-memory snapshot and can preserve changes that the old store could not
write. Open the corrected build and restore that backup if needed. Do not force
quit an old build with unsaved changes merely to install the fix.

## Chat, rich content and devotional pass (September 17, 2026)

Added the chat/rich-card/devotional items in "Current desktop implementation"
above. The one structural change: the conversation's message list is now a
dedicated `MacMessageRow` view — folding attachment/payment/shared-item/link
branching directly into the `ForEach` closure hit a real Swift type-checker
timeout ("unable to type-check this expression in reasonable time"), not a
logic error; extracting the row fixed it. Watch for the same failure mode if
more per-message branching is added later — extract another view rather than
adding another inline conditional.

Verified: clean `xcodebuild` succeeded, all 13 `swift test` cases pass, the
built app launches under the preview/fixture harness and stays alive with no
crash log. Not verified: interactive click-through (this sandbox has no
Accessibility/Screen-Recording permission) and Scripture Memory/Fasting
Reminders' generated tasks actually appearing correctly on a real board over
several days — both are exercised by calling the same AppModel methods the PWA
and iOS already rely on, but that call path itself was not run against a live
account in this session.

## Print Checklist pass (September 22, 2026)

Added the Print Checklist toolbar action described in "Current desktop
implementation" above. `MacPhysicalChecklistPrintView` is a line-for-line port
of iOS's `PhysicalChecklistPDFRenderer` (`BibleTrackerView.swift`) onto
AppKit's classic multi-page `NSView` printing (`knowsPageRange`/`rectForPage`,
pages stacked vertically in one tall view) instead of `UIGraphicsPDFRenderer` —
`PhysicalChecklistLayout`'s millimeter geometry and the page-ID marker
encoding are unchanged, so the two renderers should produce matching pages
for the same job. `NSPrintInfo.paperSize` is set explicitly from the chosen
`PhysicalChecklistPaper` and all four margins are zeroed, since the layout
already reserves its own margin — leaving the system default paper size or
margins in place would have scaled or clipped the content against what the
geometry actually expects.

Verified: clean `xcodebuild`, all 13 `swift test` cases pass (no new pure
logic was added — `PhysicalChecklistLayout` itself already has its own
`PhysicalChecklistLayoutTests`), app launches and stays alive under the
preview harness. Not verified: an actual printed (or Save-as-PDF) page's pixel
alignment against a real printer/PDF viewer, and whether a page printed from
Mac is in fact readable by the iOS scan-back-in flow — both need a real
print/export and, for the second, a device with the camera scanner, neither
of which this sandbox can do.

## Correlated shared-item chat cards (September 22, 2026)

Replaced the read-only, content-decoded share cards from the previous pass
with the interactive ones described in "Current desktop implementation"
above. `MacConversation.timeline` merges `model.directMessages(with:)` with
`sharedInboxItems`/`sharedContactInboxItems`/`sharedCalendarInviteItems`/
`sharedBoardInboxItems` filtered to the open peer — copied field-for-field
from iOS's `ChatView.makePresentation()` (`ChatTimelineItem`), including
which two of the four item kinds get excluded from the plain message list
(tasks and calendar invites, by matching `rumorEventID`; contacts and boards
are not excluded there, since the PWA/iOS contract doesn't produce a matching
plain-text message that would render as a duplicate for those two). Getting
that exclusion set wrong in either direction is the failure mode to watch
for — too broad silently drops real messages, too narrow shows a card next
to its own raw envelope text.

`MacMessageRow`'s old envelope-decode fallback (`TaskifyShareEnvelope.decode`)
now only handles `assignmentResponse`, which has no correlated inbox-item
array of its own; task/contact/event/board envelopes resolve to `EmptyView()`
there since their card is already rendered as its own timeline entry.

Verified: clean `xcodebuild`, all 13 `swift test` cases pass (unchanged —
this pass is UI/correlation wiring over already-tested model methods, no new
pure logic), app launches and stays alive under the preview harness. Not
verified: interactive click-through of the new accept/decline/join buttons
against a live conversation with real shared items, for the same sandbox
permission reason as every other pass in this file.

## Bible-chapter checklist printing (September 22, 2026)

Extended Print Checklist to the Bible tracker: `MacPrintChecklistSheet` took
a `board: Board` before, tying the whole sheet to board task-fetching; it now
takes a plain `title` + pre-built `[PhysicalChecklistItem]` (`MacChecklistItems`
assembles the list — `.forBoard` unchanged in behavior, `.forBibleTracker` new,
mirroring `BibleTrackerView.biblePrintJob` field-for-field), so the same sheet
serves both. "Include Completed Tasks" only applies to the board case now (the
Bible tracker always prints the full 66-book overview).

`MacChecklistItems` needed `@MainActor`: it calls `AppModel.tasks`/`.weekStart`
and `BibleTrackerStore.chaptersRead`, and the compiler correctly refused a
nonisolated function calling into `@MainActor`-isolated methods. Every caller
was already on the main actor (SwiftUI sheet closures), so this was a pure
annotation fix, not a behavior change — worth calling out because the previous
pass's `MacRecurrenceBuilder`-style pure helpers get away without `@MainActor`
specifically because they take plain values, never a model reference; a helper
that touches `AppModel`/`BibleTrackerStore` directly will hit this every time.

Verified: clean `xcodebuild` (after that one actor-isolation fix), all 13
`swift test` cases pass, app launches and stays alive under the preview
harness. Not verified: an actual print/PDF of the Bible checklist, for the
same reason as the task-list printing pass.

## Midnight agenda rollover (September 22, 2026)

Added `AppModel.currentCalendarDay` (a stored day, updated only by
`refreshCalendarDayIfNeeded`) and switched `MacAgendaView`'s Today/Upcoming
cutoff to read it instead of computing `Calendar.current.startOfDay(for:
Date())` inline. iOS never needed this: a phone reliably backgrounds and
resumes with a fresh `Date()` on its own, so nothing there reads the new
property. A Mac routinely stays open and active straight through midnight,
so without this, "Today" would stay stuck on yesterday until something else
happened to force a re-render. `MacRuntime` now registers for
`NSCalendarDayChanged` and `NSSystemTimeZoneDidChange` (covers staying awake)
and also calls the refresh from `resume()` (covers waking from sleep).

Registering the notification observer needed an explicit `Task { @MainActor
in }` inside the handler: `NotificationCenter.addObserver`'s closure isn't
statically `@MainActor`-isolated just because the enclosing class is, so
calling straight into `AppModel` (also `@MainActor`) from it hits the same
class of compiler error `MacChecklistItems` did in the previous pass — the
same lesson, a different call shape this time.

Verified: clean `xcodebuild` for both macOS and iOS Simulator (this pass
touches shared `AppModel.swift`), all 13 `swift test` cases pass, app
launches and stays alive under the preview harness. Not verified: watching
the actual rollover happen at a real midnight, or waking from real sleep —
both need to be run for real, not simulated, to be sure.

## Clipboard paste for attachments (September 22, 2026)

Added `PasteButton(payloadType: URL.self)` next to the attach button in both
the chat composer and the task editor's Attachments section (which also
gained drag-and-drop, matching chat) — the same `Transferable`-based
mechanism already proven safe by the existing `.dropDestination(for:
URL.self)` drag handling, rather than the older `NSItemProvider`-based
`.onPasteCommand` this file previously flagged as uncertain. `PasteButton` is
a dedicated control rather than a modifier, partly because Cmd-V while the
composer `TextField` is focused is claimed by the text field's own paste
handling first — a `PasteButton` gives paste-a-file its own explicit,
unambiguous affordance instead of fighting over the same shortcut.

Scope is file URLs only, matching drag-and-drop exactly: copy a file in
Finder, paste it in. Raw image data with no backing file (a browser's "Copy
Image") isn't covered — see "Remaining parity" above.

Verified: clean `xcodebuild`, all 13 `swift test` cases pass (no new pure
logic), app launches and stays alive under the preview harness. Not verified:
an actual paste gesture end to end, for the same sandbox permission reason as
every interactive-click-through gap in this file.

## Attachment upload cancellation (September 22, 2026)

Chat's `send()` and the task editor's `save()` now keep their `Task` (renamed
`sendTask`/`saveTask`) instead of firing it and discarding the handle, and
`MacAttachmentQueueView` grew an `onCancel` closure that shows a "Cancel"
button next to the progress text while an upload is in flight. Cancelling
during the encrypt/upload phase throws `CancellationError` out of
`MacAttachmentQueue.uploadChat()`/`.uploadDocuments()` — both already checked
`Task.checkCancellation()` per file, so this needed no changes to the queue
itself, only a way for the UI to reach the running task. Both catch blocks
special-case `CancellationError` to clear the progress text silently rather
than show it as a failure. For chat specifically, cancelling only reaches the
encrypt/upload step; once the message itself is actually sending, the button
disappears along with the progress text it sits next to. Already-uploaded
files in a batch stay marked uploaded (the queue's existing per-file
`uploadedChat`/`uploadedDocument` cache), so retrying after a cancel resumes
rather than re-uploads.

Verified: clean `xcodebuild`, all 13 `swift test` cases pass (no new pure
logic), app launches and stays alive under the preview harness. Not verified:
actually cancelling a real in-flight upload, for the same sandbox permission
reason as the rest of this file.
