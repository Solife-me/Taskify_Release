# Cashu Wallet Layer

This doc maps the **current wallet + mint implementation** in `taskify-pwa/src/wallet/` and `taskify-pwa/src/mint/` for agent onboarding on branch `docs/agent-onboarding-roadmap`.

## Scope & Reality Check

- Core wallet operations are centralized in `wallet/CashuManager.ts`.
- Per-mint orchestration and request-control wrappers are in `mint/MintConnection.ts`.
- Multi-mint singleton/session routing is in `mint/MintSession.ts`.
- DLEQ proof validation is actively enforced after mint/receive/send/melt change paths.
- Request dedupe, batching, and local throttling are implemented (cache + rate limiter + queued proof-state checks).
- No server-side wallet custody: proofs and seed metadata are local only.

---

## File Map

### Wallet core (`taskify-pwa/src/wallet/`)

- `CashuManager.ts`
  - Core flows: init, mint quote/claim, send, receive, melt, partial invoice payment.
  - Tracks local proof cache + persistence sync via `storage.ts` (`getProofs` / `setProofs`).
  - Supports P2PK lock/send and auto-signing of proofs when a private-key resolver is configured.
  - Handles mint keyset refresh/retry on known keyset drift error codes (`11005`, `12001`, `12002`) and keyset-related error strings.
  - Maintains in-memory `pendingMeltBlanks` to recover `change` proofs if a melt is paid but response handling is interrupted.

- `storage.ts`
  - IndexedDB-backed wallet store via `idbKeyValue` (`TASKIFY_STORE_WALLET`) with localStorage-style keys (`cashu_proofs_v1`, `cashu_tracked_mints_v1`, etc.).
  - Proof persistence helpers (`getProofs`, `setProofs`) plus mint-list and pending-token queue helpers (`addPendingToken`, `markPendingTokenAttempt`, `replacePendingTokens`, etc.).

- `seed.ts`
  - Seed lifecycle: `getWalletSeedMnemonic`, `getWalletSeedBytes`, backup/restore helpers, counter persistence.
  - Counter persistence via `persistWalletCounter` + `persistWalletCounterSnapshot` to avoid deterministic wallet replay collisions.

- `dleq.ts`
  - `verifyProofDleq` and `assertValidProofsDleq` for blind-signature proof integrity checks.

- `p2pk.ts`
  - P2PK helper checks (`extractPubkeysFromP2PKSecret`, `proofIsLockedToPubkey`).

- `nwc.ts`
  - NWC URI parsing + client wrapper (`NwcClient`) for NIP-47 style wallet connect.

- `mintBackup.ts`
  - Encrypted mint state backup payload helpers.
  - Backup event constants: `MINT_BACKUP_KIND = 30078`, `MINT_BACKUP_D_TAG = "mint-list"`.

- `lightning.ts`, `nut16.ts`, `npubCash.ts`, `peanut.ts`
  - Supporting adapters/utilities for invoice parsing, NUT-16 frame handling, NPub cash claims, and Peanut token helpers.

### Mint orchestration (`taskify-pwa/src/mint/`)

- `MintSession.ts`
  - Singleton coordinator over `MintConnection` instances keyed by normalized mint URL.
  - Public static helpers route to connection managers (`requestMintQuote`, `executeMelt`, `checkTokenStates`, etc.).
  - Hook propagation (`getP2PKPrivkey`, `onP2PKUsage`) across existing connections.

- `MintConnection.ts`
  - Composition root for per-mint services:
    - `MintQuoteManager`
    - `SwapManager`
    - `StateCheckManager`
    - `PaymentRequestManager`
    - `LockedTokenManager`
  - Owns request controls:
    - `MintRequestCache` (in-flight + short TTL dedupe)
    - `MintRateLimiter` (min interval + adaptive backoff)
  - Wraps `CashuManager` and re-validates returned proofs with DLEQ checks.

- `MintQuoteManager.ts`
  - Quote-level memoization and status checks.
  - Avoids repeated quote calls when state is already terminal (`PAID`, `ISSUED`).

- `StateCheckManager.ts`
  - Batches `checkstate` calls (25ms queue window), dedupes proofs, remaps results per caller.

- `PaymentRequestManager.ts`
  - Request-id idempotency guard for in-flight melt payment execution.

- `SwapManager.ts`
  - Wallet swap passthrough with request-keying and DLEQ validation.

- `MintCapabilityStore.ts`
  - Mint info capability cache across connections.

- `MintRequestCache.ts`
  - Stable-key cache wrapper around async factory functions with TTL and failure eviction.

- `MintRateLimiter.ts`
  - Local scheduler (`minIntervalMs` default `120`, `maxBackoffMs` default `5000`) with 429-aware backoff behavior.

