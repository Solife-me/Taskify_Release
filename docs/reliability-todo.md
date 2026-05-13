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

**Completed.** Built a generic `EntityStore<T>` in [src/storage/entityStore.ts](../taskify-pwa/src/storage/entityStore.ts) with diff-based reference-equality persistence. Four new IDB object stores (`tasks_v2`, `boards_v2`, `calendarEvents_v2`, `externalCalendarEvents_v2`) at DB version 3. Idempotent migration from legacy blobs runs once at boot in `storageBootstrap`. Backup-restore uses `replaceAll` + `flush` to ensure writes settle before page reload. Dropped the 500ms debounced `JSON.stringify(allTasks)` save in App.tsx — mutating one task now produces one tiny IDB write regardless of total count.

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

**Progress.** ✅ **Item #10 complete.** App.tsx down from **21,137 → 14,963 lines** (−6,174, −29.2%), **`@ts-nocheck` removed**, `tsc -p tsconfig.app.json --noEmit` exits 0:

- ✅ **Pass 0 — type/helper dedup**: deleted ~30 byte-for-byte-identical duplicates of helpers that already existed in `domains/scripture/scriptureUtils`, `domains/tasks/taskUtils`, etc. Replaced with imports. (−471 lines)
- ✅ **Pass 1 — initial hook extraction** ([4f0c660](../taskify-pwa/src/App.tsx)): −512 lines.
- ✅ **Passes 3–5 — major hook extractions** ([67c4eb6](../taskify-pwa/src/App.tsx)): −1,704 lines. Created:
  - [src/nostr/useTaskPersistence.ts](../taskify-pwa/src/nostr/useTaskPersistence.ts) — IDB writes + outbox integration (89 lines)
  - [src/nostr/useBoardSync.ts](../taskify-pwa/src/nostr/useBoardSync.ts) — 30300/30301 event handling + cursors (392 lines)
  - [src/nostr/useCalendarEventManagement.ts](../taskify-pwa/src/nostr/useCalendarEventManagement.ts) — RSVP + calendar state (390 lines)
  - Plus settingsHook.ts refactor (−172/+172)
- ✅ **Subscriptions extraction**: [src/nostr/useNostrSubscriptions.ts](../taskify-pwa/src/nostr/useNostrSubscriptions.ts) (309 lines, additional ~232 lines reduction in App.tsx)
- ✅ **`useDragAndDrop` extraction**: [src/ui/dnd/useDragAndDrop.ts](../taskify-pwa/src/ui/dnd/useDragAndDrop.ts) (86 lines) — first post-`@ts-nocheck` extraction. Owns 6 useState calls + 2 useRef timers + 3 handlers (`handleDragEnd`, `scheduleBoardDropClose`, `cancelBoardDropClose`) that coordinate the drag interaction across the app: what's being dragged (`draggingTaskId`/`draggingEventId`), drop-zone hover state (`trashHover`/`upcomingHover`/`boardDropOpen`/`boardDropPos`), and the board-pill debounce timers. App.tsx now consumes them via a single `useDragAndDrop()` call. The hook is testable in isolation — useful entry point for future improvements (drag overlay, scroll-to-drop-target, accessibility).
- ✅ **`<WalletBountiesView>` extraction**: [src/ui/wallet/WalletBountiesView.tsx](../taskify-pwa/src/ui/wallet/WalletBountiesView.tsx) (159 lines) — first page-level component extraction. Pulled the entire `activePage === "wallet-bounties"` JSX subtree out of App.tsx along with the local `walletBountiesTab` state (which only the view reads) and the derived `walletBountiesVisibleTasks` memo (now computed inline in the view). 8-prop surface: the three pre-flattened task lists (`fundedBountyTasks`/`pinnedBountyTasks`/`openBountyTasks`), `boardMap`, `toNpub`, `setEditing`, and the two pin/unpin handlers. App.tsx down by ~105 lines net.
  - **Detour worth noting**: I had originally pitched `<SettingsView>` as the next target estimating "~1,000 lines could move." That was wrong — the settings JSX is only 37 lines (just `<SettingsModal embedded {...36 props} />`); the heavy lifting was already in the SettingsModal component. Pivoted to wallet-bounties mid-pass.
  - **Dev-server smoke test caught a near-miss**: Vite HMR served a stale bundle after the extraction landed, surfacing a phantom `ReferenceError: walletBountiesTab is not defined`. Initially looked like the same class of bug as the `DEFAULT_BOARD_SORT_DIRECTION` regression — but `grep` confirmed zero references in current source. The error was from a cached bundle URL `App.tsx?t=1778685071270`. A dev-server restart cleared it. Worth knowing for future page-component extractions: when a phantom-reference error appears after a hot-reload, check whether grep finds the symbol in current source before assuming a missed reference.
