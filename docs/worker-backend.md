# Worker Backend Layer (Cloudflare Worker)

This guide documents the **current production backend flow** implemented in `worker/src/index.ts`.

It is written for contributors/agents who need to safely modify reminder delivery, push registration, Google Calendar sync, or OAuth behavior without introducing silent regressions.

---

## 1) Purpose and runtime boundaries

The Worker is responsible for three backend concerns:

1. **Push device + reminder orchestration** (HTTP APIs + cron)
2. **Google Calendar OAuth and synchronization**
3. **Static PWA asset serving** (`ASSETS` binding fallback)

Primary entry points:
- Fetch router: `worker/src/index.ts` (around lines 261–337)
- Cron scheduler: `worker/src/index.ts` (around lines 317–335)
- Schema bootstrapping: `worker/src/index.ts` (around lines 174–233)

---

## 2) Bindings and deployment contract

`wrangler.toml` defines the runtime contract:

- Cron cadence: `*/1 * * * *` (`wrangler.toml:16–17`)
- D1: `TASKIFY_DB` (`wrangler.toml:47–52`)
- KV (legacy/compat): `TASKIFY_DEVICES`, `TASKIFY_REMINDERS`, `TASKIFY_PENDING` (`wrangler.toml:26–36`)
- VAPID key binding: `VAPID_PRIVATE_KEY` as string secret or KV namespace (`wrangler.toml:38–40`)

`Env` typing in code confirms mixed binding support:
- `TASKIFY_DB` required D1 source-of-truth
- KV namespaces optional fallback/migration path
- `VAPID_PRIVATE_KEY: string | KVNamespace`

Reference: `worker/src/index.ts:37–44`.

---

## 3) API surface (actual router behavior)

Router dispatch in `fetch()`:

- `GET /api/config` → exposes `workerBaseUrl` + VAPID public key
- `GET /api/preview` → URL preview proxy
- `GET /api/nip05` → NIP-05 lookup
- `PUT /api/devices` → register/update push device
- `DELETE /api/devices/:deviceId` → delete device + associated reminder/pending rows
- `PUT /api/reminders` → replace reminder set for a device
- `POST /api/reminders/poll` → fetch and acknowledge pending reminder notifications

Reference: `worker/src/index.ts:290–307`.

### API contract anchors (agent quick-check table)

Use this table before changing handler logic so caller contracts stay aligned.

| Route | Request contract | Response contract | Primary caller(s) | Handler anchor |
|---|---|---|---|---|
| `GET /api/config` | none | `{ workerBaseUrl, vapidPublicKey }` | PWA bootstrap/config load | router branch in `fetch()` (`worker/src/index.ts:278`) |
| `PUT /api/devices` | `{ deviceId, platform, subscription{endpoint,keys{auth,p256dh}} }` | `{ subscriptionId, deviceId }` | `taskify-pwa/src/App.tsx:13237` | `worker/src/index.ts:608` (`handleRegisterDevice`) |
| `DELETE /api/devices/:deviceId` | path param `deviceId` | `204` empty body | `taskify-pwa/src/App.tsx:13321` | `worker/src/index.ts:2305` (`handleDeleteDevice`) |
| `PUT /api/reminders` | `{ deviceId, reminders[] }` | `204` empty body | reminder sync in PWA | `worker/src/index.ts:2335` (`handleSaveReminders`) |
| `POST /api/reminders/poll` | `{ endpoint }` or authenticated `{ deviceId, subscriptionId }`; optional acknowledgement IDs | `PendingReminder[]` | `taskify-pwa/public/sw.js` | `worker/src/reminders.ts` (`handlePollReminders`) |

---

## 4) Data model (D1 source-of-truth)

`ensureSchema()` creates/updates these core tables:

- `devices`
  - key: `device_id`
  - stores endpoint, endpoint hash, push keys
- `reminders`
  - key: `(device_id, reminder_key)`
  - stores due schedule (`send_at`) per reminder instance
- `pending_notifications`
  - queue-like rows consumed by `/api/reminders/poll`

Reference: `worker/src/index.ts:174–233`, plus migration baseline `worker/migrations/0001_init.sql`.

**Important invariant:** moving due reminders into `pending_notifications` and deleting the source rows is transactional. Pending rows remain until the client displays and acknowledges them.

---

## 5) Reminder lifecycle (authoritative control flow)

### 5.1 Save/update reminders

`PUT /api/reminders` (`handleSaveReminders`) validates payload and performs full replacement for device state.

High-level flow:
1. Parse `{ deviceId, reminders[] }`
2. Validate reminder item shape inline (`taskId`, `title`, `dueISO`, `minutesBefore[]`) and compute `sendAt`
3. Resolve/verify device record
4. Replace existing device reminder rows in D1
5. Clear existing pending rows for the device to avoid stale deliveries

