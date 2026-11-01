# macOS Multi-Account Isolation Audit

**Date:** 2026-10-30

**Scope:** Native macOS multi-account storage, identity switching, delayed async work, notifications, Spotlight, relay authentication, attachment uploads, wallet-adjacent identity operations, and device-wide projections.
**Base commit:** `6547befd716847fc186b6dcae9e43065d36709e5`

## Executive Summary

The audit found several credible cross-account paths and fixed them. The important failures were not limited to UI state: stale work could reread a newly selected Keychain identity, launch could select the generic primary store for an unknown identity, account preferences were shared, and delayed Spotlight or notification work could cross the switch boundary.

After the fixes in this audit, every account-owned local store and preference suite is selected from the account model's immutable expected identity. Account changes stop and fence the old model before the global Keychain identity changes, verified writes are required before the new model becomes active, and stale callbacks fail closed unless they still match their originating account.

The remaining device-wide behavior is explicit and intentional: wallet funds and connections, APNs installation state, appearance/onboarding choices, and primary-account widget/intent/watch projections. These are not account-partitioned copies of account data. The wallet's identity-derived subfeatures now use a captured account context rather than rereading the global Keychain.

## Findings and Resolution

| Severity | Finding | Resolution |
| --- | --- | --- |
| Critical | Bible/Scripture state, relays, app-state ledger, chat retention, notification preferences, media servers, fasting/streak/startup/week settings, and print-job state used global `UserDefaults`. | Account-specific preference suites are created from the public key. Legacy values migrate once into the first primary account only. |
| Critical | Switching the global Keychain key while an old model still had async work allowed old content to be signed or state to be applied against the wrong active identity. | `AppModel` now holds an immutable expected account id; every operational identity lookup is account-bound. Account switching stops and cancels all tracked work, clears cached identity, stops relay auth, and only then changes Keychain. |
| Critical | A Keychain identity not present in the saved-account vault could fall through to the generic primary store. | Startup trusts the Keychain identity only when it is already a valid vault entry; otherwise it restores the saved primary. Unknown ids and malformed vault rows fail closed. |
| Critical | First-run account import changed the Keychain identity behind the account vault. | First-run import now goes through the vault, safely moves the placeholder primary store/outbox into its own account folder, promotes the imported account to primary, and rolls back the move and both Keychain writes on failure. |
| High | Attachment uploads reread the global Keychain and global file-server settings. | Upload calls receive the model's captured identity and account-scoped defaults. Shared-task drafts verify the draft account after upload. |
| High | A delayed old-account Spotlight update could reactivate the old account and repopulate its visible index. | Spotlight activation is now runtime-controlled. Delayed updates can only update an already-active matching account; they cannot select or reactivate an account. |
| High | Task/event notification actions and urgent alarms were account-agnostic. | Notification userInfo, alarm ids, action parsing, navigation, and the action router all carry and require an account id. Legacy actions without an account id are ignored. |
| High | An in-flight notification reschedule from the retiring model could install or remove notifications after the switch. | Notification coordinators have a terminal closed state checked after every suspension point; scheduled requests and urgent alarms are removed if closure wins the race. |
| High | DM push preview selection was a single App Group value shared by all accounts. | Selection is keyed per account. Pending previews and DM local notifications carry the account id. |
| High | Contact-list mutations, profile enrichment, and own-profile publication could apply results after an identity change. | Account checks fence operations after relay discovery, proof of work, decryption, upload, and before publication. |
| High | Identity-derived solife.me/NWC/npub.cash wallet operations read whatever Keychain key was current when an async task resumed. | The shared wallet receives an explicit active Nostr account context. Mac call sites capture that account before starting an operation; multi-account mode never falls back to global Keychain while unbound. |
| Medium | Saved-account rows did not verify that `publicKeyHex`, `npub`, and the private key described the same account. | Vault entries are canonicalized and rejected unless all public metadata matches the derived identity. Corrupt rows cannot choose another account's folder or primary store. |
| Medium | Account-vault writes were assumed successful without readback. | Saved-account and active-identity Keychain writes are read back and verified. A vault read failure blocks account mutation rather than overwriting unread state. |
| Medium | Open editors, drafts, split tabs, selections, and settings fields could survive a model replacement in another window. | Every Mac window and the Settings scene are rebuilt at the identity boundary. Global menu actions are disabled during switching. |
| Medium | Secondary accounts could overwrite primary-only widget/App Intent/Watch projections. | Device projections are written only by the primary account model. Secondary accounts never trigger widget reloads or replace the primary editor projection. |
| Medium | Fresh relay connections could authenticate with a process-wide identity after a switch. | Unowned connections now fail closed. Only connections explicitly constructed with an account identity can answer NIP-42 AUTH. |
| Medium | Task presentation choices (`completedTab`, `hideCompletedSubtasks`) remained device-global on Mac. | They are read and written through the active account's preference suite and refreshed with the rest of the workspace at account switches. |
| Medium | The account manager could not remove the current account, and removing the primary had no safe store transition. | Current/secondary removal switches to a remaining account first. Primary removal promotes a replacement, swaps the generic and account-scoped stores/outboxes, verifies the Keychain writes, and rolls the entire transition back on failure. |