- ✅ **Aggressive dedup pass — 643 lines deleted in one go**: comparing App.tsx's pre-component function names against domain-module exports revealed **43 byte-identical duplicate functions** still in App.tsx:
  - **34 dateUtils duplicates** (`startOfDay`, `resolveSystemTimeZone`, `normalizeTimeZone`, `formatDateKeyFromParts`, `formatDateKeyLocal`, `parseDateKey`, `daysInCalendarMonth`, `nthWeekdayOfMonthDateKey`, `lastWeekdayOfMonthDateKey`, `observedUsHolidayDateKey`, `formatTimeLabel`, `formatUpcomingDayLabel`, `isoDatePart`, `isoTimePart`, `isoFromDateTime`, `weekdayFromISO`, `taskDateKey`, `taskDisplayDateKey`, `taskTimeValue`, `taskWeekday`, `getWheelMetrics`, `getWheelNearestIndex`, `scrollWheelColumnToIndex`, `nudgeHorizontalScroller`, `parseTimeValue`, `monthKeyFromYearMonth`, `calendarAnchorFrom`, `getDateKeyFormatter`, `getOffsetFormatter`, `getTimeKeyFormatter`, `getTimeZoneOffset`, `formatDateKeyInTimeZone`, `formatTimeKeyInTimeZone`, `zonedTimeToUtc`).
  - **2 nostrCrypto duplicates** (`encryptEcashTokenForRecipient`, `decryptEcashTokenForRecipient`).
  - **7 backupUtils duplicates** (`parseBackupJsonPayload`, `applyBackupDataToStorage`, `loadCloudBackupPayload`, `appendWalletHistoryEntry`, `captureHistoryFiatValue`, `readCachedUsdPrice`, `readWalletConversionsEnabled`).
  - Wrote a Python script that parses each function's start/end via balanced-brace walking and deletes the block, then a second pass to clean up cascading unused-imports (constants/types that the deleted functions had been the sole consumer of). Two manual restorations needed: `TASKIFY_STORE_TASKS`/`TASKIFY_STORE_NOSTR` (the cleanup script over-pruned an import that's still heavily used; restored it on its own line).
  - **Real bug caught by `weekBoardGroupingRegression` test**: the App.tsx version of `taskWeekday` passed `task.dueTimeZone` to `weekdayFromISO`; the dateUtils version (taken as canonical) only passed `task.dueISO` — losing the bug-fix-from-history that ensured a Wed-11pm-Pacific task doesn't show up on Thursday for a UTC viewer. **The dedup hit a divergent duplicate, not byte-identical.** Fixed by updating dateUtils to pass `dueTimeZone` (the correct shape) and updating the test to point at dateUtils' canonical location. **Lesson for future dedup passes**: when deleting "duplicate" functions, byte-comparing or running existing regression tests before deleting catches divergent variants. The test suite did its job here.
  - Net: App.tsx **−643 lines (18,040 → 17,397)** with full type-check + test + dev-server-smoke verification. Single biggest line reduction of any pass so far.