- `LockedTokenManager.ts`
  - Locked-token bookkeeping helper tied to `MintConnection`.

---

## Agent Code Anchors (spot-check map)

Use this table when verifying docs against code. Anchors are function-level and stable enough for grep-based navigation.

| Area | Code anchor |
|---|---|
| Wallet bootstrap + proof hydration | `taskify-pwa/src/wallet/CashuManager.ts:427` (`init`) + `:440` (`getProofs`) + `:470` (`setProofs`) |
| Mint-claim path | `taskify-pwa/src/wallet/CashuManager.ts:563` (`claimMint`) |
| Receive token path | `taskify-pwa/src/wallet/CashuManager.ts:574` (`receiveToken`) |
| Send token path | `taskify-pwa/src/wallet/CashuManager.ts:632` (`createSendToken`) |
| Melt quote + execute | `taskify-pwa/src/wallet/CashuManager.ts:746` (`createMeltQuote`) + `:757` (`executeMeltQuote`) + `:843` (`payMeltQuote`) |
| Interrupted melt recovery | `taskify-pwa/src/wallet/CashuManager.ts:145` (`wallet.completeMelt(blanks)`) |
| DLEQ verification gates | `taskify-pwa/src/wallet/dleq.ts:57` (`assertValidProofsDleq`) + callsites in `CashuManager.ts:98` and `MintConnection.ts:107` |
| Per-mint connection bootstrap | `taskify-pwa/src/mint/MintSession.ts:53` (`getConnection`) + `taskify-pwa/src/mint/MintConnection.ts:62` (`init`) |
| Request dedupe + rate-limit wrapper | `taskify-pwa/src/mint/MintConnection.ts:75` (`runWithRateLimit`) + `taskify-pwa/src/mint/MintRequestCache.ts:26` (`buildKey`) + `taskify-pwa/src/mint/MintRateLimiter.ts:16` (constructor defaults) |
| Quote orchestration | `taskify-pwa/src/mint/MintQuoteManager.ts:43` (`requestMintQuote`) |
| Proof-state batching | `taskify-pwa/src/mint/StateCheckManager.ts:30` (`flush`) + `:73` (`checkStates`) |
| Wallet persistence primitives | `taskify-pwa/src/wallet/storage.ts:247` (`getProofs`) + `:252` (`setProofs`) |
| Seed counter persistence | `taskify-pwa/src/wallet/seed.ts:192` (`persistWalletCounter`) + `:203` (`persistWalletCounterSnapshot`) |

### Quick verification recipe (agents)

1. Confirm every outward wallet mutation re-checks DLEQ (`claimMint`, `receiveToken`, `createSendToken`, `payMeltQuote`).
2. Confirm quote/status/checkstate network paths enter through `MintConnection.runWithRateLimit(...)`; note that wallet mutation paths (`claimMint`, `receiveToken`, `createSendToken`, `payMeltQuote`) call manager methods directly and rely on retry/idempotency guards instead of the rate-limiter wrapper.
3. Confirm persistence writes happen after proof normalization (`setProofs`) rather than raw mint response storage.
4. Confirm melt-recovery path still uses `pendingMeltBlanks` + `completeMelt` before final proof commit.

## Control Flow Reference

## 1) Session and connection lifecycle

Entry: `MintSession.getConnection(mintUrl)`

1. Normalize URL (`trim` + trailing slash strip).
2. Reuse existing `MintConnection` or construct a new one with shared `MintCapabilityStore` + hooks.
3. `connection.init()`:
   - runs `CashuManager.init()` once,
   - best-effort caches mint info via `getMintInfo()`.

## 2) Mint quote -> claim flow

Entry: `MintSession.requestMintQuote(...)` / `MintSession.executeMint(...)`

1. Quote request routes through `MintQuoteManager.requestMintQuote`.
2. Request key built via `MintRequestCache.buildKey(...)`.
3. Execution wrapped by `MintConnection.runWithRateLimit(...)` (cache + scheduler).
4. Quote cached by quote ID.
5. Claim path calls `CashuManager.claimMint(...)`:
   - retries once with mint refresh when keyset drift errors are detected,
   - validates DLEQ,
   - merges/persists proofs.

## 3) Send / receive token flow

### Send (`createSendToken`)

1. `CashuManager.createSendToken(amount, options)` validates amount.
2. Optional P2PK lock metadata translated to output config.
3. `wallet.send(...)` splits proofs into `keep` and `send`.
4. DLEQ check runs on resulting proofs.
5. `keep` proofs persisted; `send` proofs encoded into Cashu token string.

### Receive (`receiveToken`)

