# Taskify Architecture Overview

Detailed technical reference for the runtime architecture, data flows, key modules, and known constraints. Read `AGENT.md` first for project orientation; this document goes deeper.

---

## Runtime Architecture

Taskify has three runtime surfaces that collaborate:

```
┌─────────────────────────────────────────────────────┐
│                   User's Browser                    │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │              Taskify PWA                     │   │
│  │  React 19 + Vite + Tailwind                  │   │
│  │                                              │   │
│  │  App.tsx (root)                              │   │
│  │    ├── State: tasks, boards, settings,       │   │
│  │    │         onboarding, activePage          │   │
│  │    ├── Nostr session layer (NDK)             │   │
│  │    ├── Cashu wallet layer                    │   │
│  │    └── Agent mode dispatcher                 │   │
│  │                                              │   │
│  │  Storage: IndexedDB (tasks/state)            │   │
│  │           localStorage (flags/keys)          │   │
│  └──────────────────────────────────────────────┘   │
│           │                        │                │
│    Web Push API             Service Worker          │
└───────────┼────────────────────────┼────────────────┘
            │                        │
            ▼                        ▼
┌──────────────────────┐   ┌─────────────────────────┐
│  Cloudflare Worker   │   │    Nostr Relay Network   │
│  (wrangler.toml)     │   │  (public relays + NDK)   │
│                      │   │                          │
│  - Push notify subs  │   │  - Task/board events     │
│  - Reminder cron     │   │  - App state sync        │
│  - Legacy GCal APIs  │   │  - Profile metadata      │
│  - Static PWA assets │   │  - Wallet events (NWC)   │
│  - D1: device/remind │   │                          │
│  - KV: device/remind │   │                          │
└──────────────────────┘   └─────────────────────────┘
```

### Key Principle

Tasks and app state are **not stored in the Worker** — they live in the user's local IndexedDB and are synced peer-to-peer via encrypted Nostr events. The Worker serves PWA assets and handles Web Push delivery. Google Calendar is no longer exposed by the PWA; its backend routes remain temporarily for existing connection cleanup and compatibility.

---

## Key Modules and Responsibilities

### Entry Point: `taskify-pwa/src/main.tsx`

Bootstrap sequence:
1. Inject Node polyfills (`process`, `Buffer`, `global`) required by `nostr-tools` / `@cashu/cashu-ts`
2. Call `initializeStorageBoundaries()` with a 1500ms timeout guard — if IDB fails to open, app continues with degraded state
3. Lazy-load `App` and context providers (`CashuProvider`, `NwcProvider`, `P2PKProvider`, `ToastProvider`)
4. Register service worker for PWA asset caching

### Root Component: `taskify-pwa/src/App.tsx`

The central orchestrator (~800KB, ~20k lines). Manages:
- All React state for tasks, boards, settings, wallet UI, onboarding flags
- Nostr session lifecycle (subscribing, publishing events)
- Navigation state (`activePage`: `"boards" | "upcoming" | "wallet" | "contacts" | "settings"`)
- Onboarding gating refs and state (see Onboarding section below)
- Push notification registration

This file is intentionally monolithic — it avoids prop-drilling by keeping all stateful operations co-located. Agent-facing operations are extracted into `src/agent/agentRuntime.ts`.

### Nostr Session Layer: `taskify-pwa/src/nostr/`

All files in `taskify-pwa/src/nostr/` unless noted:

| File | Status | Responsibility |
|------|-----|--|
| `NostrSession.ts` | ✅ Current | Singleton NDK session: connects to relays, signs events, owns the NDK instance |
| `SessionPool.ts` | ✅ Current | Manages multiple concurrent sessions (e.g. for shared board keys) |
| `SubscriptionManager.ts` | ✅ Current | NDK subscription lifecycle with reference counting; deduplicates filters |
| `PublishCoordinator.ts` | ✅ Current | Batched, debounced event publishing for replaceable events; no internal retry loop |
| `RelayHealth.ts` | ✅ Current | Tracks relay failure counts; applies exponential backoff (5s base, 2× multiplier, 5min cap) |
| `RelayAuth.ts` | ✅ Current | NIP-42 relay authentication — responds to AUTH challenges per-connection |
| `RelayInfoCache.ts` | ✅ Current | NIP-11 relay metadata caching (capabilities, supported NIPs) |
| `EventCache.ts` | ✅ Current | In-memory event deduplication (FIFO eviction at 2048 IDs) |
| `BoardKeyManager.ts` | ✅ Current | Derives deterministic board keypairs from `SHA256(boardId)` for per-board signing |
| `CursorStore.ts` | ✅ Current | Persists `since` cursors per subscription filter to avoid re-fetching old events |
| `startupStability.ts` | ⏳ Pending | Guards against relay event floods stalling the main thread at startup (frame budgeting). **Status**: On branch `fix/startup-relay-stability`, pending merge to main. |
| `WalletNostrClient.ts` | ✅ Current | Nostr client scoped to wallet operations (NWC, NIP-47) |
| `ProfilePublisher.ts` | ✅ Current | Publishes and caches Nostr kind-0 profile metadata |
| `Nip96Client.ts` | ✅ Current | NIP-96 file/backup upload over Nostr HTTP |
| `index.ts` | ✅ Current | Module exports |

### Cashu / Wallet Layer: `taskify-pwa/src/wallet/` and `src/mint/`

#### Wallet Modules (`taskify-pwa/src/wallet/`)

| File | Status | Responsibility |
|------|-----|--|
| `CashuManager.ts` | ✅ Current | Core wallet operations: init, send, receive, melt; manages proof lifecycle |
| `storage.ts` | ✅ Current | Proof persistence (`getProofs` / `setProofs` per mint URL) |
| `seed.ts` | ✅ Current | BIP39 seed phrase generation and derivation; `persistWalletCounter` for replay prevention |
| `p2pk.ts` | ✅ Current | Pay-to-Public-Key locking for Cashu tokens |
| `nut16.ts` | ✅ Current | Cashu NUT-16 deterministic/offline token support |
| `nwc.ts` | ✅ Current | Nostr Wallet Connect (NIP-47) integration |
| `lightning.ts` | ✅ Current | Lightning invoice utilities |
| `dleq.ts` | ✅ Current | DLEQ blind signature proof validation |
| `npubCash.ts` | ✅ Current | NPub-addressed cash sends |
| `mintBackup.ts` | ✅ Current | Encrypted mint state backup/restore |
| `peanut.ts` | ✅ Current | Peanut network utility functions (lightning node discovery) |

#### Mint Modules (`taskify-pwa/src/mint/`)

| File | Status | Responsibility |
|------|-----|--|
| `MintConnection.ts` | ✅ Current | Per-mint HTTP connection abstraction |
| `MintSession.ts` | ✅ Current | Session-level mint state (keyset cache, info) |
| `MintQuoteManager.ts` | ✅ Current | Quote lifecycle: create, poll, expire |
| `SwapManager.ts` | ✅ Current | Atomic token swap (split + merge) |
| `StateCheckManager.ts` | ✅ Current | Proof state queries (NUT-17) |
| `LockedTokenManager.ts` | ✅ Current | Bookkeeping for P2PK/HTLC locked tokens |
| `MintRateLimiter.ts` | ✅ Current | Per-mint request throttling |
| `PaymentRequestManager.ts` | ✅ Current | Cashu payment request handling |
| `MintCapabilityStore.ts` | ✅ Current | Stores mint info (supported NUTs) |
| `MintRequestCache.ts` | ✅ Current | Response caching to avoid redundant mint calls |

**React bindings:** `src/context/CashuContext.tsx` (main wallet state), `NwcContext.tsx` (NWC), `P2PKContext.tsx` (P2PK locked tokens).

### Agent Mode: `taskify-pwa/src/agent/`

| File | Responsibility |
|------|---------------|
| `agentDispatcher.ts` | JSON command parser and operation router; the main agent entry point |
| `agentRuntime.ts` | Runtime interface — provides `AgentRuntime` instance backed by real app state |
| `agentSecurity.ts` | Trust config CRUD, provenance annotation, security mode enforcement |
| `agentIdempotency.ts` | Idempotency key storage in IndexedDB to prevent duplicate creates on retry |

Agent commands arrive as JSON (`{v, id, op, params}`), are dispatched through `agentDispatcher.ts`, execute via `agentRuntime.ts`, and return `{v, id, ok, result, error}`. See `docs/agent-mode.md` for the full command reference.

