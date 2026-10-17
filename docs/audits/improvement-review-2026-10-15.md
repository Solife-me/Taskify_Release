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
- **Long-term best practice over quick fixes** (maintainer, 2026-10-15). Proposals lead with
  the durable design and state its cost. A smaller step is offered only as a stage toward it.
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
| 2 | PWA app shell | `App.tsx` (12.8k lines), navigation, onboarding, settings | Implementing |
| 3 | PWA boards, tasks, Upcoming, calendar, desktop layout | `ui/board`, `ui/task`, `domains/tasks`, `domains/calendar`, `styles/desktop-layout.css` | Pending; starts with C3-1 (desktop layout, maintainer request) |
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

---

## Chunk 2 — PWA app shell

The shell is everything around the features: entry and bootstrap (`main.tsx`), the `App`
component, navigation between pages and overlays, first run, settings, error handling and
startup cost.

What the review found:

- **`App.tsx` is 12,828 lines, and `App` is one component of about 12,300.** It holds 35
  `useState`, 56 `useRef`, 30 `useEffect` and 185 `useMemo`/`useCallback` hooks. It covers tasks,
  boards, calendar invites, the Bible tracker, printing, push, import, voice, task moves, Nostr
  publishing and about 1,700 lines of JSX. Every state change re-runs all of it, and none of its
  task mutations can be tested without rendering the app.
- **There is no navigation model.** The current page and view live in `useState`, and the app
  never writes to `history`, apart from removing a reminder's query string. In an installed PWA
  on Android, the system Back gesture closes Taskify instead of the open sheet. In a desktop
  browser, Back leaves the site. No board, task or settings page can be linked to, so reminders,
  shared boards and push each carry their own one-off deep-link handling. The Worker has no SPA
  fallback (`wrangler.toml` `[assets]`), so path URLs would 404 today.
- **Overlays are not accessible.** `ui/Modal.tsx` has no dialog role, no `aria-modal`, no Escape,
  no focus trap or focus restore, and the background stays interactive. 26 other sheets are
  built by hand.
- **The user's identity is a global, and signing needs the raw key.** The user's public key
  travels through `window.nostrPK` (24 places), and `readNostrIdentity` is called 42 times. The
  secret key is read in 35 files. There is no NIP-07 (browser extension) or NIP-46 (remote
  signer) support, so signing in always means pasting an nsec into a web page.
- **First run starts with key management.** The first screen offers "Sign in with nsec", "Create
  new login" and "Restore from backup" before the user has seen a task. It then asks for
  notification permission before any reminder exists.
- **About 614 KB gzipped of JavaScript loads before first render** (42 files). Roughly a third
  serves features most users never open. The Cashu SDK (140 KB) and the wallet, NWC and P2PK
  providers (about 31 KB) load for everyone, though the wallet is hidden for new users. QR tools
  (24 KB) and spreadsheet import (10 KB) are on the startup path. Node `process`/`Buffer`
  polyfills load at boot for a wallet dependency. Nothing in CI stops this growing.
- **One error boundary for the whole app.** A crash in any sheet replaces everything with a fixed
  light-themed message: no reload button, nothing to copy for a bug report.
- **No keyboard layer on desktop.** The macOS app has ⌘N, ⌘1–5 and ⌘↩; the PWA in a desktop
  browser has none.
- **Settings is one long modal** of seven stacked sections, with no index, no search and no way
  to link to a section.
- **Language fit:** nothing here. The shell is UI and orchestration, not CPU-bound or parsing
  code, so a port would add a boundary and gain nothing.

### C2-1 — URL routes with history, shared route vocabulary with iOS (UX, interop)

- **User:** Every PWA user. Android and desktop users most: Back works as they expect.
- **Proposal:** A typed route table, with pages as paths and overlays as history entries:
  - Pages: `/boards/:boardId`, `/upcoming`, `/chat/:conversation?`, `/settings/:section?`.
  - Overlays: an open task, event, note or sheet pushes an entry, so Back closes it.
  - Reminder, push, shared-board and quick-add deep links all resolve through this one parser.

  The vocabulary matches iOS's existing `taskify://` links (`upcoming`, `boards`, `task`,
  `event`, `quick-add`). Parsing and formatting live in `taskify-core`, with vectors shared with
  `TaskifyWidgetLink`, so one link opens the same place on every client. Later, Universal Links on
  `taskify.solife.me` can carry those paths to the iOS and macOS apps.