1. Resolve potential P2PK private keys from incoming token proofs.
2. `wallet.receive(encoded, receiveConfig)` executes (with mint refresh retry wrapper).
3. Auto-signs P2PK proofs when resolver keys are available.
4. DLEQ validates received proofs.
5. Proof cache is merged + persisted.

## 4) Melt / pay invoice flow

Entry: `CashuManager.payInvoice(...)` / `payMeltQuote(...)`

1. Create melt quote (`wallet.createMeltQuote`).
2. Compute required amount (`quote.amount + quote.fee_reserve`); abort if insufficient balance.
3. Pre-split proofs with `wallet.send(required, ...)` into `keep` and `send`.
4. Execute `wallet.meltProofs(quote, send, { onChangeOutputsCreated })`.
5. If payment is paid but response handling fails, attempt recovery:
   - check quote status,
   - finalize stored melt blanks via `completeMelt(...)`.
6. Persist resulting proof set:
   - paid: `keep + change`
   - unpaid/error: restore `keep + send`.

## 5) Proof-state check batching

Entry: `StateCheckManager.checkStates(proofs)`

1. Request enqueued.
2. 25ms delayed flush batches concurrent calls.
3. Deduped proof list submitted once (`MintConnection.checkProofStates`).
4. Results mapped back to each request's original proof order.

---

## Mint refresh retry matrix (keyset drift resilience)

`CashuManager.withMintRefreshRetry(...)` is the core one-retry guard used by claim/receive/send/melt quote and melt execution paths.

Anchors:
- Retry wrapper: `taskify-pwa/src/wallet/CashuManager.ts:415–424`
- Refresh trigger classifier: `:376–390`
- Refresh implementation + rebuild fallback: `:402–413`

### Trigger conditions (current code)

The retry path runs once when either of these matches:

1. **Known numeric error codes**: `11005`, `12001`, `12002`
   - Anchor: `REFRESH_RETRY_CODES` (`taskify-pwa/src/wallet/CashuManager.ts:54`)
2. **Message/detail text contains** keyset-drift hints:
   - `"no keyset found"`
   - `"keyset"`
   - `"input_fee_ppk"`
   - `"transaction is not balanced"`
   - `"wallet keyset has no keys"`
   - Anchor: `shouldRefreshMintState(...)` (`taskify-pwa/src/wallet/CashuManager.ts:376–390`)

If `wallet.loadMint(true)` itself fails with specific keyset-loading messages, manager rebuilds wallet state via `init()` before the second attempt.

Operationally: this is a **single refresh + single retry** strategy (not unbounded retry).

## Melt idempotency + recovery deep slice

This is the highest-risk wallet mutation path and should be preserved during refactors.

Anchors:
- Main melt flow: `taskify-pwa/src/wallet/CashuManager.ts:757–828`
- Pending blank-change store: `:107–137`
- Change finalization: `:139–159`
- Request-id idempotency wrapper: `taskify-pwa/src/mint/MintConnection.ts:205–224`

### Sequence (exact behavior)

1. `MintConnection.payMeltQuote(...)` computes deterministic request id from quote/request and calls `PaymentRequestManager.executeOnce(...)`.
2. `CashuManager.executeMeltQuote(...)` pre-splits proofs (`keep`, `send`) and validates DLEQ on both sets before melt.
3. During `wallet.meltProofs(...)`, `onChangeOutputsCreated` stores melt blanks by quote key in `pendingMeltBlanks`.
4. On thrown melt error:
   - restore unpaid state (`keep + send`) immediately,
   - check melt quote status,
   - if quote is actually paid, finalize stored blanks via `completeMelt(...)`, DLEQ-validate change, then persist paid state (`keep + change`).
5. On successful melt response:
   - DLEQ-validate returned change when present,
   - if response has no change but stored blanks exist and quote is paid, finalize from stored blanks,
   - persist paid (`keep + change`) or unpaid (`keep + send`) proof set accordingly.

### Invariants to protect

- Never persist unvalidated change proofs.
- Never drop `pendingMeltBlanks` cleanup on successful paid resolution.
- Preserve request-id idempotency to avoid duplicate payment execution races.

## MintConnection request-control contract (agent verification chunk)

`MintConnection` mixes three distinct control layers that are easy to conflate during refactors:

1) `MintRequestCache` (request-key dedupe / short memoization),
2) `MintRateLimiter` (local pacing + 429 backoff),
3) `PaymentRequestManager` (in-flight idempotency for melt execution).

### 1) Rate-limit wrapping is selective, not universal

`runWithRateLimit(...)` is used for quote/status style calls (`createMintQuote`, `checkMintQuote`, `createMeltQuote`) but **not** for all wallet mutations.