### Storage Layer: `taskify-pwa/src/storage/`

| File | Responsibility |
|------|---------------|
| `taskifyDb.ts` | IndexedDB database name and version constants |
| `idbStorage.ts` | Low-level IndexedDB API wrapper (open, get, put, delete) |
| `idbKeyValue.ts` | Async write-queued key-value store on top of IDB; synchronous reads from in-memory cache |
| `kvStorage.ts` | App-level KV abstraction (`getItem` / `setItem`) backed by localStorage |
| `localStorageGuardrails.ts` | Detects localStorage quota issues and degraded-mode fallbacks |
| `storageBootstrap.ts` | Initializes all storage stores on startup with timeout protection |

**IndexedDB stores** (defined in `taskifyDb.ts`):
- Tasks, boards, settings, agent security config
- Wallet: Cashu proof sets per mint
- Nostr: cursor snapshots, event cache metadata

**localStorage** (via `kvStorage`): onboarding flags, Nostr secret key (`LS_NOSTR_SK`), relay list, VAPID public key, settings flags. Constants defined in `src/localStorageKeys.ts` and `src/domains/storageKeys.ts`.

### Task Domain: `taskify-pwa/src/domains/tasks/`

| File | Responsibility |
|------|---------------|
| `taskTypes.ts` | `Task`, `Board`, `Subtask`, `TaskAssignee`, `Recurrence` type definitions |
| `taskUtils.ts` | Task manipulation helpers (filter, sort, due-date grouping) |
| `boardUtils.ts` | Board operations: compound board parsing, `boardScopeIds` for multi-relay publish |
| `taskHooks.ts` | React hooks for task create/update/complete operations |
| `settingsTypes.ts` | `AppSettings` type definition |
| `settingsHook.ts` | React hook for settings read/write |
| `contactUtils.ts` | Contact metadata resolution from Nostr profiles |

**Core task type shape** (abridged from `taskTypes.ts`):
```typescript
type Task = {
  id: string;
  boardId: string;
  title: string;
  dueISO: string;          // ISO date for day-grouping
  priority?: 1 | 2 | 3;   // 1=low (!), 2=medium (!!), 3=high (!!!)
  completed?: boolean;
  note?: string;
  createdBy?: string;      // Nostr pubkey hex
  lastEditedBy?: string;   // Nostr pubkey hex (used for agent trust)
  bounty?: { token: string; state: "locked"|"unlocked"|"revoked"|"claimed"; lock?: "p2pk"|"htlc"|"none" };
  recurrence?: Recurrence;
  subtasks?: Subtask[];
  assignees?: TaskAssignee[];
};

type Board =
  | { kind: "week" }
  | { kind: "lists"; columns: ListColumn[] }
  | { kind: "compound"; children: CompoundChildId[] }  // "boardId@relay1,relay2"
  | { kind: "bible" };
```

### Cloudflare Worker: `worker/src/index.ts` and feature modules

The router delegates feature-specific behavior to modules under `worker/src/`. Responsibilities:

| Area | Detail |
|------|--------|
| **Static assets** | Serves `taskify-pwa/dist/` via `ASSETS` static-assets binding (`[assets]` in `wrangler.toml`; type `AssetFetcher`, not R2) |
| **Device registration** | `PUT /api/devices` and `DELETE /api/devices/:deviceId` — stores push subscription records (D1 as source-of-truth, optional KV mirrors) |
| **Reminder scheduling** | `PUT /api/reminders` — upserts reminder rows in D1 (`reminders` table) per device |
| **Reminder delivery polling** | `POST /api/reminders/poll` — drains pending reminder rows for clients that poll after push wake-up |
| **Cron handler** | Runs every minute; reads due reminders from D1, appends pending notifications, sends Web Push ping |
| **Legacy Google Calendar** | Backend OAuth/watch/event routes retained temporarily; the PWA no longer calls or displays this integration |
| **Independent Apple Watch sync** | Authenticated HTTPS transport forwards Watch-signed, board-encrypted kind-30301 events to configured public Nostr relays without receiving decryption keys or task plaintext |
| **VAPID signing** | Signs Web Push requests using P-256 ECDSA; private key resolved from `VAPID_PRIVATE_KEY` env/KV binding |

