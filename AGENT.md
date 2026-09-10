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
│   │   ├── onboarding/   # Welcome/login gating and onboarding flow
│   │   ├── components/   # Shared React components
│   │   ├── context/      # React context providers
│   │   ├── storage/      # Local storage abstractions
│   │   ├── ui/           # UI primitives and layout components
│   │   └── types/        # Shared TypeScript types
│   ├── public/           # Static assets, service worker manifest
│   └── package.json      # PWA dependencies (React 19, NDK, Cashu, nostr-tools)
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
├── taskify-push-relay/   # Dedicated NIP-17 inbox relay, APNs bridge, StartOS package
│   ├── src/              # Relay, NIP-42/NIP-98 auth, store, APNs provider
│   ├── startos/          # Start SDK 2.x manifest, action, daemon, interface, backup
│   └── test/             # Protocol, persistence, APNs, and WebSocket integration tests
│
├── docs/                 # Project documentation
│   ├── agent-mode.md              # Agent Mode command reference
│   ├── architecture-overview.md   # Runtime architecture and data flows
│   ├── domains-layer-reference.md # Domain-by-domain map for src/domains/
│   ├── functions-and-flows.md     # End-to-end runtime flows
│   └── engineering-roadmap.md     # Documentation + testing roadmap
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
| **Taskify Push Relay** | Node.js, Nostr, APNs, StartOS | Encrypted kind-1059 retention and opaque-token APNs rich-preview delivery |
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

- Uses `@cashu/cashu-ts` v3 and `@cashu/crypto`
- Supports P2PK (NIP-61), NWC (NIP-47), lightning, seed-based key derivation
- `SwapManager.ts` — atomic token swaps
- `MintSession.ts` — per-mint connection lifecycle
- `LockedTokenManager.ts` — locked token bookkeeping

---

## Protocols and Standards in Use

| Protocol | Purpose | Key Files |
|---|---|---|
| **NIP-01** | Core Nostr event structure | `nostr/`, `domains/nostr/` |
| **NIP-17** | Private DMs, kind-10050 inbox relay preferences, sender/recipient delivery copies | `taskify-ios-native/Sources/TaskifyCore/Nostr/NostrSharedInbox.swift`, `taskify-ios-native/Sources/TaskifyCore/Nostr/NIP17InboxRelayResolver.swift` |
| **NIP-59** | Gift-wrapped Nostr events with randomized timestamps and ephemeral outer keys | `taskify-ios-native/Sources/TaskifyCore/Nostr/NostrSharedInbox.swift` |
| **NIP-42** | Relay authentication | `nostr/RelayAuth.ts`, `taskify-ios-native/Sources/TaskifyCore/Sync/TaskSyncEngine.swift`, `taskify-push-relay/src/server.js` |
| **NIP-98** | Authenticated native APNs device registration | `taskify-ios-native/Sources/TaskifyCore/Nostr/DMPushRegistrationClient.swift`, `taskify-push-relay/src/auth.js` |
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
npm test             # Node test runner (no jest/vitest — native --test)
npm run lint         # ESLint
```

**Worker (local):**
```sh
# Requires Cloudflare account + wrangler auth
cp .dev.vars.example .dev.vars  # fill in VAPID_PUBLIC_KEY, VAPID_SUBJECT
npx wrangler dev
```

### Important Notes

- Test runners are package-specific: `taskify-core` uses Node's built-in `--test`, while
  `taskify-pwa` uses Vitest through `npm test`.
- No monorepo build tool — each package (`taskify-pwa`, `worker`) is independent.
- PWA build output (`taskify-pwa/dist/`) is served by the Cloudflare Worker via `[assets]` binding.
- Wrangler config (`wrangler.toml`) is at repo root; it references paths relative to root.

---

## Testing Strategy and Current Gaps

### What Is Tested

| Test File | Domain | What It Covers |
|---|---|---|
| `src/agent/agentDispatcher.test.ts` | Agent mode | Command dispatch, op routing, security modes |
| `tests/taskMovePersistence.test.ts` | Task drag persistence | Monotonic relay clocks and source cleanup for cross-board moves |
| `tests/recurrenceCutoffs.test.ts` | Task recurrence | Durable delete-future cutoffs, legacy instances, and recoverable bounties |
| `tests/calendarRecurrenceCutoffs.test.ts` | Taskify event recurrence | Durable delete-future cutoffs and stale-occurrence rejection |
| `taskify-ios-native/Tests/TaskifyCoreTests/SharedInboxTests.swift` | NIP-17 private messages | Gift-wrap verification, independent sender/recipient copies, strict kind-10050 routing, and signed inbox preferences |
| `taskify-ios-native/Tests/TaskifyCoreTests/CryptoSyncTests.swift` | Native relay sync | Keeps inbox subscriptions on the account's advertised inbox relays while allowing outbound-only relay connections |
| `taskify-ios-native/Tests/TaskifyCoreTests/DMPushNotificationPolicyTests.swift` | Native DM push privacy | Local-only message/payment classification and per-category settings |
| `taskify-ios-native/Tests/TaskifyCoreTests/DMPushRegistrationClientTests.swift` | Native push registration | NIP-98 method, URL, and payload binding plus safe endpoint construction |
| `taskify-push-relay/test/*.test.js` | Push relay and StartOS runtime | NIP-42/NIP-98 authorization, recipient-only reads, sender-copy suppression, persistence, expiry, APNs payload privacy, retries, and authenticated WebSocket delivery |

Additional tests exist on feature branches and are being promoted into `New_Features_Fixes`:

| Test File | Domain | Status |
|---|---|---|
| `src/nostr/startupStability.test.ts` | Nostr startup | On `fix/startup-relay-stability` branch |
| `src/onboarding/onboardingGating.test.ts` | Onboarding | On `fix/startup-relay-stability` branch |

### Current Gaps (see `docs/engineering-roadmap.md` for plan)

- **No tests** for the legacy Web Push reminder Worker logic
- Native relay health and NIP-42 retry behavior still lack a live-relay integration test
- **No E2E tests** — browser-level flows are untested
- Coverage tooling not yet configured (no c8/nyc setup)

---

## Docs Update Policy

> **When you change behavior, update the docs.**

| Change type | Doc update required |
|---|---|
| New agent command / op | `docs/agent-mode.md` |
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
