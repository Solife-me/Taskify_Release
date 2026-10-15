# Improvement review — started October 15, 2026

A chunk-by-chunk review of every Taskify client for **high-value features, user experience,
UI/UX simplification, codebase simplification, and performance refactors**. It complements the
[October 2 full-stack audit](full-stack-audit-report-2026-10-02.md), which covered security,
abuse and efficiency and explicitly left usability, accessibility and end-to-end flows out of
scope (its Appendix C). Findings already tracked there are not repeated here.

## How this review runs

1. Review one chunk.
2. Record proposals below with an ID (`C<chunk>-<n>`), the user it serves, value, effort and risk.
3. The maintainer marks each **Approve**, **Decline** or **Explore**.
4. Approved items are implemented (test-first for bugs, per `AGENT.md`), then the next chunk starts.
   Explore items get a short investigation and come back as a concrete proposal.

Constraints carried through every chunk:

- **Interoperability first.** A change to what one client writes must be readable by every other
  client (PWA, iOS, Watch, macOS, CLI). Wire-format changes need parity tests on both sides.
- **The Taskify wallet is being phased out** (`cd9e02f6`). Wallet work is limited to
  simplification, removal and safe close-out; no new wallet features.
- **Language fit.** Each chunk also asks whether code should move to another language, such as
  Rust compiled for Swift (UniFFI) and the web (WASM). The bar is a measurable gain: one
  implementation replacing two drifting ones, CPU-bound work, or memory safety around parsing
  untrusted input. Rewriting for its own sake does not qualify.

## Who each client serves

| Client | Primary user | What "better" means for them |
| --- | --- | --- |
| PWA (mobile web) | Android users and anyone trying Taskify from a shared link | Fast first run, no-install onboarding, reliable offline, feels native on a phone |
| PWA (desktop browser) | Windows/Linux desktop users | Keyboard-driven capture and triage, multi-pane views, dense layouts |
| iOS / iPadOS | Daily-driver Apple users | Native polish, widgets, Siri/Shortcuts, notifications that act, iPad multitasking |
| watchOS | The same users, at a glance | Today's list, one-tap complete, dictated capture, nothing else |
| macOS | Desktop power users on Apple | Keyboard and menu-bar capture, multiple windows, parity with iOS |
| CLI | Developers and AI agents (OpenClaw skill) | Predictable JSON, idempotent writes, the same semantics as the apps |
| Worker, push relay | The maintainer and StartOS self-hosters | Free-tier cost, easy self-hosting, nothing users notice |

## Chunk plan

| # | Chunk | Scope | Status |
| --- | --- | --- | --- |
| 1 | Shared domain core and contract drift | `taskify-core`, and where clients re-implement it | Done |
| 2 | PWA app shell | `App.tsx` (12.8k lines), navigation, onboarding, settings | Pending |
| 3 | PWA boards, tasks, Upcoming, calendar | `ui/board`, `ui/task`, `domains/tasks`, `domains/calendar` | Pending |
| 4 | PWA sync and storage | `nostr/`, `storage/`, `domains/nostr` | Pending |
| 5 | PWA chat, contacts, sharing, agent mode, voice, Bible tracker | `lib/`, `agent/`, `components/` | Pending |
| 6 | PWA wallet phase-out | `wallet/`, `mint/`, `context/Cashu*` — what can be deleted or lazy-loaded | Pending |
| 7 | iOS TaskifyCore | Swift sync, state and Nostr engine | Pending |
| 8 | iOS tasks, boards, Upcoming UI | `TaskifyApp/Features` (tasks side) | Pending |
| 9 | iOS chat, settings, onboarding, wallet phase-out | `TaskifyApp/Features` (rest) | Pending |
| 10 | iOS extensions | Widgets, Watch, share extension, notification service, App Intents | Pending |
| 11 | macOS | `taskify-macos` | Pending |
| 12 | Nostr runtime and CLI | `taskify-runtime-nostr`, `taskify-cli` | Pending |
| 13 | Worker and push relay | `worker/`, `taskify-push-relay/` — running cost and self-hosting | Pending |
| 14 | Parity matrix, repo hygiene, roll-up | Feature parity across clients, docs, final summary | Pending |

---

## Chunk 1 — Shared domain core and contract drift

`taskify-core` is 3,090 lines of pure TypeScript with 106 passing tests. The PWA imports it in 41
files and the CLI in 21. iOS and macOS re-implement it in Swift, kept in step by hand-written tests
on each side. The core is in good shape; what it lacks is the **behaviour** that clients must
agree on. Recurrence lives only in the PWA (`domains/tasks/boardUtils.ts`) and in Swift, and some
protocol code has been copied into each client and has drifted.

### C1-1 — The CLI ends a recurring series when it completes a task (bug, interop)