Anchors:
- Wrapper: `taskify-pwa/src/mint/MintConnection.ts` (`runWithRateLimit`)
- Wrapped flows: `createMintQuote`, `checkMintQuote`, `createMeltQuote`
- Direct mutation flows: `claimMint`, `receiveToken`, `createSendToken`, `payMeltQuote`

Implication: mutation reliability mainly depends on wallet-layer retry/idempotency guards, not the rate-limiter scheduler.

### 2) Cache TTL=0 is explicit bypass mode

`runWithRateLimit` checks `options.ttlMs === 0` and skips cache, but still schedules through `MintRateLimiter`.

Anchor:
- `taskify-pwa/src/mint/MintConnection.ts` (`runWithRateLimit`)

In `MintRequestCache`, non-positive TTLs become near-immediate expiry (`now + 1`) rather than permanent cache entries.

Anchor:
- `taskify-pwa/src/mint/MintRequestCache.ts` (`getOrCreate`)

### 3) Request-key stability is payload-order independent

`MintRequestCache.buildKey(...)` uses stable object key ordering via `stableStringify`, so equivalent payload objects produce deterministic keys.

Anchors:
- `taskify-pwa/src/mint/MintRequestCache.ts` (`stableStringify`, `buildKey`)

Operational consequence: callers can pass object literals in different key order without blowing dedupe hit rate.

### 4) 429 handling escalates to max backoff

`MintRateLimiter.schedule(...)` reads HTTP status from `err.response.status` / `err.status` and, on `429`, sets backoff to `maxBackoffMs` (default 5000ms).

Anchors:
- `taskify-pwa/src/mint/MintRateLimiter.ts` (`schedule`, `registerSignal`, constructor defaults)

For non-429 failures, optional `signal.slow` only bumps to at least `minIntervalMs` (default 120ms), then relaxes on later successes.

### 5) Melt payment idempotency is per request-id while in-flight

`PaymentRequestManager.executeOnce(...)` dedupes by trimmed `requestId` using an in-memory `Map`; entry is removed in `finally`.

Anchors:
- `taskify-pwa/src/mint/PaymentRequestManager.ts` (`executeOnce`)
- Request-id derivation: `taskify-pwa/src/mint/MintConnection.ts` (`buildMeltPaymentRequestId`, `payMeltQuote`)

Boundary: this is process-local in-flight dedupe, not durable replay protection across app restarts.

### Safe-edit guardrails

If modifying this layer, preserve:
- deterministic request-keying (`buildKey`) for equivalent payloads,
- explicit cache bypass semantics when `ttlMs === 0`,
- 429-specific aggressive backoff path,
- in-flight melt idempotency keyed by deterministic request-id derivation,
- DLEQ re-validation after wallet mutation return paths.

## MintSession singleton + hook propagation contract (agent verification chunk)

`MintSession` is the multi-mint façade most app code calls. It has subtle singleton + hook-update behavior that can be broken by “cleanup” refactors.

### 1) `init(...)` is mutating singleton setup, not a pure constructor

`MintSession.init(hooks)` does two different things:
- creates singleton once when missing,
- otherwise merges new hooks into existing instance via `setHooks`.

Anchors:
- `taskify-pwa/src/mint/MintSession.ts` (`init`, `getInstance`, `setHooks`)

Implication: repeated init calls from different app surfaces can intentionally update hook callbacks on the live session.

### 2) Hook updates are propagated to all existing connections

`setHooks(...)` stores merged hooks and then calls `conn.updateHooks(...)` for every cached connection.

Anchors:
- `taskify-pwa/src/mint/MintSession.ts` (`setHooks`)
- `taskify-pwa/src/mint/MintConnection.ts` (`updateHooks`)

Operational consequence: hook changes are hot-applied; they are not limited to newly created mint connections.

### 3) Mint URL identity is normalized before cache lookup

Both `MintSession` and `MintConnection` normalize mint URLs by trimming and removing trailing slashes.

Anchors:
- `taskify-pwa/src/mint/MintSession.ts` (`normalize`, `getConnection`)
- `taskify-pwa/src/mint/MintConnection.ts` (constructor `this.mintUrl = mintUrl.trim().replace(/\/+$/, "")`)

Boundary to preserve: equivalent URLs (`https://mint.example` vs `https://mint.example/`) must map to the same `connections` entry.

### 4) Connection initialization is single-flight per mint

`MintConnection.init()` memoizes `initPromise`, so concurrent calls share one bootstrap sequence:
1. `manager.init()`
2. best-effort `getMintInfo()` warmup (errors swallowed)

Anchor:
- `taskify-pwa/src/mint/MintConnection.ts` (`init`)