Reference:
- `handleSaveReminders`: `worker/src/index.ts:2335+`

### 5.2 Cron dispatch

`scheduled()` runs once per minute and calls `processDueReminders()`.

`processDueReminders` behavior:
1. Query due rows from `reminders` where `send_at <= now` in batches
2. Delete processed reminder rows
3. Group by device
4. Insert mapped reminder payload rows into `pending_notifications` (`appendPending`)
5. Resolve device subscription (D1 first, KV migration fallback)
6. Send lightweight Web Push ping (`sendPushPing`) so SW wakes and polls
7. If push endpoint expired (410), remove device state

References:
- `scheduled`: `worker/src/index.ts:317–335`
- `processDueReminders`: `worker/src/index.ts:2443+`
- `appendPending`: `worker/src/index.ts:2507+`
- `sendPushPing`: `worker/src/index.ts:2779+`

### 5.3 Client poll + drain

Service worker flow:
- On push event, call `POST /api/reminders/poll` with subscription endpoint
- Retry with exponential backoff if needed
- Show one notification per returned item

References:
- `taskify-pwa/public/sw.js:175–235`
- `handlePollReminders`: `worker/src/index.ts:2404+`

**Why poll after push:** payload delivery and wake-up are decoupled; pending rows provide reliability when push payload limits/network variability occur.

---

## 6) Device registration + deletion semantics

### Register (`PUT /api/devices`)

`handleRegisterDevice` upserts device subscription into D1, tracks endpoint hash, and supports endpoint collision handling/migration.

Reference: `worker/src/index.ts:608+`.

### Delete (`DELETE /api/devices/:deviceId`)

`handleDeleteDevice` removes:
- device row
- reminders for device
- pending notifications for device
- legacy KV mirrors (best-effort)

Reference: `worker/src/index.ts:2305–2333`.

---

## 8) VAPID key resolution and signing

Push ping signing uses ES256 JWT + VAPID headers.

Key loading sequence in `resolvePrivateKeyPem`:
1. If `env.VAPID_PRIVATE_KEY` is a non-empty string, use it
2. Else if it behaves like KV, try keys: `VAPID_PRIVATE_KEY`, `private-key`, `key`
3. Else throw configuration error

References:
- `resolvePrivateKeyPem`: `worker/src/index.ts:2859+`
- `getPrivateKey`: `worker/src/index.ts:2833+`

**Security note:** private key material is never sent to clients. Client receives public key only via `/api/config`.

---

## 9) Failure modes and operator signals

Common failure classes:

1. **Misconfigured bindings**
   - Missing `TASKIFY_DB` or VAPID key → runtime errors
   - Mitigation: validate env setup and secrets before deploy

2. **Stale push subscriptions**
   - 404/410 from push service during ping
   - Worker cleanup path removes stale device registrations

3. **Reminder drift / late delivery**
   - Cron granularity is 1 minute + network/runtime latency
   - System is at-least-once wake + at-most-once queue drain per row

4. **Schema mismatch in older environments**
   - `ensureSchema()` runs at request/scheduled entry to reduce cold migration issues

Operational references:
- Error wrappers/logging in `fetch` and `scheduled`: `worker/src/index.ts:309–333`

---

## 10) KV→D1 migration contract (legacy compatibility)

The worker still supports progressive migration from legacy KV namespaces into D1 at read time. This path is easy to break during “cleanup” refactors, so verify these invariants before deleting any fallback logic.

Primary anchors:
- Device read fallback: `getDeviceRecord` → `migrateDeviceFromKv` (`worker/src/index.ts:2557–2653`)
- Endpoint reverse lookup fallback: `findDeviceIdByEndpoint` (`worker/src/index.ts:2584–2607`)
- Reminder migration: `migrateRemindersFromKv` (`worker/src/index.ts:2655–2711`)
- Pending queue migration: `migratePendingFromKv` (`worker/src/index.ts:2713–2749`)

### Migration behavior that must stay true

1. **D1 is preferred; KV is fallback-only.**
   - Reads hit D1 first, then attempt KV migration only on miss.
2. **Migration is destructive to legacy KV once imported.**
   - After successful import, legacy keys are deleted best-effort.
3. **Malformed KV payloads fail closed.**
   - Parse/shape failures are logged and ignored, not partially imported.
4. **Reminder and pending payloads are normalized before insert.**
   - Invalid entries are dropped before D1 writes.
5. **Endpoint hash consistency is repaired during migration.**
   - Missing `endpointHash` in legacy records is recomputed before upsert.

### Agent verification pseudocode

