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

## Current desktop implementation

- Persistent sidebar, independent windows sharing one account runtime, native
  menus, search, resizable task inspector, and Settings window.
- Week/list/compound boards, board settings, archives, sharing/joining, task cards
  and sortable native table with multiple selection and batch actions.
- Quick entry, task editor, notes, subtasks, priorities, scheduling, basic
  recurrence controls, reminders, encrypted file attachments and task sharing.
- Today/Upcoming agenda, Taskify event editing, EventKit calendars/reminders and
  invitation responses.
- DM/group conversation layouts, replies, reactions, history search, unread
  state, archive/block controls and encrypted attachments.
- Mint balances/activity, ecash receive/send, Lightning invoice receive/pay,
  pending receive retries, saved outgoing tokens, authenticated wallet backup
  and seed recovery. Payment preparation/confirmation and recovery use the
  existing wallet service; pending results are not reported as settled payments.
- Account import/export, profile publishing, task backup/restore, relay controls,
  file-server selection, notification permission and basic Bible tracking.

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

- Advanced recurrence editing, column rename/delete controls, event recurrence
  and participant editing, richer invitation/contact details.
- Chat drafts across navigation, rich payment/share cards, bot controls, inline
  media preview, drag/paste attachments and scroll-position preservation.
- Lightning addresses/LNURL, payment requests, P2PK/contact payments, mint
  transfers, outgoing reclaim/check UI and advanced wallet settings/QR workflows.
- Full Bible/scripture/fasting features, voice entry, printing, widgets, App
  Intents and share extension integration.
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