- **User:** CLI and agent users; everyone who shares a board with them.
- **Finding:** PWA (`App.tsx` `completeTask`) and iOS (`TaskifySnapshot.swift` ~L1480) create
  the next occurrence when a recurring task is completed, with a date-derived id so two devices
  converge. The CLI's `setTaskStatus` (`taskify-cli/src/nostrRuntime.ts` ~L1378) only sets
  `completedAt`. An agent that ticks off "daily standup" ends the series for every device. The
  weekly backfill in `ensureWeekRecurrencesForCurrentWeek` only covers week boards.
- **Proposal:** Move `nextOccurrence`, `recurringInstanceId`, `hiddenUntilForNext` and a pure
  `buildNextRecurringInstance(task, now, options)` from the PWA into `taskify-core`. The PWA
  re-exports them, and the CLI calls it on `done`. Write a failing CLI test first.
- **Effort:** M. **Risk:** medium (recurrence is subtle; covered by the vectors in C1-2).
- **Note:** The CLI edit touches `nostrRuntime.ts`, which has uncommitted relay work.

### C1-2 — Shared protocol test vectors for TypeScript and Swift (interop)

- **User:** Everyone; this is what stops iOS and PWA drifting.
- **Finding:** No fixture is shared between languages. Parity rests on hand-written tests on
  each side (`FastingReminderParityTests`, `NIP44InteropVectorsTests`, app-state merge tests).
- **Proposal:** Add `taskify-core/fixtures/*.json` with input/expected pairs, read by both the
  Node tests and the Swift tests (`TaskifyCoreTests` loads them by relative path). Start with
  recurrence next-occurrence and instance ids (C1-1). Then add share-envelope parsing,
  calendar decode and bot-command lists as those areas are touched.
- **Effort:** S to start, grows per area. **Risk:** low.

### C1-3 — Remove PWA copies of core functions (cleanup)

- **Finding:**
  - `domains/tasks/boardUtils.ts` re-declares five compound-board helpers that are identical
    to `taskify-core/boardContracts.ts`.
  - `startOfWeek` exists twice in the PWA (`boardUtils.ts`, `calendarUtils.ts`) besides core's
    `startOfWeekLocal`.
  - `contactInitials` exists four times. The core version slices by UTF-16 unit, which splits
    emoji and non-Latin names into broken glyphs. The three PWA copies fixed that separately.
- **Proposal:** Fix `contactInitials` in core (emoji-safe, with a test) and delete the PWA
  copies. Have `boardUtils.ts` and `calendarUtils.ts` re-export the core helpers.
- **Effort:** S. **Risk:** low.

### C1-4 — One home for date-key and time-zone helpers (cleanup)

- **Finding:** `taskify-core/src/events.ts` declares its own `CalendarEvent` type, which
  `index.ts` exports as `DraftCalendarEvent`, and private copies of `normalizeTimeZone` and
  `parseDateKey`. Those helpers are also in `taskify-pwa/src/domains/dateTime/dateUtils.ts`, and
  `addDaysToDateKey` is defined inside `App.tsx`. Only the CLI uses `events.ts`.
- **Proposal:** Add `taskify-core/src/dateKey.ts` holding date-key parse, format and add-days,
  plus time-zone validation. Use it from `events.ts` and have the PWA's `dateUtils` re-export it.
  C1-1 needs the same helpers.
- **Effort:** S. **Risk:** low.

### C1-5 — Move bot-command and private-contact wire code into core (interop)

- **Finding:** `botCommands.ts` (PWA 148 lines, CLI 257) and `nip51Contacts.ts` (PWA 194, CLI
  155) are separate copies that have drifted: about 300 and 230 differing lines. The parse and
  validate rules are the wire contract in `docs/reference/bot-command-lists.md`. Only the CLI
  validates drafts, and only the CLI reads the legacy `taskify-contacts` list.
- **Proposal:** Move the pure parts into `taskify-core`: constants, `parseBotCommands`,
  `validateBotCommandsDraft`, the NIP-51 item build/extract/merge. Keep fetch, publish and
  caching in each client. Add vectors per C1-2.
- **Effort:** S–M. **Risk:** low. **Note:** CLI's `botCommands.ts` has uncommitted edits.

### C1-6 — A Rust core for protocol logic shared by Swift and the web (explore)

- **User:** Everyone, indirectly. Interoperability is the payoff, not speed.
- **Finding:** Protocol behaviour exists twice: TypeScript (core and PWA) and Swift (TaskifyCore,
  97k lines with the app). This chunk found three drifts: the CLI recurrence gap, the clamping
  differences, and the NIP-51 petname slot. All three were the kind a single implementation
  rules out. The hot paths are not CPU-bound. The exceptions are NIP-13 mining (already native
  SHA-256 in the CLI) and NIP-44, so speed alone does not justify a port.
