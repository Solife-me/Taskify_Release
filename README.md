# Taskify

Taskify is a privacy-first, local-first task manager with Nostr-based sync and an integrated Cashu ecash wallet. Task data lives in signed Nostr events — there is no traditional backend database storing user tasks. A Cloudflare Worker handles push notifications, reminder scheduling, and encrypted backup storage.

## What It Is

- **Offline-first PWA** (React 19 + Vite) with service worker caching
- **Nostr-native sync**: tasks, boards, and app state published as signed NIP-01 events
- **Cashu ecash wallet**: send/receive tokens, P2PK locks, Lightning payments via NWC, and wallet-managed Lightning Address settings
- **Agent Mode**: programmatic task manipulation via a JSON command API (`?agent=1`)
- **Web Push reminders**: scheduled via Cloudflare Worker cron (every minute)
- **No account required**: identity is a Nostr keypair generated or imported at first run

---

## Feature Domains

| Domain | Description | Key Paths |
|--------|-------------|-----------|
| **Tasks** | Create, edit, complete tasks with due dates, priorities, notes, subtasks, recurrence | `src/domains/tasks/`, `src/ui/task/` |
| **Boards** | Week view, list columns, compound boards; per-board encryption | `src/domains/tasks/boardUtils.ts`, `src/ui/board/` |
| **Upcoming** | Calendar-style view of tasks by date | `src/domains/calendar/` |
| **Wallet** | Cashu ecash: send, receive, P2PK locks, NWC (NIP-47), Lightning, Address page | `src/wallet/`, `src/mint/`, `src/context/CashuContext.tsx`, `src/ui/wallet/` |
| **Contacts** | Nostr-based contact list (NIP-51) | `src/lib/contacts.ts`, `src/lib/nip51Contacts.ts` |
| **Settings** | Relays, push notifications, theme, startup view, backups | `src/ui/settings/` |
| **Onboarding** | Key generation/import, agent mode setup, hard navigation gating | `src/onboarding/` |
| **Agent Mode** | JSON command API for AI/scripted task operations | `src/agent/`, `docs/agent-mode.md` |
| **Bible Tracker** | Scripture reading progress and memory card tracking | `src/components/BibleTracker.tsx` |
| **Reminders** | Push notification scheduling via Cloudflare Worker cron | `worker/src/index.ts`, `src/domains/push/` |

---

## Monorepo/Package Map

```
Taskify_Release/
├── taskify-pwa/               # React 19 + Vite PWA (main user-facing app)
│   ├── src/
│   │   ├── agent/             # Agent dispatcher, security config, idempotency
│   │   ├── components/        # Large shared components (BibleTracker, CashuWalletModal)
│   │   ├── context/           # React context providers (Cashu, NWC, P2PK, Toast)
│   │   ├── domains/           # Domain logic (tasks, calendar, nostr, push, dateTime, etc.)
│   │   ├── mint/              # Cashu mint connections, quote/swap/state managers
│   │   ├── nostr/             # NDK session layer, relay health, subscriptions, publish
│   │   ├── onboarding/        # First-run and agent mode onboarding flows
│   │   ├── storage/           # IndexedDB and localStorage abstractions
│   │   ├── ui/                # UI primitives, settings panels, task/board/agent UI
│   │   └── wallet/            # Cashu wallet ops (swap, P2PK, NWC, seed, lightning)
│   ├── public/                # Static assets, PWA manifest
│   └── package.json           # PWA dependencies (React 19, NDK, Cashu, nostr-tools)
│
├── taskify-core/              # Shared pure domain contracts/normalizers/utilities
├── taskify-runtime-nostr/     # Shared Nostr runtime transport/orchestration modules
├── taskify-cli/               # CLI surface built on shared core/runtime packages
│
├── worker/                    # Cloudflare Worker (push, reminders, backups, static assets)
│   ├── src/index.ts           # Worker entry — all backend logic in one file
│   └── migrations/            # D1 SQL migrations
│
├── docs/                      # Project documentation
│   ├── agent-mode.md             # Agent command reference with examples
│   ├── architecture-overview.md  # Runtime architecture and data flows
│   ├── domains-layer-reference.md# Domain-by-domain map for src/domains/
│   ├── engineering-roadmap.md    # Testing and docs roadmap (March 2026)
│   └── functions-and-flows.md    # End-to-end flow walkthroughs for agents/contributors
│
├── AGENT.md                   # Contributor onboarding guide (start here)
├── wrangler.toml              # Cloudflare Worker config (KV, R2, D1, cron, assets)
└── scripts/                   # Build helpers (install-worker-deps.mjs)
```

There is no monorepo build tool. Each package (`taskify-pwa`, `worker`) is managed independently. PWA build output (`taskify-pwa/dist/`) is served by the Cloudflare Worker via the `[assets]` binding.

