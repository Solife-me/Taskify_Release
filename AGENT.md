# AGENT.md — Taskify Onboarding Guide

Practical orientation for AI agents and human contributors. Read this before touching code.

---

## Project Structure Map

```
Taskify_Release/
├── taskify-pwa/          # React + Vite PWA (main user-facing app)
│   ├── src/
│   │   ├── agent/        # Agent mode dispatcher, security, idempotency
│   │   ├── domains/      # Domain logic: tasks, nostr, backup, calendar, push, etc.
│   │   ├── nostr/        # Nostr session layer: NDK, relay health, startup stability
│   │   ├── mint/         # Cashu mint connections and session management
│   │   ├── wallet/       # Cashu wallet ops: swap, p2pk, NWC, lightning, seed
│   │   ├── ui/task/taskActions.tsx # What task/event cards can do, provided once by App; BoardTaskCard, BoardEventCard, Upcoming cards
│   │   ├── ui/board/BoardPage.tsx    # The Boards page body: week, lists and Bible views, Completed, board Upcoming
│   │   ├── styles/       # app-shell.css and boards-and-tasks.css are the mobile layout; desktop-layout.css rearranges it (rail with boards) for mouse desktops ≥1024px
│   │   ├── onboarding/   # First run, key-backup reminder, reminder-notification offer (rules in firstRunRules.ts)
│   │   ├── components/   # Shared React components
│   │   ├── chat/         # Wallet-independent PWA ChatShell: always-mounted DM runtime, lazy page, per-view components, hooks and presentation helpers
│   │   ├── context/      # React context providers
│   │   ├── identity/     # The user's Nostr identity: public key and signer; raw key only via revealLocalSecretKey
│   │   ├── state/        # Synchronous app stores (tasks, boards, events) read via useSyncExternalStore
│   │   ├── storage/      # Local storage abstractions
│   │   ├── ui/           # UI primitives and layout components
│   │   └── types/        # Shared TypeScript types
│   ├── public/           # Static assets, service worker manifest
│   └── package.json      # PWA dependencies (React 19, NDK, Cashu, nostr-tools)
│
├── taskify-core/         # Shared pure domain contracts and utilities
├── taskify-runtime-nostr/ # Shared Nostr transport and orchestration
├── taskify-cli/          # CLI consuming shared core/runtime packages
│   └── src/commands/    # Command groups and shared command context; index.ts composes groups
│
├── worker/               # Cloudflare Worker (backend)
│   ├── src/
│   │   └── index.ts      # Worker entry: push notifications, reminders, cron, backups
│   └── migrations/       # D1 SQL migrations
│
├── taskify-ios-native/   # Native SwiftUI app and TaskifyCore Swift package
│   ├── Sources/TaskifyApp/        # iOS UI, APNs lifecycle, wallet, settings
│   ├── Sources/TaskifyCore/       # Nostr/NIP-17 crypto, relay sync, core policy
│   └── Tests/TaskifyCoreTests/    # Native unit and interoperability tests
│
├── taskify-macos/        # Native SwiftUI/AppKit Mac target sharing iOS services
│   ├── Sources/         # Desktop UI and pure presentation helpers
│   ├── Scripts/         # Deterministic Xcode-project generator and read-only CI check
│   ├── Tests/           # Mac presentation and runtime-configuration regression tests
│   └── UITests/         # Isolated app-host smoke tests; never use a production identity/store
│
├── taskify-push-relay/   # Dedicated NIP-17 inbox relay, APNs/FCM/Web Push bridge, StartOS package
│   ├── src/              # Relay, NIP-42/NIP-98 auth, store, APNs provider
│   ├── startos/          # Start SDK 2.x manifest, action, daemon, interface, backup
│   └── test/             # Protocol, persistence, APNs, and WebSocket integration tests
│
├── docs/                 # Project documentation
│   ├── README.md              # Documentation index
│   ├── reference/             # Architecture and operational guides
│   ├── plans/                 # Implementation plans and roadmaps
│   └── audits/                # Dated investigations
│
├── scripts/              # Build helpers (install-worker-deps.mjs, etc.)
├── wrangler.toml         # Cloudflare Worker + asset config
└── AGENT.md              # This file
```

---

## Architecture Overview

Taskify is a **privacy-first, local-first task manager** with Nostr-based sync and Cashu payments. There is no traditional backend database storing user tasks — all task data lives in signed Nostr events.

### Components

| Layer | Tech | Role |
|---|---|---|
| **PWA** | React 19, Vite, Tailwind | UI, local state, Nostr sync, Cashu wallet |
| **Cloudflare Worker** | Wrangler, TypeScript | Push notifications, reminder scheduling, backup storage, cron triggers |
| **Native iOS app** | SwiftUI, TaskifyCore | Native task/chat/wallet client, NIP-17 inbox, local notification classification |
| **Native macOS app** | SwiftUI/AppKit, shared native services | Desktop boards, agenda, chat, wallet and settings; see taskify-macos/README.md for parity gaps |
| **Taskify Push Relay** | Node.js, Nostr, APNs, Web Push, StartOS | Encrypted kind-1059 retention, opaque-token APNs rich-preview delivery, and generic Web Push chat alerts for the PWA |
| **Nostr relay network** | NDK, nostr-tools | Decentralized event transport and persistence |