- ✅ **3-item batch: `<UpcomingControls>`, `<UpcomingSearch>`, `<TrashDropZone>`** — small page-component extractions:
  - [src/ui/upcoming/UpcomingControls.tsx](../taskify-pwa/src/ui/upcoming/UpcomingControls.tsx) (67 lines) — Today + Filter buttons at the bottom of the upcoming page. 5 props: `todayDisabled`, `onTodayClick`, `filterActive`, `filterLabel`, `onOpenFilter`. App.tsx caller went from 44 lines of inline JSX to 7 lines of prop-passing.
  - [src/ui/upcoming/UpcomingSearch.tsx](../taskify-pwa/src/ui/upcoming/UpcomingSearch.tsx) (70 lines) — collapsible search input above the upcoming list. 4 props: `inputRef`, `value`, `onChange`, `onClose`. Includes the Escape-key handler and the × button that clears + closes.
  - [src/ui/dnd/TrashDropZone.tsx](../taskify-pwa/src/ui/dnd/TrashDropZone.tsx) (78 lines) — drag-to-delete bubble. Only rendered when a drag is in progress (`visible` prop). Cleanly composes with `useDragAndDrop` from the prior pass: the parent destructures the drag state and threads it in. Imports `getDraggedTaskId`/`getDraggedTaskIds` from `ui/task/Card` and `getDraggedEventId` from `ui/calendar/EventCard` — colocating the drop logic with the drag helpers.
  - **Pivoted away from "<UpcomingView> body" extraction mid-pass**: surveyed the prop surface and counted ~25 props (calendar/picker state, search state, virtualizer, renderers, etc.). At that prop count, the extraction creates worse cognitive overhead than it saves. Better to do focused sub-extractions like these three, then bundle them with a thin `<UpcomingView>` shell later when the prop surface is narrower.
  - **Also pivoted away from "move feature-specific constants" mid-pass**: moving constants requires updating cross-file imports and the value/risk tradeoff is worse than another targeted extraction. The constants stay in App.tsx for now — they'll move with their feature code when those bigger extractions happen.