```text
read device from D1
if missing and TASKIFY_DEVICES exists:
  parse legacy device JSON
  validate shape
  compute endpointHash if absent
  upsert to D1
  migrate reminders/pending arrays from KV to D1
  delete legacy KV keys best-effort
```

Refactor warning:
- `findDeviceIdByEndpoint` can trigger migration as a side effect (`endpoint:{hash}` lookup → device id). Do not assume endpoint lookup is read-only in mixed deployments.

---

## 11) Agent change checklist (safe edits)

Before changing reminder/backend logic, verify:

1. API path + method still match PWA callers
   - `App.tsx` reminder sync: `taskify-pwa/src/App.tsx:20024–20071`
   - SW poll path: `taskify-pwa/public/sw.js:213–217`
2. D1 write/read/delete semantics remain consistent across:
   - `handleSaveReminders`
   - `processDueReminders`
   - `handlePollReminders`
3. Device deletion still clears all three stores (D1 + optional KV mirrors)
4. VAPID key resolution still supports both string and KV binding modes
5. Any behavior change is mirrored in docs (`architecture-overview.md`, this file)

---

## 12) Endpoint error semantics (status-code quick map)

Use this when changing validation/handler behavior so clients and service worker retries stay correct.

| Route | Success | Caller-visible error statuses in current implementation | Notes / code anchors |
|---|---|---|---|
| `PUT /api/devices` | `200` JSON `{ subscriptionId, deviceId }` | `400` (`deviceId`/`platform`/`subscription` validation), `500` (router-level catch) | Validation in `handleRegisterDevice` (`worker/src/index.ts:608–622`) |
| `DELETE /api/devices/:deviceId` | `204` empty body | `500` (unexpected DB/runtime error via router catch) | Delete is idempotent in practice; missing rows still return `204` (`worker/src/index.ts:2305–2333`) |
| `PUT /api/reminders` | `204` empty body | `400` (`deviceId` missing, `reminders` not array), `404` (unknown device), `500` (router catch) | Existing reminders are replaced, then pending queue is cleared (`worker/src/index.ts:2335–2401`) |
| `POST /api/reminders/poll` | `200` JSON (`[]` or `PendingReminder[]`), or `204` for acknowledgement-only | `400` (invalid acknowledgement list), `404` (unknown/unauthorized device), `500` (router catch) | Rows remain durable until explicitly acknowledged after display (`worker/src/reminders.ts`) |

Implementation detail worth preserving:
- Handler-level validation returns stable 4xx codes used by callers to differentiate user/actionable failures vs transient failures.
- Everything else is wrapped by the router `try/catch` and returned as `500` with `{ error }`.

## 12) Reminder dispatch deep slice (DB + side-effect sequence)

This section is a precise "what runs in what order" map for the cron-to-device path.
Use it when changing idempotency or debugging duplicate/missed notifications.

### 12.1 `processDueReminders` batch loop contract

Anchor: `worker/src/index.ts:2443–2504`

Per iteration:
1. **Select due rows** (`send_at <= now`, ordered, capped by `LIMIT 256`).
   - SQL anchor: `:2451–2457`
2. **Delete selected reminder rows immediately** (device_id + reminder_key pairs).
   - SQL anchor: `:2466–2471`
3. **Group reminders by device** in-memory.
   - Grouping anchor: `:2473–2481`
4. For each device:
   - Load device record (`getDeviceRecord`).
   - If missing device: clear pending rows for that device and skip push.
     - Missing-device cleanup anchor: `:2484–2487`
   - Else append pending rows (`appendPending`) and push ping.
     - append + ping anchor: `:2496–2499`

Important behavior: reminder rows are removed **before** push ping, so queue durability relies on `pending_notifications`, not `reminders`.

### 12.2 Queue append/poll drain semantics

- Append path: `appendPending` inserts one row per reminder with shared `created_at` batch timestamp.
  - Anchor: `worker/src/index.ts:2507–2528`
- Poll path: `handlePollReminders` loads all pending rows for device, ordered by `(created_at, id)`, then deletes exactly those row IDs.
  - Anchor: `worker/src/index.ts:2415–2431`

This yields:
- deterministic delivery order per device (oldest first),
- at-most-once drain for fetched row IDs,
- no server retry queue after successful poll response.

### 12.3 Stale-subscription cleanup trigger

When push ping returns `404/410`, worker calls `handleDeleteDevice(deviceId, env)`.
That cascades through D1 + KV mirrors (device/reminder/pending).

Anchors:
- push expiry branch: `worker/src/index.ts:2795–2798`
- deletion fan-out: `worker/src/index.ts:2305–2333`

Operational implication: endpoint expiry is treated as terminal device invalidation, not temporary backoff.

