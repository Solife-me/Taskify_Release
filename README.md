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
| **Agent Mode** | JSON command API for AI/scripted task operations | `src/agent/`, `docs/reference/agent-mode.md` |
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
│   ├── src/index.ts           # Worker routing entry; handlers live alongside it
│   └── migrations/            # D1 SQL migrations
│
├── taskify-ios-native/        # Native SwiftUI app and TaskifyCore Swift package
├── taskify-push-relay/        # NIP-17 inbox relay and APNs bridge
│
├── docs/                      # Project documentation
│   ├── README.md             # Documentation index
│   ├── reference/            # Architecture, protocols, and operational guides
│   ├── plans/                # Implementation plans and roadmaps
│   └── audits/               # Dated investigations and findings
│
├── AGENT.md                   # Contributor onboarding guide (start here)
├── wrangler.toml              # Cloudflare Worker config (KV, R2, D1, cron, assets)
└── scripts/                   # Build helpers (install-worker-deps.mjs)
```

There is no monorepo build tool. Each JavaScript package has its own manifest and lockfile; install dependencies in the package directory. PWA build output (`taskify-pwa/dist/`) is served by the Cloudflare Worker via the `[assets]` binding.

**Where to start:**
- App logic: `taskify-pwa/src/App.tsx` (root component) and `src/domains/tasks/taskTypes.ts`
- Nostr layer: `src/nostr/NostrSession.ts`
- Wallet layer: `src/wallet/CashuManager.ts`
- Agent operations: `src/agent/agentDispatcher.ts` + `docs/reference/agent-mode.md`
- Backend: `worker/src/index.ts`

---

## Local Development Setup

**Prerequisites:** Node 22.13+, a Cloudflare account (for Worker dev), `wrangler` CLI.

### PWA

```sh
cd taskify-pwa
npm install
npm run dev          # Vite dev server at http://localhost:5173
npm run build        # Production build → taskify-pwa/dist/
npm run lint         # ESLint
npm test             # Vitest runner (see Testing section)
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
| `cd taskify-pwa && npm test` | Run PWA tests (Vitest) |
| `cd taskify-pwa && npm run lint` | ESLint check |
| `cd taskify-pwa && npm run build` | Production PWA build |
| `npx wrangler dev` | Start Worker locally (from repo root) |
| `npx wrangler deploy` | Deploy Worker + PWA to Cloudflare |

---

## Testing

Test runners are package-specific:

| Package | Command | Runner |
|---------|---------|--------|
| `taskify-pwa` | `npm test` | Vitest |
| `taskify-core` | `npm test` | Node test runner; builds first |
| `taskify-runtime-nostr` | `npm test` | Node test runner; builds first |
| `taskify-cli` | `npm test` | Node test runner; builds first |
| `worker` | `npm test` | Node test runner |
| `taskify-push-relay` | `npm test` | Node test runner |

Run commands from the corresponding package directory. Add PWA tests as `*.test.ts` or `*.test.tsx`; Vitest discovers them automatically. See the [native iOS README](taskify-ios-native/README.md) for Swift test instructions.

The shared TypeScript packages keep their `dist/` output in Git because consumers resolve their package entry points there. After changing shared source, run `npm run build` in that package and include the regenerated output. Builds clean `dist/` first to prevent obsolete files from surviving. Build `taskify-core` and `taskify-runtime-nostr` before building consumers after shared-source changes.

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
| New agent op | `docs/reference/agent-mode.md` |
| New Nostr NIP usage | `AGENT.md` protocols table |
| New domain or subsystem | `AGENT.md` + `docs/reference/architecture-overview.md` |
| New branch or deploy flow change | `AGENT.md` branch promotion section |
| New test file or coverage change | `AGENT.md` testing table + `docs/plans/engineering-roadmap.md` |
| New env var or Worker binding | `wrangler.toml` comment + `AGENT.md` |

PRs that change behavior without updating relevant docs will be flagged in review.

---

## Further Reading

- [Documentation index](docs/README.md) — all references, plans, and audits

- [`AGENT.md`](./AGENT.md) — full contributor guide: architecture, protocols, safe contribution rules
- [`docs/reference/agent-mode.md`](docs/reference/agent-mode.md) — agent command reference with copy-paste examples
- [`docs/reference/architecture-overview.md`](docs/reference/architecture-overview.md) — runtime architecture and data flows
- [`docs/reference/domains-layer-reference.md`](docs/reference/domains-layer-reference.md) — source-of-truth map for `src/domains/*`
- [`docs/reference/functions-and-flows.md`](docs/reference/functions-and-flows.md) — end-to-end flow walkthroughs with file references
- [`docs/plans/engineering-roadmap.md`](docs/plans/engineering-roadmap.md) — testing and documentation roadmap
