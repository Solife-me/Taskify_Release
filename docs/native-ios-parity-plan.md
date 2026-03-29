# Taskify Native iOS Parity Plan (SwiftUI-First)

## 0) Decisions Locked

1. **UI framework:** SwiftUI-first. UIKit only when there is no practical SwiftUI equivalent.
2. **Backend contract:** Shared PWA + iOS contract (same APIs/schemas/semantics). iOS-only endpoints allowed only for truly native concerns.
3. **Key handling:** Keychain-first native nsec flow.
4. **Scope target:** Full parity (not partial).
5. **Release strategy:** Keep WKWebView app until native app is production-ready, then replace.
6. **Interoperability:** PWA and iOS must be cross-compatible for sign-in, boards, tasks, contacts, settings, sync/share.

---

## 1) Product Goal

Build a fully native Swift iOS app that matches the PWA’s UI/UX and functionality as closely as possible, while preserving complete cross-compatibility of user data and sync behavior.

---

## 2) Non-Negotiable Technical Requirements

### 2.1 Shared Contract Rules

- No iOS-specific forks of core behavior for:
  - task CRUD
  - board/list/week grouping
  - contacts
  - shared board sync
  - settings persistence semantics
- API payload shapes and field semantics must match existing PWA expectations.
- If contract changes are needed, they are versioned and rolled out to both clients.

### 2.2 Data Compatibility

- A user signing in with same nsec on PWA and iOS sees equivalent state.
- Event ordering conflict rules must be equivalent (latest-write / nostr clock behavior).
- Cross-client edits must converge predictably.

### 2.3 Security

- nsec imported and stored in iOS Keychain.
- No plaintext persistence of secret in UserDefaults/local files.
- biometric unlock optional later (not required for parity v1 unless already present in PWA semantics).

---

## 3) Target Native Architecture

## 3.1 App Layers

- **Presentation (SwiftUI):** screens, components, navigation, gestures.
- **Feature ViewModels:** state orchestration, user intents, effects.
- **Domain Layer:** task/board/contact models, reducers/transformers, validation.
- **Data Layer:** API + Nostr + local persistence + key management.
- **Infra Layer:** logging, metrics, feature flags, runtime config.

## 3.2 Suggested Modules (logical, can be folders/packages)

- `CoreModels` (Task, Board, Contact, Settings)
- `CoreSync` (Nostr/event merge, cursor/state)
- `CoreStorage` (SQLite/SwiftData/GRDB decision)
- `CoreSecurity` (Keychain)
- `FeatureBoards`
- `FeatureTasks`
- `FeatureContacts`
- `FeatureCalendar`
- `FeatureSettings`
- `FeatureWallet` (if part of strict parity target)
- `UIShared` (tokens, reusable components)

---

## 4) Parity Matrix (Build Order)

## Milestone A — Foundation

- App shell/navigation structure matching PWA IA
- Design tokens/theme parity (spacing, typography, color system, component radii)
- Keychain identity import/export flow
- Base network stack + shared API client
- Base Nostr client wiring + relay config ingestion

**Exit gate:** user can sign in with nsec and reach empty-state app shell.

## Milestone B — Core Task/Board Engine

- Boards list and board selection
- Task CRUD in list boards and week boards
- Sorting/grouping rules parity
- Due date/time/timezone behavior parity
- Attachments baseline display/upload hooks

**Exit gate:** side-by-side board/task behavior parity with PWA on core flows.

## Milestone C — Sync + Shared Boards

- Relay subscriptions, EOSE handling, cursoring
- Merge/conflict semantics aligned with PWA
- Shared board membership visibility parity
- Startup sync stability and timeout behavior parity

**Exit gate:** same account on PWA+iOS converges to same board/task state under concurrent edits.

## Milestone D — Contacts + Sharing

- Contacts list/detail parity
- NPUB/QR behavior parity
- contact card/share payload parity
- Follow/sync behaviors as implemented in PWA

**Exit gate:** contact identity/share flows behave identically across clients.

## Milestone E — Remaining Feature Parity

- Calendar/upcoming/task detail parity
- Settings parity
- Wallet-related parity (if included in native v1 target)
- Any remaining modal/sheet flows

**Exit gate:** full parity checklist complete.

## Milestone F — Stabilization + Replacement Readiness

- Perf profiling (cold start, list virtualization, scroll smoothness)
- Crash-free soak in internal TestFlight
- Regression matrix pass (PWA ↔ iOS interop)
- Wrapper replacement decision

---

## 5) UI/UX Parity Strategy

- Build a **screen-by-screen parity checklist** with references (PWA screenshots/video clips).
- For each screen:
  - layout parity
  - interaction parity (tap/long-press/swipe/drag)
  - edge states (loading/empty/error/offline)
  - animation parity (where meaningful)
- Keep a “known deltas” log; no silent drift.

---

## 6) Cross-Compatibility Test Matrix (PWA ↔ iOS)

Minimum required scenarios:

1. Sign in same nsec on both clients; identical board/contact visibility.
2. Create/edit/delete task on iOS, observe convergence on PWA.
3. Create/edit/delete task on PWA, observe convergence on iOS.
4. Concurrent edits on both clients; verify deterministic winner.
5. Offline edits on one client then reconnect; verify merge behavior.
6. Shared board updates propagate both ways.
7. Contact updates/npub metadata visible both ways.
8. Settings that are intended to sync are consistent both ways.

---

## 7) Delivery Process

- Use feature flags per major module.
- Keep wrapper app untouched except critical fixes.
- Native app advances in vertical slices, each with acceptance tests.
- No replacement until:
  - parity checklist complete
  - interop matrix passes
  - stability/performance gates pass

---

## 8) Open Technical Decisions (Need resolution early)

1. **Local storage engine** for native app (SwiftData/CoreData/GRDB/SQLite).
2. **Nostr Swift stack** choice and how closely it can match runtime semantics.
3. **Background sync policy** under iOS constraints.
4. **Attachment pipeline** parity with PWA (upload endpoints, caching, preview behavior).
5. **Wallet parity scope** in v1 if wallet remains part of strict parity requirement.

---

## 9) Immediate Next Actions

1. Create `taskify-ios` architecture skeleton (modules/folders + dependency boundaries).
2. Draft API/Nostr contract conformance doc from current PWA behavior.
3. Build Milestone A vertical slice:
   - sign-in via nsec
   - keychain storage
   - app shell navigation
4. Define and commit parity checklist template in `docs/`.
5. Add automated interop test cases for core task sync scenarios.

---

## 10) Definition of Done (for wrapper replacement)

- Full parity checklist signed off.
- PWA ↔ iOS interop matrix fully passing.
- No blocker regressions in internal TestFlight soak period.
- Native app meets UX quality bar (navigation responsiveness, stable sync, attachment/media reliability).

When all are true, replace WKWebView iOS wrapper with native app.
