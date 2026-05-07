# Reliability & Offline-Sync TODO

A verified, prioritized punch-list of fixes/refactors to bring Taskify closer to its vision: a **reliable, Nostr-based, private, secure, permissionless, offline-first** kanban + calendar manager that syncs cleanly when back online.

Compiled from two independent audits (Claude Code + Codex). Every item below was verified against the actual code — file paths and line numbers reference the current `Taskify-V2` branch (commit `9147543` at the time of writing). Items are ordered **most critical → least critical**, and within each tier, **easiest first** so quick wins land before larger refactors.

---

## Tier 1 — Critical for "reliable + offline-first + secure"

### 1. Bypass `/api/*` in service-worker cache (~30 min) ✅ easiest critical fix

**Problem.** [public/sw.js:23](../taskify-pwa/public/sw.js:23) caches every successful GET unless the response sets `Cache-Control: no-store`. The worker's [JSON_HEADERS at worker/src/index.ts:157](../worker/src/index.ts:157) only sets `Content-Type` + `Access-Control-Allow-Origin` — no cache directive. Result: signed Google Calendar responses, backup status, push registration, and reminder polling can be cached and served stale.

**Fix.** Either:
- Add `Cache-Control: no-store` to `JSON_HEADERS` in `worker/src/index.ts`, **or**
- In `sw.js`, extend `shouldBypassRelayTraffic` (or add a new check) to bypass any same-origin `/api/*` request.

The worker-side fix is preferred — it's authoritative and doesn't rely on the SW staying in sync with route changes.

**Acceptance.** After deploy, opening DevTools → Network shows `/api/*` requests as `(no-store)` and they never appear in `caches.keys()` cache contents.

---

### 2. Fix the `npm test` script (~15 min)

**Problem.** [taskify-pwa/package.json](../taskify-pwa/package.json) sets `"test": "node --experimental-strip-types --test src/agent/agentDispatcher.test.ts ..."`, but:
- Those tests `import { describe, it } from "vitest"` — incompatible with the Node test runner.
- `src/agent/agentDispatcher.test.ts` doesn't exist (the entire `src/agent/` directory is gone).
- `npm test` currently fails with `code: 'ERR_TEST_FAILURE'`.

`npx vitest run` already works (131 passed, 1 skipped at time of audit).

**Fix.** Change to `"test": "vitest run"`. Remove the missing-file reference.

**Acceptance.** `npm test` passes locally and in CI.

---

### 3. Add Nostr event signature verification (~4–6 hrs) 🛡️ critical security

**Problem.** Grep for `verifyEvent` / `verifySignature` returns **zero hits** across `taskify-pwa/src/`, `taskify-runtime-nostr/src/`, and `taskify-core/src/`. Every inbound Nostr event is applied to local state without verifying its signature. A malicious relay (or any MITM) can forge an event claiming to be from another pubkey and the app will accept it. This undermines the entire "permissionless + secure" trust story.

**Fix.** Wrap inbound event handlers (board sync, task sync, calendar, inbox) in `verifyEvent()` from `nostr-tools`. Reject silently or surface a relay-trust warning. Apply at the lowest level — ideally inside `taskify-runtime-nostr/src/SubscriptionManager.ts` so every consumer benefits.

Key call sites in [App.tsx](../taskify-pwa/src/App.tsx) currently applying events without verification: ~7118, ~7284, ~17896 (inbox/board/task subscriptions).

**Acceptance.** Forged-event unit test in `taskify-runtime-nostr` rejects an event whose `sig` doesn't match `pubkey + content`.

---

### 4. Add a durable Nostr outbox (~1–2 days) ✅ biggest reliability win

**Problem.** Local edits persist to IDB, but failed publishes do not. There are **22+ call sites** of the pattern:

```ts
maybePublishTask(updated).catch(() => {});
```

(see App.tsx:6593, 6893, 6986, 9226, 13018, 13046, 14891, 15004, 15050, 15277, 15482, 15554, 15631, 15742, 15761, 15790, 15895, 15935, 15971, 16042, …). If a relay is offline or a publish errors, the local UI shows the change as saved but it never reaches Nostr — and the user is never told.

**Fix.** Build an IDB-backed outbox layer:
1. New IDB object store `mutations` keyed by mutation id, with `{ kind, payload, intentAt, attempts, lastError, ackedRelays[], pendingRelays[] }`.
2. Write the mutation row **before** invoking the publish, in the same transaction as the local state change.
3. Replace `.catch(() => {})` with success → mark relay ack, partial → keep the row, failure → schedule retry with exponential backoff.
4. Drain queue on `online` event, app foreground, and relay reconnect.
5. Surface a small "N changes pending sync" indicator in the UI for trust.