### Data Flow

```
User action (PWA)
  → Signs NIP-01 event with user's nsec
  → Publishes to Nostr relays via NDK SessionPool
  → Other devices subscribe and receive events
  → Local state updated via nostrAppState reconciler

Reminders (Worker cron, every 1 min)
  → Reads TASKIFY_REMINDERS KV
  → Sends Web Push via VAPID to registered devices
  → Logs to D1 database

Backups
  → Encrypted Nostr event export stored in R2 (taskify-backups)
```

### Nostr Session Layer (`taskify-pwa/src/nostr/`)

- `NostrSession.ts` — per-user NDK session lifecycle
- `SessionPool.ts` — manages multiple concurrent sessions
- `RelayHealth.ts` — tracks relay responsiveness and drops unhealthy relays
- `startupStability.ts` — prevents relay event floods from stalling startup (critical: see `startupStability.test.ts`)
- `SubscriptionManager.ts` — NDK subscription lifecycle
- `PublishCoordinator.ts` — batched/retried event publishing
- `RelayAuth.ts` — NIP-42 relay authentication

### Cashu / Wallet Layer (`taskify-pwa/src/wallet/`, `src/mint/`)

- Uses `@cashu/cashu-ts` v4 and `@cashu/crypto`
- Supports P2PK (NIP-61), NWC (NIP-47), lightning, seed-based key derivation
- `SwapManager.ts` — atomic token swaps
- `MintSession.ts` — per-mint connection lifecycle
- `LockedTokenManager.ts` — locked token bookkeeping
- `CashuWalletModal` is optional, lazy and wallet-only. Chat never imports it; the wallet may read
  Chat-owned contacts through `ChatRuntime` for payment selection and scanned-contact metadata.
- Always pass `walletEnabled` into `useWalletShellState`; it synchronously prevents a disabled
  wallet route or prefetch request from loading the Cashu chunk before navigation redirects.

---

## Protocols and Standards in Use

| Protocol | Purpose | Key Files |
|---|---|---|
| **NIP-01** | Core Nostr event structure | `nostr/`, `domains/nostr/` |
| **NIP-17** | Private DMs, kind-10050 inbox relay preferences, sender/recipient delivery copies | `taskify-ios-native/Sources/TaskifyCore/Nostr/NostrSharedInbox.swift`, `taskify-ios-native/Sources/TaskifyCore/Nostr/NIP17InboxRelayResolver.swift` |
| **NIP-59** | Gift-wrapped Nostr events with randomized timestamps and ephemeral outer keys | `taskify-ios-native/Sources/TaskifyCore/Nostr/NostrSharedInbox.swift` |
| **NIP-42** | Relay authentication | `nostr/RelayAuth.ts`, `taskify-ios-native/Sources/TaskifyCore/Sync/TaskSyncEngine.swift`, `taskify-push-relay/src/server.js` |
| **NIP-98** | Authenticated chat-push device registration (Apple native apps and PWA) | `taskify-ios-native/Sources/TaskifyCore/Nostr/DMPushRegistrationClient.swift`, `taskify-pwa/src/domains/push/chatPush.ts`, `taskify-push-relay/src/auth.js` |
| **NIP-47** | Nostr Wallet Connect (NWC) | `wallet/nwc.ts` |
| **NIP-61** | Nutzap / P2PK Cashu | `wallet/p2pk.ts` |
| **NIP-96** | File/backup storage over Nostr | `nostr/Nip96Client.ts` |
| **Cashu NUT-16** | Offline/deterministic tokens | `wallet/nut16.ts` |
| **Web Push (RFC 8030)** | Push notifications via VAPID | `worker/src/index.ts` |
| **Apple Push Notification service** | Generic DM alert delivery with device-side rich preview decryption | `taskify-ios-native/Sources/TaskifyNotificationService/NotificationService.swift`, `taskify-ios-native/Sources/TaskifyApp/Notifications/DMPushNotificationCoordinator.swift`, `taskify-push-relay/src/apns.js` |
| **DLEQ proofs** | Cashu blind signature verification | `wallet/dleq.ts` |

---

## Dev Workflow and Branch Promotion Path

```
your-feature-branch  (branch from New_Features_Fixes)
        ↓ PR
  New_Features_Fixes  (integration, staging)
        ↓ PR (after QA)
        Beta           (pre-release testing)
        ↓ PR (after sign-off)
        main           (production)
```

### Local Dev

**PWA:**
```sh
cd taskify-pwa
npm install
npm run dev          # Vite dev server
npm test             # Vitest
npm run lint         # ESLint
```

**Shared Nostr runtime and CLI:**
```sh
cd taskify-runtime-nostr
npm test             # builds, then runs transport/unit tests (including a loopback fake relay)

cd ../taskify-cli
npm test             # rebuilds the bundled CLI before the Node test suite
```