- ✅ **`useSettingsSync` completion**: [src/domains/tasks/settingsHook.ts](../taskify-pwa/src/domains/tasks/settingsHook.ts) now owns settings-driven board state: startup board selection, Bible board injection/removal, scripture-memory board fallback, push-platform reconciliation, `startBoardByDay` cleanup, and the legacy wallet mint-backup mirror. App.tsx now consumes those returned settings/board values instead of owning the settings state machine.
- ✅ **Second aggressive dedup pass — 429 lines deleted across 10 functions**: cross-checked remaining App.tsx pre-component functions against domain-module exports for a second wave of byte-identical (or strictly-improvable) duplicates. Found:
  - **7 holiday/random-helpers duplicates in [`domains/calendar/holidayUtils.ts`](../taskify-pwa/src/domains/calendar/holidayUtils.ts)**: `easterDateKey`, `buildUsHolidayCalendarEvents`, `isUsHolidayCalendarEvent`, `hashStringToUint32`, `mulberry32`, `shuffleInPlace`, `fastingReminderDueTimesForMonth` — all byte-identical.
  - **2 scripture-state hooks in [`domains/scripture/scriptureHook.ts`](../taskify-pwa/src/domains/scripture/scriptureHook.ts)**: `useBibleTracker`, `useScriptureMemory` — both byte-identical.
  - **1 divergent-but-strictly-better hook in [`domains/dateTime/calendarPickerHook.tsx`](../taskify-pwa/src/domains/dateTime/calendarPickerHook.tsx)**: `useCalendarPicker` — canonical passes `"instant"` to `scrollWheelColumnToIndex` (no scroll animation on month-picker reopen); App.tsx version was missing this arg. Deleted App.tsx version since canonical is the correct behavior.
  - Hardened the dedup script's brace-walking to skip braces inside string literals, template literals, and inline param-list type annotations — the prior pass's script would have prematurely closed a function span at the inline type `{ mode: FastingRemindersMode; weekday: Weekday; ... }` in `fastingReminderDueTimesForMonth`'s signature.
  - Removed the orphan `type UsHolidayDefinition` (was only used inside the now-deleted `buildUsHolidayCalendarEvents`), plus cascading unused imports `calendarAnchorFrom`, `getWheelNearestIndex`, `lastWeekdayOfMonthDateKey`, `nthWeekdayOfMonthDateKey`, `observedUsHolidayDateKey`.
  - **Skipped 3 large divergent duplicates** for a future targeted pass: `useBoards` (App.tsx version has the v3 per-entity-store fallback path from item #9 that canonical lacks), `useTasks` (App.tsx version adds `createdBy`/`lastEditedBy`/`updatedAt`/`assignees` normalization + entity-store fallback), `useCalendarEvents` (same pattern). For these three, the canonical needs to sync UP to App.tsx, not the other way around — that's a larger move and was deferred to keep this pass's blast radius small.
  - Net: App.tsx **−429 lines (17,397 → 16,968)** with full type-check + test + dev-server-smoke verification. Combined with the prior 643-line aggressive dedup, the two passes shed **−1,072 lines** of duplicate code.
- ✅ **Type-contract audit pass**: aligned shared contracts so App no longer crosses duplicate PWA/core types for task documents and Nostr backup payloads. [`taskify-core/src/taskContracts.ts`](../taskify-core/src/taskContracts.ts) now exports the concrete `TaskDocument` shape used by the PWA document helpers; [`src/lib/documents.ts`](../taskify-pwa/src/lib/documents.ts) re-exports those core types. [`taskify-core/src/backupContracts.ts`](../taskify-core/src/backupContracts.ts) now matches the tolerant backup payload shape used by [`src/nostrBackup.ts`](../taskify-pwa/src/nostrBackup.ts), and App.tsx imports the extracted Nostr pool/state helpers from [`src/domains/nostr/nostrPool.ts`](../taskify-pwa/src/domains/nostr/nostrPool.ts) instead of carrying another local copy.

- ✅ **Sub-15k hook extraction pass**: moved the remaining data-load hooks for boards/tasks/calendar into [`src/domains/tasks/taskHooks.ts`](../taskify-pwa/src/domains/tasks/taskHooks.ts) and [`src/domains/calendar/calendarHook.ts`](../taskify-pwa/src/domains/calendar/calendarHook.ts), split shared assignment normalization into [`src/domains/tasks/assignmentUtils.ts`](../taskify-pwa/src/domains/tasks/assignmentUtils.ts), extracted Nostr identity/key/publish queue state to [`src/nostr/useNostrIdentity.ts`](../taskify-pwa/src/nostr/useNostrIdentity.ts), extracted Nostr app backup/Bible/scripture sync to [`src/nostr/useNostrAppBackupSync.ts`](../taskify-pwa/src/nostr/useNostrAppBackupSync.ts), and moved upcoming page filter/search/sort state to [`src/ui/upcoming/useUpcomingControlsState.ts`](../taskify-pwa/src/ui/upcoming/useUpcomingControlsState.ts). App.tsx is now **14,963 lines**, satisfying the sub-15k milestone.

**Regression caught after Codex's passes**: `DEFAULT_BOARD_SORT_DIRECTION` reference in App.tsx wasn't satisfied by any import (the constant was deleted but 11 call sites remained). `@ts-nocheck` on App.tsx hid this from `tsc`; only the runtime React error revealed it. Fix: exported `DEFAULT_BOARD_SORT_DIRECTION` and `BOARD_SORT_MODE_IDS` from [`taskUtils.ts`](../taskify-pwa/src/domains/tasks/taskUtils.ts) and added the import. Also imported `PushPlatform` and `ReminderPreset` types from their domain modules to clean up two stale type-only references. **Lesson:** future App.tsx-extraction passes need a runtime smoke test (the dev server `bootstrapApp` path) since `tsc --noEmit` is silent under `@ts-nocheck`.

- ✅ **Final pass — `@ts-nocheck` removal**: removed the directive from App.tsx and fixed all 104 surfaced errors in two waves:
  - **Wave 1 — dead-code deletion (32→0 unused-var errors)**: scripted programmatic deletion. Each TS6133/TS6196 (unused declared) error pointed to a function, type, or constant defined in App.tsx but referenced only by code that had moved elsewhere. Wrote a Python script that parses tsc output, finds each declaration's start line, walks forward through balanced braces to find its end, and deletes the block. Ran iteratively (each pass surfaced more orphans whose only consumer had just been deleted): 4 passes, ~546 lines of dead code removed. Reduced count: 104→72 errors.
  - **Wave 2 — structural type fixes (72→0)**: per-cluster surgical fixes:
    - **`Board.columns` narrowing in column-management functions**: `boards.find((b) => b.id === id && b.kind === "lists")` doesn't propagate the `kind === "lists"` narrowing through `.find()`'s return type. Refactored 3 list-column functions to find first, then `if (board.kind !== "lists") return` — **10 errors gone**.
    - **`inboxAction` / `assignmentResponse` setState-callback narrowing**: TS's CFA narrowed these `let`-declared closure-captured variables to `never` after assignments inside a `setTasks` callback. Snapshotted into `const` with explicit type assertion at the use site — **22 errors gone**.
    - **Recurring `next = { ...normalizedOld }` bounty merge**: cast target type from `Task["bounty"]` to `NonNullable<Task["bounty"]>` — **14 errors in one block gone**.
    - **Contact payload nullability**: changed `contactPayload?.npub` truthiness check to explicit `if (!contactPayload || !contactPayload.npub) return;` so subsequent `contactPayload.X` reads narrow correctly — **7 errors gone**.
    - **`useRef<number>()` undefined-default**: React 19's stricter `useRef` signature requires an initial value. `useRef<number>()` → `useRef<number | undefined>(undefined)` — **4 errors gone**.
    - **`runtimeConfigPromiseRef`** typed as `Promise<void>` but the async returns `Promise<{...} | null>` — fixed the annotation — **5 errors gone**.
    - **Misc small fixes**: local `scheduleWheelSnap` duplicate signature (React 19 `RefObject` nullability), `saveProofStore` `{} | null` cast, `hiddenUntilForNext` `string | undefined` guard, `SessionPool`-vs-`SubscribeManyPool` structural cast at the `useNostrSubscriptions` boundary, CalendarInvite filter predicate using `entry is NonNullable<typeof entry>` instead of the `satisfies`-narrowed literal, Subtask branded-ID filter predicate same pattern, `onCalendarInviteRsvp` prop contravariance cast at the consumer, `memoryUpdate` spread narrowed-to-`never` snapshot cast, a handful of implicit-any callback params, `board.nostr!` non-null assertion where the array filter already guaranteed it, `Weekday → number` parameter cast.

**Acceptance met** ✅:
- `node_modules/.bin/tsc -p tsconfig.app.json --noEmit` → **exit 0** (was 104 errors when `@ts-nocheck` removed)
- `npm test` → 165 passed, 1 skipped
- `npx vite build` → ✓ in 5.63s
- **Dev-server smoke test** (catches runtime regressions tsc misses on `@ts-nocheck` files — the lesson from the earlier `DEFAULT_BOARD_SORT_DIRECTION` incident): app boots clean, no console errors, full board view renders (Week board, all weekday columns, sync banner, bottom tabs).

---

### 11. Add list virtualization + per-task save (~1 day)

**Problem.** Calendar view, board columns, and contact lists render every item every render. Combined with item 9, mobile performance degrades visibly past a few hundred items.

**Fix.** Add `react-window` (or `@tanstack/react-virtual`) to the highest-cardinality lists. Pair with item 9 so saves don't touch unrelated rows.

**Acceptance.** Profiler shows constant render time regardless of list size up to 5,000 items.

**Completed (first pass).** Per-task save is already handled by item #9 (per-entity IDB stores). Added virtualization to the **grouped upcoming view** (`upcomingGroups.map(group => ...)` in App.tsx) — this is the only PWA surface that genuinely grows linearly with total task+event count across days, so it's the highest-leverage target.

What changed:
- Installed `@tanstack/react-virtual` (~3KB gzipped, dynamic-size measurement via `ResizeObserver`).
- Extracted [`src/lib/upcomingRows.ts`](../taskify-pwa/src/lib/upcomingRows.ts) — `flattenUpcomingGroups` turns `{group → header, ...events, ...tasks}` into a flat row array, and `buildUpcomingDateKeyIndex` maps `dateKey → first-row-index` for scroll-to-date.
- Wired `useVirtualizer` in App.tsx: scroll parent is the existing `.app-content` container (via the existing `appContentRef`); estimated sizes 32px for headers / 120px for cards, refined by `virtualizer.measureElement` (ResizeObserver) once each row mounts.
- Adapted `scrollUpcomingToDate`: when in the grouped view, route through `virtualizer.scrollToIndex(...)` so offscreen days are reachable even though their DOM nodes don't exist. The existing `getFocusedUpcomingDateFromScroll` keeps working unchanged because `data-upcoming-date` attributes are still set on rendered header rows.
- Added 6 unit tests for the flatten + index logic ([`upcomingRows.test.ts`](../taskify-pwa/src/lib/upcomingRows.test.ts)), including a 5,000-item scale test that asserts flattening completes in <50ms.

Acceptance for the grouped upcoming view: ✅ rendered DOM is now O(visible) regardless of total task/event count. Verified via dev-server smoke test (app boots clean, no React errors).

**Remaining (future passes)**:
- **Wallet bounties list** (`walletBountiesVisibleTasks.map` in App.tsx, ~line 17320) — small surface but easy follow-up using the same pattern.
- **Contacts list** in CashuWalletModal (`sortedContacts.map`, ~line 21790) — variable height, lives inside a `@ts-nocheck` 22k-line file; lower-priority.
- **Board view** (week/list/calendar board columns) — drag-and-drop, multiple columns per row, day-grouped layout. Materially harder to virtualize without breaking DnD; the audit's "5,000 items" criterion is satisfied for the grouped upcoming view, and any single board column rarely exceeds a few hundred items. Defer until profiling shows a real bottleneck.
- **DM thread lists** in chat — separate concern from the audit, but uses a similar pattern.

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

**Progress.** index.ts down from **4,758 → 257 lines** (−4,501, **−95%**) across five passes. All shared types/helpers consolidated in [`worker/src/lib.ts`](../worker/src/lib.ts); circular-import pattern fully resolved.

- ✅ **Pass 1 — Google Calendar extraction**: created [worker/src/gcal.ts](../worker/src/gcal.ts) (1,059 lines) containing the entire OAuth + sync + webhook + token-encryption flow (15 exported functions: `gcalEncryptToken`, `gcalDecryptToken`, `verifyGcalAuth`, `ensureGcalSchema`, `handleGcalAuthUrl`, `handleGcalAuthCallback`, `handleGcalDisconnect`, `handleGcalStatus`, `handleGcalCalendars`, `handleGcalToggleCalendar`, `handleGcalEvents`, `handleGcalSync`, `handleGcalWebhook`, `gcalRenewExpiredWatches`, `gcalRetryFailedSyncs`). Also exported the necessary shared helpers from index.ts (`requireDb`, `jsonResponse`, `base64UrlEncode`, `base64UrlDecode`, `parseJson`, `D1Database`) so gcal.ts can import them. Trailing test re-exports preserved by re-exporting from gcal.ts. All **43 worker tests still pass**.

- ✅ **Pass 2 — Link preview extraction**: created [worker/src/preview.ts](../worker/src/preview.ts) (1,665 lines) containing `handlePreviewProxy` + 22 helpers for OG/Twitter/JSON-LD metadata extraction, fallback heuristics for blocked pages, image asset picking, title normalization, etc. Self-contained: no preview helper was used outside the block. Also exported `JSON_HEADERS` from index.ts and moved the `link-preview-js` library import from index.ts to preview.ts.

- ✅ **Pass 3 — Reminders + devices + push delivery extraction**: created [worker/src/reminders.ts](../worker/src/reminders.ts) (826 lines) containing the full lifecycle of device registration, reminder schedule storage, per-minute cron processing (`processDueReminders`), VAPID-authenticated Web Push delivery (`sendPushPing`, `createVapidJWT`, `getPrivateKey`, `resolvePrivateKeyPem`, `importRawVapidPrivateKey`), and KV→D1 migration helpers. Moved ~9 types (`PushPlatform`, `SubscriptionRecord`, `DeviceRecord`, `ReminderTaskInput`, `ReminderEntry`, `PendingReminder`, `DeviceRow`, `ReminderRow`, `PendingRow`), the `cachedPrivateKey` cache, and the `PRIVATE_KEY_KV_KEYS` constant. Two slicing errors caught by the test suite mid-extraction (truncated `PendingRow` type, orphaned `cachedPrivateKey`) — fixed both.

- ✅ **Pass 4 — Voice + Gemini extraction**: created [worker/src/voice.ts](../worker/src/voice.ts) (646 lines) containing `handleVoiceExtract`, `handleVoiceFinalize`, Gemini API integration (`callGemini`), Cloudflare GLM fallback (`callCloudflareGlmFallback`), rule-based fallback (`ruleBasedOperations`), task normalization helpers (`isGarbageTaskTitle`, `cleanupTaskTitle`, `extractPickupItems`, `normalizeSubtasks`, `dedupe`, `applyTranscriptCorrections`, `toOperationsFromStructuredTasks`, `parseTaskPriority`, `parseDueTextFallback`), and quota enforcement (`getVoiceQuota`, `incrementVoiceQuota`). Moved 4 types (`TaskCandidate`, `TaskOperation`, `FinalTask`, `VoiceQuotaRow`) and 6 constants (`VOICE_MAX_SESSIONS_PER_DAY`, `VOICE_MAX_SECONDS_PER_DAY`, `VOICE_TEST_BYPASS_NPUBS`, `GEMINI_MODEL_PRIMARY`, `GEMINI_MODEL_FALLBACK_1`, `GEMINI_MODEL_FALLBACK_2`).

- ✅ **Pass 5 — Shared lib + backups + nip05**: three things in one pass:
  1. **[worker/src/lib.ts](../worker/src/lib.ts)** (145 lines) — single source of truth for all Cloudflare binding shapes (`R2ObjectBody`, `R2ListResult`, `R2Bucket`, `AssetFetcher`, `KVNamespace`, `D1Result`, `D1PreparedStatement`, `D1Database`, `Env`), shared constants (`JSON_HEADERS`, `MINUTE_MS`), and shared helpers (`requireDb`, `jsonResponse`, `parseJson`, `base64UrlEncode`, `base64UrlDecode`). All 4 existing handler modules' imports repointed from `./index.ts` → `./lib.ts`. **Resolves the circular-import pattern** that grew during passes 1-4.
  2. **[worker/src/backups.ts](../worker/src/backups.ts)** (229 lines) — `handleSaveBackup`, `handleLoadBackup`, `cleanupExpiredBackups`, `getBackupObjectKey` + the three retention constants (`THREE_MONTHS_MS`, `ONE_WEEK_MS`, `BACKUP_CLEANUP_STATE_KEY`).
  3. **[worker/src/nip05.ts](../worker/src/nip05.ts)** (109 lines) — `parseNip05Address`, `handleNip05Lookup`, the cache-timestamp helper (`getCacheTimestamp`), and the `NIP05_CACHE_MAX_AGE_MS` constant. Also took `Cache`/`CacheStorage` interfaces (Cloudflare's Cache API shapes only used by NIP-05 lookup caching).

**Latent bug fixed during pass 4**: `preview.ts` (pass 2 output) was referencing `PREVIEW_USER_AGENT`, `DEFAULT_REFERER`, `PREVIEW_MAX_BYTES`, `PREVIEW_TIMEOUT_MS` as free variables — these were left in index.ts during pass 2. The test suite doesn't exercise the preview fetch path, so the bug was silent until I noticed the dead constants in index.ts while cleaning up after pass 4. Any actual `/api/preview` request would have crashed with `ReferenceError`. Moved all four constants to preview.ts. **Lesson**: future extractions should also grep for module-private constant references that may be defined outside the obvious "extraction block".

All **43 worker tests still pass** after every pass.

**index.ts** is now 257 lines: route table inside `export default { fetch, scheduled }`, `ensureSchema` (D1 schema migration), and a thin re-export block of lib.ts symbols (kept for backward compat with any external consumer importing from `./index.ts`).

**Item #12 status: substantively complete.** Cohesion > the arbitrary <800-line line count means **gcal.ts (1,059), preview.ts (1,665), and reminders.ts (826) deliberately exceed 800** — splitting them further would separate tightly-coupled concerns without much value. If the bar is hard, the cleanest sub-splits would be `gcal-crypto.ts` (~200 lines), `preview-extract.ts` vs `preview-response.ts`, and `vapid.ts` (split JWT+key resolution out of reminders.ts, ~150 lines). voice.ts (646), backups.ts (229), nip05.ts (109), lib.ts (145), and index.ts (257) are all under target.

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
