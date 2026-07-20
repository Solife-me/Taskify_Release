# Taskify Native iOS

This is the clean native SwiftUI replacement for the current `taskify-ios/` WebView release app. The PWA is the behavior and visual reference. The WebView app remains untouched until the native parity gates are complete.

## Current runnable slice

- Native SwiftUI shell matching the PWA's dark glass appearance
- Boards, Upcoming, Wallet, Chat, and Settings navigation
- Weekly board columns with quick task entry
- Local task completion and deletion
- Upcoming tasks grouped by date with search and add flow
- Local board creation and selection
- Atomic JSON persistence in Application Support
- Keychain-backed Nostr identity creation and nsec import
- PWA-compatible deterministic board keys, AES-256-GCM task payloads, and signed Nostr events
- Shared-board join flow, default relay subscriptions, EOSE startup batching, and clock-based merges
- Disk-backed offline publish outbox with relay acknowledgement handling and reconnect retries
- Core unit and interoperability tests for state, persistence, PWA cryptography fixtures, signing, merge clocks, and outbox behavior

Wallet, Chat, rich task editing, calendar integrations, reminders, recurrence, attachments, list boards, and compound boards are intentionally marked as migration work instead of being backed by the abandoned native implementation. Live two-client PWA/iOS relay validation is also still required before sync parity is considered release-ready.

## Open and build

1. Open `TaskifyNative.xcodeproj` in Xcode.
2. Select the `TaskifyNative` scheme.
3. Run on an iOS 17 or newer simulator/device.

The migration bundle identifier is `solife.me.Taskify.Native`, which allows the native build to coexist with the release WebView app during parity testing.

The migration target currently omits the shared app-icon catalog because this development machine's Xcode, installed iOS platform, and CoreSimulator components are mismatched. The release app's icon files are unchanged and should be added to this target when that host toolchain is updated.

## Validate

```sh
swift test --package-path taskify-ios-native
xcodebuild -project taskify-ios-native/TaskifyNative.xcodeproj \
  -target TaskifyNative \
  -sdk iphoneos \
  CODE_SIGNING_ALLOWED=NO \
  SYMROOT=/tmp/taskify-native-products \
  OBJROOT=/tmp/taskify-native-objects \
  build
```

## Migration order

1. Native shell and offline task vertical slice (complete)
2. Nostr identity, Keychain, relay session, offline outbox, and PWA-compatible task events (implemented; live two-client validation pending)
3. Rich task editing, board/list modes, recurrence, reminders, attachments, sharing, and calendar parity
4. Wallet and Chat
5. Widgets, App Intents, background sync, accessibility/performance soak
6. Switch the production target only after PWA/native interop and parity sign-off
