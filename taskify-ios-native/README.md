# Taskify Native iOS

This is the clean native SwiftUI replacement for the current `taskify-ios/` WebView release app. The PWA is the behavior and visual reference. The WebView app remains untouched until the native parity gates are complete.

## Current runnable slice

- Native SwiftUI shell matching the PWA's dark glass appearance
- Boards, Upcoming, Wallet, Chat, and Settings navigation
- Weekly board columns with quick task entry
- List-board creation, custom list columns, and list-scoped quick task entry
- Local task completion and deletion
- Rich native task editing for title, notes, priority, due date/time, list placement, and subtasks
- PWA-compatible recurrence presets, custom intervals/weekdays, optional end dates, and next-instance generation on completion
- Multiple relative reminders, exact custom reminder times, and local iOS notification scheduling
- Upcoming tasks grouped by date with search and add flow
- Local board creation and selection
- Atomic JSON persistence in Application Support
- Keychain-backed Nostr identity creation and nsec import
- PWA-compatible deterministic board keys, AES-256-GCM task payloads, and signed Nostr events
- Shared-board join flow, default relay subscriptions, EOSE startup batching, and clock-based merges
- Encrypted PWA-compatible list-board metadata sync, including conversion of joined boards to their remote type and columns
- Disk-backed offline publish outbox with relay acknowledgement handling and reconnect retries
- Aggregate Nostr health reporting with per-relay status, queued-change visibility, and manual/foreground retry
- PWA-compatible task image/document metadata sync that survives native edits and recurrence
- Native decryption and display of current and legacy PWA encrypted attachments, with image zoom and Quick Look document viewing
- PWA-familiar stacked image and document previews with media overflow labels, retry states, and readable file metadata
- Native Photos and Files attachment controls with PWA-compatible AES-GCM encryption, remote-first Originless uploads, and task-level removal
- Cached native rich link cards generated from URLs in task titles and notes, with duplicate inline URLs suppressed in task-card presentation
- Core unit and interoperability tests for state, persistence, recurrence, reminder timing, PWA task/attachment cryptography fixtures, signing, merge clocks, and outbox behavior

Wallet, Chat, calendar integrations, sharing, compound boards, and advanced list management are intentionally marked as migration work instead of being backed by the abandoned native implementation. Board and task relay sync has been manually confirmed in both directions between the native app and PWA. Synced PWA attachments are readable on iOS, and native additions/removals use the PWA's encrypted remote attachment contract and default encrypted file server.

## Open and build

1. Open `TaskifyNative.xcodeproj` in Xcode 27 beta or newer.
2. Select the `TaskifyNative` scheme.
3. Run on an iOS 17 or newer simulator/device.

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
2. Nostr identity, Keychain, relay session, offline outbox, PWA-compatible task events, relay health UI, and two-way board/task interop (complete for the current slice)
3. Rich task editing, list-board mode, recurrence, native reminders, polished link/media previews, and encrypted attachment read/write support (complete); sharing, compound boards, and calendar parity remain
4. Wallet and Chat
5. Widgets, App Intents, background sync, accessibility/performance soak
6. Switch the production target only after PWA/native interop and parity sign-off