Coordinate with [PublishCoordinator.ts](../taskify-runtime-nostr/src/PublishCoordinator.ts) (line 72 `publishNow`, line 107 `publish`) — that's the right boundary for outbox integration since it already debounces replaceable events.

**Acceptance.** Airplane-mode test: edit 5 tasks offline, kill the tab, reopen with airplane mode off → relay receives all 5 events; outbox is empty.

**Completed.** Added the runtime outbox boundary in `PublishCoordinator`, a PWA IndexedDB `mutations` store, retry drains on startup/online/foreground/relay reconnect, and a pending-sync indicator.

---

## Tier 2 — Important reliability + privacy hardening

### 5. Sanitize HTML in document previews/viewers (~2 hrs)

**Problem.** Two call sites render arbitrary HTML without sanitization:
- [DocumentPreviewModal.tsx:81](../taskify-pwa/src/ui/task/DocumentPreviewModal.tsx:81) — `<div dangerouslySetInnerHTML={{ __html: preview.data }} />`
- [DocumentViewer.tsx:14](../taskify-pwa/src/ui/task/viewers/DocumentViewer.tsx:14) — same pattern for full document rendering.

Grep confirms zero use of `DOMPurify` or any HTML sanitizer in the PWA. A shared board task with malicious HTML could execute scripts in another user's session.

**Fix.** Add `dompurify` (or `isomorphic-dompurify` if SSR matters later). Wrap both call sites: `DOMPurify.sanitize(preview.data, { USE_PROFILES: { html: true } })`.

**Acceptance.** Unit test inserts `<script>alert(1)</script>` and `<img onerror=...>` into a document; render produces no script execution.

---

### 6. Fix remaining tsc errors (~2–3 hrs)

**Problem.** `npx tsc -p tsconfig.app.json --noEmit` fails with errors falling into three buckets:
1. Test files importing `vitest` types not declared in `tsconfig.app.json` (`p2pk.test.ts`, `selectionModeBehavior.test.ts`).
2. `RefObject<T | null>` vs `RefObject<T>` mismatches (BoardQrScanner.tsx, CustomReminderSheet.tsx).
3. Type-mismatch between `taskify-core`'s `TaskDocument` and the local `lib/documents.ts` `TaskDocument` (TaskMedia.tsx).

**Fix.**
- Exclude `**/*.test.ts` and `**/*.test.tsx` from `tsconfig.app.json` (move to a separate `tsconfig.test.json`).
- Tighten ref types or accept nullable refs in callees.
- Reconcile the two `TaskDocument` types — pick `taskify-core` as the canonical one and re-export from `lib/documents.ts`.

**Acceptance.** `npx tsc -p tsconfig.app.json --noEmit` exits 0.

---

### 7. Encrypt the local Nostr secret key at rest (~6–8 hrs) 🛡️

**Problem.** [nostrKeys.ts](../taskify-pwa/src/nostrKeys.ts) defines `LS_NOSTR_SK = "taskify_nostr_sk_v1"` and the SK is written via plain `kvStorage.setItem(LS_NOSTR_SK, skHex)` (App.tsx:1814, 6315, 6327; BackupSection.tsx:86, 173, 203; NostrSection.tsx:62, 116). Any browser-extension compromise or local-disk forensics reads the user's identity key directly. Notable inconsistency: the Cashu wallet seed *is* encrypted with AES (App.tsx:~2230).

**Fix (two-track, ship in order).**
1. **Track A (small):** offer NIP-07 detection on first run. If `window.nostr` exists, prefer it over local key storage and skip writing `LS_NOSTR_SK` entirely. Most power users already have Alby/nos2x.
2. **Track B (larger):** for the local-key fallback, derive a wrapping key with PBKDF2 from a passphrase (or device-bound key via `crypto.subtle.generateKey({ name: "AES-GCM" }, false, …)` stored in IDB with `extractable: false`). Encrypt SK before writing, decrypt on read. Add a one-time migration from the v1 plaintext key.

Optional follow-on: add NIP-46 (remote signer) for fully no-key-on-device.

**Acceptance.** New user onboarding stores either no SK (NIP-07 path) or an AES-GCM ciphertext under a new `LS_NOSTR_SK_v2` key; old `v1` key is migrated and removed.

---

### 8. Address ESLint errors (~3–5 hrs, can land incrementally)

**Problem.** `npm run lint` reports **170 errors + 58 warnings**. The bulk are real bugs hiding in plain sight: unused variables (often dead code paths), forbidden `require()`, and `@ts-nocheck` directives suppressing real type errors. App.tsx itself uses `@ts-nocheck` on line 2 — that's the single largest cliff (item 12 below).

**Fix.** Land in two passes:
1. Quick wins: `no-unused-vars`, `no-require-imports` — likely a single-day cleanup, no behavior change.
2. Remove `@ts-nocheck` from non-App.tsx files first (`ViewSection.tsx`, `WalletSection.tsx`, `EditModal.tsx`). Each file becomes much easier to refactor afterward.