- **Build choice:** A small in-house router (~200 lines over the History API). The route set is
  small, and overlays-as-entries needs custom handling a library would not provide. The cost is
  owning it, with tests.
- **Also needs:** `not_found_handling = "single-page-application"` on the Worker's assets and a
  navigation fallback in the service worker.
- **Effort:** M–L, staged: router and pages first, then overlays. **Risk:** medium; navigation
  touches every surface. Covered by router unit tests and a Back-behaviour test per overlay type.

### C2-2 — One accessible overlay primitive (UX, accessibility, simplification)

- **User:** Everyone; screen-reader and keyboard users above all.
- **Proposal:** Replace `Modal` and the 26 hand-built sheets with one `Overlay` built on native
  `<dialog>` with `showModal()`. That gives focus trapping, an inert background, Escape and the top
  layer for free. Add labelling and focus restore on top. It presents as a bottom sheet on phones
  and a centred dialog on desktop, and it registers with C2-1 so Back closes it. Migrate one
  sheet at a time.
- **Effort:** M (primitive) plus S per sheet. **Risk:** low per sheet. **Depends on:** C2-1 for
  Back.

### C2-3 — Take `App.tsx` apart: a store, domain services and feature modules (architecture, performance)

- **User:** Indirectly everyone: fewer regressions, faster interaction on large boards. Directly,
  every future change.
- **Proposal:** The durable shape, in stages:
  1. **Pure task mutations.** `completeTask`, `deleteTask`, `moveTask`, `postponeTaskOneWeek`,
     `saveEdit` and the calendar equivalents become pure functions in `domains/tasks`. Each takes
     state and returns the next state plus publish intents, and gets unit tests. Where clients
     must agree, they move to `taskify-core`, as recurrence did in chunk 1. iOS's
     `TaskifySnapshot` already models mutations this way.
  2. **An entity store outside React.** Tasks, boards and events live in a store read through
     `useSyncExternalStore` with selectors. A component re-renders only when its slice changes.
     The existing per-entity IndexedDB store backs it.
  3. **A publish service.** Nostr publishing, retry and the optimistic clock leave the component
     and consume publish intents from stage 1.
  4. **Feature modules.** Boards, Upcoming, Bible, Print, Import and Voice become lazily loaded
     features. `App` keeps only layout and routing.
- Re-render savings are measured with the React Profiler before and after stage 2, not assumed.
- **Effort:** L, over several sessions, one stage per commit. Each stage ships with the test
  suite green. **Risk:** medium; stage 1 is low-risk and makes the rest safe.

### C2-4 — An identity and signer layer, with NIP-07 and NIP-46 sign-in (security, architecture) — Explore recommended

- **User:** People who already use Nostr and do not want to paste a secret key into a website.
  Indirectly everyone, since key handling moves into one place.
- **Proposal:** Replace `window.nostrPK` and the 42 direct reads with an `IdentityProvider`. It
  exposes the public key and a `Signer` interface (sign, NIP-44 encrypt/decrypt) with three
  implementations: local key (today), NIP-07 browser extension, and NIP-46 remote signer
  (bunker/Nostr Connect). No wire format changes.
- **Why Explore:** A remote signer pays a round trip per decryption. DM history and the private
  contact list decrypt many items at sign-in, so the approach (batching, a delegated session key,
  or local-key-only for some features) needs measuring first. The identity layer itself is worth
  doing either way and can go first.
- **Effort:** identity layer M; signers L. **Risk:** medium.

### C2-5 — First run that starts with tasks, not keys (UX)

- **User:** New users, mostly arriving from a shared link.
- **Proposal:**
  - The primary action becomes "Start using Taskify": it creates the key silently and opens a
    starter board.
  - "I already use Taskify" groups sign-in, restore and (with C2-4) signer apps.
  - Key backup is asked for once the user has something to lose, after a few tasks or on the
    second day, with an "Unsaved key" reminder in settings until it's done.
  - Notification permission is asked the first time the user sets a reminder. Today it's asked
    during onboarding.
  - iOS onboarding gets the same order (chunk 9), so both clients teach the same model.