## 13) D1↔KV migration fallback matrix (agent verification chunk)

This is the concrete fallback behavior while legacy KV bindings still exist.
Use it before touching device lookup, poll, or migration code.

### 13.1 Read path decision tree

| Entry point | D1-first behavior | KV fallback trigger | Migration side effects | Anchors |
|---|---|---|---|---|
| `getDeviceRecord(env, deviceId)` | `SELECT ... FROM devices WHERE device_id = ?` | No D1 row found | Calls `migrateDeviceFromKv`; can migrate device + reminders + pending into D1 and delete KV keys | `worker/src/index.ts:2557–2569`, `:2609–2653` |
| `findDeviceIdByEndpoint(env, endpoint)` | hash endpoint then `SELECT device_id FROM devices WHERE endpoint_hash = ?` | No D1 row and `TASKIFY_DEVICES` bound | Reads `endpoint:{hash}` KV index, migrates mapped device id to D1, returns migrated id | `worker/src/index.ts:2584–2607` |
| `/api/reminders/poll` endpoint lookup | resolves `deviceId` from explicit `deviceId` or endpoint lookup | same as `findDeviceIdByEndpoint` | Poll then drains `pending_notifications` by selected row ids | `worker/src/index.ts:2404–2431`, `:2584–2607` |

### 13.2 Migration contract details

`migrateDeviceFromKv` is not a plain read-through; it performs a one-time import pipeline:

1. Parse + validate legacy device payload from `TASKIFY_DEVICES` (`device:{id}`)
2. Backfill `endpointHash` if missing (derived from endpoint)
3. Upsert device row into D1
4. Migrate reminders (`TASKIFY_REMINDERS`) into `reminders`
5. Migrate pending payload (`TASKIFY_PENDING`) into `pending_notifications`
6. Delete legacy KV keys (`device:{id}`, `endpoint:{hash}`, `reminders:{id}`, `pending:{id}`)

Anchors:
- Device migration core: `worker/src/index.ts:2609–2653`
- Reminder migration: `worker/src/index.ts:2655–2711`
- Pending migration: `worker/src/index.ts:2713–2749`

### 13.3 Invariants to preserve when editing

- A successful KV migration must leave D1 authoritative and remove migrated KV keys.
- Endpoint-hash lookup must remain consistent across register (`upsertDevice`) and poll (`findDeviceIdByEndpoint`).
- Poll acknowledgement must delete only explicitly acknowledged `pending_notifications` row IDs for the authenticated device/endpoint.
- Device deletion must continue clearing D1 + best-effort KV mirrors to avoid zombie registrations.

Quick re-check anchors:
- Upsert with endpoint hash: `worker/src/index.ts:2530–2555`
- Poll read+delete ids: `worker/src/index.ts:2415–2431`
- Delete fan-out: `worker/src/index.ts:2305–2333`

## 15) Scheduled execution ordering + failure isolation (agent verification chunk)

This section documents the exact scheduler sequencing contract. Preserve it unless you intentionally change cron semantics.

### 15.1 Execution order per cron tick

Within `scheduled()`, the runner currently executes in strict sequence:

1. `ensureSchema(env)`
2. `processDueReminders(env)`
3. Google Calendar watch renewal and failed-sync retry

Anchor: `worker/src/index.ts:317–323`

Independent scheduled jobs should remain failure-isolated so one integration cannot starve another.

### 15.2 waitUntil compatibility behavior

Scheduler dispatch supports multiple runtime shapes:

- Preferred: `ctx.waitUntil(runner())`
- Fallback: `event.waitUntil(runner())` when present
- Final fallback: direct `await runner()`

Anchors:
- `ctx.waitUntil` branch: `worker/src/index.ts:328–329`
- `event.waitUntil` branch: `worker/src/index.ts:330–331`
- direct await branch: `worker/src/index.ts:332`

This preserves compatibility across Cloudflare scheduler contexts and local/test harnesses.

### 15.3 Error propagation contract

- Any thrown error inside the runner is logged with cron metadata and rethrown.
- Re-throw means scheduler sees the execution as failed (not silently swallowed).

Anchor: `worker/src/index.ts:323–326`

### 15.4 Safe-edit guardrails

If you modify scheduled flow:

- Keep `ensureSchema` before D1-dependent jobs.
- Preserve explicit ordering decisions (or document intentional reordering in this file).
- Do not convert failures into silent success without adding equivalent observability.

## 16) Push wake ping contract (TTL + VAPID signing)

Reminder delivery depends on an intentionally minimal "wake ping" request to each subscription endpoint.
This section captures the concrete behavior so payload/auth changes do not silently break service-worker wakeups.