**Where to start:**
- App logic: `taskify-pwa/src/App.tsx` (root component) and `src/domains/tasks/taskTypes.ts`
- Nostr layer: `src/nostr/NostrSession.ts`
- Wallet layer: `src/wallet/CashuManager.ts`
- Agent operations: `src/agent/agentDispatcher.ts` + `docs/agent-mode.md`
- Backend: `worker/src/index.ts`

---

## Local Development Setup

**Prerequisites:** Node 18+, a Cloudflare account (for Worker dev), `wrangler` CLI.

### PWA

```sh
cd taskify-pwa
npm install
npm run dev          # Vite dev server at http://localhost:5173
npm run build        # Production build → taskify-pwa/dist/
npm run lint         # ESLint
npm test             # Node --test runner (see Testing section)
```

### Worker (local)

```sh
# Requires wrangler auth and .dev.vars with VAPID_PUBLIC_KEY, VAPID_SUBJECT, VAPID_PRIVATE_KEY
npx wrangler dev     # Worker at http://localhost:8787
```

### Common Commands

| Command | What it does |
|---------|-------------|
| `cd taskify-pwa && npm run dev` | Start PWA dev server |
| `cd taskify-pwa && npm test` | Run all tests (Node built-in runner) |
| `cd taskify-pwa && npm run lint` | ESLint check |
| `cd taskify-pwa && npm run build` | Production PWA build |
| `npx wrangler dev` | Start Worker locally (from repo root) |
| `npx wrangler deploy` | Deploy Worker + PWA to Cloudflare |

---

## Testing

Tests use **Node's built-in `--test` runner** — not Jest, not Vitest. Do not add external test frameworks.

```sh
cd taskify-pwa
npm test
```

The `test` script (current, on `New_Features_Fixes` / `docs/*` branches) runs:
```
node --experimental-strip-types --experimental-specifier-resolution=node --test \
  src/agent/agentDispatcher.test.ts
```

**Current test files:**

| File | Domain | What it covers | Branch |
|------|--------|---------------|--------|
| `src/agent/agentDispatcher.test.ts` | Agent mode | Command dispatch, op routing, security modes, trust classification | merged |
| `src/nostr/startupStability.test.ts` | Nostr startup | Relay event flood prevention; startup stall guard | `fix/startup-relay-stability` |
| `src/onboarding/onboardingGating.test.ts` | Onboarding | Nav gating state, snap-back logic, mutual exclusivity | `fix/onboarding-buttons-unlocked` |

The startup stability and onboarding gating tests exist on feature branches and are pending promotion to `New_Features_Fixes`.

Tests use `node:test` and `node:assert`. No real network calls — relay and storage behavior is stubbed in-process.

**To add a test:** create `*.test.ts` in the relevant `src/` subdirectory and add its path to the `test` script in `taskify-pwa/package.json`.

---

## Branch and Promotion Workflow

```
feature-or-fix-branch    ← always branch from New_Features_Fixes
        ↓ PR + review
  New_Features_Fixes      ← integration and staging branch
        ↓ PR + QA
        Beta              ← pre-release testing
        ↓ PR + sign-off
        main              ← production
```

- **Always branch from `New_Features_Fixes`**, not `main` or `Beta`.
- `main` is the production branch and the default PR target on GitHub.
- Docs branches (e.g. `docs/*`) also branch from `New_Features_Fixes`.
- Hotfixes to `main` require explicit sign-off and must be back-ported to `New_Features_Fixes`.

---

## Documentation Policy

When you change behavior, update the docs. See `AGENT.md` for the full docs-update matrix.

| Change | Required update |
|--------|----------------|
| New agent op | `docs/agent-mode.md` |
| New Nostr NIP usage | `AGENT.md` protocols table |
| New domain or subsystem | `AGENT.md` + `docs/architecture-overview.md` |
| New branch or deploy flow change | `AGENT.md` branch promotion section |
| New test file or coverage change | `AGENT.md` testing table + `docs/engineering-roadmap.md` |
| New env var or Worker binding | `wrangler.toml` comment + `AGENT.md` |

PRs that change behavior without updating relevant docs will be flagged in review.

---

## Further Reading

- [`AGENT.md`](./AGENT.md) — full contributor guide: architecture, protocols, safe contribution rules
- [`docs/agent-mode.md`](./docs/agent-mode.md) — agent command reference with copy-paste examples
- [`docs/architecture-overview.md`](./docs/architecture-overview.md) — runtime architecture and data flows
- [`docs/domains-layer-reference.md`](./docs/domains-layer-reference.md) — source-of-truth map for `src/domains/*`
- [`docs/functions-and-flows.md`](./docs/functions-and-flows.md) — end-to-end flow walkthroughs with file references
- [`docs/engineering-roadmap.md`](./docs/engineering-roadmap.md) — testing and documentation roadmap