- **Effort:** M. **Risk:** low. The existing gating tests in `onboardingGating.test.ts` extend to
  the new order.

### C2-6 — A startup budget enforced in CI (performance)

- **User:** Everyone; most noticeable on mid-range Android phones on mobile data.
- **Proposal:**
  - Load the wallet providers, Cashu SDK, QR tools and spreadsheet import only when used: the
    wallet only on devices where it's active (`walletAvailability` already knows), and move the
    `process`/`Buffer` polyfills into that chunk.
  - Add a CI check that measures the startup graph, as in this review, and fails above a budget,
    so it cannot quietly grow back.
  - Expected: roughly 600 KB down to about 400 KB gzipped, with C2-3 stage 4 taking it further.
  - Pairs with chunk 6, which removes wallet code rather than deferring it.
- **Effort:** M. **Risk:** low–medium. Wallet holders must still see their funds after a lazy
  load; that gets a test.

### C2-7 — Recoverable errors per surface (resilience)

- **User:** Anyone who hits a bug: they lose one sheet, not the app.
- **Proposal:** An error boundary per page and per overlay. Each fallback is themed and offers
  Reload and "Copy diagnostics" (app version, route, error, no user content). The root fallback
  gets the same treatment.
- **Effort:** S. **Risk:** low.

### C2-8 — A keyboard command layer matching the Mac app (desktop UX, parity)

- **User:** Desktop browser users on Windows and Linux.
- **Proposal:** One registry of named commands (new task, search, switch view, close, complete)
  with bindings. ⌘/Ctrl+N, ⌘/Ctrl+1–5 and ⌘/Ctrl+↩ match the macOS app; "/" focuses search; Esc
  closes. Shortcuts show in tooltips and a help sheet. A command palette can come later on the
  same registry.
- **Effort:** M. **Risk:** low. **Depends on:** C2-1, so view commands are route changes.

### C2-9 — Settings as a routed page with an index (UX)

- **User:** Everyone who looks for a setting; the push prompt and backup reminders link straight to
  their section.
- **Proposal:** `/settings` shows an index of sections, and `/settings/<section>` shows one
  section. It's two columns on desktop, drill-down on phones. Section order and names match iOS
  settings, so instructions work on both. Search can follow once sections are separate.
- **Effort:** M. **Risk:** low. **Depends on:** C2-1.

### Order of work

C2-3 stage 1 → C2-3 stage 2 → C2-1 → C2-6 → C2-3 stages 3–4 → C2-4 (identity layer, then the
signer measurement) → C2-5. Everything touches `App.tsx`, so the work is sequential, one commit
per step.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C2-1 | Approve | 2026-10-15 | Done (quick-add surface is a known gap) |
| C2-2 | Not selected (declined) | 2026-10-15 | — |
| C2-3 | Approve all stages | 2026-10-15 | Stages 1–3 done; stage 4 remains (see Checkpoint) |
| C2-4 | Approve identity layer; explore signers | 2026-10-15 | Identity layer done; signer findings below. 2026-10-16: maintainer wants NIP-07 and NIP-46 support built later (sequence below) |
| C2-5 | Approve, after C2-4 | 2026-10-15 | Done (PWA); iOS parity in chunk 9 |
| C2-6 | Approve | 2026-10-15 | Done: 604 → 458 KB gzipped startup, CI budget 470 KB |
| C2-7 | Not selected (declined) | 2026-10-15 | — |
| C2-8 | Not selected (declined) | 2026-10-15 | — |
| C2-9 | Not selected (declined) | 2026-10-15 | — |

### Checkpoint — October 15, 2026 (handoff)

Committed on `Beta` (not pushed), from `f2737649` through the stage-1 cleanup described below.
The suites are green after the page-router step: PWA lint (one existing warning in
`StoredTokensSheet.tsx`), `tsc -b`, and 471 Vitest tests. Core is at 142 tests; Swift
`TaskifyCoreTests` passes 789 tests with 12 integration tests skipped.

**Done**

