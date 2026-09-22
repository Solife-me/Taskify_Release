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
  boards, calendar invites, contact cards) show who sent them.
- DM/group conversation layouts, replies, reactions, history search, unread
  state, archive/block controls and encrypted attachments. Per-conversation
  drafts and scroll position persist while navigating between conversations
  (not across leaving the Chat destination and back). Drag-and-drop file
  attachments and a bot "/" slash-command menu. Inline image previews for
  image attachments; other attachments keep the save-to-disk button.
- Rich message content: shared tasks/contacts/events/boards render as summary
  cards (informational — respond from the Inbox, which already has the
  correlated accept/decline/join actions); plain-text Cashu tokens render as a
  tappable card that opens a focused redeem sheet; HTTP(S) links render as
  link-preview cards. All detection reuses the same TaskifyCore parsers the
  iOS app uses, so what counts as a "shared item" or "a token" is identical.
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
- Print Checklist (toolbar, week/list boards): renders the board's tasks, grouped
  by column, through the shared `PhysicalChecklistLayout` geometry and the exact
  marker/page-ID drawing `PhysicalChecklistPDFRenderer` uses on iOS, so a page
  printed from Mac stays readable by the iPhone scan-back-in flow. Goes through
  the standard macOS print panel, so "Save as PDF" works without separate export
  code. Bible-chapter checklists and the scan-back-in side stay iOS-only (no
  camera on Mac).
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

- Clipboard paste of files/images into chat (drag-and-drop works; paste does
  not yet — the reliable `Transferable`/`NSItemProvider` shape for pasted
  image data specifically needs more investigation before adding it).
  Cross-navigation draft/scroll persistence does not yet survive leaving the
  Chat destination entirely (Wallet, Boards, …) and back.
- Shared-item cards in chat (task/contact/event/board) are read-only summaries
  that point to the Inbox rather than offering inline accept/decline/join —
  correlating a chat message to its Inbox item for safe inline actions needs
  more investigation before duplicating that logic in two places.
- npub.cash Lightning-address provider selection and claim UI (the always-on
  `npub@solife.me` forwarding address is exposed; npub.cash is not), animated
  multi-frame QR for transfers too large for one code, and camera-based QR
  scanning (no camera-driven scan UI on Mac yet — paste remains the only input).
- Voice entry, widgets, App Intents and share extension integration.
- Account changes with open editors in multiple windows, midnight agenda rollover,
  attachment cancellation/cleanup, complete preferences and accessibility QA.
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