### 16.1 TTL derivation (`computeReminderTTL`)

Anchor: `worker/src/index.ts:2768–2777`

Current behavior:
1. Start with baseline TTL `300` seconds.
2. For each reminder with parseable `dueISO`, compute `secondsUntilDue`.
3. Raise TTL to at least `secondsUntilDue + 120` buffer.
4. Clamp final TTL to `[300, 86400]`.

Operational implication:
- Near-term reminders still get at least 5 minutes of push validity.
- Far-future due reminders can extend TTL up to 24h, reducing missed wake windows.

### 16.2 Ping request shape (`sendPushPing`)

Anchor: `worker/src/index.ts:2779–2810`

Request contract to push endpoint:
- method: `POST`
- body: empty (`Content-Length: 0`)
- headers:
  - `TTL: <computed seconds>`
  - `Authorization: WebPush <vapid-jwt>`
  - `Crypto-Key: p256ecdsa=<VAPID_PUBLIC_KEY>`

Error handling semantics:
- `404`/`410` => treat subscription as expired and call `handleDeleteDevice(deviceId, env)`.
- other non-2xx => log warning, keep device.
- transport/runtime exceptions => catch + log, do not throw to caller.

### 16.3 VAPID JWT contract (`createVapidJWT`)

Anchor: `worker/src/index.ts:2811–2831`

Claims/signing behavior:
- validates `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` are configured.
- computes `aud` from subscription endpoint origin (`protocol + host`).
- sets `exp = now + 12h`.
- signs `base64url(header).base64url(payload)` with ES256 using worker private key.

Payload shape:
- `{ aud, exp, sub }`

### 16.4 Private-key import fallback behavior

Anchors:
- key resolution: `worker/src/index.ts:2859–2878` (`resolvePrivateKeyPem`)
- import path: `worker/src/index.ts:2833–2857` (`getPrivateKey`)
- raw-key fallback guard: `worker/src/index.ts:2880+` (`shouldAttemptRawVapidImport`, `importRawVapidPrivateKey`)

Current contract:
- primary path imports PKCS#8 PEM key material.
- if import fails with supported key shape, fallback attempts raw 32-byte P-256 private key import (validated against public key).
- resolved `CryptoKey` is cached in-process (`cachedPrivateKey`) for subsequent pings.

### Safe-edit guardrails