This prevents duplicate wallet bootstrap work and avoids hard failures when mint capability endpoints are flaky.

### 5) Static helpers route through `getConnection(...)` every time

All static methods (`requestMintQuote`, `executeMelt`, `receiveToken`, etc.) resolve connection via `getConnection(...)` first, which ensures:
- normalized mint identity,
- hook refresh on reused connections,
- init-before-use behavior.

Anchor:
- `taskify-pwa/src/mint/MintSession.ts` (all static helper methods)

### Safe-edit guardrails

When modifying `MintSession`/`MintConnection` orchestration, preserve:
- singleton mutation semantics for `init(hooks)` (do not silently turn it into no-op after first call),
- hook propagation to existing connections,
- mint URL normalization symmetry across session and connection layers,
- `initPromise` single-flight behavior,
- static helper pattern of resolving through `getConnection` before operations.

## NWC (NIP-47) request/response contract (agent verification chunk)

This section captures the concrete behavior of `wallet/nwc.ts` + `context/NwcContext.tsx` so relay/auth changes do not silently break wallet-connect flows.

### 1) URI parsing enforces strict relay + secret requirements

`parseNwcUri(...)` requires:
- `nostr+walletconnect://` scheme,
- decodable wallet pubkey (`npub`, `nprofile`, or 64-hex),
- at least one valid `relay` URL (normalized to `ws/wss`),
- decodable client secret (`nsec` or 64-hex).

Anchors:
- `taskify-pwa/src/wallet/nwc.ts` (`parseNwcUri`, `decodePubkey`, `decodeSecret`, `normalizeRelay`)

Operational implication: malformed relays are dropped during parse; if all relays are invalid, connect fails early with a validation error rather than failing during publish/subscribe.

### 2) Request flow is relay-sequential with per-relay timeout

`NwcClient.request(...)` tries relays one-by-one in URI order and returns on first successful response; if one relay errors/times out, next relay is attempted.

Within each relay attempt (`requestViaRelay`):
1. Subscribe for kind `23195` responses with `#p=[clientPubkey]` on that relay.
2. Encrypt request payload with `nip04.encrypt(clientSecretHex, walletPubkey, payload)`.
3. Publish kind `23194` request event (tagged `p=walletPubkey`, `t=nwc`) signed by client secret.
4. If publish returns event id, response handler enforces `e`-tag correlation when present.
5. Resolve `result` or reject on `error` payload; timeout rejects after default `20s`.

Anchors:
- `taskify-pwa/src/wallet/nwc.ts` (`NWC_EVENT_KIND_REQUEST`, `NWC_EVENT_KIND_RESPONSE`, `request`, `requestViaRelay`)

### 3) Response correlation is permissive-by-default, strict when e-tag exists

If response includes `e` tag and a request id is known, non-matching responses are ignored.
If response omits `e`, handler still attempts decrypt/parse.

Anchor:
- `taskify-pwa/src/wallet/nwc.ts` (`requestViaRelay` event handler)

Boundary to preserve: this supports wallets that omit `e` while still preferring strict correlation when wallet includes it.

### 4) Context-level connect is "best effort metadata", not hard gate

`NwcProvider.connect(...)` validates URI and marks status connected even if `get_info` or `get_balance` fails; those failures are logged and info can be refreshed later.

Anchors:
- `taskify-pwa/src/context/NwcContext.tsx` (`connect`, `refreshInfo`, `getBalanceMsat`)

Implication: UI should treat `status=connected` as transport config success, not guaranteed capability discovery.

### Safe-edit guardrails

When changing NWC behavior, preserve:
- strict URI parse/validation before storage,
- per-relay timeout cleanup releasing subscriptions,
- request-event signing with client secret,
- fallback compatibility for responses missing `e` tag,
- persisted connection key `cashu_nwc_connection_v1` restore path.

## Seed derivation + counter persistence contract (agent verification chunk)

`wallet/seed.ts` provides deterministic seed material and per-mint/keyset counters used by NUT-13-style deterministic wallet derivation.

### 1) Seed generation/storage invariants

- Seed record key: `cashu_wallet_seed_v1`
- Counter store key: `cashu_wallet_seed_counters_v1`
- New seed generation uses 128-bit mnemonic entropy and stores both mnemonic + derived `seedHex`.

Anchors:
- `taskify-pwa/src/wallet/seed.ts` (`LS_WALLET_SEED`, `LS_WALLET_COUNTERS`, `generateSeedRecord`, `ensureSeedRecord`)

### 2) Counter namespace is mint-normalized and keyset-scoped

Counter keys are stored as `<normalizedMintUrl>|<keysetId>`, where mint URL normalization trims and removes trailing slashes.