**Cloudflare bindings** (`wrangler.toml`):
- `TASKIFY_DB` D1 — source-of-truth for `devices`, `reminders`, and `pending_notifications`
- `TASKIFY_DEVICES` KV (optional) — legacy/cache lookup for device records
- `TASKIFY_REMINDERS` KV (optional) — legacy reminder storage keyspace
- `TASKIFY_PENDING` KV (optional) — legacy pending-notification keyspace
- `VAPID_PRIVATE_KEY` env or KV binding — VAPID signing key material
- `PREVIEW_RATE_LIMITER` — 30 requests/minute per connecting IP
- `NIP05_RATE_LIMITER` — 60 requests/minute per connecting IP

---

## Data Flow Diagrams

### Startup Sequence

```
main.tsx
  │
  ├─ Polyfill injection (process, Buffer, global)
  │
  ├─ storageBootstrap.initializeStorageBoundaries()
  │    ├─ Opens IndexedDB (taskifyDb.ts)
  │    └─ Preloads key-value stores into memory (idbKeyValue)
  │    [1500ms timeout guard — continues on failure]
  │
  ├─ Lazy-load App + providers
  │
  └─ App.tsx mounts
       │
       ├─ Read localStorage: LS_NOSTR_SK, onboarding flags, settings
       │
       ├─ Determine onboarding state:
       │    showFirstRunOnboarding || showAgentModeOnboarding
       │    → if active: hard-gate navigation, snap activePage → "boards"
       │
       ├─ NostrSession.init(relays)
       │    ├─ Creates NDK instance
       │    ├─ Connects to relays (with health tracking)
       │    └─ Begins subscription setup
       │
       ├─ CashuManager.init() per configured mint
       │    ├─ Loads proofs from IndexedDB
       │    └─ Fetches mint info (keyset, capabilities)
       │
       └─ Push notification registration check
            └─ If configured: registers service worker subscription
                 → Worker PUT /api/devices (registers push subscription)
```

### Task Event Flow (Nostr Sync)

```
User creates/edits task
  │
  ├─ taskHooks / App.tsx handler
  │    └─ idbKeyValue.setItem(TASKS_STORE, taskId, JSON(task))
  │         → In-memory cache updated immediately
  │         → Async IDB write queued (serialized write chain)
  │
  └─ (If shared board) NostrSession.publish(event)
       └─ PublishCoordinator.publish()
            ├─ Debounce (350ms default)
            ├─ BoardKeyManager.getBoardKeys(boardId)
            │    └─ Derives keypair from SHA256(boardId)
            ├─ Signs event with board key
            └─ NDK publishes to relay set
                 └─ RelayHealth filters unhealthy relays

Remote event arrives from relay
  │
  ├─ SubscriptionManager.onEvent()
  │    └─ EventCache.seen(id) → deduplicate
  │
  ├─ Frame-budget dispatch (startupStability):
  │    └─ Batch ≤64 events per requestAnimationFrame
  │
  └─ Event handler parses task event
       └─ idbKeyValue.setItem(TASKS_STORE, ...) → persists
            → React state update → re-render
```

### Cashu Token Flow

```
Send token (amount=N)
  │
  ├─ CashuManager.createSendToken(N, {p2pk?: {pubkey}})
  │    ├─ wallet.send(N, proofs) → splits into send/keep sets
  │    ├─ [optional] P2PK lock: locks send proofs to pubkey
  │    └─ getEncodedToken({mint, proofs, unit}) → cashuA... token string
  │
  └─ setProofs(mintUrl, keepProofs) → persists to IndexedDB

Receive token (encoded string)
  │
  ├─ CashuManager.receiveToken(encoded)
  │    ├─ Decode and validate token
  │    ├─ wallet.receive(proofs)
  │    │    └─ Contacts mint: swaps token proofs for new ones
  │    ├─ [if P2PK locked] resolvePrivkeysFromProofs() → auto-signs
  │    └─ assertValidProofsDleq() → DLEQ batch verification
  │
  └─ setProofs(mintUrl, mergedProofs) → persists updated proof set

Pay Lightning invoice
  │
  ├─ CashuManager.payInvoice(bolt11)
  │    ├─ mint.createMeltQuote(invoice) → fee estimate
  │    ├─ SwapManager: select sufficient proofs
  │    ├─ mint.meltProofs(proofs, quote) → returns change
  │    └─ setProofs(mintUrl, change) → persist
  │
  └─ Result: invoice paid, change proofs stored
```

