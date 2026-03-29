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

## Initial Slice Started (Milestone A)

Started with Keychain identity/profile storage domain:
- Added `ProfileIdentityStore` with injectable `SecureStore`
- Added tests for profile lifecycle semantics:
  - save active profile
  - track profile names
  - append unique profile names
  - delete profile updates names/active pointer
- Kept `KeychainStore` as production facade backed by Keychain Security APIs

This establishes the baseline TDD/parity pattern for remaining slices.