The runtime suite runs without `--test-force-exit`: it must finish by itself, which proves
transport teardown (`session-shutdown.test.ts` also checks that a process exits once its session
shuts down). If it ever hangs, something a shut-down session owns is still running. The
NIP-42/NIP-13 integration tests bind a loopback port and may need a local test environment that
permits listening on `127.0.0.1`.

**Worker (local):**
```sh
# Requires Cloudflare account + wrangler auth
# Create .dev.vars with the required local Worker secrets
npx wrangler dev
```

### Important Notes

- Test runners are package-specific: `taskify-core` uses Node's built-in `--test`, while
  `taskify-pwa` uses Vitest through `npm test`.
- Behaviour every client must compute identically belongs in `taskify-core`, with input/expected
  vectors in `taskify-core/fixtures/` that both the Node tests and `TaskifyCoreTests` read.
- No monorepo build tool — each JavaScript package has its own manifest and lockfile.
- Shared package builds clean and regenerate tracked `dist/` output; include regenerated files with source changes. See `README.md` for package test commands.
- PWA build output (`taskify-pwa/dist/`) is served by the Cloudflare Worker via `[assets]` binding.
- PWA startup JavaScript has a budget: `npm run check:startup` after a build (CI runs it). Everything
  `main.tsx` imports counts; optional features load lazily from `App`. The wallet's providers run in
  a lazily mounted `WalletRuntime`; import wallet hooks from `context/walletContexts`, never from
  the provider modules.
- The committed Mac Xcode project is generated. Run
  `python3 taskify-macos/Scripts/generate-project.py --check`, the Mac package tests with a
  scratch path outside the repository, the unsigned `Local` app build, and the isolated Mac UI
  smoke test after changing Mac sources or any shared iOS-app source in the generator manifest.
  The UI-test configuration has a different bundle id, session-scoped temporary store/outbox and
  Keychain service, and starts neither relays nor the wallet. CI runs all four gates on the Xcode
  27 runner; the UI gate currently contains ten isolated smoke tests, including the local
  Spotlight-index/open/remove lifecycle and raw-image paste in both attachment composers. The
  first smoke also terminates the app, invokes Add Task out of process through
  `AppIntentsTesting`, relaunches, and verifies the saved task.
- Production Mac builds still publish no App Shortcuts. C11-6A compiles the shared intent/provider
  only in the `UITest` configuration behind `TASKIFY_MAC_SHORTCUTS`; do not add that flag to Local,
  Debug, or Release until the signed terminated-app test passes on a host with Apple development
  signing. The production Mac target now has the APNs entitlement and app-delegate lifecycle for
  the C11-7A provisioning gate, but registers only after the existing push opt-in succeeds. A
  `DEBUG` build can exercise that opt-in with `--taskify-dm-push-provisioning-spike`; Release has no
  product toggle yet. Mac DM push must use an explicit `macos` registration and its own APNs topic;
  never send a Mac token through the iOS default, and do not call C11-7A complete until a generic
  alert reaches a terminated signed Mac app and opens Chat.
- Chat typing debt is tracked by explicit paths in `eslint.config.js`. When removing a Chat file's
  `@ts-nocheck`, remove that path from the allowlist too; do not restore a broad `src/chat/**` glob.
  Thread actions and utilities now expose typed hook contracts; preserve cached-data normalization
  and callback behavior when checking the remaining transport hooks and runtime views.
  Send-hook state and session dependencies reuse the owning hooks' return types rather than
  redeclaring their setter and publishing signatures.
- Wrangler config (`wrangler.toml`) is at repo root; it references paths relative to root.

---

## Testing Strategy and Current Gaps

### What Is Tested