### Agent Command Flow

```
External agent sends JSON:
  {"v":1, "id":"x", "op":"task.create", "params":{...}}
  │
  ├─ window.taskifyAgent.exec(json) OR AgentModePanel submit
  │
  └─ agentDispatcher.dispatchAgentCommand(jsonString)
       ├─ JSON.parse → validates schema
       ├─ Checks protocol version (any positive integer)
       ├─ [if idempotencyKey] agentIdempotency store lookup
       │    → returns cached result if already executed
       │
       ├─ getAgentRuntime() → AgentRuntime instance
       │
       ├─ Executes operation:
       │    task.create → runtime.createTask(params)
       │    task.list   → runtime.listTasks(filters)
       │    task.setStatus → runtime.setTaskStatus(id, status)
       │    ... (see docs/agent-mode.md for full list)
       │
       ├─ annotateTrust(result, securityConfig)
       │    ├─ Reads lastEditedBy / createdBy on each task
       │    └─ Classifies: "trusted" | "untrusted" | "unknown"
       │         based on trustedNpubs list
       │
       └─ Returns AgentResponseV1:
            {"v":1, "id":"x", "ok":true, "result":{...}, "error":null}
```

### Push Reminder Flow

```
User updates reminder set for a device
  │
  └─ PWA: PUT /api/reminders { deviceId, reminders[] }
       └─ Worker: replaces device reminder rows in D1 (`reminders` table)

Cloudflare Worker cron (every minute)
  │
  ├─ Reads due rows from D1 where send_at <= now (batched)
  │
  ├─ For each device with due reminders:
  │    ├─ Deletes fired rows from `reminders`
  │    ├─ Appends payload rows into `pending_notifications`
  │    ├─ Resolves device subscription (D1, with KV fallback)
  │    ├─ Signs Web Push ping with VAPID private key (P-256 ECDSA)
  │    └─ POSTs ping to device endpoint (410 triggers subscription cleanup)
  │
  └─ Client receives push and calls POST /api/reminders/poll to drain pending items
```

---

## Onboarding and Navigation Gating Model

### Overview

On first launch (or when no valid Nostr key exists), the app shows a non-dismissible onboarding modal that blocks all navigation. Two flows exist, and they are mutually exclusive:

| Flow | Trigger | Component |
|------|---------|-----------|
| **First-run** | No valid 64-char hex Nostr SK in localStorage | `src/onboarding/FirstRunOnboarding.tsx` |
| **Agent mode** | `?agent=1` URL param + no agent onboarding done flag | `src/onboarding/AgentModeOnboarding.tsx` |

### State Variables (all in `App.tsx`)

```typescript
// Derived once at mount from localStorage
const onboardingNeedsKeySelection: boolean  // true if LS_NOSTR_SK is not valid hex
const [showFirstRunOnboarding, setShowFirstRunOnboarding]: boolean
const [showAgentModeOnboarding, setShowAgentModeOnboarding]: boolean

// Master gate — computed every render
const isOnboardingActive = showFirstRunOnboarding || showAgentModeOnboarding

// Ref kept in sync every render — allows callbacks to read gate state
// without stale-closure issues
const isOnboardingActiveRef = useRef<boolean>
```

### Storage Keys for Onboarding

Defined in `src/domains/storageKeys.ts`:
- `LS_FIRST_RUN_ONBOARDING_DONE = "taskify_onboarding_done_v1"` — set to `"done"` when complete
- `LS_AGENT_MODE_ONBOARDING_DONE = "taskify_agent_onboarding_done_v1"` — set to `"done"` when complete
- `LS_NOSTR_SK` (defined in `src/nostrKeys.ts`) — 64-char hex Nostr secret key

### Gating Mechanisms (three layers)

**1. Navigation callback guards** (`App.tsx`, ~line 7916–7974):
All navigation functions (`openSettings`, `openWallet`, `openUpcoming`, `openContactsPage`, etc.) check `isOnboardingActiveRef.current` at the top and return early if true.