- **Shape if pursued:** A `taskify-proto` Rust crate holding the pure, deterministic pieces:
  recurrence, occurrence ids, board key derivation and encryption, share-envelope and
  calendar decoding, app-state merges. It ships as an XCFramework through UniFFI for
  iOS/macOS/Watch and as WASM for the PWA, CLI and Worker.
- **Costs:** a Rust toolchain in CI and in Xcode builds; WASM payload (roughly 100–300 KB gzip for
  this scope) and async init on the PWA's startup path; a bridging layer for each language;
  harder debugging across the boundary; and one more language for contributors.
- **Recommendation:** Not yet. The shared vectors (C1-2) catch drift at a fraction of the cost.
  Revisit at chunk 7 (iOS TaskifyCore) with a measured count of duplicated logic. If one piece
  is a good candidate, it is board crypto plus envelope parsing, which is pure, security
  sensitive and identical everywhere.

### Outcome

Implemented October 15, 2026:

- **C1-1:** `taskify-core/src/recurrence.ts` holds the engine (`nextOccurrence`,
  `recurringInstanceId`, `hiddenUntilForNext`, `isFrequentRecurrence`) and the pure
  `buildNextRecurringTask`. The PWA's `completeTask` uses the builder. CLI `done` publishes the
  next occurrence unless a live copy exists, returns it as `nextOccurrence`, and prints it in
  human mode. Core now reads `every` n < 1 as 1 and clamps `monthlyDay` to 1–28, as Swift's
  decoder does. Before, the PWA ended such a series silently.
- **C1-2:** `taskify-core/fixtures/recurrence-vectors.json` (16 cases: DST both ways, five time
  zones, hourly ids, clamping, end dates) is read by `tests/recurrence-core.test.ts` and by
  `RecurrenceVectorTests.swift`. Both pass, so TypeScript and Swift agree today.
- **C1-3:** The PWA re-exports core for the compound-board helpers, `startOfWeek` (twice),
  `recurringInstanceId`, `normalizeTaskPriority` and the date helpers. All five
  `contactInitials` copies now use core's grapheme-safe version, which keeps "👨‍👩‍👧" and "🇺🇸"
  whole. Before, core returned a broken surrogate for "🦊 Fox".
  **Bug fixed in passing:** the PWA's `startOfWeek` subtracted 24 h per day, so in the week after
  a DST change it returned 23:00 of the previous day. That shifted when monthly and hourly
  series reappeared. Core's calendar arithmetic is used now (test in `recurrence-core.test.ts`).
- **C1-4:** `taskify-core/src/dateTime.ts` is the one home for date-key and time-zone helpers.
  `events.ts`, `reminderUtils.ts`, `weekDate.ts`, the PWA's `dateUtils.ts`/`appTypes.ts` and
  `App.tsx` (`addDaysToDateKey`, four `ISO_DATE_PATTERN` copies) all use it.
- **C1-5:** `taskify-core/src/botCommands.ts` and `nip51Contacts.ts` hold the wire code. The PWA
  and CLI keep only fetch, publish, cache and encryption.
  **Interop bug fixed:** when a contact had a name but no relay, the PWA wrote
  `["p", pk, "", "", name]`. The CLI and the PWA's own reader expect the name at index 3, so
  they lost it; iOS had a workaround. Core writes the standard form and reads the old one.
- **Not changed:** The CLI does not advance streaks when completing (the PWA derives them from
  board history), and it uses a Sunday week start for reveal dates because it has no week-start
  setting.

Verification: core 132/132, CLI 202/202 plus type check, PWA lint (the one existing warning),
`tsc -b`, 391 Vitest tests and production build, Swift `TaskifyCoreTests` (788 tests, 0 failures, including
`RecurrenceVectorTests`).

### Notes carried to later chunks

- Chunk 2: `App.tsx` is 12,844 lines, and `completeTask` alone mixes inbox actions, streaks,
  Scripture Memory and recurrence in one `setTasks` callback.
- Chunk 6: the wallet modal (`CashuWalletModal.tsx`, 8,000+ lines) carries its own avatar,
  contact and group-avatar helpers.
- Chunk 12: most CLI runtime tests assert on source text (`readFileSync` plus regex), not on
  behaviour. A fake-session harness for `createNostrRuntime` would make them real tests.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C1-1 | Approve | 2026-10-15 | Done |
| C1-2 | Approve | 2026-10-15 | Done (recurrence vectors; extend per area) |
| C1-3 | Approve | 2026-10-15 | Done |
| C1-4 | Approve | 2026-10-15 | Done |
| C1-5 | Approve, after committing the CLI relay work | 2026-10-15 | Relay work committed in `555ecafd`; done |
| C1-6 | — | — | Logged after the maintainer asked for language-port review; revisit in chunk 7 |