| Test File | Domain | What It Covers |
|---|---|---|
| `src/nostr/boardHistoryRace.test.tsx`, `src/chat/hooks/useDmSubscription.test.tsx`, `src/nostr/useSyncResume.test.tsx` | PWA board/DM history recovery, inbox routing, browser resume | Preserves complete DM history and sender-copy deduplication, discovers native inbox relays, retains the wallet's opt-in payment handler while wallet-independent Chat leaves tokens inert; see `docs/audits/pwa-client-history-sync-2026-09-11.md` |
| `src/theme/useAppAppearance.test.tsx` | Appearance settings | Font bounds, theme transitions, status-bar color, object-URL cleanup, and image fallback |
| `taskify-cli/tests/task-ordering.test.ts` | CLI task ordering | Position moves, legacy orders, deterministic ties, ambiguous IDs, scope validation, and numeric validation |
| `taskify-cli/tests/profile-command.test.ts`, `taskify-cli/tests/csv.test.ts` | CLI profiles and CSV | Local identity lifecycle, piped input, masking, quoting, and missing fields |
| `src/domains/push/reminderClient.test.ts` | Reminder HTTP client | Stable payload ordering, minute offsets, cancellation, missing configuration, and HTTP errors |
| `src/domains/push/vapidKey.test.ts`, `src/lib/withTimeout.test.ts` | Push registration utilities | URL-safe decoding, invalid keys, timeout rejection, and timer cleanup |
| `src/domains/push/chatPush.test.ts`, `src/ui/settings/PushSection.test.tsx` | PWA chat alerts | NIP-98 header signed by the user's signer over URL, method and body hash; push relay added to or removed from the kind-10050 inbox list without ever emptying it; only the account's own latest preference read; Settings toggle shown once push is on |
| `src/chat/cashuTokenText.test.ts`, `src/chat/ChatTokenBubble.test.tsx` | Wallet-independent PWA Chat | Cashu token recognition without loading the Cashu SDK; received tokens are displayed as copy-only and the complete token, not its shortened display, is copied |
| `src/chat/ChatShell.test.tsx`, `src/ui/wallet/useWalletShellState.test.tsx`, `src/ui/wallet/WalletContactsPickerSheet.test.tsx` | PWA Chat/wallet boundary | Chat's background runtime stays mounted off-page while its page is lazy; Chat never opens or prefetches the wallet, wallet prefetch is explicit, and the wallet contact picker reads Chat-owned contacts while contributing only the payment-selection callback |
| `src/chat/hooks/useDmState.test.ts` | PWA Chat DM cache | Recognizes documented attachment type tags (not full payload validation); cached profile relays are trimmed and deduplicated, with empty/non-string entries discarded |
| `src/chat/hooks/useNostrSession.test.tsx` | PWA Chat session lifecycle | Identity refresh on sheet transitions and key events, listener cleanup, disabled identity, and one-time subscription release without relay traffic |
| `src/chat/hooks/useDmThreadUtils.test.tsx` | PWA Chat attachment tray | One deferred composer blur under StrictMode; closing or unmounting cancels pending blur |
| `src/chat/hooks/useContactDetail.test.ts` | PWA Chat contact/profile editing | Preserves the original profile-photo draft and upload blob when a browser cannot create a 2D canvas context |
| `taskify-cli/tests/config-command.test.ts`, `taskify-cli/tests/relay-diagnostics.test.ts` | CLI configuration and diagnostics | Selected-profile persistence, redaction, errors, and simulated connection outcomes |
| `taskify-cli/tests/completions-command.test.ts` | CLI completions | Explicit shells, environment detection, combined fallback output, and invalid-shell exits |
| `src/storage/boardPrintJobs.test.ts` | Saved print jobs | Legacy defaults, malformed data, per-board preservation, and storage failures |
| `src/ui/board/DroppableColumn.test.tsx` | PWA board columns | Drop ordering, multi-selection payloads, empty drops, and keyboard/selection controls |
| `taskify-cli/tests/command-registration.test.ts` | CLI command composition | Bundled help/arguments plus isolated contact persistence, profile selection, lookup, trust/relay mutations, cache status/clearing, and error exits |
| `taskify-cli/tests/command-harness.test.ts`, `taskify-cli/tests/command-lifecycle.test.ts` | CLI command behavior and process lifecycle | Importable real-command harness with injected config/runtime and recorded cleanup; bundled commands return to the executable so async cleanup finishes before the sole hard exit |
| `taskify-cli/tests/task-query-commands.test.ts` (fixtures in `tests/helpers/cliHarness.ts`) | CLI task queries | `list`, `upcoming`, `show` and `search` through the real command tree with a recording runtime and an injected clock: runtime arguments, agent envelopes, human output, failure status and disconnect order |
| `taskify-cli/tests/board-commands.test.ts` | CLI board and list commands | Board settings, sort, list columns, compound children, `board columns`, saved defaults, join/leave and compound create through the real command tree; column guards for list-less boards and ambiguous names; the column a new task landed in |
| `taskify-cli/tests/share-commands.test.ts` | CLI sharing and assignment | Board, task and event-invite shares, assignment responses (with the command clock), `event rsvp` publishing the attendee's own kind 30312 answer from an inbox invitation or with `--board` (checked with the organizer's core rule; no invitation or a bad status publishes nothing), delivery failures, share inbox listing and `--apply` (board join, task create, assignment responses, a legacy RSVP message listed but not applied, processed ids), assign/unassign with `--notify`, and backup relay merges, through an injected share transport |
| `taskify-cli/tests/event-invite.test.ts` | CLI calendar invitation secrets | npub/hex participant keys, adding an invitee once, and tokens kept in step with participants by the shared core rule (the runtime applies it on event create, update and invite) |
| `taskify-cli/tests/presentation-commands.test.ts` | CLI rich flags and `show` output | Task and event recurrence, document, assignee, reminder, invitee and list flags reach the runtime parsed (bad JSON stops before any write); `show --human` lists documents and assignment states, and `event show` lists invitees and the RSVPs attendees published (human and JSON) |
| `taskify-runtime-nostr/tests/session-shutdown.test.ts` | Runtime session lifecycle | A process exits by itself once its session shuts down, with one relay or several (child process against loopback relays); shutdown is idempotent and terminal (later calls fail with `RuntimeSessionClosedError`); a debounced publish waiting at shutdown is sent |
| `taskify-runtime-nostr/tests/standalone-session.test.ts` | One-off relay reads and writes | `withStandaloneSession`: only events with valid signatures come back, writes are signed by the account and accepted, close is idempotent and terminal, and a process exits by itself after success, an error or a timeout |
| `taskify-cli/tests/standalone-commands.test.ts` | CLI contact and bot-list relay commands | `contact fetch` (anonymous read, saved contact, failure), `contact sync` (encrypted and legacy lists merged, one encrypted list published, nobody's key in the clear, `--pull`), and bot command list publish/show, each through an injected `withStandaloneSession` that is always closed |
| `taskify-cli/tests/runtime-tasks.test.ts` (harness in `tests/helpers/runtimeHarness.ts`) | CLI Nostr runtime, tasks | The runtime facade against a real session on the loopback relay, with in-memory cache and config, a test clock and sequential UUIDs: published task tags, board signer and encrypted payload; list/status/column filters and the cache cursor; compound boards; updates and same-second edits; recurring completion publishing the next occurrence once; deletion; id prefixes, subtasks, assignment responses; clearing completed tasks; board lookup by name and the week `day` column; events not signed by the board ignored; the cache round trip of every field and deleted tasks; merging another device's versions by relay time; building on the newest version when a relay serves an older one |
| `taskify-cli/tests/runtime-calendar.test.ts` (same harness) | CLI Nostr runtime, calendar | Each event's board copy (30310) and invitees' view (30311), read with NIP-44 as the PWA and iOS read them: tags, signer, payloads and what the view leaves out; default and given lists; listing newest first and id prefixes; ids matching two boards needing a board; updates and same-second edits; invite tokens following participants; invitations and their addresses; deletion; each attendee's newest published RSVP (kind 30312) read live through the core rule, with uninvited, mis-filed and stale board-copy answers left out; an invitee's `event rsvp` reaching the organizer through the relay; events not signed by the board ignored; building on the newest version when a relay serves an older one; creating on a board given by name, and refusing an unknown one |
| `taskify-cli/tests/runtime-boards.test.ts` (same harness) | CLI Nostr runtime, board definitions | A definition's public tags are only the hashed board tag, kind and name, as the PWA and iOS publish them; a compound board's child ids and a list board's list names stay in the encrypted content on create and on every update; `syncBoard` reads them back from it; creating a board (config entry, saved once, full encrypted payload); updating one found by name (every field, the sort tag, unknown boards publishing nothing); syncing the newest definition into the config with other members' control characters removed; definitions not signed with the board's key ignored; definitions stamped with the runtime's clock; sort taken from the newest definition only (known values; a definition without one leaves this device's); each definition stamped after the newest one known (same second, a member's clock ahead), remembered as `definitionAt`; another author's definition ignored even from a relay that ignores `authors` |
| `taskify-cli/tests/wire-vectors.test.ts` (same harness) | CLI as a consumer of the cross-client wire vectors | Reads `taskify-core/fixtures/` task and calendar vectors (PWA- and iOS-made) through the CLI runtime on the loopback relay and checks the decoded fields every client must agree on; edits each live task and checks the republished payload keeps what the CLI doesn't model (Scripture Memory link and stage, reminders); `compareReplaceableEvents` against `event-version-vectors.json` |
| `src/agent/agentDispatcher.test.ts` | Agent mode | Command dispatch, op routing, security modes |
| `src/domains/upcoming/upcomingPreferences.test.ts` | Upcoming preferences and calendar filter | Board toggles take their lists and a list its board; stored filters follow board changes; labels; presets saved newest first and applied to boards that still exist; preferences saved under the existing storage keys and read back defensively; choosing a sort again flips its direction |
| `src/domains/upcoming/upcomingModel.test.ts` | Upcoming and board sort | Which tasks/events are upcoming (holidays, external calendars, messages board excluded); board/list filter and search; ordering by time, board, manual order and title, grouped or mixed; multi-day events on each day; a board's upcoming section only after today; board sort keeps open tasks first |
| `src/domains/tasks/taskCommands.test.ts` | PWA task commands | Pure plans for complete, delete (incl. series cutoffs, bounties), restore, clear, save, postpone, subtasks, notes, assignment replies and moves (reorder, columns, compound boards, time of day, board position) |
| `src/domains/tasks/generatedTasks.test.ts` | Generated tasks | Fasting reminders created, moved and deleted like native, stable on rerun; one Scripture Memory review task with a date-derived id |
| `src/domains/calendar/calendarRecurrenceWindow.test.ts` | Recurring event window | Local generation of the window, stable on rerun, orphan cleanup, deleted occurrences skipped, edited occurrences never trimmed |
| `src/domains/calendar/calendarCommands.test.ts` | PWA calendar commands | Pure plans for event moves, recurring-series deletion/seed advancement, edits, invite materialization and RSVP publication/local state |
| `src/onboarding/firstRunRules.test.ts`, `src/onboarding/keyBackup.test.ts` | First run and key backup | First run only without an identity; backup asked once a key made here has 3 tasks or is a day old, never for a key the user brought or saved, snooze then ask again, migration notice merged; notifications offered once when an item first gets a reminder |
| `src/identity/identity.test.ts` | Identity and signer | Local signer signs verifiable events and round-trips NIP-44/NIP-04; stored key loaded (also when asked before the key store loads); adopt, reveal only via the named accessor, sign out; invalid keys refused |
| `src/ui/useEscapeToClose.test.tsx` | Escape handling | Escape closes only the top-most open layer; in a text field the first Escape only leaves the field |
| `src/state/stateStore.test.ts` | PWA app stores | Updates apply immediately and exactly once, listeners fire only on change, safe unsubscribe during notify |
| `src/routing/appRouter.test.ts` | PWA routes and browser history | Typed page/entity/sheet routes, legacy reminder links, canonical paths, page Back navigation, overlay close-via-Back, and direct-link close fallback |
| `src/nostr/boardPublisher.test.ts` | Shared-board publishing and wire format | Board metadata, task and calendar event shapes (compound children, week `day` column, explicit nulls, no reminders, board secrets kept out of the invitee copy); metadata once before items; superseded edits dropped; tombstone before send; new event keys stored before use; generated occurrences never published; pending settled when a step fails; each board definition stamped after the newest one known, even in the same second or after a member's clock ahead |
| `src/nostr/calendarEventMerge.test.ts` | Reading shared calendar events | Writer/reader round trip of the canonical copy; invalid dates rejected, inverted ends dropped; device-local fields kept |
| `src/nostr/taskEventMerge.test.ts` | Reading shared task events | Writer/reader round trip of the task wire format; absent fields kept, null cleared; malformed fields ignored; authorized bounty state changes |
| `src/nostr/boardSyncLedger.test.ts` | Board sync clocks | Newer-wins acceptance with pending ties, reserved publish timestamps, monotonic clocks, replaceable board metadata, persisted and trimmed deletion tombstones |
| `src/context/walletContexts.test.tsx` | Lazy wallet runtime | Unavailable wallet without the runtime, published values outside it, nearest provider inside it |
| `src/routing/useOverlayHistory.test.tsx`, `src/routing/useNotificationTaps.test.tsx` | PWA overlays and deep links | Back closes the top overlay then the one beneath; UI close unwinds history in one step; editor switches replace their entry; links open their task once synced and close to the page; stale sheets in a reloaded URL are dismissed; reminder taps open their task or event; chat alert taps open Chat |
| `taskify-core/tests/recurrence-core.test.ts`, `taskify-ios-native/Tests/TaskifyCoreTests/RecurrenceVectorTests.swift` | Recurring tasks across clients | Both read `taskify-core/fixtures/recurrence-vectors.json`: next due date and occurrence id through DST, time zones, clamped rules and end dates; the shared next-occurrence builder |
| `taskify-core/tests/taskify-links-core.test.ts`, `taskify-ios-native/Tests/TaskifyCoreTests/TaskifyWidgetLinkTests.swift` | Cross-client links | Both read `taskify-core/fixtures/taskify-link-vectors.json`: the upcoming, boards, task, event and quick-add app-link grammar; core also round-trips their canonical web paths |
| `taskify-core/tests/file-servers-core.test.ts`, `taskify-ios-native/Tests/TaskifyCoreTests/FileServerUploadVectorTests.swift` | Cross-client encrypted file uploads | Both read `taskify-core/fixtures/file-server-upload-vectors.json`: fixed Originless/Blossom upload routes and Originless response URL resolution; PWA and CLI consume the core helpers directly |
| `taskify-core/tests/event-invitation-vectors.test.ts`, `taskify-ios-native/Tests/TaskifyCoreTests/EventInvitationVectorTests.swift` | Calendar invitation secrets across clients | Both read `taskify-core/fixtures/event-invitation-vectors.json`: a token per invitee (sender excluded, spellings merged, removed invitees dropped, existing tokens kept) and the event key kept unless malformed; the PWA and CLI call `planEventInvitations` |
| `taskify-core/tests/calendar-rsvp-vectors.test.ts`, `taskify-ios-native/Tests/TaskifyCoreTests/CalendarRsvpVectorTests.swift` | Event RSVPs across clients | Both read `taskify-core/fixtures/calendar-rsvp-vectors.json`: an attendee's kind 30312 tags and payload, the organizer's acceptance check (kind, author, address, payload, event id, then the event's or the board-derived token), the board-derived token, and the newest response per attendee; the PWA and CLI call `calendarRsvp.ts` |
| `taskify-core/tests/event-version-vectors.test.ts`, `taskify-ios-native/Tests/TaskifyCoreTests/EventVersionVectorTests.swift` | Which version of a replaceable item wins, and a new version's time | Both read `taskify-core/fixtures/event-version-vectors.json`: later `created_at`, then the lower id in any case, then a known id; `nextCreatedAt` (now, but after the newest version known). The PWA and CLI call `compareEventVersions`/`nextEventCreatedAt`, iOS `EventVersion`; the CLI also checks it in `wire-vectors.test.ts` |
| `taskify-cli/tests/recurring-completion.test.ts` | CLI recurring completion | `done` opens the next occurrence with the shared id, keeps the series, and skips one that already exists |
| `taskify-core/tests/wire-lists-core.test.ts`, `src/lib/nip51Contacts.test.ts` | Bot command and private contact lists | Strict bot-command parsing and draft validation; NIP-51 petnames at index 3, with the late form older PWA builds wrote still read |
| `taskify-core/tests/app-state-sync-core.test.ts`, `taskify-ios-native/Tests/TaskifyCoreTests/AppStateSyncTests.swift` | Cross-device app state sync | Three-way Bible tracker/scripture merges with PWA↔native parity, chat-state merge/prune, event round trip; see `docs/reference/app-state-sync.md` |
| `src/nostr/useNostrChatStateSync.test.tsx`, `src/domains/inbox/inboxResponseSync.test.ts` | PWA chat state sync | Coalesced publishing, echo suppression, remote read markers and shared-item and calendar-invite responses |
| `src/nostr/boardVerifyUnseen.test.tsx` | PWA board sync | Re-verification of tasks missing from a board's initial sync is applied, and ignored after teardown |
| `taskify-ios-native/Tests/TaskifyCoreTests/ScriptureMemorySyncTests.swift`, `src/domains/scripture/scriptureUtils.test.ts` | Scripture memory | Review applied exactly once across timestamp precisions, PWA key spelling, whole-chapter passages, shared review-task ids |
| `tests/taskMovePersistence.test.ts` | Task drag persistence | Monotonic relay clocks and source cleanup for cross-board moves |
| `tests/recurrenceCutoffs.test.ts` | Task recurrence | Durable delete-future cutoffs, legacy instances, and recoverable bounties |
| `tests/calendarRecurrenceCutoffs.test.ts` | Taskify event recurrence | Durable delete-future cutoffs and stale-occurrence rejection |
| `taskify-ios-native/Tests/TaskifyCoreTests/TaskifySharedContainerTests.swift` | Native storage | Signed Mac App Group authorization, private fallback, migration preservation and repeated saves/reloads |
| `taskify-ios-native/Tests/TaskifyCoreTests/SnapshotLookupCacheTests.swift` | Native board cache invalidation/reuse, compound scope, calendar boundaries, sorting, and flat timeline identities |
| `taskify-ios-native/Tests/TaskifyCoreTests/SharedInboxTests.swift` | NIP-17 private messages | Gift-wrap verification, independent sender/recipient copies, encrypted group task/event shares with persisted conversation routing, strict kind-10050 routing, and signed inbox preferences |
| `taskify-ios-native/Tests/TaskifyCoreTests/RelayRetryBackoffTests.swift`, `taskify-ios-native/Tests/TaskifyCoreTests/RelayOutboxLatencyTests.swift` | Native relay pressure | Bounded ingress with ordered lossless recovery, cancellation, and shared subscription/publication cooldown after rate limiting |
| `taskify-ios-native/Tests/TaskifyCoreTests/CryptoSyncTests.swift` | Native relay sync | Keeps inbox subscriptions on the account's advertised inbox relays while allowing outbound-only relay connections |
| `taskify-ios-native/Tests/TaskifyCoreTests/DMPushNotificationPolicyTests.swift` | Native DM push privacy | Local-only message/payment classification and per-category settings |
| `taskify-core/fixtures/dm-push-registration-vectors.json`, `taskify-ios-native/Tests/TaskifyCoreTests/DMPushRegistrationClientTests.swift`, `taskify-push-relay/test/{server,apns,store}.test.js` | Apple push registration across native clients and relay | Shared legacy/iOS/Watch/Mac platform and token-normalization vectors; NIP-98 request binding; distinct metadata-free Mac topic routing with no preview capability |
| `taskify-ios-native/Tests/TaskifyCoreTests/ShareTaskDraftTests.swift`, `taskify-ios-native/Tests/TaskifyNativeUITests/ShareToTaskUITests.swift` | Native share sheet to tasks | Draft title/note rules and isolated file persistence; Safari page-title capture; real image upload and attachment when the app imports the draft |
| `taskify-macos/Scripts/generate-project.py`, `taskify-macos/Tests/MacPresentationTests.swift`, `taskify-macos/UITests/TaskifyMacUITests.swift` | Mac build, presentation and isolated app host | Generated shared-source/product manifest matches the committed Xcode project; the full unsigned app compiles in CI; 28 package tests cover DST-aware placement, list drafts, pending wallet outcomes, recovery consent, payment-request mint selection, recurrence, deep-link selection, runtime isolation, live withdraw-only routes, recovery-mode wallet startup, production-only APNs lifecycle/entitlements, the explicit signed-push proof gate, file/raw-image import, Transferable type negotiation, both encrypted attachment inputs, and the isolated no-relay external-action store; ten isolated host smokes cover deep-link navigation plus terminated-app App Intent capture, wallet close-out surfaces, task editing and completion, two-window conflicts/account switching, quit/outbox persistence, local Spotlight index/open/remove, and raw PNG paste in both composers without production relays, APNs registration or wallet startup |
| `taskify-push-relay/test/*.test.js` | Push relay and StartOS runtime | NIP-42/NIP-98 authorization, recipient-only reads, sender-copy suppression, persistence, expiry, APNs payload privacy and per-platform topic configuration/migration, one kept-open APNs connection (reconnected after a close) with per-app collapse IDs and a day's expiry, retries, authenticated WebSocket delivery, and Web Push (RFC 8291 payload a browser decrypts, VAPID signature, push-service-only endpoints); refusals that need no signature (kind, recipient, author, size) come before the signature check; a reader that falls too far behind is cut off; the SQLite store's durability across reopening, all-or-nothing writes, task-cache columns on disk, and the one-time import of a former `state.json` (sequences kept, run once) |

Additional PWA regression tests include `src/nostr/startupStability.test.ts`, which is
present in this checkout and discovered by Vitest.

### Current Gaps (see `docs/plans/engineering-roadmap.md` for plan)

- Worker tests exist in `worker/src/*.test.ts`; reminder delivery coverage remains a separate area to assess
- Native relay health and NIP-42 retry behavior still lack a live-relay integration test
- **No E2E tests** — browser-level flows are untested
- Coverage tooling not yet configured (no c8/nyc setup)

---

## Docs Update Policy

> **When you change behavior, update the docs.**

| Change type | Doc update required |
|---|---|
| New agent command / op | `docs/reference/agent-mode.md` |
| New Nostr NIP usage | `AGENT.md` protocols table |
| New domain / subsystem | `AGENT.md` structure map + architecture section |
| New branch or deploy flow change | `AGENT.md` branch promotion |
| New test file or coverage change | `AGENT.md` testing table + roadmap |
| New env var or infra binding | `wrangler.toml` comment + `AGENT.md` |

PRs that change behavior without updating relevant docs will be flagged in review.

---

## Development Philosophy

These principles apply to all Taskify work — PWA, CLI, Worker, and Core.

### Bug workflow — test first, always
**Never fix a reported bug without a failing test first.**
1. Write a test that reproduces the bug and confirm it fails
2. Implement the fix
3. Confirm the test now passes

This prevents regressions and proves the fix is real, not accidental.

### Nevernesting
Favor early returns and guard clauses over nested conditionals.

```ts
// ❌ Bad
if (user) {
  if (task) {
    if (boardId) {
      doThing();
    }
  }
}

// ✅ Good
if (!user) return;
if (!task) return;
if (!boardId) return;
doThing();
```

### Core is source of truth
`taskify-core` and `taskify-runtime-nostr` own business logic. The PWA and CLI are thin consumers — they call core, they never reimplement it. If you find duplicate logic in the UI layer, move it to core.

### No dead code
Delete commented-out code. Commented code is dead code. Add comments only for genuinely non-obvious logic — not to explain what the code already says.

### Logically distinct, standalone commits
Each commit must build and run on its own. One logical change per commit. Reviewers should be able to bisect safely.

### Never block the render thread (PWA)
All network requests, relay queries, and expensive computations must be async. Never perform synchronous blocking work in React hooks, renders, or component bodies. Use `async/await` and keep UI updates on the React thread.

### Minimize agent output noise
Build and test scripts should output clear `✓`/`✗` indicators with errors only on failure. Verbose output by default makes agent verification harder.

---

## Safe Contribution Rules

1. **Never modify `main` directly.** All changes go through PRs.
2. **Branch from `New_Features_Fixes`**, not from `main` or `Beta`.
3. **Do not commit secrets.** `.dev.vars` is gitignored — keep it that way. Never commit VAPID keys, nsec, or mint API keys.
4. **Test before PR.** Run `npm test` and `npm run lint` in `taskify-pwa/`.
5. **Docs-first for new features.** If you're adding a new agent op or Nostr flow, document it before or alongside the code.
6. **No product code in docs PRs.** Docs branches touch only `*.md`, `.github/`, and `docs/` files.
7. **Worker changes require local wrangler testing.** Don't guess at cron or KV behavior — test with `wrangler dev`.
8. **Cashu/wallet changes are high-risk.** Get a second review on any changes to `wallet/` or `mint/` — token loss is not recoverable.
9. **Nostr event schema changes are breaking.** Changing the structure of published events affects all clients. Require explicit sign-off.

---

## PR Checklist

See `.github/pull_request_template.md` for the full checklist used on every PR.

Quick summary:
- [ ] Branched from `New_Features_Fixes`
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] Docs updated if behavior changed
- [ ] No secrets committed
- [ ] Wallet/Nostr changes flagged for extra review if applicable

Relay access regression coverage: `taskify-runtime-nostr/tests/proof-of-work.test.ts`
and `relay-auth.test.ts` cover cooperative/cancellable mining and duplicate AUTH
challenges. Native `NostrProofOfWorkTests` and `NostrRelayAuthenticationTests` cover
signed work across native/Watch and acknowledgement-gated replay. Prepare work
before retaining event IDs; never re-sign an already-submitted outbox event.