```typescript
const openSettings = useCallback(() => {
  if (isOnboardingActiveRef.current) return   // ← gate
  startTransition(() => setActivePage("settings"))
}, [])
```

**2. Hard snap-back effect** (`App.tsx`, ~line 8218–8222):
If `isOnboardingActive` becomes true while on any non-boards page, force navigation back to boards:

```typescript
useEffect(() => {
  if (isOnboardingActive && activePage !== "boards") {
    startTransition(() => setActivePage("boards"))
  }
}, [isOnboardingActive, activePage])
```

**3. Non-dismissible modal UI** (~line 19686–19712):
The onboarding modal renders with `showClose={false}` and `onClose={() => {}}`, making it impossible to dismiss without completing the flow.

### Onboarding Decision Logic

```
App mounts
  │
  ├─ Is agentSessionEnabled? (URL contains ?agent=1)
  │    YES → First-run onboarding skipped entirely
  │         → Show agent mode onboarding if not done
  │    NO  → Is LS_NOSTR_SK valid 64-char hex?
  │              YES → Skip first-run (user has a key)
  │              NO  → Is LS_FIRST_RUN_ONBOARDING_DONE = "done"?
  │                        YES → Skip (onboarding already completed)
  │                        NO  → Show first-run onboarding
  │
  └─ Storage access failures: fail-open (show onboarding)
```

### User Actions in First-Run Flow

| Action | Effect |
|--------|--------|
| Generate new key | `rotateNostrKey()` creates nsec; `getWalletSeedMnemonic()` creates wallet seed |
| Use existing key | Validates nsec format; writes to `LS_NOSTR_SK` |
| Restore from backup file | Parses backup JSON; restores keys and task data |
| Restore from cloud | Fetches encrypted backup from Worker R2; decrypts |
| Enable notifications | Registers service worker push subscription |
| Complete | `setItem(LS_FIRST_RUN_ONBOARDING_DONE, "done")`; `window.location.reload()` after 120ms |

### Test Coverage

`src/onboarding/onboardingGating.test.ts` (on `fix/onboarding-buttons-unlocked`, pending merge) covers:
- Fresh-install trigger conditions
- Agent-session mutual exclusivity
- Navigation blocking while active
- Snap-back from any non-boards page
- Startup-view redirect suppression during onboarding
- All storage key flag scenarios

---

## Nostr Event Processing Pipeline and Reliability Controls

### Subscription Lifecycle

```
NostrSession.subscribe(filters, options)
  → SubscriptionManager.subscribe()
       ├─ Normalize filters (add cursor `since` from CursorStore)
       ├─ Deduplicate: same filter + relay combo → refCount++
       ├─ NDK.subscribe(filters, relaySet)
       └─ Returns ManagedSubscription { key, subscription, release, filters, relayUrls }

Events arrive
  → SubscriptionManager state.seenIds has eventId? → drop (duplicate)
  → EventCache.add(event)
  → CursorStore.updateMany(filters, latestEventTimestamp)
  → User onEvent handlers

Subscription closed (component unmount or explicit)
  → release() → refCount-- → if 0: NDK.subscription.stop()
```

### Relay Health Tracking (`nostr/RelayHealth.ts`)

- Consecutive failure counter per relay URL
- Backoff schedule: 5s → 10s → 20s → ... → 5min max
- Unhealthy relays excluded from publish relay sets
- Recovery: successful event from relay resets failure count

### Startup Stability (Pending Merge)

The current version **does not yet include** startupStability.ts. This stabilization module is on branch `fix/startup-relay-stability` and pending merge.

**Current behavior:** No rate control at startup — relays may flood hundreds of events, potentially blocking the main thread.

**Planned behavior (after merge):**
- Intercepts the NDK event stream at startup
- Dispatches events in batches of `FLUSH_BATCH_SIZE=64` per animation frame
- Uses `requestAnimationFrame` with `setTimeout(0)` fallback for environments that throttle rAF
- Once event ingest stabilizes (EOSE or count falls below threshold), normal event routing resumes

### NIP-42 Relay Authentication (`nostr/RelayAuth.ts`)

- Listens for `AUTH` challenge messages from relays
- Responds with signed NIP-42 auth events using the user's nsec
- Auth state cached per relay WebSocket connection
- Failed auth marks relay as auth-failed (not the same as health failure)