Anchors:
- `taskify-pwa/src/wallet/seed.ts` (`normalizeMintUrl`, `counterKey`, `getWalletCounterInit`, `persistWalletCounter`)

Operational implication: equivalent mint URLs with/without trailing slash share the same deterministic counter space.

### 3) Backup/restore shape is explicit and versioned

Backup payload contract:
- `type: "nut13-wallet-backup"`
- `version: 1`
- `mnemonic`
- nested `counters[mint][keysetId]`

`restoreWalletSeedBackup(...)` validates type/version/mnemonic, rebuilds `seedHex`, and replaces in-memory + persisted counter store.

Anchors:
- `taskify-pwa/src/wallet/seed.ts` (`getWalletSeedBackup`, `getWalletSeedBackupJson`, `restoreWalletSeedBackup`)

### 4) Regeneration is destructive for counters by design

`regenerateWalletSeed()` creates a new mnemonic and clears all stored counters.

Anchor:
- `taskify-pwa/src/wallet/seed.ts` (`regenerateWalletSeed`)

Safe-edit guardrails:
- keep backup payload backward-compat checks (`type`/`version`),
- keep mint URL normalization consistent across read/write APIs,
- keep numeric counter clamping (`>=0`, integer floor) to avoid drift from malformed inputs.

## Pending token redemption queue contract (agent verification chunk)

This queue bridges UX-level "save token now, redeem later" flows and crash/offline recovery.
It lives in `wallet/storage.ts` and is executed in `context/CashuContext.tsx`.

### 1) Storage-level queue invariants

Persistent key + shape:
- key: `cashu_pending_tokens_v1`
- entry fields: `id`, `mint`, `token`, `addedAt`, `attempts`, optional `amount`, optional `lastTriedAt`, optional `lastError`, optional `source`

Anchors:
- `taskify-pwa/src/wallet/storage.ts` (`LS_PENDING_TOKENS`, `PendingTokenEntry`, `normalizePendingTokens`)
- mutation helpers: `addPendingToken`, `removePendingToken`, `markPendingTokenAttempt`, `replacePendingTokens`, `setPendingTokenSource`

Behavioral details to preserve:
- token dedupe currently keys on raw `token` string (new insert with same token replaces prior entry identity regardless of mint),
- `markPendingTokenAttempt` increments attempts and stamps `lastTriedAt` (+ `lastError`),
- `replacePendingTokens` normalizes entries before write (shape cleanup on restore/import).

### 2) Redemption loop semantics

Primary runner: `redeemPendingTokens()` in `CashuContext`.

Flow:
1. Guard against concurrent runs using `redeemingPendingRef`.
2. Snapshot pending entries via `listPendingTokens()`.
3. Process each entry sequentially through `processPendingEntry(...)`.
4. On per-entry failure:
   - store attempt/error via `markPendingTokenAttempt(...)`,
   - break early only for likely offline errors.
5. Always clear in-progress flag and refresh balances in `finally`.

Anchors:
- `taskify-pwa/src/context/CashuContext.tsx` (`redeemPendingTokens`, `processPendingEntry`)

### 3) Duplicate-proof and partially-spent handling

`processPendingEntry` intentionally avoids double-crediting and can salvage partially spendable tokens:

- extracts token proofs for the target mint,
- filters out proofs whose secrets already exist in wallet state,
- if all proofs already exist, removes queue entry and exits,
- on "already spent" receive failure, calls `MintSession.checkTokenStates(...)` and retries receive with only non-`SPENT` proofs,
- if none remain spendable, removes queue entry and surfaces "Token already spent".

Anchors:
- `taskify-pwa/src/context/CashuContext.tsx` (`extractProofsForMint` usage, `isTokenAlreadySpentError` branch, `MintSession.checkTokenStates` path)

### 4) Cross-mint intake behavior

`savePendingTokenForRedemption(...)` can enqueue tokens for a mint different from the current active mint:

- derives target mint from token payload when possible,
- falls back to active mint when token is opaque,
- ensures mint is tracked (`addMintToList`) before queueing,
- returns `crossMint` flag for caller/UI context.

Anchors:
- `taskify-pwa/src/context/CashuContext.tsx` (`savePendingTokenForRedemption`)

### Safe-edit guardrails

When modifying pending-token flows, preserve:
- durable queue write before asynchronous redemption attempts,
- sequential processing + offline short-circuit to avoid noisy retry storms,
- duplicate-proof filtering before receive attempts,
- partial-spend recovery path using `checkTokenStates` (do not convert all spent-like errors into hard terminal drop),
- balance refresh after queue mutation and redemption attempts.

## Mint capability cache + fallback contract (agent verification chunk)