If modifying push delivery/auth logic, preserve:
- empty-body wake ping semantics (payload-free push trigger),
- 404/410 terminal cleanup path,
- `aud` derivation from endpoint origin,
- ES256 JWT signing with bounded expiration,
- private key fallback compatibility (PKCS#8 + validated raw key path).

## 23) Poll drain concurrency + idempotency boundary (agent verification chunk)

`POST /api/reminders/poll` performs a **read-then-delete** sequence, but not inside an explicit SQL transaction.

Anchors:
- row read: `worker/src/index.ts:2415–2423`
- delete by selected row ids: `worker/src/index.ts:2428–2431`

### Current contract

1. Pending rows are fetched in deterministic order (`ORDER BY created_at, id`).
2. The same handler invocation then deletes exactly those fetched row ids.
3. Response payload is built from the fetched rows (not a second post-delete query).

### Practical boundary (important)

Because select + delete are separate D1 calls, concurrent poll requests for the same device can observe overlapping rows before one delete batch wins.

Operationally this means:
- normal single-consumer flow behaves as at-most-once,
- concurrent duplicate poll invocations may produce duplicate deliveries unless client-side dedupe exists.

### Safe-edit guardrails

If you change poll/drain behavior, preserve one of these explicitly:
- keep current read-then-delete contract and document caller dedupe responsibility, **or**
- move to an atomic claim/drain strategy (transactional delete-return pattern) and update service worker assumptions/tests accordingly.

## 24) Preview proxy resource-bound + fallback-shape contract (agent verification chunk)

`/api/preview` is intentionally built as a **bounded fetch + layered fallback** endpoint. Preserve these limits and response-shape guarantees when modifying preview behavior.

### 24.1 Hard runtime bounds (timeout + body size)

Current constants:
- `PREVIEW_TIMEOUT_MS = 8000`
- `PREVIEW_MAX_BYTES = 600000`

Anchors:
- constants: `worker/src/index.ts:136–139`
- timeout abort wiring in `handlePreviewProxy`: `worker/src/index.ts:2228–2242`
- bounded body reader: `worker/src/index.ts:916+` (`readResponseBodyLimited`)

Contract:
- upstream fetches are aborted after timeout via `AbortController`,
- response body reads are capped (no unbounded HTML buffering),
- timeout/read failures degrade to alternate/fallback preview payloads instead of raw upstream errors.

### 24.2 Protocol guard + redirect unwrapping

Input behavior:
1. requires query `url`,
2. normalizes Google redirect wrappers (`unwrapGoogleRedirectUrl`),
3. rejects non-`http(s)` URLs with `400`.

Anchors:
- request parse/validation: `worker/src/index.ts:2215–2227`
- redirect unwrapping helper: `worker/src/index.ts:717+`

Security implication: this endpoint is not a generic protocol proxy; `file:`, `data:`, and other schemes remain blocked at handler entry.

### 24.3 Fallback layering and caller-visible flags

`handlePreviewProxy` attempts in this order:
1. direct fetch + HTML derivation (`derivePreviewFromHtml`),
2. alternate enrichment (`attemptAlternatePreview`) when blocked/incomplete/fetch failure,
3. deterministic URL-based fallback (`buildFallbackPreview`).

Anchors:
- main decision tree: `worker/src/index.ts:2230–2303`
- alternate resolver: `worker/src/index.ts:2087+`
- fallback builder/response wrapper: `worker/src/index.ts:1052+`, `:1041+`

Response-shape contract:
- success payload always uses preview JSON shape,
- degraded paths set response metadata hints (`fallback` and, when detected, `blocked`) via `buildPreviewResponse(...)` extras.

### 24.4 Safe-edit guardrails

If you touch preview handling, preserve:
- protocol allowlist enforcement before fetch,
- timeout + byte-cap bounded fetch/read behavior,
- layered alternate/fallback path (no raw HTML passthrough on failure),
- stable caller-facing fallback signaling (`fallback`/`blocked`) used by clients for UX decisions.

## 17) Known limitations (current state)

- Worker implementation is monolithic (`worker/src/index.ts`), so cross-cutting edits are easy to miss in review.
- Legacy KV migration paths increase branch complexity and testing surface.
- Reminder dispatch relies on minute-level cron cadence, not real-time scheduling.
- There is no dedicated worker unit test suite yet for reminder/push paths (roadmap gap).

This is intentional documentation of **present reality**, not a proposal.

## 18) Preview proxy + NIP-05 lookup contracts (agent verification chunk)

These two endpoints are externally visible and easy to regress because they include fallback logic and caching behavior that is not obvious from the router table alone.

### 18.1 `/api/preview` contract (`handlePreviewProxy`)

Anchor: `worker/src/index.ts` (`handlePreviewProxy`)

Request requirements:
- query param `url` is required.
- URL is normalized through `unwrapGoogleRedirectUrl(...)`.
- only `http:` and `https:` protocols are accepted.

Core flow:
1. Fetch target with browser-like headers (`buildBrowserHeaders`) and redirect-following.
2. Abort the fetch after `PREVIEW_TIMEOUT_MS` via `AbortController`.
3. Read body through `readResponseBodyLimited(...)` (bounded body read).
4. Attempt rich extraction via `derivePreviewFromHtml(...)`.
5. If incomplete/blocked, attempt alternate resolver path (`attemptAlternatePreview(...)`).
6. If still unresolved, return deterministic fallback preview (`buildFallbackPreview(...)`).

Behavioral invariants:
- endpoint never proxies arbitrary non-http(s) protocols.
- failures degrade to structured fallback preview payloads instead of hard 5xx whenever possible.
- response metadata includes fallback/blocked hints when rich preview extraction fails.

### 18.2 `/api/nip05` lookup contract (`handleNip05Lookup`)

Anchors:
- parser: `worker/src/index.ts` (`parseNip05Address`)
- resolver: `worker/src/index.ts` (`handleNip05Lookup`)

Input behavior:
- accepts `address`, `addr`, or `nip05` query parameter.
- requires strict `name@domain` format; both parts are lowercased/trimmed.

Lookup sequence:
1. Try Cloudflare cache hit (`caches.default`) keyed by normalized address.
2. If cache stale/miss, fetch `https://<domain>/.well-known/nostr.json?name=<name>`.
3. Then fetch `https://<domain>/.well-known/nostr.json`.
4. For non-localhost domains, also try the two `http://` variants.
5. Return first successful JSON record and cache it with timestamp headers.

Status semantics:
- `400` for invalid address format.
- `502` when all upstream lookup attempts fail.
- `200` with `{ nip05, resolvedFrom, record }` on success.

Compatibility note:
- fallback to the no-query `.well-known/nostr.json` path is intentionally preserved for providers that return the full names map without `?name=` filtering.

### 18.3 Safe-edit guardrails

If you modify preview or NIP-05 logic, preserve:
- URL protocol allowlist (`http/https`) for preview fetches,
- timeout-bounded preview fetch + fallback response behavior,
- cache-first NIP-05 response path with bounded freshness,
- multi-endpoint NIP-05 lookup order (`https` first, localhost-safe `http` handling),
- stable response shape consumed by existing PWA callers.

## 19) Schema bootstrap + concurrency contract (agent verification chunk)

The Worker does runtime schema bootstrapping and intentionally de-duplicates concurrent bootstrap attempts in-process.

### 19.1 `ensureSchema` single-flight behavior

Anchors:
- schema gate state: `worker/src/index.ts:165` (`schemaReadyPromise`)
- bootstrap function: `worker/src/index.ts:174–235`

Contract:
1. First caller creates `schemaReadyPromise` and runs DDL.
2. Concurrent callers await the same promise instead of issuing duplicate DDL.
3. If bootstrap fails, `.catch(...)` resets `schemaReadyPromise = null` so a later request/cron tick can retry.

Operational implication:
- cold starts with concurrent requests should not race schema creation in the same isolate.
- transient D1 errors do not permanently poison future bootstrap attempts.

### 19.2 DDL + index invariants

Current bootstrapped objects:
- `devices`
- `reminders` (FK to `devices` with `ON DELETE CASCADE`)
- `pending_notifications` (FK to `devices` with `ON DELETE CASCADE`)
- indexes: `idx_reminders_send_at`, `idx_pending_device`

Anchors:
- table creation block: `worker/src/index.ts:186–226`
- index creation: `worker/src/index.ts:227–228`

Guardrails when editing:
- preserve `ON DELETE CASCADE` for reminder/pending rows unless deletion semantics are intentionally changed across handlers.
- preserve `send_at` and `pending device_id` indexes or provide equivalent query-path indexing before merge.
- keep bootstrap idempotent (`CREATE ... IF NOT EXISTS`) because it runs from both fetch and scheduled entry points.

### 19.3 Entry-point dependency ordering

Both HTTP and cron paths call `ensureSchema` before touching D1-backed flows.

Anchors:
- fetch path: `worker/src/index.ts:275`
- scheduled runner sequence: `worker/src/index.ts:320–322`

This ordering is required so first-run deployments do not fail reminder or device operations due to missing tables.

## 20) Device identity reconciliation contract (agent verification chunk)

`PUT /api/devices` is intentionally endpoint-centric, not strict-client-id centric. This avoids duplicate registrations when app/device IDs rotate but the push endpoint remains stable.

### 20.1 Registration resolution order

Anchor: `worker/src/index.ts:608–648` (`handleRegisterDevice`)

Current behavior:
1. Validate payload shape (`deviceId`, `platform`, `subscription.endpoint`, push keys).
2. Compute `endpointHash = hashEndpoint(subscription.endpoint)`.
3. Try `getDeviceRecord(env, deviceId)`.
4. If no row by provided `deviceId`, try `findDeviceIdByEndpoint(env, subscription.endpoint)`.
5. If endpoint lookup resolves an existing row, reuse that `device_id` as `resolvedDeviceId`.
6. Upsert using `resolvedDeviceId`; return `{ subscriptionId: endpointHash, deviceId: resolvedDeviceId }`.

Operational implication:
- callers can present a new/random `deviceId` and still attach to the prior canonical record when endpoint is unchanged.

### 20.2 D1 uniqueness and upsert semantics

Anchors:
- schema uniqueness: `worker/src/index.ts:187–195` (`endpoint_hash TEXT NOT NULL UNIQUE`)
- upsert query: `worker/src/index.ts:2530–2555` (`upsertDevice`)

Invariants:
- `endpoint_hash` must stay unique across `devices`.
- Upsert conflict key is `device_id`; endpoint updates are applied in-place.
- `updated_at` is refreshed on every register/update call.

### 20.3 Poll/delete consistency dependency

`/api/reminders/poll` endpoint lookup depends on the same endpoint-hash mapping path (`findDeviceIdByEndpoint`) used during registration reconciliation.

Anchors:
- poll handler lookup path: `worker/src/index.ts:2404–2414`
- endpoint hash lookup: `worker/src/index.ts:2584–2607`
- delete fan-out: `worker/src/index.ts:2305–2333`

If you change registration identity behavior, re-verify:
- endpoint-based poll still resolves the intended device,
- stale/expired endpoint cleanup (`404/410` push result) still deletes the same canonical `device_id`,
- KV fallback migration (`migrateDeviceFromKv`) still preserves endpoint index parity.

## 21) CORS + request trust boundary contract (agent verification chunk)

The Worker currently exposes a public cross-origin API surface with no auth/session layer in this file.
That is intentional for push-reminder device flows, but it is a high-impact contract that should not be changed accidentally.

### 21.1 CORS behavior is globally permissive

Current response behavior:
- JSON helper responses include `Access-Control-Allow-Origin: *` via `JSON_HEADERS`.
- `OPTIONS` preflight returns `204` with:
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type,Authorization`
  - `Access-Control-Max-Age: 86400`

Anchors:
- `worker/src/index.ts:147–150` (`JSON_HEADERS`)
- `worker/src/index.ts:261–270` (`OPTIONS` preflight branch)
- `worker/src/index.ts:2922–2926` (`jsonResponse`)

Operational implication: browser clients can call API endpoints cross-origin without credential coupling in this layer.

### 21.2 Request identity is payload-driven, not authenticated

For the reminder/device endpoints, authorization checks are currently structural/existence checks only:
- `PUT /api/devices`: validates payload shape and upserts by `deviceId`/endpoint hash.
- `PUT /api/reminders`: accepts `deviceId` and requires that device exists.
- `POST /api/reminders/poll`: resolves by `deviceId` or endpoint hash and drains queue.

Anchors:
- register validation/upsert: `worker/src/index.ts:608–649`
- save reminders validation/device existence: `worker/src/index.ts:2335–2343`
- poll device resolution: `worker/src/index.ts:2404–2413`

Boundary to preserve/document during changes:
- there is no bearer-token or signature verification gate in these handlers today;
- any auth hardening change is a breaking client contract and must be coordinated with PWA callers.

### 21.3 Invalid JSON bodies normalize to handler-level 4xx paths

`parseJson` returns `null` on parse failure instead of throwing.
Handlers then perform field validation and emit stable 4xx errors (for example `deviceId is required`, `reminders must be an array`, etc.).

Anchors:
- parser: `worker/src/index.ts:2944–2949`
- example 4xx guards: `worker/src/index.ts:611–621`, `:2338–2346`, `:2411–2413`

Why this matters:
- malformed JSON does not hit router-level `500` by default;
- client-side retries can distinguish validation errors from transient server failures.

### Safe-edit guardrails

If modifying API security/CORS behavior, preserve or intentionally migrate with rollout notes:
- explicit CORS preflight handling for browser clients,
- stable handler-level validation error shapes/statuses,
- clear compatibility plan before introducing auth requirements on existing device/reminder routes.

## 22) Backup object-key + read-side mutation contract (agent verification chunk)

Backup persistence looks simple, but there are two behavior contracts that are easy to break during refactors:
1) object-key canonicalization (`npub` normalization) controls read/write identity;
2) every successful backup read mutates metadata (`lastReadAt`) as a side effect.

### 22.1 Object key identity is lowercased `npub` with strict prefix/charset checks

`getBackupObjectKey` enforces:
- input must be non-empty string,
- normalized with `trim().toLowerCase()`,
- must start with `npub`,
- must match `/^[0-9a-z]+$/`.

Generated key format:
- `backups/taskify-backup-${npub}.json`

Anchors:
- validator/key builder: `worker/src/index.ts:335–342`
- write path usage: `worker/src/index.ts:353`
- read path usage: `worker/src/index.ts:386`

Compatibility implication:
- clients using uppercase or mixed-case `npub` still resolve the same object;
- changing canonicalization rules can silently orphan existing backups.

### 22.2 Reads perform metadata write-back (`lastReadAt`) but omit it from response

`handleLoadBackup` flow:
- fetch object,
- parse JSON payload,
- create `storedPayload = { ...payload, lastReadAt: nowIso }`,
- best-effort `put` back to R2,
- strip `lastReadAt` before returning `{ backup: responsePayload }`.

Anchors:
- read + parse: `worker/src/index.ts:390–412`
- metadata write-back: `worker/src/index.ts:415–427`
- response field stripping: `worker/src/index.ts:434–435`

Contract to preserve:
- telemetry/retention logic can rely on `lastReadAt` in storage,
- API consumers should not rely on `lastReadAt` being present in response bodies.

### 22.3 R2 metadata headers are pinned on both save and read-side rewrite

Both save and read-side metadata update use:
- `contentType: "application/json"`
- `cacheControl: "private, max-age=0, must-revalidate"`

Anchors:
- save headers: `worker/src/index.ts:372–376`
- read-side rewrite headers: `worker/src/index.ts:418–423`

Why this matters:
- changing only one path creates inconsistent object metadata across historical backups;
- tooling that inspects object metadata for troubleshooting/retention can drift if headers diverge.

### Safe-edit guardrails

If modifying backup handlers, re-verify:
- mixed-case `npub` lookups still hit existing backup keys,
- load path continues to be resilient to unreadable/corrupt objects with explicit 4xx/5xx responses,
- `lastReadAt` behavior remains intentional (kept in storage, excluded from response unless consciously changed with client coordination).
