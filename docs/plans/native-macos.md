# Native macOS Taskify

The Mac app uses a dedicated SwiftUI/AppKit target, sharing TaskifyCore and the
existing app coordination and wallet services with iOS. It does not use Catalyst.
The iOS application remains the functional reference. A compiling target alone
is not feature parity or release approval.

Implementation status and build instructions: [Mac README](../../taskify-macos/README.md).

## Desktop experience

Persistent navigation sidebar with boards and destinations; resizable workspace;
selection-driven task inspector; keyboard commands and native menus; independent
windows with a shared account store; Settings scene; system light/dark appearance.
Chat uses a conversation list beside message history. Upcoming presents an agenda
and calendar. File import/export uses native panels and security-scoped access.

## Port and acceptance inventory

- Boards: week/list/compound, columns, archive, reorder, shared boards/templates.
- Tasks: rich editor, subtasks, recurrence/deletion scope, scheduling, reminders,
  attachments, sharing, drag/drop and batch selection.
- Upcoming: task agenda, calendar events, EventKit calendars/reminders, invitations.
- Chat: identity/contact directory, DMs/groups, replies/reactions, attachments,
  search, unread state, retention, block/archive/delete, structured shares.
- Wallet: mint management, ecash and Lightning, payment requests, pending recovery,
  transaction history, backup/restore, P2PK keys, addresses and contact payments.
- Account: Keychain identity, encrypted backup continuity, relay settings/status,
  durable offline outbox, onboarding, notifications, appearance and startup choices.
- Additional features: Bible tracker, scripture memory, fasting reminders, voice,
  printing, App Intents, widgets and native sharing integration.

## Platform boundaries

Keep task mutation, recurrence, encryption, wire formats, and durable payment logic
shared. Conditional compilation is limited to platform services and UI. Mac window
selection must not create independent stores or competing account sync engines.

Watch pairing and iOS background scheduling stay on iPhone. Mac push needs its own
APNs topic and server support; do not send Mac device tokens to the iOS registration
contract. Notification reminders can use UserNotifications independently. Do not
claim closed-app DM delivery until provisioned and verified end to end.

## Verification

Build macOS and iOS; run existing shared core tests plus Mac-specific lifecycle and
selection checks. Manually verify multiple windows, quit/relaunch persistence,
offline changes and reconnect, keyboard navigation, VoiceOver, light/dark appearance,
file access, account import, cross-client sync and payment recovery with test funds.
Track any incomplete feature explicitly in the Mac README before release.