**Acceptance.** Error count → 0; warnings allowed but trending down.

---

## Tier 3 — Larger refactors (sequence after Tier 1 & 2 land)

### 9. Move tasks/calendar from single JSON blobs to per-entity object stores (~1 day)

**Problem.** [App.tsx:4423](../taskify-pwa/src/App.tsx:4423) serializes `boards` to one IDB key; [App.tsx:4556](../taskify-pwa/src/App.tsx:4556) writes the entire `tasks` array on a 500ms debounce; [App.tsx:4833](../taskify-pwa/src/App.tsx:4833) writes the full `calendarEvents` array. At 1000+ items this is slow on mobile, crash-unsafe (a half-written blob loses everything), and prevents row-level mutation tracking — which the outbox (item 4) wants.

**Fix.** Replace with discrete IDB object stores:
- `tasks` keyed by `id`
- `boards` keyed by `id`
- `calendarEvents` keyed by `id`
- `mutations` (the outbox)
- `syncState` (cursors, relay acks)

Commit local mutations + outbox row in one IDB transaction. Migrate from existing blob keys on first load.

**Acceptance.** Task save no longer touches all tasks; mutating one task results in a single small IDB write.

---

### 10. Extract Nostr / sync logic from App.tsx (~3–5 days, incremental)

**Problem.** [App.tsx](../taskify-pwa/src/App.tsx) is **21,067 lines** with `@ts-nocheck` on line 2. The main `App()` component has 487 hook calls and contains all routing, modal, and sync orchestration. This is the dominant tax on feature velocity. The codebase already has the right packages — `taskify-core` (typed contracts) and `taskify-runtime-nostr` (session, publish, subscriptions, cursors) — but App.tsx duplicates types and re-implements wiring locally.

**Fix.** Extract incrementally, no behavior change per step:
1. `useNostrSubscriptions()` — unify boards/tasks/calendar/inbox subscriptions (currently scattered ~7100–7300).
2. `useBoardSync()` — 30300/30301 event handling + cursors (~17850–17900).
3. `useCalendarEventManagement()` — RSVP + calendar state (~11865–12180).
4. `useTaskPersistence()` — IDB writes + outbox integration (consumes item 4 + item 9).
5. `useSettingsSync()` — settings state machine.
6. Replace local type duplicates with imports from `taskify-core`.

Each extract should ship as its own PR with no UI change.

**Acceptance.** App.tsx shrinks below 15k lines after pass 1, below 10k after pass 3. Remove `@ts-nocheck` from App.tsx as a final step.

---

### 11. Add list virtualization + per-task save (~1 day)

**Problem.** Calendar view, board columns, and contact lists render every item every render. Combined with item 9, mobile performance degrades visibly past a few hundred items.

**Fix.** Add `react-window` (or `@tanstack/react-virtual`) to the highest-cardinality lists. Pair with item 9 so saves don't touch unrelated rows.

**Acceptance.** Profiler shows constant render time regardless of list size up to 5,000 items.

---

### 12. Worker backend cleanup (~half day, low priority)

**Problem.** [worker/src/index.ts](../worker/src/index.ts) is 4,757 lines doing push notifications, reminder cron, Google Calendar OAuth + webhook handling, link previews, voice quotas, and D1 queries — no clear domain boundaries.

**Fix.** Add `// region: <name>` markers and split into modules under `worker/src/`:
- `worker/src/push.ts`
- `worker/src/reminders.ts`
- `worker/src/google-calendar.ts`
- `worker/src/preview.ts`
- `worker/src/voice.ts`

Document the public HTTP contract in [docs/worker-backend.md](worker-backend.md).

**Acceptance.** Each module < 800 lines; index.ts becomes the routing entrypoint.

---

## Conflict resolution & collaboration (deferred)

Codex flagged collaboration security ("Harden collaboration security") as a Tier-1 item; the author elected to defer this scope for now. The related question of **conflict resolution** (currently last-write-wins via `updatedAt` timestamps with no rollback) is also deferred — it becomes urgent once multi-device active editing is a regular use case. When picked up, evaluate Automerge or Yjs against the current state-machine; for the kanban board domain, per-card LWW with explicit "conflicted" UI may be sufficient.

---

## Recommended first slice

The audits agree on this short list as the highest-leverage first sprint:

1. ✅ Item 1 — `/api/*` cache bypass (30 min)
2. ✅ Item 2 — fix `npm test` (15 min)
3. ✅ Item 4 — durable outbox (1–2 days)
4. ✅ Item 3 — signature verification (4–6 hrs)

That alone moves the app from "local-first with optimistic Nostr sync" to genuinely "works offline, syncs when back online, doesn't trust forged events" — without waiting on the App.tsx refactor.