## Account-Switching Invariants

1. A model's account id, task store, outbox, preference suite, and primary/secondary role are immutable for its lifetime.
2. An identity is accepted only when it matches the model's expected account and the model is still active.
3. The old model is persisted, unregistered from notification/DM routing, stopped, persisted again, and detached from relay authentication before the Keychain identity changes.
4. The target account's vault row and derived identity are validated before the switch begins.
5. The target identity write is read back and verified. Failure restores the previous Keychain identity and rebuilds the previous model.
6. Spotlight is cleared and activated for the target only by the runtime, after the old model is stopped and before the new account model loads.
7. Old work may finish only against its own inactive model. It cannot publish account-owned actions, update the visible Spotlight index, install notifications, or navigate an account-owned destination under the new account.
8. Account-list load or write failure is a hard stop for switching; the app never guesses which saved account a damaged vault meant.

## Data Boundaries

### Account-scoped for macOS

- Tasks, boards, calendar/events, contacts, direct messages, unread/read state, chat archives, and encrypted attachment references.
- Nostr outbox and account backup/app-state ledgers.
- Encrypted account-backup board tombstones. They live in the account-scoped preference suite and are indexed again by public key before use, so replacing an identity in the same process cannot inherit another account's deletions.
- App relays, excluded relays, NIP-17 state, DM push selection/relay configuration, and account backup baseline.
- Bible Tracker, Scripture Memory, fasting reminders, streaks, chat retention, startup board, week layout, new-task ordering, media servers, and physical checklist jobs.
- Mac task presentation preferences and all transient workspace/editor/split-view state.

### Intentionally device-wide

- Wallet funds, mints, Cashu tokens, saved NWC connections, and recovery material. The wallet is one device wallet, not one wallet per Nostr account.
- APNs installation id and device token; multiple account registrations share one installation.
- Notification authorization, appearance, wallet currency/display settings, and onboarding completion.
- The decrypted attachment cache. Entries are content-addressed by URL plus cryptographic key/nonce metadata; they are not a browsable per-account store.

### Primary-account-only projections

- Widgets, production App Intents/Shortcuts, Watch provisioning, and the default App Group task store represent the primary account only. A secondary account must never overwrite them.
- Inactive accounts do not run relay sync or schedule the active notification set. Switching to an account starts its own sync; switching away preserves its local store/outbox for the next visit.
- DM push can only present a decrypted rich preview when the current Keychain identity is the pushed account. Otherwise the generic alert is retained and cannot complete or reply as another account.

## Verification

- `swift test` for `taskify-ios-native`: 911 XCTest cases passed with 14 skipped, plus 50 Watch runtime XCTest cases and 44 Swift Testing cases; zero failures.
- `swift test` for `taskify-macos`: 53 presentation/runtime tests passed; zero failures.
- Unsigned `TaskifyMac` `Local` build: succeeded.
- Unsigned `TaskifyNative` iOS Simulator `Local` build: succeeded.
- Generated Xcode project check: `TaskifyMac.xcodeproj matches generate-project.py`.
- Isolated Mac UI account-switch smoke test was attempted, but the host test runner failed to initialize UI automation (`Timed out while enabling automation mode`). This is an environment/tooling failure before test execution, not an assertion failure. The underlying editor-reset behavior is also enforced structurally by identity-scoped window and Settings rebuilds.

## Residual Notes

- Account switching is intentionally blocked when the saved-account Keychain item cannot be loaded or verified. Restarting is safer than choosing an account from partial state.
- Notification actions created before account ids were added to the contract are intentionally ignored. They are stale and cannot be attributable safely.
- The wallet is a device-wide asset boundary. A user who wants strict wallet separation must use separate macOS user accounts or separate Taskify installations; Nostr account switching does not partition funds or NWC connections.
- The UI automation gate must be rerun on a host where Xcode UI automation is enabled before release QA is considered complete.