### Event Deduplication

Two-layer deduplication:
1. **`SubscriptionManager`** — per-subscription `seenIds` Set prevents duplicate callback dispatch.
2. **`EventCache`** — global in-memory cache of recent event IDs with FIFO-style eviction at 2048 entries (auxiliary cache for downstream reads).

Events are deduped for dispatch by `seenIds`; `EventCache` is populated after dispatch eligibility checks.

---

## Security and Trust Model

### User Identity

- Identity is a Nostr keypair (nsec/npub)
- Secret key stored in localStorage (`LS_NOSTR_SK`) as 64-char hex — never transmitted
- Key rotation via `rotateNostrKey()` generates a new keypair and updates localStorage
- No server-side account — no passwords, no email

### Board Encryption

- Shared boards use deterministic per-board keypairs derived from `SHA256(boardId)` via `nostr/BoardKeyManager.ts`
- All tasks on a shared board are signed with the board key, not the user key
- Board key is derived locally; anyone who knows `boardId` can derive the same key

### Agent Mode Security (`src/agent/agentSecurity.ts`)

Three security modes for agent operations:

| Mode | Behavior |
|------|---------|
| `off` | All task operations permitted; results annotated with provenance fields |
| `moderate` | Operations permitted; trusted npubs' tasks marked `agentSafe=true` |
| `strict` | `task.get` / `task.list` returns only tasks where `lastEditedBy` is in `trustedNpubs`; FORBIDDEN error for others |

**Trust classification** (per task, in `annotateTrust`):
```
lastEditedBy in trustedNpubs  → "trusted"
lastEditedBy not set          → "unknown"
lastEditedBy set but not trusted → "untrusted"
```

**Trust config persistence**: stored in IndexedDB (not localStorage) via `agentSecurity.ts`. Config includes: `{ enabled: boolean, mode: "off"|"moderate"|"strict", trustedNpubs: string[] }`.

**Trusted npub format**: bech32 `npub1...` format; validated via `isLooselyValidTrustedNpub()` before adding.

### Cashu Token Security

- Proof storage is local-only (IndexedDB) — no server holds proofs
- P2PK locks tie tokens to a Nostr pubkey; auto-signing in `resolvePrivkeysFromProofs()` uses the user's key
- DLEQ proofs validated on receive to detect blind-signature forgeries
- Wallet seed (BIP39 mnemonic) stored locally; `persistWalletCounter` prevents counter replay
- **High-risk**: any change to `wallet/` or `mint/` requires second-reviewer sign-off — token loss is not recoverable

### Push Notification Security

- VAPID keys generated at deploy time; private key stored in Cloudflare KV (`VAPID_PRIVATE_KEY` binding), never in PWA
- Device push endpoints stored in D1; Worker verifies VAPID signature on every push send
- No user-identifiable data in push payloads beyond reminder text

---

## Known Constraints and Technical Debt

| Constraint | Detail | Location |
|------------|--------|----------|
| **Monolithic App.tsx** | ~800KB root component; hard to navigate and test in isolation | `taskify-pwa/src/App.tsx` |
| **No wallet/mint tests** | Swap, P2PK, NWC flows are entirely untested | `src/wallet/`, `src/mint/` |
| **No Worker tests** | Cron, push dispatch, KV/D1 logic untested outside live Cloudflare | `worker/src/index.ts` |
| **No E2E tests** | Browser-level flows (onboarding, task create, wallet send) unverified | — |
| **No coverage tooling** | No `c8` / `nyc` configured; coverage is unknown | `taskify-pwa/package.json` |
| **localStorage for secrets** | Nostr SK in localStorage is readable by injected scripts; no secure enclave | `src/nostrKeys.ts` |
| **Single Worker file** | All Worker logic in one 98KB file; hard to unit-test individual handlers | `worker/src/index.ts` |
| **BIP39 counter persistence** | Wallet counter stored per mint/keyset; loss causes proof replay risk | `wallet/seed.ts` |
| **Board key derivation** | Board keys are deterministic from `boardId` — anyone with `boardId` gets signing key | `nostr/BoardKeyManager.ts` |

See `docs/engineering-roadmap.md` for the planned test expansion addressing the most critical gaps.