- **C2-3 stage 2, the store.**
  - `src/state/stateStore.ts` is a synchronous store. `src/state/appStores.ts` holds the tasks,
    boards, calendar events and recurring-series cutoffs stores, each saving its own changes.
  - `useTasks`/`useBoards`/`useCalendarEvents` keep the `[value, set]` shape.
  - Read current state with `tasksStore().get()`, never from a closure.
  - The old `useState` initializers are loaders: `domains/tasks/storedTasks.ts` and
    `domains/calendar/storedCalendarEvents.ts`.
- **C2-3 stage 1, task commands** (`domains/tasks/taskCommands.ts`, 36 tests):
  - complete, delete (with series cutoffs and bounties), restore, clear completed, save, postpone,
    toggle subtask, note edit and assignment reply;
  - moves: drag/drop, to a board, and a selection to a column.
- **Generated-task planners** (`domains/tasks/generatedTasks.ts`): the Scripture Memory review task
  and fasting reminders.
- **Calendar window planner** (`domains/calendar/calendarRecurrenceWindow.ts`).
- **Calendar commands** (`domains/calendar/calendarCommands.ts`, 24 tests): selection moves between boards
  and list columns, recurring-series cutoffs, single-occurrence deletion, seed advancement and
  edits (including local recurrence-window refresh) all return explicit state and publish plans.
  Accepted invites use a two-phase flow: relay/decryption I/O in `App`, then a tested pure
  materialization plan. RSVP validation, wire payload/tags and post-publish local state are also
  planned before `App` performs encryption and relay publication.
- **C2-3 stage 1 complete.** The last `lib/app/weekBoardDate.ts` re-export shim is gone; its
  consumers import the shared implementation directly from `taskify-core`.
- **Fixed along the way:**
  - updaters that deferred or double-ran publishes;
  - a lost board `order` on save;
  - moves landing at arbitrary positions, which now follow the new-task position setting;
  - fasting reminders not deleted on other devices;
  - the recurring-event window deleting the user's edited occurrences.
- **Infrastructure:**
  - The PWA compiles `taskify-core` from source (Vite alias), so no stale build is served.
  - `ensureWeekRecurrencesForCurrentWeek` returns `{ tasks, generated }`.
  - The built-in Bible ids and `isAssignedSharedTask` are in core.
- **C2-1 shared link contract:** `taskify-core/src/taskifyLinks.ts` parses and formats the five
  existing native destinations as `taskify://` URLs and canonical web paths. Node and Swift read
  `fixtures/taskify-link-vectors.json`, including the native contract's intentional empty
  `board=` field when a task link has no board context.
- **C2-1 typed page router:** `src/routing/appRoute.ts` owns canonical board, Upcoming, Chat,
  Settings and compatibility-wallet paths; `AppHistoryRouter` owns `pushState`, `replaceState`
  and `popstate`. Tab and board navigation now create real history entries, a URL-selected board
  wins over the startup preference, and an explicit URL is not replaced by `startupView`.
