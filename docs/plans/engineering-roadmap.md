# Engineering Roadmap — Documentation & Testing Initiative

**Period:** March 2026 (weeks 1–2)
**Scope:** Documentation expansion and test coverage — no product code changes.

---

## Context

Taskify has a working product across two primary surfaces (PWA + Worker) with a small but meaningful test suite covering agent dispatch, Nostr startup stability, and onboarding gating. This roadmap formalizes the next steps to make the codebase approachable for contributors and AI agents, and to close the largest gaps in test coverage before the next feature cycle.

---

## Week 1 — Documentation Foundation

### Milestone 1.1: Core Onboarding Docs (Days 1–3)

**Deliverables:**
- [x] `AGENT.md` — project structure, architecture, protocols, branch flow, testing strategy, contribution rules
- [x] `docs/plans/engineering-roadmap.md` — this file
- [x] `.github/pull_request_template.md` — enforces docs-impact section on every PR

**Acceptance criteria:**
- A new contributor or AI agent can understand the architecture, find relevant files, and run tests by reading `AGENT.md` alone.
- PRs cannot be submitted without addressing the docs-impact checklist item.

---

### Milestone 1.2: Domain Documentation (Days 3–5)

**Deliverables:**

| File | Covers | Status |
|---|---|---|
| `docs/reference/nostr-session-layer.md` | SessionPool, RelayHealth, startup stability, relay auth (NIP-42) | ✅ Done |
| `docs/reference/cashu-wallet-layer.md` | Mint connections, swap flow, P2PK (NIP-61), NWC (NIP-47), seed derivation | ✅ Done |
| `docs/reference/worker-backend.md` | Cron behavior, KV schemas, D1 schema, push notification, voice, and public endpoint flows | ✅ Done |
| `docs/reference/agent-mode.md` | Full command reference (all 12 ops), security mode matrix, task shape, error codes | ✅ Done |

**Acceptance criteria:**
- Each doc covers: purpose, key files, data flow diagram or pseudocode, failure modes, and known limitations. ✅
- Docs reference specific file paths and line ranges where relevant. ✅

---

## Week 2 — Test Coverage Expansion

Current test count: 3 files. Target: expand to cover 6+ domains.

### Milestone 2.1: Nostr Layer Tests (Days 6–7)

**Target files:**
- `taskify-pwa/src/nostr/RelayHealth.test.ts` ✅ **Done** — 19 tests
- `taskify-pwa/src/nostr/PublishCoordinator.test.ts` — Deferred (requires deep NDK mock; low ROI vs. risk)

