# Taskify Functions and Flows

End-to-end walkthroughs of the highest-value application flows. For each flow: entry points, core functions called, state touched, and persistence side effects. Designed as a working reference for contributors and AI agents.

---

## Flow Index

1. [App Startup and Relay Ingest](#1-app-startup-and-relay-ingest)
2. [First-Run Onboarding](#2-first-run-onboarding)
3. [Create Task](#3-create-task)
4. [Complete Task](#4-complete-task)
5. [Board Switching](#5-board-switching)
6. [Send Cashu Token](#6-send-cashu-token)
7. [Receive Cashu Token](#7-receive-cashu-token)
8. [Agent Command Dispatch](#8-agent-command-dispatch)
9. [Push Reminder Scheduling](#9-push-reminder-scheduling)

---

## 1. App Startup and Relay Ingest

**Purpose:** Bootstrap the app from cold start, connect to Nostr relays, and ingest existing task events without stalling the UI.

### Entry Points
- `taskify-pwa/src/main.tsx` — process polyfills, storage init, lazy load
- `taskify-pwa/src/App.tsx` — component mount, session init

### Step-by-Step

```
main.tsx
  1. Inject polyfills:
       window.process = process; window.Buffer = Buffer; window.global = window
       → Required by nostr-tools and @cashu/cashu-ts (Node-only APIs)

  2. storageBootstrap.initializeStorageBoundaries()
       Path: src/storage/storageBootstrap.ts
       → Opens IndexedDB via idbStorage.openDatabase()
       → Calls idbKeyValue.initStore(storeName, keys) for each store
       → Preloads key-value pairs into memory (src/storage/idbKeyValue.ts)
       → 1500ms timeout: if IDB fails, app continues with degraded state

  3. Lazy-load App component + providers:
       CashuProvider    → src/context/CashuContext.tsx
       NwcProvider      → src/context/NwcContext.tsx
       P2PKProvider     → src/context/P2PKContext.tsx
       ToastProvider    → src/context/ToastContext.tsx

  4. ReactDOM.render(<App />) inside StrictMode

App.tsx (mount)
  5. Read localStorage flags synchronously:
       LS_NOSTR_SK          → src/nostrKeys.ts
       LS_FIRST_RUN_ONBOARDING_DONE → src/domains/storageKeys.ts
       LS_NOSTR_RELAYS      → relay list
       App settings         → src/domains/tasks/settingsHook.ts

  6. Compute onboarding state:
       onboardingNeedsKeySelection: !/^[0-9a-fA-F]{64}$/.test(sk)
       showFirstRunOnboarding: !agentSession && needsKey && flag !== "done"
       showAgentModeOnboarding: agentSession && flag !== "done"
       isOnboardingActive = showFirstRunOnboarding || showAgentModeOnboarding
       → If active: navigation callbacks blocked, activePage snapped to "boards"

  7. NostrSession.init(relays)
       Path: src/nostr/NostrSession.ts
       → Creates NDK instance with relay URLs
       → RelayHealth.ts registers relay failure trackers
       → NDK connects to relays (WebSocket)

  8. Startup relay ingest begins:
       SubscriptionManager.subscribe(taskFilters)
       → src/nostr/SubscriptionManager.ts
       → CursorStore injects `since` per normalized filter (src/nostr/CursorStore.ts)
       → Events arrive → per-subscription `seenIds` dedupe + EventCache.add(raw)
       → Handlers fire immediately from the NDK `event` callback (no frame-budget dispatcher in this branch)

  9. CashuManager.init() for each configured mint:
       Path: src/wallet/CashuManager.ts
       → wallet/storage.ts: loads proofs from IndexedDB
       → Fetches mint keyset info (MintCapabilityStore)
       → MintSession initialized

  10. Push subscription check:
        If push configured: navigator.serviceWorker.ready
        → getSubscription() or subscribe()
        → PUT /api/devices to Worker (registers push subscription)
```

### State Touched
- `activePage` (React state in App.tsx)
- `showFirstRunOnboarding`, `showAgentModeOnboarding` (React state)
- `isOnboardingActiveRef` (React ref, kept in sync each render)
- In-memory IDB cache populated (`idbKeyValue`)
- NDK session created and connected

### Persistence Side Effects
- None during startup itself — state read from existing storage
- Relay `since` cursors updated in `CursorStore` as events are ingested

### Where to Edit
- Change relay defaults: `src/lib/relays.ts`
- Change storage init timeout: `src/storage/storageBootstrap.ts`
- Change startup ingest behavior (dedupe/cursor/event callback path): `src/nostr/SubscriptionManager.ts`
- Change polyfills: `src/main.tsx` top-of-file

---

## 2. First-Run Onboarding

**Purpose:** Establish user identity (Nostr keypair) before allowing any app use. Blocks navigation until complete.

### Entry Points
- `App.tsx` — `showFirstRunOnboarding` state, rendered at ~line 19686
- `src/onboarding/FirstRunOnboarding.tsx` — onboarding component
- `src/onboarding/AgentModeOnboarding.tsx` — agent-mode variant

### Step-by-Step (Standard Flow)

```
1. App mounts; showFirstRunOnboarding = true
   → Modal rendered: <Modal showClose={false} onClose={() => {}}>
   → All nav callbacks return early (isOnboardingActiveRef.current = true)

2. User chooses an action:

   A. Generate new key
      Handler: handleOnboardingGenerateNewKey (App.tsx ~line 8174)
        → rotateNostrKey()               [src/nostrKeys.ts]
             → generateSecretKey() from nostr-tools
             → localStorage.setItem(LS_NOSTR_SK, hexSK)
        → getWalletSeedMnemonic()        [src/wallet/seed.ts]
             → generateMnemonic() from @scure/bip39
             → stores mnemonic in localStorage
        → returns { nsec: "nsec1..." }

   B. Use existing key (nsec import)
      Handler: handleOnboardingUseExistingKey (App.tsx)
        → Validates nsec format
        → Decodes to hex via nostr-tools
        → localStorage.setItem(LS_NOSTR_SK, hexSK)

   C. Restore from backup file
      Handler: handleOnboardingRestoreFromBackupFile (App.tsx)
        → Reads File object
        → Parses backup JSON
        → Restores SK, boards, tasks, settings to localStorage + IDB

   D. Enable push notifications
      Handler: handleOnboardingEnableNotifications (App.tsx)
        → navigator.serviceWorker.ready
        → pushManager.subscribe({userVisibleOnly: true, applicationServerKey})
        → PUT /api/devices with endpoint + push keys (registers device)

3. User clicks "Complete"
   Handler: completeOnboardingWithReload (App.tsx ~line 8184)
     → kvStorage.setItem(LS_FIRST_RUN_ONBOARDING_DONE, "done")
     → setShowFirstRunOnboarding(false)
     → setTimeout(() => window.location.reload(), 120)
        [120ms delay: ensures localStorage write flushes before reload]

4. Page reloads
   → isOnboardingActive = false
   → All navigation unlocked
   → NostrSession initialized with new/restored key
```

### State Touched
- `showFirstRunOnboarding` (React state → false on complete)
- `isOnboardingActive` (derived → false)
- `isOnboardingActiveRef.current` (ref → false)
- `activePage` (snapped to "boards" while active; unlocks after)

### Persistence Side Effects
- `LS_NOSTR_SK` written to localStorage
- `LS_FIRST_RUN_ONBOARDING_DONE` written to localStorage
- Wallet mnemonic written to localStorage (if new key generated)
- Task/settings data written to IDB (if restore path)

### Where to Edit
- Onboarding UI: `src/onboarding/FirstRunOnboarding.tsx`
- Key generation: `src/nostrKeys.ts` (`rotateNostrKey`)
- Wallet seed: `src/wallet/seed.ts` (`getWalletSeedMnemonic`)
- Gating logic and state: `App.tsx` lines ~7510–8222
- Tests: `src/onboarding/onboardingGating.test.ts`

---

## 3. Create Task

**Purpose:** Add a new task to a board, persist locally, and publish to Nostr if the board is shared.

### Entry Points
- **UI**: Task edit modal (`src/ui/task/EditModal.tsx`) → "Add" button
- **Agent**: `agentDispatcher.dispatchAgentCommand({op:"task.create", ...})`
- **Hooks**: `src/domains/tasks/taskHooks.ts` → `useCreateTask()`

### Step-by-Step (UI path)

```
1. User opens task creation UI
   → EditModal.tsx renders
   → Inputs: title (required), note, dueISO, priority (1-3), boardId

2. User submits
   → App.tsx task create handler invoked
   → Constructs Task object:
        id: crypto.randomUUID() or nanoid
        boardId: selected board id
        title, note, dueISO, priority
        createdBy: hexPubkey (from LS_NOSTR_SK → getPublicKey())
        lastEditedBy: hexPubkey

3. Persist to IndexedDB:
   idbKeyValue.setItem(TASKS_STORE, task.id, JSON.stringify(task))
   Path: src/storage/idbKeyValue.ts
   → In-memory cache updated immediately (synchronous for reads)
   → Async IDB write queued (serialized write chain prevents races)

4. Update React state:
   → setTasks([...tasks, newTask]) or similar state update
   → Component re-renders with new task visible

5. (If shared board) Publish Nostr event:
   NostrSession.publish(taskEvent)
   Path: src/nostr/NostrSession.ts → PublishCoordinator.publish()
   → BoardKeyManager.getBoardKeys(boardId)
        src/nostr/BoardKeyManager.ts
        → SHA256(boardId) → derive secp256k1 keypair
   → Constructs NIP-01 event:
        kind: [task kind for Taskify]
        content: JSON.stringify(task)
        tags: [board tag, due date tag, ...]
   → Signs with board keypair
   → NDK publishes to relay set (unhealthy relays excluded)
   → PublishCoordinator debounces: 350ms default
```

### Step-by-Step (Agent path)

```
dispatchAgentCommand('{"v":1,"id":"x","op":"task.create","params":{...}}')
  Path: src/agent/agentDispatcher.ts

  1. JSON.parse → validate envelope (v, id, op, params)

  2. [if idempotencyKey provided]
     agentIdempotency.checkIdempotencyKey(key)
     Path: src/agent/agentIdempotency.ts
     → Looks up key in IDB idempotency store
     → If found: return cached response (skip execution)

  3. getAgentRuntime() → AgentRuntime instance
     Path: src/agent/agentRuntime.ts
     → Backed by live App.tsx state/handlers

  4. runtime.createTask({title, note, boardId, dueISO, priority})
     → Same IDB + Nostr publish path as UI (step 3-5 above)
     → Sets lastEditedBy to agent's npub (if provided in params)

  5. [if idempotencyKey] Store result in IDB idempotency store

  6. annotateTrust(createdTask, securityConfig)
     Path: src/agent/agentSecurity.ts
     → Reads lastEditedBy; classifies as trusted/untrusted/unknown

  7. Return: {"v":1, "id":"x", "ok":true, "result":{task, trustInfo}}
```

### State Touched
- `tasks` (React state array in App.tsx)
- IDB `TASKS_STORE` — new record written
- NDK relay publish (if shared board)

### Persistence Side Effects
- Task written to IndexedDB immediately
- Nostr event published to connected relays (for shared boards)
- Idempotency key stored in IDB (agent path only)

### Where to Edit
- Task type definition: `src/domains/tasks/taskTypes.ts`
- Task creation UI: `src/ui/task/EditModal.tsx`
- Task hooks: `src/domains/tasks/taskHooks.ts`
- Agent create op: `src/agent/agentDispatcher.ts` (`task.create` handler)
- Nostr publishing: `src/nostr/PublishCoordinator.ts`

---

## 4. Complete Task

**Purpose:** Mark a task as done, update local state and persistence, trigger any completion side effects (recurrence, scripture tracking).

### Entry Points
- **UI**: Task card (`src/ui/task/Card.tsx`) → checkmark tap
- **Agent**: `{op:"task.setStatus", params:{taskId, status:"done"}}`

### Step-by-Step

```
1. User taps task checkmark on Card.tsx
   → Calls App.tsx task complete handler

2. App.tsx handler:
   → Find task in local state by id
   → Mutate:
        task.completed = true
        task.completedAt = new Date().toISOString()

3. (If recurrence defined)
   → Compute next occurrence from recurrence rule
   → Create new task with next dueISO, completed = false
   → IDB write for new recurring task

4. (If scripture memory task — board kind "bible")
   → Update scripture memory progress in IDB
   → Publish scripture sync event (kind 30078) to Nostr
        Content: NIP-44 encrypted NostrScriptureMemorySyncPayload
        src/nostrAppState.ts: encryptNostrSyncPayload()

5. Persist updated task:
   idbKeyValue.setItem(TASKS_STORE, task.id, JSON.stringify(task))
   → In-memory cache updated; async IDB write queued

6. React state update → Card re-renders with completed style

7. (If shared board) Publish updated task event to Nostr relays
   → Same publish path as task creation
```

### Agent Path (`task.setStatus`)

```
dispatchAgentCommand({op:"task.setStatus", params:{taskId, status:"done"}})

1. getAgentRuntime().setTaskStatus(taskId, "done")

2. Strict mode check:
   getEffectiveAgentSecurityMode(config)
   → If "strict": verify task.lastEditedBy in trustedNpubs
     → NOT trusted: return FORBIDDEN error
   → If "off" or "moderate": proceed

3. Update task (steps 2-7 above)

4. Return updated task with trust annotation
```

### State Touched
- `tasks` array (React state) — task.completed mutated
- IDB `TASKS_STORE` — record updated
- (Conditional) IDB scripture memory store
- (Conditional) Nostr kind-30078 event published

### Persistence Side Effects
- Task updated in IndexedDB
- (If recurrence) New task created in IndexedDB + published
- (If scripture) Encrypted sync event published to Nostr relays
- (If shared board) Updated task event published to Nostr relays

### Where to Edit
- Completion logic: `App.tsx` task complete handler
- Recurrence: `src/domains/tasks/taskUtils.ts` (recurrence next-date computation)
- Scripture sync: `src/nostrAppState.ts` (`encryptNostrSyncPayload`)
- Card UI: `src/ui/task/Card.tsx`

---

## 5. Board Switching

**Purpose:** Change which board the user is viewing; load the correct tasks and subscription.

### Entry Points
- Board selector UI in the main boards view
- `App.tsx` `setActiveBoard(boardId)` handler
- `openBoardsPage()` navigation helper

### Step-by-Step

```
1. User taps a board in the board list
   → App.tsx: setActiveBoard(boardId)

2. Navigation guard check:
   if (isOnboardingActiveRef.current) return  ← blocked during onboarding

3. React state update:
   setActiveBoard(boardId) → triggers re-render
   → Boards view filters tasks by board.id === activeBoard

4. (If shared board) Update Nostr subscriptions:
   → SubscriptionManager: unsubscribe previous board filter
        refCount-- → if 0: NDK.subscription.stop()
   → boardScopeIds(board, boards) → get all relay scope IDs
        src/domains/tasks/boardUtils.ts
        For compound boards: recursively includes child board IDs
   → SubscriptionManager.subscribe(newBoardFilters)
        CursorStore.get(filter) → loads since cursor
        NDK.subscribe with fresh filter

5. Tasks load:
   → Existing tasks from IDB cache displayed immediately
   → New events from relays ingested via frame-budget dispatcher
```

### Compound Boards

Compound boards reference multiple child boards. `boardScopeIds()` (`src/domains/tasks/boardUtils.ts`) resolves all child IDs recursively. Each child may have its own relay set (format: `"boardId@relay1,relay2"`), parsed by `parseCompoundChildInput()`.

### State Touched
- `activeBoard` (React state)
- NDK subscriptions (unmount old, mount new)
- `CursorStore` — `since` cursor loaded for new subscription

### Persistence Side Effects
- `CursorStore` updates `since` as new events arrive
- No task state changes from switching boards alone

### Where to Edit
- Board switching handler: `App.tsx` `setActiveBoard` and board list UI
- Compound board parsing: `src/domains/tasks/boardUtils.ts` (`boardScopeIds`, `parseCompoundChildInput`)
- Subscription management: `src/nostr/SubscriptionManager.ts`
- Board types: `src/domains/tasks/taskTypes.ts`

---

## 6. Send Cashu Token

**Purpose:** Create a Cashu ecash token (optionally P2PK-locked) to send to another user.

### Entry Points
- Wallet UI: `src/components/CashuWalletModal.tsx` → send flow
- `src/context/CashuContext.tsx` → `sendToken(amount, options)`
- `src/wallet/CashuManager.ts` → `createSendToken(amount, options)`

### Step-by-Step

```
1. User enters amount and optional recipient npub
   → CashuWalletModal.tsx send form

2. [If P2PK lock requested]
   → Resolve recipient npub → hex pubkey
        src/lib/nostr.ts: normalizeNostrPubkey(npub)
   → Will lock token to this pubkey

3. CashuManager.createSendToken(amount, {p2pk: {pubkey}})
   Path: src/wallet/CashuManager.ts

   a. Load current proofs:
      wallet/storage.ts: getProofs(mintUrl) → from IndexedDB

   b. wallet.send(amount, proofs)
      [@cashu/cashu-ts Wallet.send()]
      → Selects sufficient proofs from local set
      → Contacts mint: POST /v1/swap
           mint splits proofs into send amount + change
      → Returns: { send: Proof[], keep: Proof[] }

   c. [If P2PK] Lock send proofs to pubkey:
      wallet/p2pk.ts or cashu-ts P2PK API
      → Proofs locked: can only be spent by holder of private key

   d. Encode token:
      getEncodedToken({ token: [{ mint, proofs }], unit: "sat" })
      → Returns "cashuA..." bech32 token string

   e. Persist keep proofs:
      wallet/storage.ts: setProofs(mintUrl, keepProofs)
      → idbKeyValue.setItem(WALLET_STORE, mintUrl, JSON(keepProofs))

4. Token string displayed / copied to clipboard
   → User shares via text, QR, or inline Nostr DM

5. CashuContext updates balance:
   → Recomputes total from keepProofs
   → Re-renders wallet balance display
```

### State Touched
- Proof set in IndexedDB (`WALLET_STORE`) — send proofs removed, keep proofs updated
- `CashuContext` balance state

### Persistence Side Effects
- IndexedDB proof set updated (send proofs consumed, keep proofs stored)
- Mint contacted to perform split (requires network)

### Where to Edit
- Send UI: `src/components/CashuWalletModal.tsx`
- Core send logic: `src/wallet/CashuManager.ts` (`createSendToken`)
- P2PK locking: `src/wallet/p2pk.ts`
- Proof storage: `src/wallet/storage.ts`
- Balance context: `src/context/CashuContext.tsx`

---

## 7. Receive Cashu Token

**Purpose:** Accept a Cashu token string, validate it, contact the mint, and add resulting proofs to local storage.

### Entry Points
- Wallet UI: `src/components/CashuWalletModal.tsx` → receive/paste flow
- `src/wallet/CashuManager.ts` → `receiveToken(encoded)`

### Step-by-Step

```
1. User pastes or scans a "cashuA..." token string

2. CashuManager.receiveToken(encoded)
   Path: src/wallet/CashuManager.ts

   a. Decode token:
      getDecodedToken(encoded) → { token: [{mint, proofs}], unit }

   b. [If P2PK locked] Check if any proof is P2PK-locked:
      resolvePrivkeysFromProofs(proofs)
      → Reads proof spending conditions
      → Matches against user's known pubkeys (Nostr key + board keys)
      → Builds privkey map for auto-signing

   c. wallet.receive(proofs, {privkeys?})
      [@cashu/cashu-ts Wallet.receive()]
      → Contacts mint: POST /v1/swap
           Presents token proofs; mint verifies and issues new proofs
      → Auto-signs P2PK proofs if privkeys provided
      → Returns new Proof[] (fresh from mint — old proofs invalidated)

   d. Validate DLEQ proofs:
      assertValidProofsDleq(newProofs, pubkeyResolver)
      Path: src/wallet/dleq.ts
      → Batch-verifies blind signature proofs
      → Throws if any proof is invalid (forgery detection)

   e. Merge with existing proofs:
      existingProofs = getProofs(mintUrl)
      merged = [...existingProofs, ...newProofs]

   f. Persist:
      wallet/storage.ts: setProofs(mintUrl, merged)
      → idbKeyValue.setItem(WALLET_STORE, mintUrl, JSON(merged))

3. CashuContext updates balance → re-renders
```

### State Touched
- Proof set in IndexedDB (`WALLET_STORE`) — new proofs appended
- `CashuContext` balance state

### Persistence Side Effects
- IndexedDB proof set updated (new proofs added)
- Mint contacted to swap/validate proofs (requires network)
- Wallet counter updated via `persistWalletCounter` if deterministic derivation used

### Where to Edit
- Receive UI: `src/components/CashuWalletModal.tsx`
- Core receive: `src/wallet/CashuManager.ts` (`receiveToken`)
- P2PK key resolution: `src/wallet/p2pk.ts` (`resolvePrivkeysFromProofs`)
- DLEQ validation: `src/wallet/dleq.ts` (`assertValidProofsDleq`)

---

## 8. Agent Command Dispatch

**Purpose:** Accept a JSON command from an external agent (AI, CLI, script), execute the operation against live app state, return a structured response.

### Entry Points
- `window.taskifyAgent.exec(jsonString)` — browser API (registered in App.tsx when `?agent=1`)
- `src/ui/agent/AgentModePanel.tsx` — manual input panel in agent mode UI

### Step-by-Step

```
Agent sends: '{"v":1,"id":"req-1","op":"task.list","params":{"status":"open"}}'

1. dispatchAgentCommand(jsonString)
   Path: src/agent/agentDispatcher.ts

2. JSON.parse(jsonString) → if fails: return PARSE_JSON error

3. Validate envelope:
   → v: must be positive integer (accepts "version" alias)
   → id: must be string
   → op: must be known operation string
   → params: validated per-op schema
   → If invalid: return VALIDATION error

4. [idempotencyKey present]
   getAgentIdempotencyStore().get(key)
   Path: src/agent/agentIdempotency.ts
   → If found: return cached response immediately (no re-execution)

5. getAgentRuntime()
   Path: src/agent/agentRuntime.ts
   → Returns AgentRuntime instance connected to live App.tsx state

6. Security check (for read ops under "strict" mode):
   getEffectiveAgentSecurityMode(config)
   Path: src/agent/agentSecurity.ts
   → "strict": task reads filtered to trustedNpubs tasks only
   → "moderate"/"off": no filtering

7. Execute operation:
   op routing table in agentDispatcher.ts:
     "meta.help"          → return all supported ops + descriptions
     "task.create"        → runtime.createTask(params)
     "task.update"        → runtime.updateTask(taskId, patch)
     "task.setStatus"     → runtime.setTaskStatus(taskId, status)
     "task.list"          → runtime.listTasks(filters) with pagination cursor
     "task.get"           → runtime.getTask(taskId)
     "agent.security.get" → loadAgentSecurityConfig()
     "agent.security.set" → saveAgentSecurityConfig({mode})
     "agent.trust.add"    → addTrustedNpub(config, npub)
     "agent.trust.remove" → removeTrustedNpub(config, npub)
     "agent.trust.list"   → config.trustedNpubs
     "agent.trust.clear"  → clearTrustedNpubs(config)

8. [if idempotencyKey] Store result:
   getAgentIdempotencyStore().set(key, result)

9. annotateTrust(result, config)
   Path: src/agent/agentSecurity.ts → annotateTrust()
   → For each task in result:
        lastEditedBy in trustedNpubs? → trusted: true
        lastEditedBy not set?         → trusted: unknown
        else?                         → trusted: false, agentSafe: false

10. Return response:
    {
      "v": 1,
      "id": "req-1",
      "ok": true,
      "result": { tasks: [...], cursor: "..." },
      "error": null
    }
```

### Error Response Shape

```json
{
  "v": 1,
  "id": "req-1",
  "ok": false,
  "result": null,
  "error": {
    "code": "FORBIDDEN",
    "message": "Task not accessible in strict mode"
  }
}
```

Error codes: `PARSE_JSON` | `VALIDATION` | `NOT_FOUND` | `CONFLICT` | `FORBIDDEN` | `INTERNAL`

### State Touched
- Depends on operation: `tasks` array, `boards` array, security config in IDB
- Agent security config: IDB `TASKS_STORE` (agent security key)
- Idempotency store: IDB (separate store)

### Persistence Side Effects
- `task.create`: new task in IDB + Nostr publish
- `task.update` / `task.setStatus`: updated task in IDB + Nostr publish
- `agent.trust.*` / `agent.security.set`: security config in IDB
- Idempotency key stored in IDB after any successful mutating op

### Where to Edit
- Op routing and schemas: `src/agent/agentDispatcher.ts`
- Runtime operations: `src/agent/agentRuntime.ts`
- Security / trust: `src/agent/agentSecurity.ts`
- Idempotency: `src/agent/agentIdempotency.ts`
- Command reference: `docs/agent-mode.md`
- Tests: `src/agent/agentDispatcher.test.ts`

---

## 9. Push Reminder Scheduling

**Purpose:** Schedule a push notification to fire at a future time when a task is due.

### Entry Points
- Task edit modal: enable reminder toggle → `src/domains/push/pushUtils.ts`
- Worker cron handler: fires every minute via `wrangler.toml` cron trigger

### Step-by-Step

#### PWA Side (scheduling)

```
1. User sets reminders on a task (preset/custom `minutesBefore[]`)
   → Task edit modal / reminder UI (App.tsx computes snapshot from current tasks)

2. PWA pushes the full reminder snapshot to Worker:
   PUT /api/reminders
   Headers: Content-Type: application/json
   Body: {
     deviceId,
     reminders: [{ taskId, boardId, title, dueISO, minutesBefore: number[] }, ...]
   }

3. Worker `handleSaveReminders(...)` validates device + payload,
   then rewrites reminder rows for that device in D1 table `reminders`:
   - DELETE existing rows for device_id
   - INSERT each computed reminder occurrence (send_at = dueISO - minutesBefore)

4. Worker clears stale pending notifications for that device
   (`DELETE FROM pending_notifications WHERE device_id = ?`).
```

#### Worker Side (delivery, every minute)

```
Worker cron trigger (*/1 * * * *)
  Path: worker/src/index.ts → scheduled() handler
  Runs reminder delivery and push wake-up processing.

  processDueReminders steps:
  1. Query due rows from D1 `reminders` table (batched):
       SELECT ... FROM reminders WHERE send_at <= now ORDER BY send_at LIMIT 256

  2. In one D1 transaction, insert durable `pending_notifications` rows and
     delete their source reminder rows.

  3. For each device: resolve push subscription (D1 first, KV migration fallback),
     then send a lightweight Web Push ping (sendPushPing) to wake the service worker.
     → If push endpoint is expired (HTTP 410): device state is removed.

  4. Service worker wakes on push, then polls:
       POST /api/reminders/poll  (with subscription endpoint)
     → Worker returns pending rows, deletes delivered records, returns payload.
     → SW shows one notification per pending item.
```

### State Touched
- `TASKIFY_DB` D1 `reminders` table — rewritten per device on each PUT `/api/reminders`
- `TASKIFY_DB` D1 `pending_notifications` table — filled by cron, drained by `/api/reminders/poll`
- `TASKIFY_DEVICES` KV — device lookup/registration source (reminders require known device)

### Persistence Side Effects
- Existing reminder rows for the device are replaced atomically via D1 batch
- Due reminders are deleted from `reminders` and inserted into `pending_notifications`
- Polling client reads + deletes pending rows (at-least-once semantics per poll window)

### Where to Edit
- PWA reminder snapshot + sync call: `src/App.tsx` (PUT `${workerBaseUrl}/api/reminders`)
- Push utility helpers: `src/domains/push/pushUtils.ts`
- Worker cron handler: `worker/src/index.ts` (`scheduled` export → `processDueReminders`)
- Reminder APIs: `worker/src/index.ts` (`PUT /api/reminders`, `POST /api/reminders/poll`)
- Service worker push handler: `taskify-pwa/public/` (service worker file)
- Worker bindings config: `wrangler.toml`

---

## Quick Reference: Where to Edit by Concern

| Concern | File(s) |
|---------|---------|
| Task types | `src/domains/tasks/taskTypes.ts` |
| Task creation/update logic | `src/domains/tasks/taskHooks.ts`, `App.tsx` |
| Board types and compound parsing | `src/domains/tasks/boardUtils.ts` |
| Nostr event publishing | `src/nostr/PublishCoordinator.ts`, `NostrSession.ts` |
| Nostr subscriptions | `src/nostr/SubscriptionManager.ts` |
| Relay health | `src/nostr/RelayHealth.ts` |
| Startup event ingest behavior | `src/nostr/SubscriptionManager.ts` (`sub.on("event", ...)` immediate handler path) |
| Cashu send/receive | `src/wallet/CashuManager.ts` |
| Proof storage | `src/wallet/storage.ts` |
| P2PK locking | `src/wallet/p2pk.ts` |
| Agent commands | `src/agent/agentDispatcher.ts` |
| Agent security and trust | `src/agent/agentSecurity.ts` |
| Onboarding state and gating | `App.tsx` (lines ~7510–8222), `src/onboarding/` |
| localStorage keys | `src/localStorageKeys.ts`, `src/domains/storageKeys.ts` |
| IndexedDB abstraction | `src/storage/idbKeyValue.ts`, `idbStorage.ts` |
| Push scheduling | `src/domains/push/pushUtils.ts` |
| Worker cron + push delivery | `worker/src/index.ts` |
| Settings types and hook | `src/domains/tasks/settingsTypes.ts`, `settingsHook.ts` |