- **C2-1 overlays and fallbacks (done).**
  - `useOverlayHistory` binds the task/event editor, the note viewer and all 16 sheets to history
    entries: Back (and Android's system Back) closes the top one, closing in the UI unwinds its
    entry, and stacked overlays close in order. The router coalesces closes into one history
    step and claims entries that have UI, so a closing editor is never reopened from its own URL.
  - `useRouteOverlayOpener` is now the only deep-link path: task, event and note URLs open once
    the item has synced; sheet and quick-add entries left by a reload are dismissed.
    `useReminderDeepLink` is replaced by `useReminderTaps`, which turns an open-app reminder tap
    into a router entry. A cold link with no in-app entry beneath closes to its page rather
    than leaving Taskify.
  - `wrangler.toml` serves `index.html` for navigations to unknown paths
    (`not_found_handling = "single-page-application"`; every Worker route is a fetched `/api/`
    path). The service worker caches one app shell for every navigation (cache `v9`), so any
    route opens offline and the shell is stored once rather than per URL.
  - Verified in the dev server: board URL selection, editor URL and entry, Back, UI close, and a
    cold `/task/<id>` link.
  - Known gap: a `quick-add` link (from the iOS widget vocabulary) only selects its board; the
    PWA has no quick-add surface to open yet.

- **C2-6 startup budget (done).** Startup JavaScript fell from 604 KB to 458 KB gzipped (−24%),
  and CI now fails above 470 KB (`npm run check:startup`, from Vite's manifest: everything
  `main.tsx` imports counts).
  - Chunking moved from the deprecated `manualChunks` to prioritized `codeSplitting` groups. Three
    hidden costs went away: React had been bundled into the QR chunk, Vite's lazy-chunk loader
    into the QR chunk, and the `Buffer`/`process` polyfills into the Cashu chunk. So every visit
    downloaded the QR scanner and the whole Cashu SDK.
  - The wallet providers run in a lazily mounted `WalletRuntime`, beside `App` rather than around
    it, and only where the wallet is enabled. Hooks come from `context/walletContexts`, which
    returns an unavailable wallet elsewhere. The share-board dialogs and the two wallet pages
    load on demand.
  - Verified in the dev server: no runtime and no wallet pages on a no-wallet device; with the
    wallet enabled the runtime publishes a ready wallet and the wallet page renders.
  - **Next lever (chunks 5–6):** chat lives inside `CashuWalletModal` (`CashuWalletShell` hosts
    it), so the modal and the Cashu SDK still load after startup on every device that opens
    chat. Moving chat out of the wallet modal removes that, and it is also the main step in the
    wallet phase-out.
  - Not moved: the `Buffer`/`process` polyfills (10 KB) stay at boot until every library that
    needs them is known.

- **C2-3 stage 3, the publish service (done).** Nostr sync state and publishing left `App`
  (12,828 lines at the start of chunk 2, 10,393 now):
  - `nostr/boardSyncLedger.ts` owns the clocks, in-flight publishes and deletion tombstones.
  - `nostr/boardPublisher.ts` publishes board metadata, tasks and calendar events, with keys,
    crypto, relays and storage injected.
  - The wire format is pure and tested: `boardWire.ts` and `calendarWire.ts` (writers),
    `taskEventMerge.ts` and `calendarEventMerge.ts` (readers), with writer-to-reader
    round-trip tests.
  - Fixed along the way:
    - a failed key derivation or upload left a task marked as publishing;
    - the initial-sync batch skipped the bounty authorization check;
    - calendar versions were recorded before decryption, so an unreadable copy could block a
      good one.
  - Logged for chunk 4: initial-sync batch entries take `order` from the batch, so a flush may
    reset a task's local position; `BoardPublisher` still sets `_nostrAt` on the task object
    passed in.

- **Chat alerts for the PWA (maintainer request 2026-10-16, done; needs a relay deploy).**
  - The push relay now also sends Web Push (`src/webpush.js`: RFC 8291 encryption and VAPID with
    node:crypto, no new dependencies). A browser has one push subscription, made with the
    Worker's VAPID key for reminders, so the relay is configured with the same key pair (the
    new Configure Web Push StartOS action, or `WEB_PUSH_VAPID_*`). Only browser push service
    hosts are accepted as endpoints, so a registration cannot aim the relay at other hosts.
  - The alert payload is `{"type":"message"}`: no sender, conversation or preview link. The
    service worker tells it apart from reminder pings (which carry no payload), shows "New
    message", and a tap opens Chat.
  - The PWA's push code moved out of `App.tsx` into `domains/push/usePushNotifications.ts`
    (−370 lines from App). Settings → Push notifications gains a Chat messages toggle once push
    is on. Turning it on registers the subscription with the relay (NIP-98, signed through the
    identity's signer, so it carries over to NIP-07/NIP-46) and adds the relay to the account's
    kind-10050 inbox list, as iOS does; turning it off reverses both (the relay stays listed
    while another device still uses it). Each launch refreshes the registration.
  - Until the relay is deployed with the key pair, turning chat alerts on shows "Web push is not
    configured on this relay".
  - For chunk 5: rich previews on the web (the service worker would need the key, or a signer).
- **C2-5, first run that starts with tasks (done, PWA).**
  - First run is "Start using Taskify" (makes the key quietly and opens the board) or "I already
    use Taskify" (sign in with an nsec, or restore a backup file). Signer apps join that page
    with NIP-07/NIP-46. Onboarding no longer asks for notifications or creates a wallet seed
    (the wallet makes its seed on first use).
  - The rules are pure and tested in `onboarding/firstRunRules.ts`; `onboarding/keyBackup.ts`
    keeps whether the key is saved. The backup reminder appears once a key made on this device
    has 3 tasks or is a day old; "Not now" waits 3 days. It replaces the separate key-migration
    notice. A key the user brought (sign-in, restore) is never nagged about.
  - Copying the nsec anywhere, or downloading a backup (which includes the key), records the
    key as saved. Settings shows "Unsaved key" until then, and says so when copying fails.
  - Notifications are offered the first time an item gains a reminder, when push is available
    and off; declining is remembered and Settings can still turn them on.
  - The mirror-logic `onboardingGating.test.ts` is replaced by tests of the real rules.
  - Not verifiable in the dev pane: the notification offer itself (push isn't configured in
    the dev build and the pane denies permission); its rule is unit-tested.
- **C2-4, identity layer (done) and the signer exploration.**
  - `src/identity/` is the single source of the user's identity: a public key plus a
    `NostrSigner` (sign, NIP-44, NIP-04). `LocalKeySigner` wraps the browser-held key.
  - `window.nostrPK` is gone (20 readers).
  - The user's own events and relay AUTH are signed through the signer. The runtime gained
    `prepareEventWith` and `loadAccountSigner`; the CLI is unchanged.
  - Every other read of the raw key goes through `revealLocalSecretKey` (21 sites in 12 files),
    which is now the exact list of what a non-local signer needs.

  **What a NIP-07 or NIP-46 signer would require, by feature:**

  | Feature | Key use today | With a signer |
  | --- | --- | --- |
  | Sending NIP-17 messages, shares, invites, RSVPs | seal signed, NIP-44 to recipient | sign + `nip44Encrypt`; the wrap keeps its throwaway key |
  | Receiving them (DMs, share inbox) | two NIP-44 decryptions per gift wrap | `nip44Decrypt` ×2 per wrap |
  | Private contact list (NIP-51) | NIP-44 to self | `nip44Encrypt`/`Decrypt` |
  | App-state, chat-state and backup sync | NIP-44 to self | `nip44Encrypt`/`Decrypt` |
  | Attachment upload authorization | signs an auth event | `sign` |
  | Showing or exporting the key | raw key | not possible by design |
  | Taskify wallet (P2PK, bounty AES key, npub.cash) | raw key or keys derived from it | not possible; the wallet is being phased out |

  **Measured cost per operation** (`nostr-tools` 2.25 on this Mac, in process):
  - a local NIP-44 decrypt is 2.3 ms;
  - the NIP-46 request/response envelope alone (no network) is 15 ms, 6.8× local.

  Over a real relay, each operation also costs two relay hops plus the signer app's response
  time. At an assumed 300 ms per operation (100–1,000 ms depending on relay and signer;
  not measured here), first sign-in on a new device costs:
  - 500 messages of history: 1,000 decryptions, about 5 minutes;
  - 5,000 messages: about 50 minutes.

  It is doubled today. The share inbox (`useNostrSubscriptions`) and the DM subscription
  (`useDmSubscription`) each subscribe to the same kinds 4 and 1059 and decrypt them
  independently, so every gift wrap in their overlap is unwrapped twice. This also wastes
  local CPU and relay traffic now.

  **Recommendation:**
  - NIP-07 (browser extensions) is viable once the table's first five rows move onto the
    signer: operations are local and take milliseconds.
  - NIP-46 (remote signers) needs two things first:
    - one gift-wrap ingestion pipeline that unwraps each wrap once and routes it to chat or the
      share inbox;
    - a per-device store of unwrapped messages keyed by wrap id, so a wrap is never decrypted
      twice on a device.

    With both, the cost after first sign-in is bounded by new messages. First sign-in still
    needs progressive, backgrounded history.
  - Proposed for chunk 5 (chat and sharing) as one item: the unified ingestion pipeline. It
    pays off with local keys today.

**The pattern to follow:** a command takes current state plus a context (`now`,
`actorPubkey`, the settings it needs) and returns the next state plus what to publish. `App`
reads the store, calls the command, calls `set`, then publishes. Nothing publishes or records
follow-up work inside a `set(prev => …)` updater. Bugs get a failing test first.

**Remaining, in order**

1. **C2-3 stage 4.** Make Boards, Upcoming, Bible, Print, Import and Voice lazily loaded feature
   modules; `App` keeps layout and routing.
   - Step 1 done: Upcoming's data model is pure and tested (`domains/upcoming/upcomingModel.ts`),
     and task comparators moved to `domains/tasks/taskSort.ts`; two copies of the day grouping
     became one.
   - Step 2 done: Upcoming is a lazily loaded page (`ui/upcoming/UpcomingPage.tsx`). `App` gives
     it the scroll container and two slots, one in the header for its actions and one above the
     tab bar for its controls, which the page fills through portals; `App` still renders the
     cards, since it owns the task and event actions. Upcoming's preferences are one store
     (`domains/upcoming/upcomingPreferences.ts`), read by the page and by a board's "upcoming"
     section; the calendar filter rules are pure (`upcomingFilter.ts`). Board sort left the
     shared controls hook (`ui/board/useBoardSort.ts`, `BoardSortSheet`). The "View" sheet,
     which nothing could open, is gone, and the Upcoming tab's count no longer includes US
     holidays. Startup JavaScript 462.4 → 449.0 KB gzipped; `App.tsx` 9,427 → 8,777 lines.
     Next: Boards (see the reordering below).
2. **C3-1, a real desktop layout (maintainer request 2026-10-17: "I don't like the PWA desktop
   layout; the mobile layout is good").** Details under "Desktop layout" below.
3. **The rest of stage 4:** Bible, Print, Import and Voice as lazy modules. They are small and
   don't affect layout, so they wait until after C3-1.
4. **Chunk 3 onward,** per the chunk plan.

**Desktop layout (C3-1, approved by the maintainer 2026-10-17)**

- **What's wrong today.** Desktop is the mobile DOM restyled by one 237-line CSS layer
  (`styles/desktop-layout.css`, active at ≥1024 px with a mouse). At 1440×900:
  - The tab bar becomes a floating card holding four links, with an empty column below it.
  - The board picker stays a dropdown in the header, apart from the rail.
  - A week board shows about three and a half days and scrolls sideways, with tall empty
    columns.
  - Upcoming and Settings are one column stretched across the full width (Settings cards run
    about 1,000 px wide).
  - Task and event editors open as phone-sized modals over everything.
- **Why fix it structurally.** Patching the CSS layer again would repeat the problem. The
  durable fix is an `AppLayout` component with named regions: rail, header, content, page
  controls, and an optional detail pane. Each page module fills the regions; mobile and
  desktop arrange the same regions differently. The Upcoming page's header and footer slots
  (stage 4 step 2) are the first version of this API.
- **Order.** The Boards module (next in stage 4) is built on these regions instead of more
  ad-hoc slots, so the board page is moved once and the layout redesign follows directly.
- **Proposed direction, to confirm with the maintainer when C3-1 starts:**
  - A rail that holds the board list (switch boards in one click), Upcoming, Chat and Settings.
  - A week board that fits seven days at ≥1280 px.
  - Upcoming with the month calendar and the day list side by side.
  - Settings at a readable width with section navigation.
  - Editors in a side detail pane on wide screens instead of a modal.
  - Mobile layout unchanged.

**Signer support (approved by the maintainer 2026-10-16, to build later):**

1. Unified gift-wrap ingestion (chunk 5): one pipeline that unwraps each wrap once, plus a
   per-device store of unwrapped messages.
2. Move the first five rows of the C2-4 table (messaging, contacts, sync, attachments) onto
   `NostrSigner`.
3. NIP-07 browser-extension sign-in.
4. NIP-46 remote signers, with progressive background history on first sign-in.

**Logged for later chunks**

- Chunk 4: Scripture Memory review tasks whose series fields get normalized are not republished.
  Republishing would send every past review on a frequency change, so it needs a deliberate rule.
- Chunk 4: `maybePublishTask` mutates `task._nostrAt` on objects held in state.
- Chunk 3: check on a device that opening `/upcoming` directly lands on today. In the dev
  Browser pane it started at the oldest day, but that pane was hidden, and hidden pages pause the
  animation frames the list's virtualizer scrolls with, so this may not be a real bug.
- Chunk 12: the CLI's runtime tests assert on source text; build a fake-session harness.