`MintCapabilityStore` provides shared per-mint `getMintInfo()` caching across connections. This affects feature gating (`supports*` checks) and reduces repeated startup probes.

### 1) Cache key normalization and TTL behavior

- Mint URLs are normalized by trim + trailing slash removal before read/write.
- Cache entries store `{ info, fetchedAt }`.
- Default TTL is `5m` (`300000ms`); `ttlMs <= 0` disables expiry.

Anchors:
- `taskify-pwa/src/mint/MintCapabilityStore.ts:12–18` (constructor + normalize)
- `taskify-pwa/src/mint/MintCapabilityStore.ts:20–29` (`getCached` + TTL eviction)

Operational implication: equivalent mint URLs (`https://mint.example` vs `https://mint.example/`) resolve to one cache slot.

### 2) Connection init treats capability fetch as best-effort

`MintConnection.init()` always initializes wallet state first, then attempts mint-info warmup, but intentionally swallows mint-info errors.

Anchor:
- `taskify-pwa/src/mint/MintConnection.ts:62–71`

This keeps wallet operations available even when `getMintInfo` endpoints are flaky/unavailable.

### 3) Mint info fetch fallback path

`MintConnection.getMintInfo()` uses capability-store `get(...)` and tries:
1. `wallet.getMintInfo()`
2. fallback `(manager as any).ensureMintInfo?.()` if direct call throws

Anchor:
- `taskify-pwa/src/mint/MintConnection.ts:83–92`

Compatibility note: the fallback keeps older/newer cashu-ts integration paths working without hard-coupling to one method shape.

### 4) Safe-edit guardrails

If you change capability probing/caching, preserve:
- URL normalization symmetry across cache read/write,
- shared cache store usage (avoid per-call ad-hoc probes),
- best-effort startup fetch (do not hard-fail `init()` on info fetch errors),
- `getMintInfo()` fallback behavior unless all callers are migrated in lockstep.

## MintQuoteManager cache + terminal-state contract (agent verification chunk)

`MintQuoteManager` adds quote-specific caching behavior on top of `MintConnection` request-cache/rate-limiter controls.
This section captures the concrete cache keys and terminal-state shortcuts that callers currently rely on.

### 1) Mint quote cache is quote-id keyed and terminal-state sticky

`checkMintQuote(quoteId)` first checks in-memory `mintQuoteCache` and immediately returns cached values only when state is terminal:
- `PAID`
- `ISSUED`

Otherwise it fetches fresh status through `connection.checkMintQuote(...)` and refreshes cache.

Anchors:
- `taskify-pwa/src/mint/MintQuoteManager.ts` (`checkMintQuote`, `rememberMintQuote`)
- `taskify-pwa/src/mint/MintConnection.ts` (`checkMintQuote`)

Operational implication:
- repeated status polls for paid/issued quotes avoid extra network calls,
- non-terminal states still re-check mint status rather than pinning stale cache entries.

### 2) Melt quote cache is invoice-keyed with quote/request fallback

`requestMeltQuote(invoice)` first checks `meltQuoteCache.get(invoice)`.
When saving, `rememberMeltQuote` prefers key order:
1. explicit key argument,
2. `quote.request`,
3. `quote.quote`.

Anchors:
- `taskify-pwa/src/mint/MintQuoteManager.ts` (`requestMeltQuote`, `rememberMeltQuote`)

Why this matters:
- callers can later retrieve quote by original invoice string,
- cache still retains quote/request aliases for downstream reuse paths.

### 3) Quote update subscriptions refresh cache before caller callback

`subscribeMintQuoteUpdates(...)` wraps connection callback and calls `rememberMintQuote(quote)` before invoking caller `callback(quote)`.

Anchor:
- `taskify-pwa/src/mint/MintQuoteManager.ts` (`subscribeMintQuoteUpdates`)

Boundary to preserve:
- push/streamed quote updates must continue to hydrate local cache first so subsequent `checkMintQuote` calls see fresh state.

### 4) Request-cache TTL layering differs by quote type

Current TTLs across quote paths:
- Mint quote create: `3000ms`
- Mint quote status check: `1500ms` (`slow: true`)
- Melt quote create: `2000ms` in `MintConnection`, `2500ms` in manager-level request path

Anchors:
- `taskify-pwa/src/mint/MintConnection.ts` (`createMintQuote`, `checkMintQuote`, `createMeltQuote`)
- `taskify-pwa/src/mint/MintQuoteManager.ts` (`requestMintQuote`, `requestMeltQuote`)

Note for maintainers:
- There are two entry paths for quote creation (`MintConnection.*` and `MintQuoteManager.*`) with slightly different TTLs; keep this divergence intentional (or consolidate explicitly with call-site updates).

### Safe-edit guardrails

