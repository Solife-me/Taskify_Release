# Native iOS Parity Execution Strategy (Formal)

This defines the default implementation loop for rebuilding Taskify as a native Swift app with full PWA parity.

## Core Loop (required for each feature slice)

1. **Scope one PWA slice**
   - Identify exact files, data flow, and UI interactions.
   - Document intent + non-obvious rules.

2. **Extract parity spec**
   - Inputs/outputs
   - State transitions
   - Edge/error/offline behavior
   - Sync/conflict rules

3. **Write failing Swift tests first**
   - Unit tests for domain logic
   - Integration tests for feature behavior
   - Interop tests using shared fixtures where applicable

4. **Implement Swift code**
   - SwiftUI-first
   - UIKit only for hard blockers
   - Keep backend contract shared with PWA

5. **Make all tests pass**
   - No implementation merged with failing tests
   - Add regression tests for defects discovered during implementation

6. **Validate cross-client compatibility**
   - PWA-created data behaves correctly in iOS
   - iOS-created data behaves correctly in PWA

---

## Guardrails

- No silent behavioral drift from PWA.
- No iOS-only forks for core task/board/contact/sync semantics.
- Any contract changes must be versioned and coordinated across both clients.
- Key handling is Keychain-first (no plaintext secret persistence).

---

## Test Asset Strategy

- Maintain reusable **golden fixtures** from PWA behavior:
  - payload examples
  - event sequences
  - expected merge outcomes
- Use same fixtures in Swift test suites to enforce parity.

---

## Current Restart Baseline (July 2026)

The earlier native experiment was not functional and is no longer treated as an implementation baseline. The active replacement lives in `taskify-ios-native/`; the release WebView app remains in `taskify-ios/`.

The clean first vertical slice now provides:

- a buildable SwiftUI application and custom PWA-shaped five-tab shell
- weekly board selection, quick task entry, completion, and deletion
- Upcoming date grouping, search, and task entry
- local weekly board creation
- atomic offline JSON persistence
- tests for default state, task mutations, date resolution, and persistence round trips

The next native sync slice now adds:

- automatic native Nostr identity generation plus nsec/hex import, stored only in Keychain
- the PWA's deterministic board signing key, board tag, AES-256-GCM key, and event layout
- kind `30300` board metadata, kind `30301` task state/tombstones, and kind `5` deletion requests
- WebSocket relay subscriptions across the PWA default relay set
- per-relay startup buffering until EOSE, followed by clock-protected task merges
- immediate offline mutations backed by a persistent publish outbox, relay acknowledgements, and retry after reconnect
- golden Swift tests built from fixed PWA signing, key derivation, and encrypted-content fixtures

This is an implemented compatibility foundation, not a claim of production sync parity. A real PWA/iOS two-client convergence pass is still required, and high-volume cursoring/live micro-batching remains stabilization work. Wallet, chat, recurrence, reminders, attachments, list/compound boards, and calendar parity remain later slices.