**Coverage goals:**
- RelayHealth: `canAttempt` / `nextAttemptIn` / `markSuccess` / `markFailure` / `onBackoffExpiry` ✅
- RelayHealth: severity weighting (low/high vs normal) ✅
- RelayHealth: exponential backoff grows with consecutive failures ✅
- RelayHealth: relay isolation (failure on one doesn't affect another) ✅
- PublishCoordinator: deferred — requires NDK internals stub

**Bonus (completed):**
- `taskify-pwa/src/agent/agentSecurity.test.ts` ✅ **27 tests** — covers `normalizeAgentSecurityConfig`, `addTrustedNpub`, `removeTrustedNpub`, `clearTrustedNpubs`, `annotateTrust`, `applyTrustFilter`, `summarizeTrustCounts`, `getEffectiveAgentSecurityMode`

**Acceptance criteria:**
- All tests pass with Node `--test` runner, no real network calls. ✅ (46/46 pass)

---

### Milestone 2.2: Wallet / Cashu Layer Tests (Days 7–9)

**Target files:**
- `taskify-pwa/src/mint/SwapManager.test.ts` ✅ **Done**
- `taskify-pwa/src/wallet/p2pk.test.ts` ✅ **Done**

**Coverage delivered:**
- SwapManager: throws when mint wallet has no `swap()` ✅
- SwapManager: verifies init → rate-limit wrapper → wallet.swap → DLEQ validation chain ✅
- SwapManager: supports both `{ proofs: [...] }` and direct array swap responses ✅
- P2PK: key extraction + normalization from `data`, `pubkeys`, and `refund` tags ✅
- P2PK: lock checks return true for matching keys and false for missing/invalid keys ✅

---

### Milestone 2.3: Worker Logic Tests (Days 9–10)

**Target files:**
- `worker/src/index.test.ts` ✅ **Added** (in-memory D1 mock)

**Coverage delivered:**
- `GET /api/config` contract validation ✅
- `PUT /api/reminders` unknown device behavior (404) ✅
- `POST /api/reminders/poll` drain semantics (returns + deletes pending rows) ✅
- `scheduled()` due-reminder path enqueues pending + sends push ping ✅
- Push dispatch 410-expiry cleanup assertion ✅
- VAPID signing-path header assertion (`Authorization`, `Crypto-Key`, `TTL`) ✅

**Still pending for full hardening:**
- Additional edge-case coverage for batched multi-device due-reminder windows

---

## Coverage Tracking

| Domain | Week 1 Start | Week 2 Result |
|---|---|---|
| Agent dispatch | Basic | ✅ Maintained |
| Agent security (trust, modes) | None | ✅ 27 new tests |
| Nostr startup stability | Basic | ✅ Maintained |
| Onboarding gating | Basic | ✅ Maintained |
| Nostr relay layer (RelayHealth) | None | ✅ 19 new tests |
| PublishCoordinator | None | Deferred (NDK stub complexity) |
| Wallet / Cashu | None | ✅ Added (SwapManager + p2pk) |
| Worker backend | None | ✅ Added baseline API/scheduler tests |

**Total new tests this cycle: 72** (19 RelayHealth + 27 agentSecurity + 1 agent happy-path smoke + 3 SwapManager + 5 p2pk + 5 worker)

---

## Native Board Performance Coverage (2026-09-12)

`SnapshotLookupCacheTests` verifies domain-specific invalidation and cached board projections,
including compound membership, event removal, custom ordering, calendar/timezone changes, flat
Upcoming row identities, and repeated messaging writes against 5,000 additional tasks.
`ScrollPerformanceUITests` adds dense Upcoming/Completed scrolling and switching measurements,
using 500 future tasks on one date and 500 completed tasks. Device relay-traffic and thermal
acceptance checks remain manual. See [native board performance](../audits/native-board-performance-2026-09-12.md).

## Definition of Done

A milestone is complete when:

1. All deliverable files exist and pass a consistency review (no broken links, no placeholder sections).
2. All new test files pass `npm test` (or equivalent) with zero failures.
3. `npm run lint` passes with no new errors introduced.
4. A PR is opened against `New_Features_Fixes` with the PR template filled out, including the docs-impact section.
5. At least one reviewer approves the PR before merge.

---

## Out of Scope (This Cycle)

- E2E / browser-level tests (Playwright, Cypress) — planned for a future cycle
- Coverage percentage tooling (c8, nyc) — will be added once domain tests are in place
- CI/CD pipeline changes — separate infrastructure track
- Product feature work — this roadmap is documentation and testing only

---

## Feature Backlog

### Originless File Attachment Integration

**Priority:** Medium  
**Blocked by:** Usage allowance availability  
**Source:** 2026-03-14 — reviewed Originless open-source project

Add IPFS-based file attachments to tasks using [Originless](https://github.com/besoeasy/Originless) as the storage backend.

#### Requirements

- **Encryption is mandatory**: Files must be encrypted to the board key client-side *before* upload — same encryption model as task content. The Originless server never sees plaintext.
- Decrypt on download using the board key, client-side.
- Use `documents` field already present in the task payload schema (zero schema changes needed).
- Document shape: `{ url: string, cid: string, filename: string, type: string }`
- Default to public gateway (`https://originless.besoeasy.com`); allow self-hosted URL override in settings.
- Check `/health` endpoint before rendering upload UI.

#### PWA scope
- "Attach file" on task create/edit → upload encrypted file → store document entry → display attachments inline

#### CLI scope
- `taskify attach <taskId> <file> --board <board>` — encrypt + upload + patch task
- `taskify attachments <taskId>` — list attached file URLs

#### Notes
- Self-hosted Originless runs via Docker (`ghcr.io/besoeasy/originless`) — no accounts, no API keys for basic ops
- Pin management (keep forever) requires Daku auth token — optional for initial implementation
- Fits cleanly into existing agent workflow: agent uploads → returns IPFS URL → patches task via normal update flow

## Entry-point organization pass — September 13, 2026

- Extracted PWA `DroppableColumn` into `src/ui/board/` with three interaction tests
  covering drop ordering, multiple selected tasks, plain-text/empty drops, and
  selection/keyboard controls.
- Extracted CLI bot and contact groups into `src/commands/`, preserving registration
  order and global option access. Seven bundled CLI checks cover command discovery,
  arguments/options, and isolated local contact operations across profiles.
- Updated existing contact contract checks to inspect the extracted module.
- Further extraction of task, board, calendar, and wallet orchestration remains
  incremental work; this pass does not change those behaviors.

### Second organization pass

- Moved saved board-print job persistence out of `App.tsx` into
  `src/storage/boardPrintJobs.ts`, preserving its key, defaults, and error handling.
  Four tests cover legacy data, per-board updates, malformed data, and write failures.
- Moved CLI trust, relay, and cache command groups into `src/commands/`.
  Bundled command checks now include these groups and isolated trust/relay
  mutations plus cache status/clearing. No live relay connections are needed.

### Third organization pass

- Extracted appearance effects and their color helpers into `theme/useAppAppearance.ts`.
  Four interaction tests cover font sizing, theme transitions, status-bar color,
  background object-URL lifecycle, and fallback rendering.
- Extracted shell-completion registration into `commands/completions.ts`.
  A bundled CLI regression checks all three shells, environment detection,
  combined fallback output, and invalid-shell errors using an isolated home API.

Native iOS sharing coverage (2026-09-14): contact search includes directories larger than eight entries; encrypted task and event shares round-trip for all group members and retain their group conversation after snapshot restoration.

### Fourth organization pass — September 15, 2026

- Extracted CLI config command registration and the shared connection probe from
  the entry point, preserving command bodies and diagnostic behavior.
- Added isolated command regression coverage for selected-profile mutations,
  secret redaction, invalid input, and missing boards.
- Added four fake-WebSocket checks for success, error, timeout, and constructor
  failure. No real network connections or user configuration are used.

### Fifth through seventh organization passes — September 15, 2026

- Extracted profile command registration, including its piped-input queue, into
  `commands/profile.ts`. Isolated CLI tests cover creation, duplicate rejection,
  switching, renaming, key masking, removal guards, and piped onboarding.
- Extracted CLI CSV helpers into `src/csv.ts` without changing parsing semantics.
  Three tests cover quoting, escaped quotes, blank lines, and missing fields.
- Extracted PWA VAPID decoding and generic promise timeouts. Six tests cover
  URL-safe decoding, bad inputs, absent decoder support, completion/failure timer
  cleanup, and timeout errors. No live push registration is performed.

### Final standalone extraction pass — September 15, 2026

- Completed CLI command-group extraction. The entry point now configures the root
  program, assembles a typed command context, registers groups in the original
  order, and handles parse completion/errors.
- Existing source-contract tests now read command modules. Bundled command and
  local persistence tests remain in place; a full pre/post help-tree comparison
  checks that registration preserves arguments, options, descriptions, and order.
- Extracted the PWA reminder HTTP client with three tests for payload serialization,
  cancellation, missing setup, and HTTP failures.
- PWA stateful task/calendar/relay orchestration remains feature-level refactoring
  work, requiring state-transition coverage before changing its boundaries.

### Native Mac storage regression — September 17, 2026

Nine storage tests now cover unentitled macOS group URL resolution, private-store
save/reload, and migration that preserves existing stores. The App Group path is
selected only after checking the Mac process entitlement. Signed sandbox and
extension integration remain separate release checks.