If modifying quote orchestration, preserve:
- terminal-state fast-return behavior for `PAID`/`ISSUED`,
- invoice-first melt-quote cache lookup semantics,
- cache refresh-before-callback behavior for quote subscriptions,
- explicit TTL choices (or document coordinated changes across both entry paths).

## SwapManager execution + cache-bypass contract (agent verification chunk)

`SwapManager.swap(inputs, outputs)` is intentionally treated as a **wallet mutation path** (not a quote/status polling path), so it bypasses short-TTL request caching while still using the mint connection rate-limiter lane.

### 1) Swap operation support is runtime-gated

`swap(...)` checks for `wallet.swap` at runtime and throws a hard error if unavailable.

Anchors:
- `taskify-pwa/src/mint/SwapManager.ts` (`swap`, `wallet?.swap` guard)
- `taskify-pwa/src/mint/MintConnection.ts` (`wallet` getter)

Implication: mint/wallet capability drift surfaces as explicit failure (`"Mint swap operation is not supported by this wallet"`) instead of silent no-op fallback.

### 2) Request key is deterministic over input/output proof shape

`buildKey(inputs, outputs)` composes a key from:
- input secrets (fallback to `C:amount`), and
- output amount/keyset-id tuples,
then prefixes via `requestCache.buildKey("POST", "swap", ...)`.

Anchor:
- `taskify-pwa/src/mint/SwapManager.ts` (`buildKey`)

Boundary: because `swap(...)` uses `ttlMs: 0`, this key is currently not consumed by `requestCache.getOrCreate(...)`; it is still constructed for interface parity with other connection calls and future cache-policy changes.

### 3) Cache bypass is explicit (`ttlMs: 0`) while rate-limit scheduling remains

`swap(...)` calls:
- `connection.runWithRateLimit(key, factory, { ttlMs: 0 })`

In `MintConnection.runWithRateLimit(...)`, `ttlMs === 0` returns direct scheduled work and skips `requestCache.getOrCreate(...)`.

Anchors:
- `taskify-pwa/src/mint/SwapManager.ts` (`runWithRateLimit(..., { ttlMs: 0 })`)
- `taskify-pwa/src/mint/MintConnection.ts` (`runWithRateLimit`, `ttlMs === 0` branch)

Operational effect:
- no stale cached swap payloads,
- no deduped replay suppression from request cache,
- still paced by `MintRateLimiter` to avoid local burst pressure.

### 4) Return-shape normalization + DLEQ validation is mandatory

Swap response is normalized as:
- `res.proofs` when object payload has array proofs,
- otherwise raw array response,
- otherwise empty list.

Then `connection.validateProofsDleq(...)` is always applied before returning proofs.

Anchors:
- `taskify-pwa/src/mint/SwapManager.ts` (`proofs` normalization + `validateProofsDleq`)
- `taskify-pwa/src/mint/MintConnection.ts` (`validateProofsDleq`)

### Safe-edit guardrails

If modifying swap behavior, preserve:
- explicit runtime unsupported-operation guard,
- cache-bypass semantics for mutation safety (`ttlMs: 0`) unless replaced with a stronger idempotency design,
- DLEQ validation before exposing swap-returned proofs,
- deterministic key construction compatibility with existing request-key conventions (unless all related call sites are updated together).

## Security & Reliability Notes (Current)

- DLEQ proof validation is explicit in wallet and connection paths before proofs are treated as valid.
- P2PK usage is key-resolver dependent; if no resolver hook is set, proofs are not auto-signed.
- Local request dedupe reduces duplicate network calls and duplicate melt execution (`PaymentRequestManager`).
- Mint capability probing is cached (`MintCapabilityStore`) and used for feature checks like quote/proof-state subscriptions.
- Wallet seed/counter state is local; no backend key custody.

---

## Known Gaps / Watchpoints

- Mint operation support varies by wallet/mint version; several flows are capability-gated at runtime.
- Storage is local browser storage, so compromise of runtime JS context remains a key risk.
- `LockedTokenManager` and surrounding higher-level P2PK UX assumptions should be reviewed before protocol-level changes.

---

## Agent Jump-Start Read Order

1. `taskify-pwa/src/wallet/CashuManager.ts`
2. `taskify-pwa/src/mint/MintConnection.ts`
3. `taskify-pwa/src/mint/MintSession.ts`
4. `taskify-pwa/src/mint/MintQuoteManager.ts`
5. `taskify-pwa/src/mint/StateCheckManager.ts`
6. `taskify-pwa/src/wallet/storage.ts`
7. `taskify-pwa/src/wallet/seed.ts`

This order mirrors runtime criticality (wallet core first, then orchestration, then support layers).
